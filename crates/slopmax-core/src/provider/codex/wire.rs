//! Codex upstream adaptation.
//!
//! Codex requests go to the ChatGPT backend with the account's bearer token
//! and workspace id. Encrypted reasoning in the conversation is bound to the
//! account that produced it, so it is dropped when a session changes
//! accounts; the readable summaries stay.

use http::header::{ACCEPT_ENCODING, AUTHORIZATION};
use http::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

const CHATGPT_ACCOUNT_ID: HeaderName = HeaderName::from_static("chatgpt-account-id");

/// Headers for the upstream request, with the account's `Authorization`
/// value ([`Account::bearer`]) and workspace id. `moved` drops the per-turn
/// routing token, which belongs to the previous account's backend session.
///
/// [`Account::bearer`]: crate::account::Account::bearer
pub fn upstream_headers(
    client: &HeaderMap,
    bearer: Option<HeaderValue>,
    account_id: Option<HeaderValue>,
    moved: bool,
) -> HeaderMap {
    let mut headers = crate::net::headers::forwardable(client);
    if let Some(bearer) = bearer {
        headers.insert(AUTHORIZATION, bearer);
    }
    if let Some(id) = account_id {
        headers.insert(CHATGPT_ACCOUNT_ID, id);
    }
    if moved {
        headers.remove("x-codex-turn-state");
    }
    // Uncompressed streams can be read for usage and in-stream refusals.
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    // Custom providers omit the `version` header the built-in one sends; the
    // backend gates some models on client version.
    if !headers.contains_key("version")
        && let Some(version) = client_version(client)
    {
        insert(&mut headers, "version", &version);
    }
    headers
}

/// Whether a request comes from Codex. Codex names itself in its user
/// agent (`codex_exec/…`, `codex_cli_rs/…`, `Codex Desktop/…`) unless the
/// app driving it renames it: T3 Code starts it as `T3 Code/…`. Every
/// model request it makes, over HTTP or a socket, carries its window id
/// either way.
pub fn from_codex(headers: &HeaderMap) -> bool {
    headers.contains_key("x-codex-window-id")
        || headers.contains_key("x-codex-turn-metadata")
        || user_agent(headers)
            .and_then(|agent| agent.split_once('/'))
            .is_some_and(|(product, _)| product.to_ascii_lowercase().starts_with("codex"))
}

fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers.get("user-agent")?.to_str().ok()
}

/// `0.159.3` from Codex's user agent, `codex_exec/0.159.3 (Linux; x86_64) …`
/// or under another app's name, `T3 Code/0.169.0 (Mac OS 26.1; arm64) …`.
pub fn client_version(headers: &HeaderMap) -> Option<String> {
    if !from_codex(headers) {
        return None;
    }
    let (_, rest) = user_agent(headers)?.split_once('/')?;
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
/// reasoning items and on replayed output (Codex's output token replay seals
/// messages and tool calls too, beside their readable content), and any
/// `previous_response_id`. A compaction item is nothing but its sealed
/// summary, so it is left as it is. Returns `None` when the body carries none.
pub fn strip_account_state(body: &[u8]) -> Option<Vec<u8>> {
    let mut json: Value = serde_json::from_slice(body).ok()?;
    let mut changed = json
        .as_object_mut()
        .and_then(|o| o.remove("previous_response_id"))
        .is_some();
    if let Some(items) = json.get_mut("input").and_then(Value::as_array_mut) {
        for item in items {
            let summary = matches!(
                item.get("type").and_then(Value::as_str),
                Some("compaction" | "context_compaction")
            );
            if let Some(fields) = item.as_object_mut().filter(|_| !summary) {
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
    fn codex_is_known_under_any_name() {
        for agent in [
            "codex_exec/0.169.0 (Linux; x86_64) unknown",
            "codex_cli_rs/0.169.0 (Mac OS 26.1; arm64) ghostty",
            "Codex Desktop/0.169.0 (Mac OS 26.1; arm64) unknown",
        ] {
            let request = headers(&[("user-agent", agent)]);
            assert!(from_codex(&request), "{agent}");
            assert_eq!(client_version(&request).as_deref(), Some("0.169.0"));
        }
        // T3 Code drives `codex app-server` under its own name.
        let t3 = headers(&[
            (
                "user-agent",
                "T3 Code/0.169.0 (Mac OS 26.1; arm64) unknown (t3-code; 0.1.10)",
            ),
            (
                "x-codex-window-id",
                "019a7c2e-0000-7000-8000-000000000000:0",
            ),
        ]);
        assert!(from_codex(&t3));
        assert_eq!(client_version(&t3).as_deref(), Some("0.169.0"));
        // Another client's version is not taken for Codex's.
        let other = headers(&[("user-agent", "OpenAI/Python 2.4.0")]);
        assert!(!from_codex(&other));
        assert_eq!(client_version(&other), None);
        assert!(!from_codex(&HeaderMap::new()));
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
        let bearer = HeaderValue::from_static("Bearer tok");
        let out = upstream_headers(
            &client,
            Some(bearer),
            Some(HeaderValue::from_static("ws-1")),
            true,
        );
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
    fn strips_replayed_output_but_keeps_compactions() {
        let body = br#"{"input":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}],"encrypted_content":"gAAA"},{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1","encrypted_content":"gBBB"},{"type":"compaction","encrypted_content":"gCCC"}]}"#;
        let out: Value = serde_json::from_slice(&strip_account_state(body).unwrap()).unwrap();
        assert!(out["input"][0].get("encrypted_content").is_none());
        assert_eq!(out["input"][0]["content"][0]["text"], "hi");
        assert!(out["input"][1].get("encrypted_content").is_none());
        assert_eq!(out["input"][1]["call_id"], "c1");
        assert_eq!(out["input"][2]["encrypted_content"], "gCCC");
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
