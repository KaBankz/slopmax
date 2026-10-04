//! API keys, billed per token: Anthropic, OpenAI, and xAI.
//!
//! A key is stored as an access token that never expires. Requests keep the
//! agent's own headers, with the key in place of the slopmax key.

use anyhow::{Result, bail};
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use serde_json::Value;

use super::{Billing, BoxFuture, Provider, ProviderId, Spec, Verdict, codex};
use crate::account::{Account, Tokens};
use crate::auth::LoginOptions;
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;
use crate::{limits, log, ui};

/// How a key is presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyHeader {
    /// `x-api-key`, as Anthropic-style APIs expect.
    XApiKey,
    /// `authorization: Bearer`, as OpenAI-style APIs expect.
    Bearer,
}

impl KeyHeader {
    /// The usual header for an API speaking `dialect`.
    pub fn for_dialect(dialect: Dialect) -> Self {
        match dialect {
            Dialect::Messages => Self::XApiKey,
            Dialect::Responses | Dialect::Chat => Self::Bearer,
        }
    }
}

/// A provider whose accounts are API keys.
pub struct KeyProvider {
    id: ProviderId,
    spec: &'static Spec,
    /// Where the API lists its models, which checks a new key.
    models_url: &'static str,
}

static ANTHROPIC_SPEC: Spec = Spec {
    id: "anthropic",
    title: "Anthropic API",
    api: super::claude::API,
    dialects: &[Dialect::Messages],
    models: &["claude-*"],
    billing: Billing::Metered {
        backs: Some(ProviderId::Claude),
    },
    // slopmax serves Claude models to Claude Code only.
    agent_only: Some("claude"),
    refresh_lead: SignedDuration::ZERO,
    device_login: false,
};

pub static ANTHROPIC: KeyProvider = KeyProvider {
    id: ProviderId::Anthropic,
    spec: &ANTHROPIC_SPEC,
    models_url: "https://api.anthropic.com/v1/models",
};

static OPENAI_SPEC: Spec = Spec {
    id: "openai",
    title: "OpenAI API",
    api: "https://api.openai.com/v1",
    dialects: &[Dialect::Responses, Dialect::Chat],
    models: codex::MODELS,
    billing: Billing::Metered {
        backs: Some(ProviderId::Codex),
    },
    agent_only: None,
    refresh_lead: SignedDuration::ZERO,
    device_login: false,
};

pub static OPENAI: KeyProvider = KeyProvider {
    id: ProviderId::OpenAI,
    spec: &OPENAI_SPEC,
    models_url: "https://api.openai.com/v1/models",
};

static XAI_SPEC: Spec = Spec {
    id: "xai",
    title: "xAI API",
    api: "https://api.x.ai/v1",
    dialects: &[Dialect::Chat],
    models: &["grok-*"],
    billing: Billing::Metered { backs: None },
    agent_only: None,
    refresh_lead: SignedDuration::ZERO,
    device_login: false,
};

pub static XAI: KeyProvider = KeyProvider {
    id: ProviderId::Xai,
    spec: &XAI_SPEC,
    models_url: "https://api.x.ai/v1/models",
};

impl Provider for KeyProvider {
    fn spec(&self) -> &'static Spec {
        self.spec
    }

    fn identity(&self, account: &Account) -> Option<String> {
        Some(account.tokens.access_token.clone())
    }

    fn login<'a>(
        &'a self,
        http: &'a Client,
        _options: LoginOptions,
    ) -> BoxFuture<'a, Result<Account>> {
        Box::pin(async move {
            let key = ui::read_secret(&format!("{} key", self.spec.title))?;
            if key.is_empty() {
                bail!("no key entered");
            }
            let header = KeyHeader::for_dialect(self.spec.dialects[0]);
            check(http, self.models_url, header, &key).await?;
            let tokens = Tokens {
                access_token: key,
                ..Tokens::default()
            };
            Ok(Account::new(self.id, tokens))
        })
    }

    fn headers(&self, client: &HeaderMap, account: &Account, _moved: bool) -> HeaderMap {
        let header = KeyHeader::for_dialect(self.spec.dialects[0]);
        with_key(client, header, &account.tokens.access_token)
    }

    fn catalog<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        _version: &'a str,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let header = KeyHeader::for_dialect(self.spec.dialects[0]);
            let listed = check(http, self.models_url, header, &account.tokens.access_token).await?;
            Ok(listed.unwrap_or_default())
        })
    }

    fn verdict(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
        _model: Option<&str>,
        now: Timestamp,
    ) -> Verdict {
        metered_verdict(status, headers, body, now)
    }
}

