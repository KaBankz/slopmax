//! Answers from another format, told in Responses: the event stream Codex
//! reads, or a whole response.

use serde_json::{Value, json};

use crate::ids;
use crate::pool::Usage;
use crate::time::Timestamp;
use crate::wire::frame;
use crate::wire::ir::{Answer, Call, Event, Failure, Stop, ToolKind};

/// The item being streamed.
#[derive(Debug)]
enum Open {
    Message { id: String, text: String },
    Reasoning { id: String, text: String },
}

/// Encodes one answer as a Responses event stream.
#[derive(Debug)]
pub struct Reply {
    id: String,
    model: String,
    created: i64,
    sequence: u64,
    started: bool,
    open: Option<Open>,
    /// Finished items, for the final response.
    output: Vec<Value>,
    /// Compacting: the answer's text is gathered into one compaction item.
    summary: Option<String>,
}

impl Reply {
    pub fn new(model: &str) -> Self {
        Self {
            id: format!("resp_{}", ids::token()),
            model: model.to_owned(),
            created: Timestamp::now().as_second(),
            sequence: 0,
            started: false,
            open: None,
            output: Vec::new(),
            summary: None,
        }
    }

    /// An encoder that turns the answer into one compaction item.
    pub fn compacting(model: &str) -> Self {
        Self {
            summary: Some(String::new()),
            ..Self::new(model)
        }
    }

