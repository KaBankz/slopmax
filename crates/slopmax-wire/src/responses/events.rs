//! A Responses event stream from upstream, read as answer events.

use std::collections::HashSet;

use serde_json::Value;

use crate::Usage;
use crate::ir::{Call, Event, Failure, Stop, ToolKind};

/// Reads one answer's events.
#[derive(Debug, Default)]
pub struct Events {
    /// Message items whose text already streamed as deltas.
    streamed: HashSet<String>,
    /// The message item text last came from, to set the next one apart.
    texting: Option<String>,
    /// Reasoning summary parts seen, to separate them.
    summaries: usize,
    done: bool,
}

impl Events {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads one event.
    pub fn feed(&mut self, event: &Value, out: &mut Vec<Event>) {
        let text = |key: &str| {
            event
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_text.delta" => {
                let id = text("item_id");
                self.text_from(&id, out);
                self.streamed.insert(id);
                out.push(Event::Text(text("delta")));
            }
            "response.reasoning_summary_part.added" => {
                if self.summaries > 0 {
                    out.push(Event::Reasoning("\n\n".into()));
                }
                self.summaries += 1;
            }
            "response.reasoning_summary_text.delta" => out.push(Event::Reasoning(text("delta"))),
            "response.output_item.done" => {
                if let Some(item) = event.get("item") {
                    self.item(item, out);
                }
            }
            "response.completed" | "response.incomplete" | "response.done" => {
                let response = event.get("response").unwrap_or(&Value::Null);
                self.done = true;
                out.push(done(response));
            }
            "response.failed" | "error" => {
                self.done = true;
                out.push(Event::Error(failure(event)));
            }
            _ => {}
        }
    }

    fn item(&mut self, item: &Value, out: &mut Vec<Event>) {
        let field = |key: &str| {
            item.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        // A call ends the text before it; text after starts afresh.
        if matches!(kind, "function_call" | "custom_tool_call") {
            self.texting = None;
        }
        match kind {
            "function_call" => out.push(Event::Call(Call {
                id: field("call_id"),
                name: field("name"),
                input: field("arguments"),
                kind: ToolKind::Function,
            })),
            "custom_tool_call" => out.push(Event::Call(Call {
                id: field("call_id"),
                name: field("name"),
                input: field("input"),
                kind: ToolKind::Freeform,
            })),
            "reasoning" => {
                if let Some(state) = item.get("encrypted_content").and_then(Value::as_str) {
                    out.push(Event::State(state.to_owned()));
                }
            }
            // Text that did not stream arrives whole.
            "message" if !self.streamed.contains(&field("id")) => {
                let text = message_text(item);
                if !text.is_empty() {
                    self.text_from(&field("id"), out);
                    out.push(Event::Text(text));
                }
            }
            _ => {}
        }
    }

    /// Notes that text comes from message item `id`. GPT models can answer
    /// in two messages, a `commentary` one saying what they are about to do
    /// and the `final_answer`: a paragraph break keeps them from running
    /// together.
    fn text_from(&mut self, id: &str, out: &mut Vec<Event>) {
        if self.texting.as_deref() == Some(id) {
            return;
        }
        if self.texting.is_some() {
            out.push(Event::Text("\n\n".into()));
        }
        self.texting = Some(id.to_owned());
    }

    /// Called when the stream ends: a stream cut short is a failure.
    pub fn finish(&mut self, out: &mut Vec<Event>) {
        if !self.done {
            self.done = true;
            out.push(Event::Error(Failure {
                status: 502,
                message: "the upstream stream ended before the response completed".into(),
            }));
        }
    }
}

/// The events of a whole (unstreamed) response.
pub fn whole(response: &Value) -> Vec<Event> {
    let mut events = Events::new();
    let mut out = Vec::new();
    if response.get("error").is_some_and(|e| !e.is_null()) {
        return vec![Event::Error(failure(response))];
    }
    for item in response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        events.item(item, &mut out);
    }
    out.push(done(response));
    out
}

fn message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

fn done(response: &Value) -> Event {
    let reason = response
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str);
    let stop = match reason {
        Some("max_output_tokens") => Stop::Length,
        Some("content_filter") => Stop::Filtered,
        _ => Stop::End,
    };
    Event::Done {
        stop,
        usage: usage(response.get("usage").unwrap_or(&Value::Null)),
    }
}

/// Usage with cached tokens split out of `input_tokens`.
pub fn usage(usage: &Value) -> Usage {
    let number = |path: &str| usage.pointer(path).and_then(Value::as_u64).unwrap_or(0);
    let cached = number("/input_tokens_details/cached_tokens");
    Usage {
        requests: 1,
        input_tokens: number("/input_tokens").saturating_sub(cached),
        cache_read_tokens: cached,
        output_tokens: number("/output_tokens"),
        cache_write_tokens: 0,
    }
}

