//! Chat Completions requests: decoded from a client, and encoded for an
//! upstream that speaks Chat (xAI, local servers, most gateways).

use serde_json::{Map, Value, json};

use crate::wire::ir::{
    Call, Effort, Format, Media, Message, Part, Request, Role, Tool, ToolChoice, ToolKind,
    ToolResult, text_of,
};
use crate::wire::responses::freeform_schema;

pub fn decode(body: &Value) -> Result<Request, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or("the request names no model")?;
    let mut request = Request {
        model: model.to_owned(),
        stream: body.get("stream").and_then(Value::as_bool) == Some(true),
        max_tokens: body
            .get("max_completion_tokens")
            .or_else(|| body.get("max_tokens"))
            .and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        parallel_tool_calls: body.get("parallel_tool_calls").and_then(Value::as_bool),
        effort: body
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .and_then(Effort::parse),
        cache_key: body
            .get("prompt_cache_key")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..Request::default()
    };
    request.stop = match body.get("stop") {
        Some(Value::String(stop)) => vec![stop.clone()],
        Some(Value::Array(stops)) => stops
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let content = message.get("content").unwrap_or(&Value::Null);
        match message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
        {
            "system" | "developer" => {
                let text = text_of(content);
                if !text.trim().is_empty() {
                    request.system.push(text);
                }
            }
            "assistant" => {
                let mut parts = parts(content);
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    parts.push(Part::Call(Call {
                        id: str_of(call, "id"),
                        name: call
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        input: call
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}")
                            .to_owned(),
                        kind: ToolKind::Function,
                    }));
                }
                push(&mut request, Role::Assistant, parts);
            }
            "tool" => {
                let result = ToolResult {
                    id: str_of(message, "tool_call_id"),
                    content: parts(content),
                    is_error: false,
                };
                // Consecutive results answer one turn.
                match request.messages.last_mut() {
                    Some(last)
                        if last.role == Role::User
                            && last.parts.iter().all(|p| matches!(p, Part::Result(_))) =>
                    {
                        last.parts.push(Part::Result(result));
                    }
                    _ => push(&mut request, Role::User, vec![Part::Result(result)]),
                }
            }
            _ => push(&mut request, Role::User, parts(content)),
        }
    }
    for tool in body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(function) = tool.get("function") else {
            continue;
        };
        request.tools.push(Tool {
            name: str_of(function, "name"),
            description: str_of(function, "description"),
            schema: function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            kind: ToolKind::Function,
        });
    }
    request.tool_choice = match body.get("tool_choice") {
        Some(Value::String(choice)) => match choice.as_str() {
            "none" => ToolChoice::None,
            "required" => ToolChoice::Required,
            _ => ToolChoice::Auto,
        },
        Some(named) => match named.pointer("/function/name").and_then(Value::as_str) {
            Some(name) => ToolChoice::Named(name.to_owned()),
            None => ToolChoice::Auto,
        },
        None => ToolChoice::Auto,
    };
    if let Some(schema) = body.pointer("/response_format/json_schema") {
        request.format = Some(Format {
            name: str_of(schema, "name"),
            schema: schema.get("schema").cloned().unwrap_or(Value::Null),
            strict: schema.get("strict").and_then(Value::as_bool) == Some(true),
        });
    }
    Ok(request)
}

fn push(request: &mut Request, role: Role, parts: Vec<Part>) {
    if !parts.is_empty() {
        request.messages.push(Message { role, parts });
    }
}

fn parts(content: &Value) -> Vec<Part> {
    match content {
        Value::String(text) if !text.is_empty() => vec![Part::Text(text.clone())],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str)? {
                "text" => Some(Part::Text(part.get("text")?.as_str()?.to_owned())),
                "image_url" => {
                    let url = part.pointer("/image_url/url")?.as_str()?;
                    Some(Part::Image(Media::from_url(url)))
                }
                "file" => {
                    let data = part.pointer("/file/file_data")?.as_str()?;
                    let mut file = Media::from_url(data);
                    file.name = part
                        .pointer("/file/filename")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    Some(Part::File(file))
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The request in Chat form, streamed with usage.
pub fn encode(request: &Request) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(request.model));
    body.insert("messages".into(), Value::Array(messages(request)));
    body.insert("stream".into(), json!(true));
    body.insert("stream_options".into(), json!({"include_usage": true}));
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                let parameters = match tool.kind {
                    ToolKind::Function => tool.schema.clone(),
                    ToolKind::Freeform => freeform_schema(),
                };
                json!({"type": "function", "function": {"name": tool.name,
                    "description": tool.description, "parameters": parameters}})
            })
            .collect();
        body.insert("tools".into(), Value::Array(tools));
        body.insert(
            "tool_choice".into(),
            match &request.tool_choice {
                ToolChoice::Auto => json!("auto"),
                ToolChoice::None => json!("none"),
                ToolChoice::Required => json!("required"),
                ToolChoice::Named(name) => json!({"type": "function", "function": {"name": name}}),
            },
        );
        if let Some(parallel) = request.parallel_tool_calls {
            body.insert("parallel_tool_calls".into(), json!(parallel));
        }
    }
    if let Some(max) = request.max_tokens {
        body.insert("max_tokens".into(), json!(max));
    }
    if let Some(temperature) = request.temperature {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(top_p) = request.top_p {
        body.insert("top_p".into(), json!(top_p));
    }
    if !request.stop.is_empty() {
        body.insert("stop".into(), json!(request.stop));
    }
    if let Some(format) = &request.format {
        body.insert(
            "response_format".into(),
            json!({"type": "json_schema", "json_schema": {"name": format.name,
                "schema": format.schema, "strict": format.strict}}),
        );
    }
    Value::Object(body)
}