/// The agent's headers with `key` as the credential (none when empty).
pub fn with_key(client: &HeaderMap, header: KeyHeader, key: &str) -> HeaderMap {
    let mut headers = crate::proxy::forwardable(client);
    if key.is_empty() {
        return headers;
    }
    let (name, value) = match header {
        KeyHeader::XApiKey => ("x-api-key", key.to_owned()),
        KeyHeader::Bearer => ("authorization", format!("Bearer {key}")),
    };
    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.insert(HeaderName::from_static(name), value);
    }
    headers
}

/// Lists models at `url` with `key`, so a mistyped or revoked key fails now
/// rather than on the first request. Returns the model ids when the list
/// could be read; a network failure is only a warning.
pub async fn check(
    http: &Client,
    url: &str,
    header: KeyHeader,
    key: &str,
) -> Result<Option<Vec<String>>> {
    let mut request = http.get(url);
    if !key.is_empty() {
        request = match header {
            KeyHeader::XApiKey => request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01"),
            KeyHeader::Bearer => request.bearer_auth(key),
        };
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => {
            log::warn!("could not check the key against {url}: {e}");
            return Ok(None);
        }
    };
    match response.status() {
        status if status.is_success() => {
            let list: Option<Value> = response.json().await.ok();
            Ok(list.map(|list| model_ids(&list)))
        }
        status @ (StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
            bail!("{url} rejected the key ({status})")
        }
        status => {
            log::warn!("could not check the key: {url} answered {status}");
            Ok(None)
        }
    }
}

/// The ids in a model list (`{"data": [{"id": …}]}`, as OpenAI- and
/// Anthropic-style APIs both answer).
fn model_ids(list: &Value) -> Vec<String> {
    list.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// How pay-per-token APIs refuse: a key out of funds sits out, rate limits
/// and overload briefly throttle it, and anything else is the request's.
pub fn metered_verdict(
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    now: Timestamp,
) -> Verdict {
    let text = String::from_utf8_lossy(&body[..body.len().min(4096)]);
    let out_of_funds = [
        "insufficient_quota",
        "credit balance",
        "exceeded your current quota",
    ]
    .iter()
    .any(|needle| text.contains(needle));
    match status.as_u16() {
        402 => Verdict::Exhausted {
            until: None,
            model: None,
        },
        400 | 429 if out_of_funds => Verdict::Exhausted {
            until: None,
            model: None,
        },
        429 | 503 | 529 => Verdict::Throttled {
            until: limits::retry_after(headers, now),
        },
        _ => Verdict::of_status(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_replace_the_slopmax_key() {
        let mut client = HeaderMap::new();
        client.insert("authorization", HeaderValue::from_static("Bearer sm-key"));
        client.insert("user-agent", HeaderValue::from_static("codex_exec/0.160.0"));
        let bearer = with_key(&client, KeyHeader::Bearer, "sk-test");
        assert_eq!(bearer["authorization"], "Bearer sk-test");
        assert_eq!(bearer["user-agent"], "codex_exec/0.160.0");
        let anthropic = with_key(&client, KeyHeader::XApiKey, "sk-ant-test");
        assert_eq!(anthropic["x-api-key"], "sk-ant-test");
        assert!(!anthropic.contains_key("authorization"));
        let open = with_key(&client, KeyHeader::Bearer, "");
        assert!(!open.contains_key("authorization"));
    }

    #[test]
    fn verdicts_tell_funds_from_rate_limits() {
        let now = Timestamp::from_second(1_000).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("20"));
        let verdict = |status: u16, body: &str| {
            metered_verdict(
                StatusCode::from_u16(status).unwrap(),
                &headers,
                body.as_bytes(),
                now,
            )
        };
        assert_eq!(
            verdict(429, r#"{"error":{"code":"rate_limit_exceeded"}}"#),
            Verdict::Throttled {
                until: Some(now + SignedDuration::from_secs(20))
            }
        );
        let broke = Verdict::Exhausted {
            until: None,
            model: None,
        };
        assert_eq!(
            verdict(429, r#"{"error":{"code":"insufficient_quota"}}"#),
            broke
        );
        assert_eq!(
            verdict(400, "Your credit balance is too low to access the API"),
            broke
        );
        assert_eq!(verdict(401, ""), Verdict::Unauthorized);
        assert_eq!(verdict(400, "max_tokens too large"), Verdict::Final);
    }

    #[test]
    fn model_lists_read_either_shape() {
        let list = serde_json::json!({"object": "list", "data": [{"id": "grok-4"}, {"id": "grok-code-fast-1"}]});
        assert_eq!(model_ids(&list), ["grok-4", "grok-code-fast-1"]);
        assert!(model_ids(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn key_accounts_are_named_by_their_tail() {
        let account = Account::new(
            ProviderId::OpenAI,
            Tokens {
                access_token: "sk-proj-abcdWXYZ".into(),
                ..Tokens::default()
            },
        );
        assert_eq!(account.name(), "OpenAI API key …WXYZ");
        assert!(account.id.starts_with("openai-"));
    }
}