    fn send(&mut self, out: &mut Vec<u8>, kind: &str, mut data: Value) {
        data["type"] = json!(kind);
        data["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        frame(out, Some(kind), &data);
    }

    fn response(&self, status: &str) -> Value {
        json!({"id": self.id, "object": "response", "created_at": self.created,
            "status": status, "model": self.model, "output": self.output})
    }

    /// Writes the frames for `event` to `out`.
    pub fn event(&mut self, event: &Event, out: &mut Vec<u8>) {
        if !self.started {
            self.started = true;
            let response = self.response("in_progress");
            self.send(out, "response.created", json!({"response": response}));
            self.send(out, "response.in_progress", json!({"response": response}));
        }
        if let Some(summary) = &mut self.summary {
            match event {
                Event::Text(text) => {
                    summary.push_str(text);
                    return;
                }
                Event::Done { .. } => {
                    let summary = std::mem::take(summary);
                    let item = compaction_item(&summary);
                    let index = self.output.len();
                    self.send(
                        out,
                        "response.output_item.added",
                        json!({"output_index": index, "item": item}),
                    );
                    self.finish_item(out, item);
                }
                Event::Error(_) => {}
                _ => return,
            }
        }
        match event {
            Event::Text(text) => {
                if !matches!(self.open, Some(Open::Message { .. })) {
                    self.close(out);
                    self.open_message(out);
                }
                let index = self.output.len();
                if let Some(Open::Message { id, text: all }) = &mut self.open {
                    all.push_str(text);
                    let data = json!({"item_id": id, "output_index": index,
                        "content_index": 0, "delta": text});
                    self.send(out, "response.output_text.delta", data);
                }
            }
            Event::Reasoning(text) => {
                if !matches!(self.open, Some(Open::Reasoning { .. })) {
                    self.close(out);
                    self.open_reasoning(out);
                }
                let index = self.output.len();
                if let Some(Open::Reasoning { id, text: all }) = &mut self.open {
                    all.push_str(text);
                    let data = json!({"item_id": id, "output_index": index,
                        "summary_index": 0, "delta": text});
                    self.send(out, "response.reasoning_summary_text.delta", data);
                }
            }
            Event::State(_) => {}
            Event::Call(call) => {
                self.close(out);
                self.call(call, out);
            }
            Event::Done { stop, usage } => {
                self.close(out);
                let mut response = self.response("completed");
                response["usage"] = usage_json(usage);
                let kind = if *stop == Stop::Length {
                    response["status"] = json!("incomplete");
                    response["incomplete_details"] = json!({"reason": "max_output_tokens"});
                    "response.incomplete"
                } else {
                    "response.completed"
                };
                self.send(out, kind, json!({"response": response}));
            }
            Event::Error(failure) => {
                self.close(out);
                let mut response = self.response("failed");
                response["error"] = error_json(failure);
                self.send(out, "response.failed", json!({"response": response}));
            }
        }
    }

    fn open_message(&mut self, out: &mut Vec<u8>) {
        let id = format!("msg_{}", ids::token());
        let index = self.output.len();
        let item = json!({"id": id, "type": "message", "role": "assistant",
            "status": "in_progress", "content": []});
        self.send(
            out,
            "response.output_item.added",
            json!({"output_index": index, "item": item}),
        );
        let part = json!({"type": "output_text", "text": "", "annotations": []});
        self.send(
            out,
            "response.content_part.added",
            json!({"item_id": id, "output_index": index, "content_index": 0, "part": part}),
        );
        self.open = Some(Open::Message {
            id,
            text: String::new(),
        });
    }

    fn open_reasoning(&mut self, out: &mut Vec<u8>) {
        let id = format!("rs_{}", ids::token());
        let index = self.output.len();
        let item = json!({"id": id, "type": "reasoning", "summary": []});
        self.send(
            out,
            "response.output_item.added",
            json!({"output_index": index, "item": item}),
        );
        let part = json!({"type": "summary_text", "text": ""});
        self.send(
            out,
            "response.reasoning_summary_part.added",
            json!({"item_id": id, "output_index": index, "summary_index": 0, "part": part}),
        );
        self.open = Some(Open::Reasoning {
            id,
            text: String::new(),
        });
    }

    /// Finishes the item being streamed.
    fn close(&mut self, out: &mut Vec<u8>) {
        let index = self.output.len();
        let item = match self.open.take() {
            None => return,
            Some(Open::Message { id, text }) => {
                let part = json!({"type": "output_text", "text": text, "annotations": []});
                self.send(
                    out,
                    "response.output_text.done",
                    json!({"item_id": id, "output_index": index, "content_index": 0, "text": text}),
                );
                self.send(
                    out,
                    "response.content_part.done",
                    json!({"item_id": id, "output_index": index, "content_index": 0, "part": part}),
                );
                json!({"id": id, "type": "message", "role": "assistant",
                    "status": "completed", "content": [part]})
            }
            Some(Open::Reasoning { id, text }) => {
                let part = json!({"type": "summary_text", "text": text});
                self.send(
                    out,
                    "response.reasoning_summary_text.done",
                    json!({"item_id": id, "output_index": index, "summary_index": 0, "text": text}),
                );
                self.send(
                    out,
                    "response.reasoning_summary_part.done",
                    json!({"item_id": id, "output_index": index, "summary_index": 0, "part": part}),
                );
                json!({"id": id, "type": "reasoning", "summary": [part]})
            }
        };
        self.finish_item(out, item);
    }

    fn call(&mut self, call: &Call, out: &mut Vec<u8>) {
        let index = self.output.len();
        let (item, delta, done) = match call.kind {
            ToolKind::Function => (
                json!({"id": format!("fc_{}", ids::token()), "type": "function_call",
                    "status": "completed", "call_id": call.id, "name": call.name,
                    "arguments": call.input}),
                "response.function_call_arguments.delta",
                "response.function_call_arguments.done",
            ),
            ToolKind::Freeform => (
                json!({"id": format!("ctc_{}", ids::token()), "type": "custom_tool_call",
                    "status": "completed", "call_id": call.id, "name": call.name,
                    "input": call.input}),
                "response.custom_tool_call_input.delta",
                "response.custom_tool_call_input.done",
            ),
        };
        let mut added = item.clone();
        added["status"] = json!("in_progress");
        let id = item["id"].clone();
        self.send(
            out,
            "response.output_item.added",
            json!({"output_index": index, "item": added}),
        );
        self.send(
            out,
            delta,
            json!({"item_id": id, "output_index": index, "delta": call.input}),
        );
        let field = match call.kind {
            ToolKind::Function => "arguments",
            ToolKind::Freeform => "input",
        };
        self.send(
            out,
            done,
            json!({"item_id": id, "output_index": index, field: call.input}),
        );
        self.finish_item(out, item);
    }

    fn finish_item(&mut self, out: &mut Vec<u8>, item: Value) {
        let index = self.output.len();
        self.send(
            out,
            "response.output_item.done",
            json!({"output_index": index, "item": item}),
        );
        self.output.push(item);
    }
}

/// A summary sealed in a compaction item.
fn compaction_item(summary: &str) -> Value {
    json!({"id": format!("cmp_{}", ids::token()), "type": "compaction",
        "encrypted_content": super::compaction::seal(summary)})
}

/// A whole compaction answer: one compaction item.
pub fn compacted(answer: &Answer, model: &str) -> Value {
    let mut reply = Reply::new(model);
    reply.output.push(compaction_item(&answer.text));
    let mut response = reply.response("completed");
    response["usage"] = usage_json(&answer.usage);
    response
}

/// A whole answer as one response.
pub fn whole(answer: &Answer, model: &str) -> Value {
    let mut reply = Reply::new(model);
    let mut sink = Vec::new();
    // Run the answer through the stream encoder and keep its final shape.
    reply.started = true;
    if !answer.reasoning.is_empty() {
        reply.event(&Event::Reasoning(answer.reasoning.clone()), &mut sink);
    }
    if !answer.text.is_empty() {
        reply.event(&Event::Text(answer.text.clone()), &mut sink);
    }
    for call in &answer.calls {
        reply.event(&Event::Call(call.clone()), &mut sink);
    }
    reply.close(&mut sink);
    let mut response = reply.response("completed");
    response["usage"] = usage_json(&answer.usage);
    if answer.stop() == Stop::Length {
        response["status"] = json!("incomplete");
        response["incomplete_details"] = json!({"reason": "max_output_tokens"});
    }
    response
}

fn usage_json(usage: &Usage) -> Value {
    let input = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    json!({
        "input_tokens": input,
        "input_tokens_details": {"cached_tokens": usage.cache_read_tokens},
        "output_tokens": usage.output_tokens,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": input + usage.output_tokens,
    })
}

fn error_json(failure: &Failure) -> Value {
    let code = match failure.status {
        429 => "rate_limit_exceeded",
        503 | 529 => "server_is_overloaded",
        400 => "invalid_request_error",
        _ => "server_error",
    };
    json!({"code": code, "message": failure.message})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(out: &[u8]) -> Vec<Value> {
        std::str::from_utf8(out)
            .unwrap()
            .split("\n\n")
            .filter(|f| !f.is_empty())
            .map(|f| {
                let data = f.lines().find_map(|l| l.strip_prefix("data: ")).unwrap();
                serde_json::from_str(data).unwrap()
            })
            .collect()
    }

    #[test]
    fn streams_items_codex_can_rebuild() {
        let mut reply = Reply::new("grok-4");
        let mut out = Vec::new();
        for event in [
            Event::Reasoning("Thinking".into()),
            Event::Text("Patching.".into()),
            Event::Call(Call {
                id: "call_7".into(),
                name: "apply_patch".into(),
                input: "*** Begin Patch".into(),
                kind: ToolKind::Freeform,
            }),
            Event::Done {
                stop: Stop::ToolUse,
                usage: Usage {
                    input_tokens: 10,
                    cache_read_tokens: 30,
                    output_tokens: 5,
                    ..Usage::default()
                },
            },
        ] {
            reply.event(&event, &mut out);
        }
        let events = events(&out);
        let done: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == "response.output_item.done")
            .map(|e| &e["item"])
            .collect();
        let types: Vec<&str> = done.iter().map(|i| i["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["reasoning", "message", "custom_tool_call"]);
        assert_eq!(done[1]["content"][0]["text"], "Patching.");
        assert_eq!(done[2]["input"], "*** Begin Patch");
        assert_eq!(done[2]["call_id"], "call_7");
        let completed = events.last().unwrap();
        assert_eq!(completed["type"], "response.completed");
        assert_eq!(completed["response"]["usage"]["input_tokens"], 40);
        assert_eq!(completed["response"]["usage"]["total_tokens"], 45);
        assert_eq!(completed["response"]["output"].as_array().unwrap().len(), 3);
        // Sequence numbers count up from zero.
        let numbers: Vec<u64> = events
            .iter()
            .map(|e| e["sequence_number"].as_u64().unwrap())
            .collect();
        assert_eq!(numbers, (0..events.len() as u64).collect::<Vec<_>>());
    }

    #[test]
    fn failures_fail_the_response() {
        let mut reply = Reply::new("m");
        let mut out = Vec::new();
        reply.event(
            &Event::Error(Failure {
                status: 429,
                message: "slow down".into(),
            }),
            &mut out,
        );
        let last = events(&out).pop().unwrap();
        assert_eq!(last["type"], "response.failed");
        assert_eq!(last["response"]["error"]["code"], "rate_limit_exceeded");
    }

    #[test]
    fn whole_responses() {
        let answer = Answer {
            text: "Hello".into(),
            ..Answer::default()
        };
        let response = whole(&answer, "m");
        assert_eq!(response["object"], "response");
        assert_eq!(response["output"][0]["content"][0]["text"], "Hello");
        assert_eq!(response["status"], "completed");
    }
}
