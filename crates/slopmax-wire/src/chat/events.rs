//! A Chat Completions stream from upstream, read as answer events.
//!
//! Text and reasoning pass on as they arrive. Tool calls stream as argument
//! fragments, possibly several at once; they are gathered and passed on
//! whole when the answer ends, with the finish reason and usage (which
//! comes in a chunk of its own after the last choice).

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::Usage;
use crate::ir::{Call, Event, Failure, Stop, ToolKind};

#[derive(Debug, Default)]
struct Partial {
    id: String,
    name: String,
    arguments: String,
}

/// Reads one answer's chunks.
#[derive(Debug, Default)]
pub struct Events {
    /// Tools the client declared as freeform, whose calls carry
    /// `{"input": …}` here.
    freeform: HashSet<String>,
    calls: BTreeMap<u64, Partial>,
    finish: Option<String>,
    usage: Option<Usage>,
    done: bool,
}

impl Events {
    pub fn new(freeform: HashSet<String>) -> Self {
        Self {
            freeform,
            ..Self::default()
        }
    }

    /// Reads one chunk.
    pub fn feed(&mut self, chunk: &Value, out: &mut Vec<Event>) {
        if chunk.get("error").is_some_and(|e| !e.is_null()) {
            self.done = true;
            out.push(Event::Error(failure(chunk)));
            return;
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(read_usage(usage));
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
        else {
            return;
        };
        let delta = choice.get("delta").or_else(|| choice.get("message"));
        if let Some(delta) = delta {
            self.delta(delta, out);
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish = Some(reason.to_owned());
        }
    }

    fn delta(&mut self, delta: &Value, out: &mut Vec<Event>) {
        for key in ["reasoning_content", "reasoning"] {
            if let Some(text) = delta.get(key).and_then(Value::as_str)
                && !text.is_empty()
            {
                out.push(Event::Reasoning(text.to_owned()));
            }
        }
        if let Some(text) = delta.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            out.push(Event::Text(text.to_owned()));
        }
        let calls = delta.get("tool_calls").and_then(Value::as_array);
        for (position, call) in calls.into_iter().flatten().enumerate() {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(position as u64);
            let partial = self.calls.entry(index).or_default();
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                partial.id = id.to_owned();
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                partial.name.push_str(name);
            }
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                partial.arguments.push_str(arguments);
            }
        }
    }

    /// Called at `[DONE]` or the end of the body: passes on the calls and
    /// the end of the answer.
    pub fn finish(&mut self, out: &mut Vec<Event>) {
        if self.done {
            return;
        }
        self.done = true;
        for (_, call) in std::mem::take(&mut self.calls) {
            out.push(Event::Call(self.call(call)));
        }
        let Some(reason) = self.finish.take() else {
            out.push(Event::Error(Failure {
                status: 502,
                message: "the upstream stream ended before the answer finished".into(),
            }));
            return;
        };
        let stop = match reason.as_str() {
            "length" => Stop::Length,
            "tool_calls" | "function_call" => Stop::ToolUse,
            "content_filter" => Stop::Filtered,
            _ => Stop::End,
        };
        out.push(Event::Done {
            stop,
            usage: self.usage.take().unwrap_or(Usage {
                requests: 1,
                ..Usage::default()
            }),
        });
    }

    fn call(&self, partial: Partial) -> Call {
        let id = if partial.id.is_empty() {
            format!("call_{}", slopmax_common::ids::token())
        } else {
            partial.id
        };
        if self.freeform.contains(&partial.name) {
            let input = serde_json::from_str::<Value>(&partial.arguments)
                .ok()
                .and_then(|v| v.get("input")?.as_str().map(str::to_owned))
                .unwrap_or(partial.arguments);
            return Call {
                id,
                name: partial.name,
                input,
                kind: ToolKind::Freeform,
            };
        }
        Call {
            id,
            name: partial.name,
            input: partial.arguments,
            kind: ToolKind::Function,
        }
    }
}

/// The events of a whole (unstreamed) completion.
pub fn whole(completion: &Value, freeform: HashSet<String>) -> Vec<Event> {
    let mut events = Events::new(freeform);
    let mut out = Vec::new();
    events.feed(completion, &mut out);
    events.finish(&mut out);
    out
}

