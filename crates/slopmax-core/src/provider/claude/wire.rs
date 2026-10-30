//! Claude upstream adaptation.
//!
//! Claude Code's requests are forwarded as it sent them. The only change is
//! the credential: the account's bearer token replaces the slopmax key, and
//! the `oauth-2025-04-20` beta flag that OAuth tokens require is added. The
//! body, including the billing header and `metadata.user_id`, is untouched.

use http::{HeaderMap, HeaderName, HeaderValue};

use super::oauth::OAUTH_BETA;

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
    let mut headers = crate::proxy::forwardable(client);
    let beta = with_oauth_beta(client.get("anthropic-beta").and_then(|v| v.to_str().ok()));
    insert(&mut headers, "anthropic-beta", &beta);
    insert(
        &mut headers,
        "authorization",
        &format!("Bearer {access_token}"),
    );
    headers
}

/// Claude Code's user agent, like `claude-cli/2.1.291 (external, cli)`, if
/// it sent the request.
pub fn client_agent(headers: &HeaderMap) -> Option<&str> {
    let agent = headers.get("user-agent")?.to_str().ok()?;
    (agent.starts_with("claude-cli/") && agent.len() <= 200).then_some(agent)
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
    fn claude_code_is_known_by_its_agent() {
        let mut headers = HeaderMap::new();
        assert_eq!(client_agent(&headers), None);
        headers.insert(
            "user-agent",
            HeaderValue::from_static("claude-cli/2.1.291 (external, cli)"),
        );
        assert_eq!(
            client_agent(&headers),
            Some("claude-cli/2.1.291 (external, cli)")
        );
        headers.insert("user-agent", HeaderValue::from_static("curl/8.7.1"));
        assert_eq!(client_agent(&headers), None);
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
