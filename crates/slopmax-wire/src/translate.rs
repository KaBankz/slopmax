//! Translation between formats, through [`ir`](super::ir).
//!
//! Requests are decoded from the client's format and encoded into the
//! upstream's; answers are decoded from the upstream's events and encoded
//! for the client. Anything translates into Responses or Chat. Nothing
//! translates into Messages: slopmax never sends Anthropic a request a
//! client did not write.

use std::collections::HashSet;

use serde_json::Value;

use super::ir::{Answer, Event, Message, Part, Request, Role, ToolChoice, ToolKind};
use super::{Dialect, chat, messages, responses};

/// Whether an API speaking `upstream` can serve a client speaking `client`
/// by translation.
pub fn can_translate(client: Dialect, upstream: Dialect) -> bool {
    client != upstream && upstream != Dialect::Messages
}

/// Where a translated request goes, under the API's base URL.
pub fn path(upstream: Dialect) -> &'static str {
    match upstream {
        Dialect::Messages => "/v1/messages",
        Dialect::Responses => "/responses",
        Dialect::Chat => "/chat/completions",
    }
}

/// Reads a client's request.
pub fn decode(client: Dialect, body: &[u8]) -> Result<Request, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| format!("the request is not valid JSON: {e}"))?;
    match client {
        Dialect::Messages => messages::request::decode(&value),
        Dialect::Responses => responses::request::decode(&value),
        Dialect::Chat => chat::request::decode(&value),
    }
}

/// Writes a request for an upstream; see [`can_translate`]. A request to
/// compact asks the model for a summary of the conversation instead.
pub fn encode(upstream: Dialect, request: &Request) -> Value {
    let compacting;
    let request = if request.compact {
        let mut summary = request.clone();
        summary.messages.push(Message {
            role: Role::User,
            parts: vec![Part::Text(responses::compaction::PROMPT.to_owned())],
        });
        summary.tool_choice = ToolChoice::None;
        compacting = summary;
        &compacting
    } else {
        request
    };
    match upstream {
        Dialect::Responses => responses::request::encode(request),
        Dialect::Chat => chat::request::encode(request),
        Dialect::Messages => unreachable!("Messages is never a translation target"),
    }
}

/// Reads an upstream's answer.
#[derive(Debug)]
pub enum Decoder {
    Responses(responses::events::Events),
    Chat(chat::events::Events),
}

impl Decoder {
    pub fn new(upstream: Dialect, request: &Request) -> Self {
        match upstream {
            Dialect::Chat => {
                let freeform: HashSet<String> = request
                    .tools
                    .iter()
                    .filter(|t| t.kind == ToolKind::Freeform)
                    .map(|t| t.name.clone())
                    .collect();
                Self::Chat(chat::events::Events::new(freeform))
            }
            Dialect::Responses | Dialect::Messages => {
                Self::Responses(responses::events::Events::new())
            }
        }
    }

    /// Reads one server-sent event's data.
    pub fn data(&mut self, data: &[u8], out: &mut Vec<Event>) {
        let data = data.trim_ascii();
        if data == b"[DONE]" {
            self.finish(out);
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(data) else {
            return;
        };
        match self {
            Self::Responses(events) => events.feed(&value, out),
            Self::Chat(events) => events.feed(&value, out),
        }
    }

    /// Reads an answer that came as one JSON document instead of a stream.
    pub fn whole(&mut self, body: &[u8], out: &mut Vec<Event>) {
        let Ok(value) = serde_json::from_slice::<Value>(body) else {
            self.finish(out);
            return;
        };
        match self {
            Self::Responses(_) => out.extend(responses::events::whole(&value)),
            Self::Chat(events) => {
                events.feed(&value, out);
                events.finish(out);
            }
        }
    }

    /// Called when the upstream body ends.
    pub fn finish(&mut self, out: &mut Vec<Event>) {
        match self {
            Self::Responses(events) => events.finish(out),
            Self::Chat(events) => events.finish(out),
        }
    }
}

/// Writes an answer in the client's format as it streams.
#[derive(Debug)]
pub enum Encoder {
    Messages(messages::reply::Reply),
    Responses(responses::reply::Reply),
    Chat(chat::reply::Reply),
}

impl Encoder {
    /// `model` is the name the client asked for; `include_usage` is a Chat
    /// client's request for a usage chunk.
    pub fn new(client: Dialect, model: &str, include_usage: bool) -> Self {
        match client {
            Dialect::Messages => Self::Messages(messages::reply::Reply::new(model)),
            Dialect::Responses => Self::Responses(responses::reply::Reply::new(model)),
            Dialect::Chat => Self::Chat(chat::reply::Reply::new(model, include_usage)),
        }
    }

    /// An encoder for the answer to `request`, which a compaction answer
    /// turns into one compaction item.
    pub fn for_request(
        client: Dialect,
        request: &Request,
        model: &str,
        include_usage: bool,
    ) -> Self {
        match client {
            Dialect::Responses if request.compact => {
                Self::Responses(responses::reply::Reply::compacting(model))
            }
            _ => Self::new(client, model, include_usage),
        }
    }