fn messages(request: &Request) -> Vec<Value> {
    let mut out = Vec::new();
    if !request.system.is_empty() {
        out.push(json!({"role": "system", "content": request.system.join("\n\n")}));
    }
    for message in &request.messages {
        match message.role {
            Role::Assistant => {
                let text: String = message
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::Text(text) => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let calls: Vec<Value> = message
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::Call(call) => Some(call),
                        _ => None,
                    })
                    .map(|call| {
                        let arguments = match call.kind {
                            ToolKind::Function => call.input.clone(),
                            ToolKind::Freeform => json!({"input": call.input}).to_string(),
                        };
                        json!({"id": call.id, "type": "function",
                            "function": {"name": call.name, "arguments": arguments}})
                    })
                    .collect();
                if text.is_empty() && calls.is_empty() {
                    continue;
                }
                let mut assistant = json!({"role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) }});
                if !calls.is_empty() {
                    assistant["tool_calls"] = Value::Array(calls);
                }
                out.push(assistant);
            }
            Role::User => {
                let mut content = Vec::new();
                // Images a tool returned go to the model with the next user turn.
                let mut images = Vec::new();
                for part in &message.parts {
                    match part {
                        Part::Result(result) => {
                            let mut text = result.text();
                            if result.is_error && !text.is_empty() {
                                text = format!("Error: {text}");
                            }
                            out.push(
                                json!({"role": "tool", "tool_call_id": result.id, "content": text}),
                            );
                            for part in &result.content {
                                if let Part::Image(image) = part {
                                    images.push(json!({"type": "image_url", "image_url": {"url": image.url()}}));
                                }
                            }
                        }
                        Part::Text(text) => content.push(json!({"type": "text", "text": text})),
                        Part::Image(image) => content
                            .push(json!({"type": "image_url", "image_url": {"url": image.url()}})),
                        Part::File(file) => content.push(json!({"type": "file", "file": {
                            "filename": file.name.clone().unwrap_or_else(|| "document.pdf".into()),
                            "file_data": file.url(),
                        }})),
                        Part::Call(_) | Part::Reasoning(_) => {}
                    }
                }
                let mut user = images;
                user.extend(content);
                match user.as_slice() {
                    [] => {}
                    // A lone text part reads best as a plain string.
                    [only] if only["type"] == "text" => {
                        out.push(json!({"role": "user", "content": only["text"]}));
                    }
                    _ => out.push(json!({"role": "user", "content": user})),
                }
            }
        }
    }
    out
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

    #[test]
    fn decodes_and_encodes_a_tool_loop() {
        let body = json!({
            "model": "grok-4",
            "messages": [
                {"role": "system", "content": "Be brief."},
                {"role": "user", "content": [{"type": "text", "text": "weather?"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j"}}]},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "weather", "arguments": "{\"city\":\"Oslo\"}"}},
                    {"id": "call_2", "type": "function", "function": {"name": "weather", "arguments": "{\"city\":\"Rome\"}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "rain"},
                {"role": "tool", "tool_call_id": "call_2", "content": "sun"}
            ],
            "tools": [{"type": "function", "function": {"name": "weather", "parameters": {"type": "object"}}}],
            "tool_choice": "required",
            "reasoning_effort": "low",
            "stop": "END",
            "stream": true,
            "stream_options": {"include_usage": true}
        });
        let request = decode(&body).unwrap();
        assert_eq!(request.system, ["Be brief."]);
        assert_eq!(request.tool_choice, ToolChoice::Required);
        assert_eq!(request.effort, Some(Effort::Low));
        assert_eq!(request.stop, ["END"]);
        assert_eq!(request.messages.len(), 3);
        assert_eq!(
            request.messages[2].parts.len(),
            2,
            "results answer one turn"
        );

        let out = encode(&request);
        let roles: Vec<&str> = out["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool", "tool"]);
        assert_eq!(out["messages"][2]["tool_calls"][1]["id"], "call_2");
        assert_eq!(out["messages"][2]["content"], Value::Null);
        assert_eq!(out["stream_options"]["include_usage"], true);
        assert_eq!(out["tool_choice"], "required");
        assert!(
            out.get("reasoning_effort").is_none(),
            "not every Chat API takes it"
        );
    }

    #[test]
    fn freeform_calls_travel_as_functions() {
        let request = Request {
            model: "m".into(),
            tools: vec![Tool {
                name: "apply_patch".into(),
                description: "Patch files".into(),
                schema: Value::Null,
                kind: ToolKind::Freeform,
            }],
            messages: vec![Message {
                role: Role::Assistant,
                parts: vec![Part::Call(Call {
                    id: "c".into(),
                    name: "apply_patch".into(),
                    input: "*** Begin Patch".into(),
                    kind: ToolKind::Freeform,
                })],
            }],
            ..Request::default()
        };
        let out = encode(&request);
        assert_eq!(
            out["tools"][0]["function"]["parameters"]["required"][0],
            "input"
        );
        let arguments = out["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap()["input"],
            "*** Begin Patch"
        );
    }
}