/// A failure event's error, with the status its code implies.
fn failure(event: &Value) -> Failure {
    let error = event
        .pointer("/response/error")
        .or_else(|| event.get("error"))
        .unwrap_or(event);
    let code = error
        .get("code")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let status = match code {
        "rate_limit_exceeded" | "usage_limit_reached" | "usage_limit_exceeded" => 429,
        "server_is_overloaded" | "slow_down" => 529,
        "context_length_exceeded" | "invalid_request_error" | "invalid_prompt" => 400,
        _ => 500,
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .unwrap_or("the upstream response failed");
    Failure {
        status,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(events: &[Value]) -> Vec<Event> {
        let mut decoder = Events::new();
        let mut out = Vec::new();
        for event in events {
            decoder.feed(event, &mut out);
        }
        decoder.finish(&mut out);
        out
    }

    #[test]
    fn separate_messages_stay_apart() {
        let events = read(&[
            json!({"type": "response.output_item.added", "item": {"type": "message", "id": "m1", "phase": "commentary"}}),
            json!({"type": "response.output_text.delta", "item_id": "m1", "delta": "Checking"}),
            json!({"type": "response.output_text.delta", "item_id": "m1", "delta": " first."}),
            json!({"type": "response.output_item.done", "item": {"type": "message", "id": "m1", "phase": "commentary", "content": [{"type": "output_text", "text": "Checking first."}]}}),
            json!({"type": "response.output_text.delta", "item_id": "m2", "delta": "Done."}),
            json!({"type": "response.output_item.done", "item": {"type": "function_call", "call_id": "c1", "name": "Bash", "arguments": "{}"}}),
            json!({"type": "response.output_text.delta", "item_id": "m4", "delta": "After."}),
            json!({"type": "response.output_item.done", "item": {"type": "message", "id": "m3", "content": [{"type": "output_text", "text": "Whole."}]}}),
            json!({"type": "response.completed", "response": {}}),
        ]);
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                Event::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Checking first.\n\nDone.After.\n\nWhole.");
    }

    #[test]
    fn reads_text_reasoning_state_and_calls() {
        let events = read(&[
            json!({"type": "response.created", "response": {"id": "r"}}),
            json!({"type": "response.reasoning_summary_part.added"}),
            json!({"type": "response.reasoning_summary_text.delta", "delta": "Plan A"}),
            json!({"type": "response.reasoning_summary_part.added"}),
            json!({"type": "response.reasoning_summary_text.delta", "delta": "Plan B"}),
            json!({"type": "response.output_item.done", "item": {"type": "reasoning", "encrypted_content": "gAAA"}}),
            json!({"type": "response.output_text.delta", "item_id": "m1", "delta": "Hi"}),
            json!({"type": "response.output_item.done", "item": {"type": "message", "id": "m1", "content": [{"type": "output_text", "text": "Hi"}]}}),
            json!({"type": "response.output_item.done", "item": {"type": "function_call", "call_id": "c1", "name": "Bash", "arguments": "{}"}}),
            json!({"type": "response.completed", "response": {"usage": {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 80}, "output_tokens": 7, "total_tokens": 107}}}),
        ]);
        assert_eq!(
            events,
            [
                Event::Reasoning("Plan A".into()),
                Event::Reasoning("\n\n".into()),
                Event::Reasoning("Plan B".into()),
                Event::State("gAAA".into()),
                Event::Text("Hi".into()),
                Event::Call(Call {
                    id: "c1".into(),
                    name: "Bash".into(),
                    input: "{}".into(),
                    kind: ToolKind::Function
                }),
                Event::Done {
                    stop: Stop::End,
                    usage: Usage {
                        requests: 1,
                        input_tokens: 20,
                        cache_read_tokens: 80,
                        output_tokens: 7,
                        cache_write_tokens: 0
                    }
                },
            ]
        );
    }

    #[test]
    fn failures_and_cut_streams_are_errors() {
        let events = read(&[
            json!({"type": "response.failed", "response": {"error": {"code": "server_is_overloaded", "message": "busy"}}}),
        ]);
        assert_eq!(
            events,
            [Event::Error(Failure {
                status: 529,
                message: "busy".into()
            })]
        );
        let cut = read(&[json!({"type": "response.output_text.delta", "delta": "Hi"})]);
        assert!(matches!(cut.last(), Some(Event::Error(f)) if f.status == 502));
    }

    #[test]
    fn whole_responses_and_length_stops() {
        let events = whole(&json!({
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"type": "message", "id": "m", "content": [{"type": "output_text", "text": "Partial"}]}],
            "usage": {"input_tokens": 5, "output_tokens": 9}
        }));
        assert_eq!(events[0], Event::Text("Partial".into()));
        assert!(matches!(
            events[1],
            Event::Done {
                stop: Stop::Length,
                ..
            }
        ));
    }
}
