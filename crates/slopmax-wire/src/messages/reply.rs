//! Answers from another format, told in Messages: the event stream Claude
//! Code reads, or a whole message.

use serde_json::{Value, json};

use crate::Usage;
use crate::frame;
use crate::ir::{Answer, Call, Event, Stop, ToolKind};
use slopmax_common::ids;

/// Encodes one answer as a Messages event stream.
#[derive(Debug)]
pub struct Reply {
    id: String,
    model: String,
    started: bool,
    /// The next content block's index.
    index: usize,
    /// Whether a text block is open.
    text: bool,
    /// Whether the answer called tools, which is why it stops.
    called: bool,
}

impl Reply {
    pub fn new(model: &str) -> Self {
        Self {
            id: format!("msg_{}", ids::token()),
            model: model.to_owned(),
            started: false,
            index: 0,
            text: false,
            called: false,
        }
    }

    /// Writes the frames for `event` to `out`.
    pub fn event(&mut self, event: &Event, out: &mut Vec<u8>) {
        if !self.started {
            self.started = true;
            let message = json!({
                "id": self.id, "type": "message", "role": "assistant", "model": self.model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            });
            frame(
                out,
                Some("message_start"),
                &json!({"type": "message_start", "message": message}),
            );
        }
        match event {
            Event::Text(text) => {
                if !self.text {
                    self.text = true;
                    let start = json!({"type": "content_block_start", "index": self.index,
                        "content_block": {"type": "text", "text": ""}});
                    frame(out, Some("content_block_start"), &start);
                }
                let delta = json!({"type": "content_block_delta", "index": self.index,
                    "delta": {"type": "text_delta", "text": text}});
                frame(out, Some("content_block_delta"), &delta);
            }
            // Reasoning from another model is not shown: Claude Code would
            // send it back to Anthropic, which rejects thinking it did not
            // sign.
            Event::Reasoning(_) | Event::State(_) => {}
            Event::Call(call) => {
                self.close(out);
                let start = json!({"type": "content_block_start", "index": self.index,
                    "content_block": {"type": "tool_use", "id": call.id, "name": call.name, "input": {}}});
                frame(out, Some("content_block_start"), &start);
                let delta = json!({"type": "content_block_delta", "index": self.index,
                    "delta": {"type": "input_json_delta", "partial_json": input(call)}});
                frame(out, Some("content_block_delta"), &delta);
                self.stop_block(out);
                self.called = true;
            }
            Event::Done { stop, usage } => {
                self.close(out);
                let stop = match stop {
                    Stop::End if self.called => &Stop::ToolUse,
                    stop => stop,
                };
                let delta = json!({"type": "message_delta",
                    "delta": {"stop_reason": stop_reason(*stop), "stop_sequence": null},
                    "usage": usage_json(usage)});
                frame(out, Some("message_delta"), &delta);
                frame(out, Some("message_stop"), &json!({"type": "message_stop"}));
            }
            Event::Error(failure) => {
                self.close(out);
                let error = super::error(failure.kind(), &failure.message);
                frame(out, Some("error"), &error);
            }
        }
    }

    fn close(&mut self, out: &mut Vec<u8>) {
        if self.text {
            self.text = false;
            self.stop_block(out);
        }
    }

    fn stop_block(&mut self, out: &mut Vec<u8>) {
        let stop = json!({"type": "content_block_stop", "index": self.index});
        frame(out, Some("content_block_stop"), &stop);
        self.index += 1;
    }
}

/// A whole answer as one message.
pub fn whole(answer: &Answer, model: &str) -> Value {
    let mut content = Vec::new();
    if !answer.text.is_empty() {
        content.push(json!({"type": "text", "text": answer.text}));
    }
    for call in &answer.calls {
        let input: Value = serde_json::from_str(&input(call)).unwrap_or_else(|_| json!({}));
        content.push(json!({"type": "tool_use", "id": call.id, "name": call.name, "input": input}));
    }
    json!({
        "id": format!("msg_{}", ids::token()), "type": "message", "role": "assistant",
        "model": model, "content": content,
        "stop_reason": stop_reason(answer.stop()), "stop_sequence": null,
        "usage": usage_json(&answer.usage),
    })
}

