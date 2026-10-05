//! Responses requests: decoded from a client such as Codex, and encoded for
//! an upstream that speaks Responses (ChatGPT, the OpenAI API).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::ir::{
    Call, Effort, Format, Media, Message, Part, Reasoning, Request, Role, Tool, ToolChoice,
    ToolKind, ToolResult, text_of,
};

pub fn decode(body: &Value) -> Result<Request, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or("the request names no model")?;
    let mut request = Request {
        model: model.to_owned(),
        stream: body.get("stream").and_then(Value::as_bool) == Some(true),
        max_tokens: body.get("max_output_tokens").and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        parallel_tool_calls: body.get("parallel_tool_calls").and_then(Value::as_bool),
        effort: body
            .pointer("/reasoning/effort")
            .and_then(Value::as_str)
            .and_then(Effort::parse),
        cache_key: body
            .get("prompt_cache_key")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..Request::default()
    };
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str)
        && !instructions.trim().is_empty()
    {
        request.system.push(instructions.to_owned());
    }
    match body.get("input") {
        Some(Value::String(text)) => request.messages.push(Message {
            role: Role::User,
            parts: vec![Part::Text(text.clone())],
        }),
        Some(Value::Array(items)) => {
            for item in items {
                item_into(item, &mut request);
            }
        }
        _ => {}
    }
    for tool in body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = match tool.get("type").and_then(Value::as_str) {
            Some("function") => ToolKind::Function,
            Some("custom") => ToolKind::Freeform,
            // Hosted tools (web search, image generation) run at OpenAI.
            _ => continue,
        };
        request.tools.push(Tool {
            name: str_of(tool, "name"),
            description: str_of(tool, "description"),
            schema: tool
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            kind,
        });
    }
    request.tool_choice = match body.get("tool_choice") {
        Some(Value::String(choice)) => match choice.as_str() {
            "none" => ToolChoice::None,
            "required" => ToolChoice::Required,
            _ => ToolChoice::Auto,
        },
        Some(named) if named.get("name").is_some() => ToolChoice::Named(str_of(named, "name")),
        _ => ToolChoice::Auto,
    };
    if let Some(format) = body.pointer("/text/format")
        && format.get("type").and_then(Value::as_str) == Some("json_schema")
    {
        request.format = Some(Format {
            name: str_of(format, "name"),
            schema: format.get("schema").cloned().unwrap_or(Value::Null),
            strict: format.get("strict").and_then(Value::as_bool) == Some(true),
        });
    }
    Ok(request)
}

/// Adds one input item to the conversation, joining it to the message
/// before when they belong together (calls to the assistant's turn,
/// results to the user's).
fn item_into(item: &Value, request: &mut Request) {
    let push = |request: &mut Request, role: Role, part: Part| match request.messages.last_mut() {
        Some(last) if last.role == role && joins(&part, last) => last.parts.push(part),
        _ => request.messages.push(Message {
            role,
            parts: vec![part],
        }),
    };
    match item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message")
    {
        "message" => {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
            let content = item.get("content").unwrap_or(&Value::Null);
            if matches!(role, "system" | "developer") {
                let text = text_of(content);
                if !text.trim().is_empty() {
                    request.system.push(text);
                }
                return;
            }
            let role = if role == "assistant" {
                Role::Assistant
            } else {
                Role::User
            };
            let parts: Vec<Part> = match content {
                Value::String(text) => vec![Part::Text(text.clone())],
                Value::Array(parts) => parts.iter().filter_map(content_part).collect(),
                _ => Vec::new(),
            };
            for part in parts {
                push(request, role, part);
            }
        }
        "function_call" | "custom_tool_call" => {
            let freeform = item.get("type").and_then(Value::as_str) == Some("custom_tool_call");
            let call = Call {
                id: str_of(item, "call_id"),
                name: str_of(item, "name"),
                input: str_of(item, if freeform { "input" } else { "arguments" }),
                kind: if freeform {
                    ToolKind::Freeform
                } else {
                    ToolKind::Function
                },
            };
            push(request, Role::Assistant, Part::Call(call));
        }
        "function_call_output" | "custom_tool_call_output" => {
            let content = match item.get("output") {
                Some(Value::String(text)) => vec![Part::Text(text.clone())],
                Some(Value::Array(parts)) => parts.iter().filter_map(content_part).collect(),
                _ => Vec::new(),
            };
            let result = ToolResult {
                id: str_of(item, "call_id"),
                content,
                is_error: false,
            };
            push(request, Role::User, Part::Result(result));
        }
        // Codex asks for remote compaction by ending its input so.
        "compaction_trigger" => request.compact = true,
        // A summary slopmax wrote is read back as the conversation so far;
        // OpenAI's own is sealed and only OpenAI can expand it.
        "compaction" => {
            let summary = item
                .get("encrypted_content")
                .and_then(Value::as_str)
                .and_then(super::compaction::open);
            if let Some(summary) = summary {
                let text = format!("{}\n\n{summary}", super::compaction::PREFIX);
                push(request, Role::User, Part::Text(text));
            }
        }
        "reasoning" => {
            let summary: Vec<&str> = item
                .get("summary")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|s| s.get("text").and_then(Value::as_str))
                .collect();
            let reasoning = Reasoning {
                text: summary.join("\n\n"),
                opaque: item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            push(request, Role::Assistant, Part::Reasoning(reasoning));
        }
        // Hosted tool calls and other items only OpenAI can replay.
        _ => {}
    }
}

