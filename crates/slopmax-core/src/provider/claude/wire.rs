//! Claude upstream adaptation.
//!
//! Claude Code's requests are forwarded as it sent them. The only change is
//! the credential: the account's bearer token replaces the slopmax key, and
//! the `oauth-2025-04-20` beta flag that OAuth tokens require is added. The
//! body, including the billing header and `metadata.user_id`, is untouched.

use http::header::AUTHORIZATION;
use http::{HeaderMap, HeaderName, HeaderValue};

use super::oauth::OAUTH_BETA;

const ANTHROPIC_BETA: HeaderName = HeaderName::from_static("anthropic-beta");

/// The agent's beta list with the OAuth flag appended if missing.
fn with_oauth_beta(existing: Option<&str>) -> String {
    let existing = existing.unwrap_or_default();
    let mut betas = String::with_capacity(existing.len() + 1 + OAUTH_BETA.len());
    let mut has_oauth = false;
    for beta in existing.split(',').map(str::trim).filter(|b| !b.is_empty()) {
        if !betas.is_empty() {
            betas.push(',');
        }
        betas.push_str(beta);
        has_oauth |= beta == OAUTH_BETA;
    }
    if !has_oauth {
        if !betas.is_empty() {
            betas.push(',');
        }
        betas.push_str(OAUTH_BETA);
    }
    betas
}

/// The `anthropic-beta` value to send for the agent's: its own when it
/// already reads as [`with_oauth_beta`] would write it, else that list.
fn oauth_beta(client: Option<&HeaderValue>) -> Option<HeaderValue> {
    let existing = client.and_then(|v| v.to_str().ok());
    let Some(list) = existing else {
        return Some(HeaderValue::from_static(OAUTH_BETA));
    };
    let mut betas = list.split(',');
    if betas.clone().any(|b| b == OAUTH_BETA) && betas.all(|b| !b.is_empty() && b.trim() == b) {
        return client.cloned();
    }
    HeaderValue::try_from(with_oauth_beta(existing)).ok()
}

/// Headers for the upstream request: the agent's own headers, with the
/// account's `Authorization` value ([`Account::bearer`]) in place of the
/// slopmax key.
///
/// [`Account::bearer`]: crate::account::Account::bearer
pub fn upstream_headers(client: &HeaderMap, bearer: Option<HeaderValue>) -> HeaderMap {
    let mut headers = crate::net::headers::forwardable(client);
    if let Some(beta) = oauth_beta(client.get(&ANTHROPIC_BETA)) {
        headers.insert(ANTHROPIC_BETA, beta);
    }
    if let Some(bearer) = bearer {
        headers.insert(AUTHORIZATION, bearer);
    }
    headers
}

/// Claude Code's user agent, like `claude-cli/2.1.291 (external, cli)`, if
/// it sent the request.
pub fn client_agent(headers: &HeaderMap) -> Option<&str> {
    let agent = headers.get("user-agent")?.to_str().ok()?;
    (agent.starts_with("claude-cli/") && agent.len() <= 200).then_some(agent)
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
        let bearer = HeaderValue::from_static("Bearer account-token");
        let out = upstream_headers(&client, Some(bearer));
        assert_eq!(out["authorization"], "Bearer account-token");
        assert_eq!(out["anthropic-beta"], "oauth-2025-04-20");
        assert_eq!(out["user-agent"], "claude-cli/2.1.287 (external, cli)");
        assert_eq!(out["accept-encoding"], "gzip, br");
        assert_eq!(out["x-app"], "cli");
        assert!(!out.contains_key("x-client-request-id"));

        // The agent's own beta list goes as it is when it holds the flag
        // and reads as written out; otherwise it is written out with it.
        let mut beta = |sent: &'static str| {
            client.insert("anthropic-beta", HeaderValue::from_static(sent));
            let out = upstream_headers(&client, None);
            out["anthropic-beta"].to_str().unwrap().to_owned()
        };
        assert_eq!(beta("x,oauth-2025-04-20"), "x,oauth-2025-04-20");
        assert_eq!(beta("x, oauth-2025-04-20"), "x,oauth-2025-04-20");
        assert_eq!(beta("x,,oauth-2025-04-20"), "x,oauth-2025-04-20");
        assert_eq!(beta("x"), "x,oauth-2025-04-20");
        assert_eq!(beta(""), "oauth-2025-04-20");
    }
}
