//! Messages requests, decoded for a model that speaks another format.

use serde_json::Value;

use crate::ir::{
    Call, Effort, Media, Message, Part, Request, Role, Source, Tool, ToolChoice, ToolKind,
    ToolResult,
};

/// Claude Code's billing line, which only Anthropic reads.
const BILLING: &str = "x-anthropic-billing-header:";

pub fn decode(body: &Value) -> Result<Request, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or("the request names no model")?;
    let mut request = Request {
        model: model.to_owned(),
        stream: body.get("stream").and_then(Value::as_bool) == Some(true),
        max_tokens: body.get("max_tokens").and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        ..Request::default()
    };
    let mut system = |text: &str| {
        if !text.trim().is_empty() && !text.starts_with(BILLING) {
            request.system.push(text.to_owned());
        }
    };
    match body.get("system") {
        Some(Value::String(text)) => system(text),
        Some(Value::Array(blocks)) => {
            for text in blocks.iter().filter_map(|b| b.get("text")?.as_str()) {
                system(text);
            }
        }
        _ => {}
    }
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let role = match message.get("role").and_then(Value::as_str) {
            Some("assistant") => Role::Assistant,
            _ => Role::User,
        };
        let parts = match message.get("content") {
            Some(Value::String(text)) => vec![Part::Text(text.clone())],
            Some(Value::Array(blocks)) => blocks.iter().filter_map(part).collect(),
            _ => Vec::new(),
        };
        if !parts.is_empty() {
            request.messages.push(Message { role, parts });
        }
    }
    // Client tools carry a schema; Anthropic's server tools (web search,
    // code execution) only work on Anthropic and are left out.
    request.tools = body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(tool)
        .collect();
    // Claude Code adds tools mid-conversation with `tool_addition` blocks,
    // which other APIs have no place for: they join the tools up front. A
    // `tool_reference` names one already there (a deferred tool, which is
    // sent anyway), and removed tools stay, as earlier turns call them.
    let added = body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("content")?.as_array())
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_addition"))
        .filter_map(|b| b.get("tool"))
        .filter(|t| t.get("type").and_then(Value::as_str) == Some("tool_definition"))
        .filter_map(|t| tool(t.get("definition")?));
    for added in added {
        if !request.tools.iter().any(|t| t.name == added.name) {
            request.tools.push(added);
        }
    }
    if let Some(choice) = body.get("tool_choice") {
        request.tool_choice = match choice.get("type").and_then(Value::as_str) {
            Some("any") => ToolChoice::Required,
            Some("none") => ToolChoice::None,
            Some("tool") => ToolChoice::Named(str_of(choice, "name")),
            _ => ToolChoice::Auto,
        };
        if choice
            .get("disable_parallel_tool_use")
            .and_then(Value::as_bool)
            == Some(true)
        {
            request.parallel_tool_calls = Some(false);
        }
    }
    request.stop = body
        .get("stop_sequences")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    request.effort = effort(body);
    Ok(request)
}

/// The effort asked for: named outright, or implied by a thinking budget.
fn effort(body: &Value) -> Option<Effort> {
    if let Some(named) = body
        .pointer("/output_config/effort")
        .and_then(Value::as_str)
        .and_then(Effort::parse)
    {
        return Some(named);
    }
    let thinking = body.get("thinking")?;
    match thinking.get("type").and_then(Value::as_str)? {
        "enabled" => Some(Effort::from_budget(
            thinking.get("budget_tokens").and_then(Value::as_u64)?,
        )),
        "disabled" => Some(Effort::Low),
        _ => None,
    }
}

/// A client tool: a name and an input schema.
fn tool(definition: &Value) -> Option<Tool> {
    Some(Tool {
        name: definition.get("name")?.as_str()?.to_owned(),
        description: str_of(definition, "description"),
        schema: definition.get("input_schema")?.clone(),
        kind: ToolKind::Function,
    })
}

fn part(block: &Value) -> Option<Part> {
    match block.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = block.get("text").and_then(Value::as_str)?;
            (!text.is_empty()).then(|| Part::Text(text.to_owned()))
        }
        "image" => media(block).map(Part::Image),
        "document" => {
            let source = block.get("source")?;
            // A plain-text document is just text.
            if source.get("type").and_then(Value::as_str) == Some("text") {
                return source
                    .get("data")
                    .and_then(Value::as_str)
                    .map(|text| Part::Text(text.to_owned()));
            }
            let mut file = media(block)?;
            file.name = block
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some(Part::File(file))
        }
        "tool_use" => Some(Part::Call(Call {
            id: str_of(block, "id"),
            name: str_of(block, "name"),
            input: block
                .get("input")
                .map_or_else(|| "{}".to_owned(), Value::to_string),
            kind: ToolKind::Function,
        })),
        "tool_result" => {
            let content = match block.get("content") {
                Some(Value::String(text)) => vec![Part::Text(text.clone())],
                Some(Value::Array(parts)) => parts.iter().filter_map(part).collect(),
                _ => Vec::new(),
            };
            Some(Part::Result(ToolResult {
                id: str_of(block, "tool_use_id"),
                content,
                is_error: block.get("is_error").and_then(Value::as_bool) == Some(true),
            }))
        }
        // Thinking carries Anthropic's signature, which no one else can
        // read; server tool blocks only make sense on Anthropic.
        _ => None,
    }
}