/// Whether `part` continues `message` rather than starting a new one: text
/// does not join a turn that already holds calls or results.
fn joins(part: &Part, message: &Message) -> bool {
    match part {
        Part::Call(_) | Part::Result(_) | Part::Reasoning(_) => true,
        _ => !message
            .parts
            .iter()
            .any(|p| matches!(p, Part::Call(_) | Part::Result(_))),
    }
}

fn content_part(part: &Value) -> Option<Part> {
    match part.get("type").and_then(Value::as_str)? {
        "input_text" | "output_text" | "text" => {
            let text = part.get("text").and_then(Value::as_str)?;
            (!text.is_empty()).then(|| Part::Text(text.to_owned()))
        }
        "refusal" => part
            .get("refusal")
            .and_then(Value::as_str)
            .map(|t| Part::Text(t.to_owned())),
        "input_image" => {
            let url = part.get("image_url").and_then(Value::as_str)?;
            Some(Part::Image(Media::from_url(url)))
        }
        "input_file" => {
            let data = part.get("file_data").and_then(Value::as_str)?;
            let mut file = Media::from_url(data);
            file.name = part
                .get("filename")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some(Part::File(file))
        }
        _ => None,
    }
}

/// The request in Responses form. Always streamed: some upstreams only
/// stream, and a client that wants one answer gets the stream collected.
pub fn encode(request: &Request) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("instructions".into(), json!(request.system.join("\n\n")));
    body.insert("input".into(), Value::Array(input(request)));
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request.tools.iter().map(tool).collect();
        body.insert("tools".into(), Value::Array(tools));
        body.insert("tool_choice".into(), tool_choice(&request.tool_choice));
        body.insert(
            "parallel_tool_calls".into(),
            json!(request.parallel_tool_calls.unwrap_or(true)),
        );
    }
    if let Some(effort) = request.effort {
        let effort = match effort {
            Effort::Minimal => "minimal",
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Max => "xhigh",
        };
        body.insert(
            "reasoning".into(),
            json!({"effort": effort, "summary": "auto"}),
        );
    }
    body.insert("store".into(), json!(false));
    body.insert("stream".into(), json!(true));
    body.insert("include".into(), json!(["reasoning.encrypted_content"]));
    if let Some(key) = &request.cache_key {
        body.insert("prompt_cache_key".into(), json!(key));
    }
    if let Some(format) = &request.format {
        body.insert(
            "text".into(),
            json!({"format": {"type": "json_schema", "name": format.name,
                "schema": format.schema, "strict": format.strict}}),
        );
    }
    if let Some(max) = request.max_tokens {
        body.insert("max_output_tokens".into(), json!(max));
    }
    Value::Object(body)
}

fn input(request: &Request) -> Vec<Value> {
    // Results answer calls of the same kind.
    let kinds: HashMap<&str, ToolKind> = request
        .messages
        .iter()
        .flat_map(|m| &m.parts)
        .filter_map(|p| match p {
            Part::Call(call) => Some((call.id.as_str(), call.kind)),
            _ => None,
        })
        .collect();
    let mut items = Vec::new();
    for message in &request.messages {
        let mut content = Vec::new();
        let mut images = Vec::new();
        let flush = |content: &mut Vec<Value>, items: &mut Vec<Value>| {
            if content.is_empty() {
                return;
            }
            let role = match message.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            items
                .push(json!({"type": "message", "role": role, "content": std::mem::take(content)}));
        };
        for part in &message.parts {
            match part {
                Part::Text(text) => content.push(match message.role {
                    Role::User => json!({"type": "input_text", "text": text}),
                    Role::Assistant => json!({"type": "output_text", "text": text}),
                }),
                Part::Image(image) => {
                    content.push(json!({"type": "input_image", "image_url": image.url()}));
                }
                Part::File(file) => content.push(json!({
                    "type": "input_file",
                    "filename": file.name.clone().unwrap_or_else(|| "document.pdf".into()),
                    "file_data": file.url(),
                })),
                Part::Call(call) => {
                    flush(&mut content, &mut items);
                    items.push(match call.kind {
                        ToolKind::Function => json!({"type": "function_call",
                            "call_id": call.id, "name": call.name, "arguments": call.input}),
                        ToolKind::Freeform => json!({"type": "custom_tool_call",
                            "call_id": call.id, "name": call.name, "input": call.input}),
                    });
                }
                Part::Result(result) => {
                    flush(&mut content, &mut items);
                    let mut output = result.text();
                    if result.is_error && !output.is_empty() {
                        output = format!("Error: {output}");
                    }
                    let kind = match kinds.get(result.id.as_str()) {
                        Some(ToolKind::Freeform) => "custom_tool_call_output",
                        _ => "function_call_output",
                    };
                    items.push(json!({"type": kind, "call_id": result.id, "output": output}));
                    for part in &result.content {
                        if let Part::Image(image) = part {
                            images.push(json!({"type": "input_image", "image_url": image.url()}));
                        }
                    }
                }
                // Only state this provider issued can be replayed.
                Part::Reasoning(reasoning) => {
                    if let Some(opaque) = &reasoning.opaque {
                        flush(&mut content, &mut items);
                        let summary: Vec<Value> = (!reasoning.text.is_empty())
                            .then(|| json!({"type": "summary_text", "text": reasoning.text}))
                            .into_iter()
                            .collect();
                        items.push(json!({"type": "reasoning", "summary": summary,
                            "encrypted_content": opaque}));
                    }
                }
            }
        }
        flush(&mut content, &mut items);
        // Images a tool returned follow its output as a user message.
        if !images.is_empty() {
            items.push(json!({"type": "message", "role": "user", "content": images}));
        }
    }
    items
}