/// Usage with cached tokens split out of `prompt_tokens`.
pub fn read_usage(usage: &Value) -> Usage {
    let number = |path: &str| usage.pointer(path).and_then(Value::as_u64).unwrap_or(0);
    let cached = number("/prompt_tokens_details/cached_tokens");
    Usage {
        requests: 1,
        input_tokens: number("/prompt_tokens").saturating_sub(cached),
        cache_read_tokens: cached,
        output_tokens: number("/completion_tokens"),
        cache_write_tokens: 0,
    }
}

fn failure(chunk: &Value) -> Failure {
    let error = chunk.get("error").unwrap_or(chunk);
    let status = error
        .get("code")
        .and_then(Value::as_u64)
        .filter(|s| (400..600).contains(s))
        .unwrap_or(500) as u16;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the upstream answer failed");
    Failure {
        status,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(delta: Value, finish: Option<&str>) -> Value {
        json!({"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
    }

    #[test]
    fn gathers_interleaved_tool_calls() {
        let mut events = Events::new(HashSet::from(["apply_patch".to_owned()]));
        let mut out = Vec::new();
        for c in [
            chunk(json!({"role": "assistant", "content": "On it."}), None),
            chunk(
                json!({"tool_calls": [{"index": 0, "id": "call_a", "function": {"name": "shell", "arguments": "{\"cmd\""}}]}),
                None,
            ),
            chunk(
                json!({"tool_calls": [{"index": 1, "id": "call_b", "function": {"name": "apply_patch", "arguments": "{\"input\":"}}]}),
                None,
            ),
            chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": ":\"ls\"}"}}]}),
                None,
            ),
            chunk(
                json!({"tool_calls": [{"index": 1, "function": {"arguments": "\"*** Begin\"}"}}]}),
                None,
            ),
            chunk(json!({}), Some("tool_calls")),
            json!({"object": "chat.completion.chunk", "choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 40}}}),
        ] {
            events.feed(&c, &mut out);
        }
        events.finish(&mut out);
        assert_eq!(out[0], Event::Text("On it.".into()));
        assert_eq!(
            out[1],
            Event::Call(Call {
                id: "call_a".into(),
                name: "shell".into(),
                input: r#"{"cmd":"ls"}"#.into(),
                kind: ToolKind::Function
            })
        );
        assert_eq!(
            out[2],
            Event::Call(Call {
                id: "call_b".into(),
                name: "apply_patch".into(),
                input: "*** Begin".into(),
                kind: ToolKind::Freeform
            })
        );
        let Event::Done { stop, usage } = &out[3] else {
            panic!("expected the end, got {:?}", out[3]);
        };
        assert_eq!(*stop, Stop::ToolUse);
        assert_eq!((usage.input_tokens, usage.cache_read_tokens), (10, 40));
    }

    #[test]
    fn reasoning_and_whole_completions() {
        let completion = json!({"object": "chat.completion", "choices": [{"index": 0,
            "message": {"role": "assistant", "content": "42", "reasoning_content": "Think"},
            "finish_reason": "length"}], "usage": {"prompt_tokens": 3, "completion_tokens": 4}});
        let out = whole(&completion, HashSet::new());
        assert_eq!(out[0], Event::Reasoning("Think".into()));
        assert_eq!(out[1], Event::Text("42".into()));
        assert!(matches!(
            out[2],
            Event::Done {
                stop: Stop::Length,
                ..
            }
        ));
    }

    #[test]
    fn errors_and_cut_streams() {
        let mut events = Events::new(HashSet::new());
        let mut out = Vec::new();
        events.feed(
            &json!({"error": {"message": "overloaded", "code": 503}}),
            &mut out,
        );
        assert_eq!(
            out,
            [Event::Error(Failure {
                status: 503,
                message: "overloaded".into()
            })]
        );
        let mut cut = Events::new(HashSet::new());
        let mut out = Vec::new();
        cut.feed(&chunk(json!({"content": "Hi"}), None), &mut out);
        cut.finish(&mut out);
        assert!(matches!(out.last(), Some(Event::Error(f)) if f.status == 502));
    }
}
