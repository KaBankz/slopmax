//! Answers from another format, told in Chat Completions: a chunk stream,
//! or a whole completion.

use serde_json::{Value, json};

use crate::ids;
use crate::pool::Usage;
use crate::time::Timestamp;
use crate::wire::frame;
use crate::wire::ir::{Answer, Call, Event, Stop, ToolKind};

/// Encodes one answer as a chunk stream.
#[derive(Debug)]
pub struct Reply {
    id: String,
    model: String,
    created: i64,
    /// Whether the client asked for a usage chunk.
    include_usage: bool,
    started: bool,
    calls: u64,
}

impl Reply {
    pub fn new(model: &str, include_usage: bool) -> Self {
        Self {
            id: format!("chatcmpl-{}", ids::token()),
            model: model.to_owned(),
            created: Timestamp::now().as_second(),
            include_usage,
            started: false,
            calls: 0,
        }
    }

    fn chunk(&self, out: &mut Vec<u8>, delta: Value, finish: Option<&str>) {
        let chunk = json!({"id": self.id, "object": "chat.completion.chunk",
            "created": self.created, "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]});
        frame(out, None, &chunk);
    }

    /// Writes the chunks for `event` to `out`.
    pub fn event(&mut self, event: &Event, out: &mut Vec<u8>) {
        if !self.started {
            self.started = true;
            self.chunk(out, json!({"role": "assistant", "content": ""}), None);
        }
        match event {
            Event::Text(text) => self.chunk(out, json!({"content": text}), None),
            // Not in the Chat spec, but widely shown by Chat clients.
            Event::Reasoning(text) => self.chunk(out, json!({"reasoning_content": text}), None),
            Event::State(_) => {}
            Event::Call(call) => {
                let delta = json!({"tool_calls": [tool_call(call, Some(self.calls))]});
                self.calls += 1;
                self.chunk(out, delta, None);
            }
            Event::Done { stop, usage } => {
                let stop = if self.calls > 0 && *stop == Stop::End {
                    Stop::ToolUse
                } else {
                    *stop
                };
                self.chunk(out, json!({}), Some(finish_reason(stop)));
                if self.include_usage {
                    let chunk = json!({"id": self.id, "object": "chat.completion.chunk",
                        "created": self.created, "model": self.model,
                        "choices": [], "usage": usage_json(usage)});
                    frame(out, None, &chunk);
                }
                out.extend_from_slice(b"data: [DONE]\n\n");
            }
            Event::Error(failure) => {
                let error = json!({"error": {"message": failure.message,
                    "type": failure.kind(), "code": failure.status}});
                frame(out, None, &error);
                out.extend_from_slice(b"data: [DONE]\n\n");
            }
        }
    }
}

/// A whole answer as one completion.
pub fn whole(answer: &Answer, model: &str) -> Value {
    let mut message = json!({"role": "assistant",
        "content": if answer.text.is_empty() { Value::Null } else { json!(answer.text) }});
    if !answer.reasoning.is_empty() {
        message["reasoning_content"] = json!(answer.reasoning);
    }
    if !answer.calls.is_empty() {
        let calls: Vec<Value> = answer.calls.iter().map(|c| tool_call(c, None)).collect();
        message["tool_calls"] = Value::Array(calls);
    }
    json!({
        "id": format!("chatcmpl-{}", ids::token()), "object": "chat.completion",
        "created": Timestamp::now().as_second(), "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason(answer.stop())}],
        "usage": usage_json(&answer.usage),
    })
}

fn tool_call(call: &Call, index: Option<u64>) -> Value {
    let arguments = match call.kind {
        ToolKind::Function => call.input.clone(),
        ToolKind::Freeform => json!({"input": call.input}).to_string(),
    };
    let mut value = json!({"id": call.id, "type": "function",
        "function": {"name": call.name, "arguments": arguments}});
    if let Some(index) = index {
        value["index"] = json!(index);
    }
    value
}

fn finish_reason(stop: Stop) -> &'static str {
    match stop {
        Stop::End | Stop::Sequence => "stop",
        Stop::ToolUse => "tool_calls",
        Stop::Length => "length",
        Stop::Filtered => "content_filter",
    }
}

fn usage_json(usage: &Usage) -> Value {
    let prompt = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    json!({
        "prompt_tokens": prompt,
        "completion_tokens": usage.output_tokens,
        "total_tokens": prompt + usage.output_tokens,
        "prompt_tokens_details": {"cached_tokens": usage.cache_read_tokens},
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks(out: &[u8]) -> Vec<String> {
        std::str::from_utf8(out)
            .unwrap()
            .split("\n\n")
            .filter(|f| !f.is_empty())
            .map(|f| f.strip_prefix("data: ").unwrap().to_owned())
            .collect()
    }

    #[test]
    fn streams_chunks_then_usage_and_done() {
        let mut reply = Reply::new("gpt-6-sol", true);
        let mut out = Vec::new();
        for event in [
            Event::Text("Hi".into()),
            Event::Call(Call {
                id: "call_1".into(),
                name: "f".into(),
                input: "{}".into(),
                kind: ToolKind::Function,
            }),
            Event::Done {
                stop: Stop::End,
                usage: Usage {
                    input_tokens: 2,
                    cache_read_tokens: 8,
                    output_tokens: 3,
                    ..Usage::default()
                },
            },
        ] {
            reply.event(&event, &mut out);
        }
        let chunks = chunks(&out);
        assert_eq!(chunks.last().unwrap(), "[DONE]");
        let parsed: Vec<Value> = chunks[..chunks.len() - 1]
            .iter()
            .map(|c| serde_json::from_str(c).unwrap())
            .collect();
        assert_eq!(parsed[0]["choices"][0]["delta"]["role"], "assistant");
        assert_eq!(parsed[1]["choices"][0]["delta"]["content"], "Hi");
        assert_eq!(
            parsed[2]["choices"][0]["delta"]["tool_calls"][0]["index"],
            0
        );
        assert_eq!(parsed[3]["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(parsed[4]["usage"]["prompt_tokens"], 10);
        assert_eq!(parsed[4]["choices"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn usage_chunks_only_when_asked() {
        let mut reply = Reply::new("m", false);
        let mut out = Vec::new();
        reply.event(
            &Event::Done {
                stop: Stop::End,
                usage: Usage::default(),
            },
            &mut out,
        );
        assert!(!String::from_utf8(out).unwrap().contains("usage"));
    }

    #[test]
    fn whole_completions() {
        let answer = Answer {
            text: "Hello".into(),
            reasoning: "Greet".into(),
            ..Answer::default()
        };
        let completion = whole(&answer, "m");
        assert_eq!(completion["choices"][0]["message"]["content"], "Hello");
        assert_eq!(
            completion["choices"][0]["message"]["reasoning_content"],
            "Greet"
        );
        assert_eq!(completion["choices"][0]["finish_reason"], "stop");
    }
}
