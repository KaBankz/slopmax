//! Claude upstream adaptation.
//!
//! Claude Code's requests are forwarded as it sent them. The only change is
//! the credential: the account's bearer token replaces the slopmax key, and
//! the `oauth-2025-04-20` beta flag that OAuth tokens require is added. The
//! body, including the billing header and `metadata.user_id`, is untouched.

use http::{HeaderMap, HeaderName, HeaderValue};

use super::rawjson::{self, Seg};
use crate::auth::claude::OAUTH_BETA;

/// The conversation id Claude Code sends, used for session affinity.
pub fn session_id(headers: &HeaderMap, body: &[u8]) -> Option<String> {
    if let Some(id) = headers
        .get("x-claude-code-session-id")
        .and_then(|v| v.to_str().ok())
    {
        return Some(id.to_owned());
    }
    let user_id = rawjson::find_str(body, &[Seg::Key("metadata"), Seg::Key("user_id")])?;
    let inner = user_id.as_bytes();
    rawjson::find_str(inner, &[Seg::Key("session_id")]).or_else(|| {
        // Legacy form: user_<hash>_account_<uuid>_session_<uuid>.
        user_id.rsplit_once("_session_").map(|(_, s)| s.to_owned())
    })
}

/// The agent's beta list with the OAuth flag appended if missing.
fn with_oauth_beta(existing: Option<&str>) -> String {
    let mut betas: Vec<&str> = existing
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .collect();
    if !betas.contains(&OAUTH_BETA) {
        betas.push(OAUTH_BETA);
    }
    betas.join(",")
}

/// Headers for the upstream request: the agent's own headers, with the
/// account's token in place of the slopmax key.
pub fn upstream_headers(client: &HeaderMap, access_token: &str) -> HeaderMap {
    let mut headers = super::forwardable(client);
    let beta = with_oauth_beta(client.get("anthropic-beta").and_then(|v| v.to_str().ok()));
    insert(&mut headers, "anthropic-beta", &beta);
    insert(
        &mut headers,
        "authorization",
        &format!("Bearer {access_token}"),
    );
    headers
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_comes_from_header_then_metadata() {
        let mut headers = HeaderMap::new();
        let body = br#"{"metadata":{"user_id":"{\"session_id\":\"from-body\"}"}}"#;
        assert_eq!(session_id(&headers, body).as_deref(), Some("from-body"));
        headers.insert(
            "x-claude-code-session-id",
            HeaderValue::from_static("from-header"),
        );
        assert_eq!(session_id(&headers, body).as_deref(), Some("from-header"));
        let legacy = br#"{"metadata":{"user_id":"user_abc_account_def_session_s-1"}}"#;
        assert_eq!(
            session_id(&HeaderMap::new(), legacy).as_deref(),
            Some("s-1")
        );
    }

    #[test]
    fn oauth_beta_is_added_once() {
        assert_eq!(
            with_oauth_beta(Some(
                "claude-code-20250219, interleaved-thinking-2025-05-14"
            )),
            "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20"
        );
        assert_eq!(with_oauth_beta(None), "oauth-2025-04-20");
        assert_eq!(
            with_oauth_beta(Some("oauth-2025-04-20,x")),
            "oauth-2025-04-20,x"
        );
    }

    #[test]
    fn only_the_credential_changes() {
        let mut client = HeaderMap::new();
        client.insert("authorization", HeaderValue::from_static("Bearer sm-key"));
        client.insert(
            "user-agent",
            HeaderValue::from_static("claude-cli/2.1.287 (external, cli)"),
        );
        client.insert("accept-encoding", HeaderValue::from_static("gzip, br"));
        client.insert("x-app", HeaderValue::from_static("cli"));
        let out = upstream_headers(&client, "account-token");
        assert_eq!(out["authorization"], "Bearer account-token");
        assert_eq!(out["anthropic-beta"], "oauth-2025-04-20");
        assert_eq!(out["user-agent"], "claude-cli/2.1.287 (external, cli)");
        assert_eq!(out["accept-encoding"], "gzip, br");
        assert_eq!(out["x-app"], "cli");
        assert!(!out.contains_key("x-client-request-id"));
    }
}