fn tool(tool: &Tool) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": match tool.kind {
            ToolKind::Function => tool.schema.clone(),
            ToolKind::Freeform => freeform_schema(),
        },
        "strict": false,
    })
}

/// The arguments of a freeform tool lowered to a function.
pub fn freeform_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"input": {"type": "string", "description": "The tool's raw input."}},
        "required": ["input"],
    })
}

fn tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::None => json!("none"),
        ToolChoice::Required => json!("required"),
        ToolChoice::Named(name) => json!({"type": "function", "name": name}),
    }
}

fn str_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Source;

    fn codex_body() -> Value {
        json!({
            "model": "gpt-6-sol",
            "instructions": "You are Codex.",
            "input": [
                {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Sandbox: workspace-write"}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix it"}]},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Plan"}], "encrypted_content": "gAAA"},
                {"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{\"command\":[\"ls\"]}"},
                {"type": "function_call_output", "call_id": "c1", "output": "a.rs"},
                {"type": "custom_tool_call", "call_id": "c2", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "c2", "output": "Done"},
                {"type": "web_search_call", "id": "ws_1"}
            ],
            "tools": [
                {"type": "function", "name": "shell", "description": "Run", "parameters": {"type": "object"}},
                {"type": "custom", "name": "apply_patch", "description": "Patch", "format": {"type": "grammar"}},
                {"type": "web_search"}
            ],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "reasoning": {"effort": "high", "summary": "auto"},
            "store": false,
            "stream": true,
            "prompt_cache_key": "conv-1"
        })
    }

    #[test]
    fn decodes_codex_items_into_turns() {
        let request = decode(&codex_body()).unwrap();
        assert_eq!(
            request.system,
            ["You are Codex.", "Sandbox: workspace-write"]
        );
        assert_eq!(request.effort, Some(Effort::High));
        assert_eq!(request.cache_key.as_deref(), Some("conv-1"));
        assert_eq!(request.parallel_tool_calls, Some(false));
        let kinds: Vec<ToolKind> = request.tools.iter().map(|t| t.kind).collect();
        assert_eq!(kinds, [ToolKind::Function, ToolKind::Freeform]);
        let roles: Vec<Role> = request.messages.iter().map(|m| m.role).collect();
        assert_eq!(
            roles,
            [
                Role::User,
                Role::Assistant,
                Role::User,
                Role::Assistant,
                Role::User
            ]
        );
        assert!(
            matches!(&request.messages[1].parts[0], Part::Reasoning(r) if r.opaque.as_deref() == Some("gAAA"))
        );
        assert!(
            matches!(&request.messages[3].parts[0], Part::Call(c) if c.kind == ToolKind::Freeform)
        );
    }

    #[test]
    fn encodes_turns_as_items() {
        let mut request = decode(&codex_body()).unwrap();
        request.messages[0].parts.push(Part::Image(Media {
            media_type: "image/png".into(),
            source: Source::Base64("iVBOR".into()),
            name: None,
        }));
        let body = encode(&request);
        assert_eq!(
            body["instructions"],
            "You are Codex.\n\nSandbox: workspace-write"
        );
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["prompt_cache_key"], "conv-1");
        let types: Vec<&str> = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            types,
            [
                "message",
                "reasoning",
                "function_call",
                "function_call_output",
                "custom_tool_call",
                "custom_tool_call_output"
            ]
        );
        assert_eq!(
            body["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,iVBOR"
        );
        assert_eq!(body["tools"][1]["parameters"]["required"][0], "input");
        assert_eq!(body["parallel_tool_calls"], false);
    }

    #[test]
    fn foreign_reasoning_is_not_replayed() {
        let request = Request {
            model: "m".into(),
            messages: vec![Message {
                role: Role::Assistant,
                parts: vec![
                    Part::Reasoning(Reasoning {
                        text: "summary only".into(),
                        opaque: None,
                    }),
                    Part::Text("Hi".into()),
                ],
            }],
            ..Request::default()
        };
        let body = encode(&request);
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        assert_eq!(body["input"][0]["content"][0]["type"], "output_text");
    }
}
