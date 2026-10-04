//! Codex upstream adaptation.
//!
//! Codex requests go to the ChatGPT backend with the account's bearer token
//! and workspace id. Encrypted reasoning in the conversation is bound to the
//! account that produced it, so it is dropped when a session changes
//! accounts; the readable summaries stay.

use http::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

/// Headers for the upstream request. `moved` drops the per-turn routing
/// token, which belongs to the previous account's backend session.
pub fn upstream_headers(
    client: &HeaderMap,
    access_token: &str,
    account_id: Option<&str>,
    moved: bool,
) -> HeaderMap {
    let mut headers = crate::proxy::forwardable(client);
    insert(
        &mut headers,
        "authorization",
        &format!("Bearer {access_token}"),
    );
    if let Some(id) = account_id {
        insert(&mut headers, "chatgpt-account-id", id);
    }
    if moved {
        headers.remove("x-codex-turn-state");
    }
    // Uncompressed streams can be read for usage and in-stream refusals.
    insert(&mut headers, "accept-encoding", "identity");
    // Custom providers omit the `version` header the built-in one sends; the
    // backend gates some models on client version.
    if !headers.contains_key("version")
        && let Some(version) = client_version(client)
    {
        insert(&mut headers, "version", &version);
    }
    headers
}

/// `0.159.3` from a user agent like `codex_exec/0.159.3 (Linux; x86_64) …`.
fn client_version(headers: &HeaderMap) -> Option<String> {
    let agent = headers.get("user-agent")?.to_str().ok()?;
    let (product, rest) = agent.split_once('/')?;
    if !product.starts_with("codex") {
        return None;
    }
    let version: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    (version.split('.').count() == 3).then_some(version)
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

/// Removes state bound to another account: `encrypted_content` on
/// reasoning items and any `previous_response_id`. Returns `None` when the
/// body carries none.
pub fn strip_account_state(body: &[u8]) -> Option<Vec<u8>> {
    let mut json: Value = serde_json::from_slice(body).ok()?;
    let mut changed = json
        .as_object_mut()
        .and_then(|o| o.remove("previous_response_id"))
        .is_some();
    if let Some(items) = json.get_mut("input").and_then(Value::as_array_mut) {
        for item in items {
            let is_reasoning = item.get("type").and_then(Value::as_str) == Some("reasoning");
            if let Some(fields) = item.as_object_mut().filter(|_| is_reasoning) {
                changed |= fields.remove("encrypted_content").is_some();
            }
        }
    }
    changed.then(|| serde_json::to_vec(&json).expect("values serialize"))
}

/// Whether a 400 says the request carried state minted by another account.
pub fn rejects_account_state(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("encrypted content")
        || text.contains("invalid_encrypted_content")
        || text.contains("not issued to this caller")
        || (text.contains("item with id") && text.contains("not found"))
}

/// Whether a 5xx body is really a spent quota (the backend sometimes
/// reports an exhausted window as a 502).
pub fn reports_usage_limit(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("usage_limit_reached") || text.contains("usage limit has been reached")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn upstream_headers_swap_credentials_and_add_version() {
        let client = headers(&[
            ("authorization", "Bearer sm-local"),
            (
                "user-agent",
                "codex_exec/0.159.3 (Amazon Linux; x86_64) unknown (codex_exec; 0.159.3)",
            ),
            ("x-codex-turn-state", "sticky"),
            ("session-id", "s"),
            ("host", "127.0.0.1:7567"),
        ]);
        let out = upstream_headers(&client, "tok", Some("ws-1"), true);
        assert_eq!(out["authorization"], "Bearer tok");
        assert_eq!(out["chatgpt-account-id"], "ws-1");
        assert_eq!(out["version"], "0.159.3");
        assert_eq!(out["session-id"], "s");
        assert!(!out.contains_key("x-codex-turn-state"));
        assert!(!out.contains_key("host"));
        assert_eq!(out["accept-encoding"], "identity");
    }

    #[test]
    fn strips_encrypted_reasoning_but_keeps_summaries() {
        let body = br#"{"model":"m","input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"s"}],"encrypted_content":"gAAA"},{"type":"message","role":"user","content":[]}],"stream":true}"#;
        let out: Value = serde_json::from_slice(&strip_account_state(body).unwrap()).unwrap();
        assert!(out["input"][0].get("encrypted_content").is_none());
        assert_eq!(out["input"][0]["summary"][0]["text"], "s");
        // Key order is preserved for the backend's routing fields.
        let keys: Vec<&str> = out
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["model", "input", "stream"]);
        assert!(strip_account_state(br#"{"input":[]}"#).is_none());
    }

    #[test]
    fn recognizes_account_state_rejections() {
        assert!(rejects_account_state(
            br#"{"error":{"code":"invalid_encrypted_content"}}"#
        ));
        assert!(rejects_account_state(
            b"reasoning `encrypted_content` was not issued to this caller"
        ));
        assert!(rejects_account_state(b"Item with id 'rs_123' not found."));
        assert!(!rejects_account_state(
            br#"{"error":{"code":"context_length_exceeded"}}"#
        ));
    }
}
