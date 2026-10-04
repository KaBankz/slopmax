//! OpenAI Chat Completions.

use serde_json::{Value, json};

use super::Outcome;

/// Clients read `retry-after`; the code names the cause.
pub fn limit_reached(message: &str) -> Value {
    json!({ "error": {
        "type": "rate_limit_error",
        "code": "rate_limit_exceeded",
        "message": message,
    } })
}

/// A whole `chat.completion`, or the stream chunk that carries usage (the
/// last one, when the client asked for `stream_options.include_usage`).
pub fn observe(event: &Value, outcome: &mut Outcome) {
    let Some(usage) = event.get("usage").filter(|u| u.is_object()) else {
        return;
    };
    let number = |path: &str| usage.pointer(path).and_then(Value::as_u64).unwrap_or(0);
    let cached = number("/prompt_tokens_details/cached_tokens");
    let total = &mut outcome.usage;
    // Cached tokens are counted inside prompt_tokens.
    total.input_tokens = number("/prompt_tokens").saturating_sub(cached);
    total.cache_read_tokens = cached;
    total.output_tokens = number("/completion_tokens");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_comes_from_the_final_chunk() {
        let mut outcome = Outcome::default();
        observe(
            &json!({"object": "chat.completion.chunk", "choices": [], "usage": null}),
            &mut outcome,
        );
        assert_eq!(outcome.usage.output_tokens, 0);
        observe(
            &json!({"object": "chat.completion.chunk", "choices": [], "usage": {
                "prompt_tokens": 120, "completion_tokens": 30,
                "prompt_tokens_details": {"cached_tokens": 100}
            }}),
            &mut outcome,
        );
        let usage = outcome.usage;
        assert_eq!(
            (
                usage.input_tokens,
                usage.cache_read_tokens,
                usage.output_tokens
            ),
            (20, 100, 30)
        );
    }
}