    pub fn event(&mut self, event: &Event, out: &mut Vec<u8>) {
        match self {
            Self::Messages(reply) => reply.event(event, out),
            Self::Responses(reply) => reply.event(event, out),
            Self::Chat(reply) => reply.event(event, out),
        }
    }
}

/// A whole answer to `request` in the client's format.
pub fn whole(client: Dialect, request: &Request, answer: &Answer, model: &str) -> Value {
    match client {
        Dialect::Messages => messages::reply::whole(answer, model),
        Dialect::Responses if request.compact => responses::reply::compacted(answer, model),
        Dialect::Responses => responses::reply::whole(answer, model),
        Dialect::Chat => chat::reply::whole(answer, model),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Stop;

    /// Claude Code's request, translated for ChatGPT, answered with a tool
    /// call, and told back to Claude Code.
    #[test]
    fn claude_code_through_responses_and_back() {
        let body = br#"{"model":"gpt-6-sol","max_tokens":1000,"stream":true,
            "system":"You are Claude Code.",
            "messages":[{"role":"user","content":"list files"}],
            "tools":[{"name":"Bash","description":"Run","input_schema":{"type":"object"}}]}"#;
        let request = decode(Dialect::Messages, body).unwrap();
        let upstream = encode(Dialect::Responses, &request);
        assert_eq!(upstream["instructions"], "You are Claude Code.");
        assert_eq!(upstream["input"][0]["content"][0]["text"], "list files");
        assert_eq!(upstream["tools"][0]["name"], "Bash");

        let mut decoder = Decoder::new(Dialect::Responses, &request);
        let mut events = Vec::new();
        for data in [
            r#"{"type":"response.created","response":{"id":"r"}}"#,
            r#"{"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"Bash","arguments":"{\"command\":\"ls\"}"}}"#,
            r#"{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}"#,
        ] {
            decoder.data(data.as_bytes(), &mut events);
        }
        let mut encoder = Encoder::new(Dialect::Messages, "gpt-6-sol", false);
        let mut out = Vec::new();
        for event in &events {
            encoder.event(event, &mut out);
        }
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains(r#""type":"tool_use","id":"call_9","name":"Bash""#),
            "{text}"
        );
        assert!(text.contains(r#""stop_reason":"tool_use""#), "{text}");

        let answer = Answer::collect(events);
        assert_eq!(answer.stop(), Stop::ToolUse);
        let message = whole(Dialect::Messages, &request, &answer, "gpt-6-sol");
        assert_eq!(message["content"][0]["input"]["command"], "ls");
    }

    /// Codex's freeform `apply_patch`, through a Chat-only provider and
    /// back as a freeform call.
    #[test]
    fn freeform_tools_survive_chat() {
        let body = br#"{"model":"grok-4","instructions":"x","input":"patch it",
            "tools":[{"type":"custom","name":"apply_patch","description":"Patch"}],"stream":true}"#;
        let request = decode(Dialect::Responses, body).unwrap();
        let upstream = encode(Dialect::Chat, &request);
        assert_eq!(upstream["tools"][0]["function"]["name"], "apply_patch");

        let mut decoder = Decoder::new(Dialect::Chat, &request);
        let mut events = Vec::new();
        for data in [
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"apply_patch","arguments":"{\"input\":\"*** Begin Patch\"}"}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            "[DONE]",
        ] {
            decoder.data(data.as_bytes(), &mut events);
        }
        let mut encoder = Encoder::new(Dialect::Responses, "grok-4", false);
        let mut out = Vec::new();
        for event in &events {
            encoder.event(event, &mut out);
        }
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#""type":"custom_tool_call""#), "{text}");
        assert!(text.contains(r#""input":"*** Begin Patch""#), "{text}");
        assert!(text.contains("response.completed"), "{text}");
    }

    #[test]
    fn nothing_translates_into_messages() {
        assert!(can_translate(Dialect::Messages, Dialect::Responses));
        assert!(can_translate(Dialect::Chat, Dialect::Responses));
        assert!(can_translate(Dialect::Responses, Dialect::Chat));
        assert!(!can_translate(Dialect::Chat, Dialect::Messages));
        assert!(!can_translate(Dialect::Chat, Dialect::Chat));
    }

    /// Codex compacting a conversation on a Chat-only model: the model is
    /// asked for a summary, which comes back sealed in a compaction item and
    /// opens into the next request's history.
    #[test]
    fn compaction_is_emulated_with_a_summary() {
        let body = br#"{"model":"grok-4","instructions":"x","stream":true,
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"fix a.rs"}]},
                     {"type":"compaction_trigger"}]}"#;
        let request = decode(Dialect::Responses, body).unwrap();
        assert!(request.compact);
        let upstream = encode(Dialect::Chat, &request);
        let last = upstream["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert!(last["content"].as_str().unwrap().starts_with("Summarize"));

        let mut encoder = Encoder::for_request(Dialect::Responses, &request, "grok-4", false);
        let mut out = Vec::new();
        for event in [
            Event::Text("Fixed a.rs; ".into()),
            Event::Text("tests pass.".into()),
            Event::Done {
                stop: crate::ir::Stop::End,
                usage: Default::default(),
            },
        ] {
            encoder.event(&event, &mut out);
        }
        let text = String::from_utf8(out).unwrap();
        let sealed = text
            .split("\"encrypted_content\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap();
        assert!(!text.contains("output_text"), "{text}");

        let next = format!(
            r#"{{"model":"grok-4","input":[{{"type":"compaction","encrypted_content":"{sealed}"}},
                {{"type":"message","role":"user","content":[{{"type":"input_text","text":"go on"}}]}}]}}"#
        );
        let request = decode(Dialect::Responses, next.as_bytes()).unwrap();
        let Part::Text(summary) = &request.messages[0].parts[0] else {
            panic!("expected the summary first");
        };
        assert!(summary.ends_with("Fixed a.rs; tests pass."), "{summary}");
    }
}