fn media(block: &Value) -> Option<Media> {
    let source = block.get("source")?;
    let media_type = str_of(source, "media_type");
    let source = match source.get("type").and_then(Value::as_str)? {
        "base64" => Source::Base64(str_of(source, "data")),
        "url" => Source::Url(str_of(source, "url")),
        _ => return None,
    };
    Some(Media {
        media_type,
        source,
        name: None,
    })
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
    use serde_json::json;

    #[test]
    fn decodes_a_claude_code_turn() {
        let body = json!({
            "model": "gpt-6-sol",
            "max_tokens": 32000,
            "stream": true,
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.287; cc_entrypoint=cli;"},
                {"type": "text", "text": "You are Claude Code.", "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [
                {"role": "user", "content": "list files"},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                    {"type": "text", "text": "Running ls."},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": "a.rs"}]},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBOR"}}
                ]}
            ],
            "tools": [
                {"name": "Bash", "description": "Run a command", "input_schema": {"type": "object"}},
                {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}
            ],
            "tool_choice": {"type": "auto", "disable_parallel_tool_use": true},
            "thinking": {"type": "enabled", "budget_tokens": 31999}
        });
        let request = decode(&body).unwrap();
        assert_eq!(request.model, "gpt-6-sol");
        assert_eq!(request.system, ["You are Claude Code."]);
        assert_eq!(request.max_tokens, Some(32000));
        assert!(request.stream);
        assert_eq!(request.effort, Some(Effort::High));
        assert_eq!(request.parallel_tool_calls, Some(false));
        assert_eq!(request.tools.len(), 1, "server tools stay behind");
        assert_eq!(request.messages.len(), 3);
        assert_eq!(
            request.messages[1].parts,
            [
                Part::Text("Running ls.".into()),
                Part::Call(Call {
                    id: "toolu_1".into(),
                    name: "Bash".into(),
                    input: r#"{"command":"ls"}"#.into(),
                    kind: ToolKind::Function,
                }),
            ]
        );
        let Part::Result(result) = &request.messages[2].parts[0] else {
            panic!("expected a tool result");
        };
        assert_eq!(
            (result.id.as_str(), result.text()),
            ("toolu_1", "a.rs".into())
        );
        assert!(
            matches!(&request.messages[2].parts[1], Part::Image(m) if m.url() == "data:image/png;base64,iVBOR")
        );
    }

    #[test]
    fn tools_added_mid_conversation_join_the_tools() {
        let body = json!({
            "model": "gpt-6-sol",
            "messages": [
                {"role": "user", "content": "go"},
                {"role": "system", "content": [
                    {"type": "text", "text": "<system-reminder>SubagentHandback is now available.</system-reminder>"},
                    {"type": "tool_addition", "tool": {"type": "tool_definition", "definition": {
                        "name": "SubagentHandback", "description": "Hand back",
                        "input_schema": {"type": "object", "properties": {"report": {"type": "string"}}}}}},
                    {"type": "tool_addition", "tool": {"type": "tool_reference", "name": "Bash"}}
                ]},
                {"role": "system", "content": [
                    {"type": "tool_addition", "tool": {"type": "tool_definition", "definition": {
                        "name": "Bash", "input_schema": {"type": "object"}}}},
                    {"type": "tool_removal", "tool": {"type": "tool_reference", "name": "Bash"}}
                ]}
            ],
            "tools": [{"name": "Bash", "description": "Run a command", "input_schema": {"type": "object"}, "defer_loading": true}]
        });
        let request = decode(&body).unwrap();
        let names: Vec<&str> = request.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["Bash", "SubagentHandback"]);
        assert_eq!(request.tools[0].description, "Run a command");
        assert_eq!(
            request.tools[1].schema["properties"]["report"]["type"],
            "string"
        );
        assert_eq!(request.messages.len(), 2, "the reminder text is kept");
    }

    #[test]
    fn named_effort_wins_over_a_budget() {
        let body = json!({"model": "m", "messages": [], "thinking": {"type": "adaptive"}, "output_config": {"effort": "max"}});
        assert_eq!(decode(&body).unwrap().effort, Some(Effort::Max));
        let adaptive = json!({"model": "m", "messages": [], "thinking": {"type": "adaptive"}});
        assert_eq!(decode(&adaptive).unwrap().effort, None);
        assert!(decode(&json!({"messages": []})).is_err());
    }
}