/// The call's input as a JSON object: freeform input is wrapped.
fn input(call: &Call) -> String {
    match call.kind {
        ToolKind::Function if !call.input.trim().is_empty() => call.input.clone(),
        ToolKind::Function => "{}".to_owned(),
        ToolKind::Freeform => json!({"input": call.input}).to_string(),
    }
}

fn stop_reason(stop: Stop) -> &'static str {
    match stop {
        Stop::End => "end_turn",
        Stop::ToolUse => "tool_use",
        Stop::Length => "max_tokens",
        Stop::Sequence => "stop_sequence",
        Stop::Filtered => "refusal",
    }
}

fn usage_json(usage: &Usage) -> Value {
    json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_read_input_tokens": usage.cache_read_tokens,
        "cache_creation_input_tokens": usage.cache_write_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Failure;

    /// The data payloads of the frames, by event name.
    fn frames(out: &[u8]) -> Vec<(String, Value)> {
        let text = std::str::from_utf8(out).unwrap();
        text.split("\n\n")
            .filter(|f| !f.is_empty())
            .map(|f| {
                let mut lines = f.lines();
                let name = lines.next().unwrap().strip_prefix("event: ").unwrap();
                let data = lines.next().unwrap().strip_prefix("data: ").unwrap();
                (name.to_owned(), serde_json::from_str(data).unwrap())
            })
            .collect()
    }

    #[test]
    fn streams_text_then_tool_use() {
        let mut reply = Reply::new("gpt-6-sol");
        let mut out = Vec::new();
        for event in [
            Event::Reasoning("thinking...".into()),
            Event::Text("Let me ".into()),
            Event::Text("check.".into()),
            Event::Call(Call {
                id: "call_1".into(),
                name: "Bash".into(),
                input: r#"{"command":"ls"}"#.into(),
                kind: ToolKind::Function,
            }),
            Event::Done {
                stop: Stop::ToolUse,
                usage: Usage {
                    input_tokens: 40,
                    cache_read_tokens: 60,
                    output_tokens: 9,
                    ..Usage::default()
                },
            },
        ] {
            reply.event(&event, &mut out);
        }
        let frames = frames(&out);
        let names: Vec<&str> = frames.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        assert_eq!(frames[0].1["message"]["model"], "gpt-6-sol");
        assert_eq!(frames[5].1["index"], 1);
        assert_eq!(frames[5].1["content_block"]["id"], "call_1");
        assert_eq!(frames[6].1["delta"]["partial_json"], r#"{"command":"ls"}"#);
        assert_eq!(frames[8].1["delta"]["stop_reason"], "tool_use");
        assert_eq!(frames[8].1["usage"]["cache_read_input_tokens"], 60);
    }

    #[test]
    fn failures_become_error_events() {
        let mut reply = Reply::new("m");
        let mut out = Vec::new();
        reply.event(&Event::Text("partial".into()), &mut out);
        reply.event(
            &Event::Error(Failure {
                status: 529,
                message: "overloaded".into(),
            }),
            &mut out,
        );
        let frames = frames(&out);
        let (name, error) = frames.last().unwrap();
        assert_eq!(name, "error");
        assert_eq!(error["error"]["type"], "overloaded_error");
    }

    #[test]
    fn whole_messages_carry_text_and_calls() {
        let answer = Answer {
            text: "Done.".into(),
            calls: vec![Call {
                id: "c".into(),
                name: "apply_patch".into(),
                input: "*** Begin Patch".into(),
                kind: ToolKind::Freeform,
            }],
            ..Answer::default()
        };
        let message = whole(&answer, "m");
        assert_eq!(message["content"][0]["text"], "Done.");
        assert_eq!(message["content"][1]["input"]["input"], "*** Begin Patch");
        assert_eq!(message["stop_reason"], "tool_use");
    }
}
