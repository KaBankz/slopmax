//! API keys, billed per token: Anthropic, OpenAI, and xAI.
//!
//! A key is stored as an access token that never expires. Requests keep the
//! agent's own headers, with the key in place of the slopmax key.

use anyhow::{Context, Result, bail};
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use serde_json::Value;

use super::{Billing, BoxFuture, Credential, Provider, ProviderId, Spec, Verdict, codex};
use crate::account::{Account, Tokens};
use crate::auth::{LoginOptions, Prompt};
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;
use crate::{limits, log};

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
    credential: Credential::Key { optional: false },
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
    credential: Credential::Key { optional: false },
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
    credential: Credential::Key { optional: false },
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
        options: LoginOptions,
        _prompt: Prompt,
    ) -> BoxFuture<'a, Result<Account>> {
        Box::pin(async move {
            let key = options
                .key
                .filter(|key| !key.is_empty())
                .with_context(|| format!("no {} key entered", self.spec.title))?;
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

    use crate::provider::{Reading, UsageError};
    use crate::testkit::{self, Mock};
    use serde_json::json;

    /// A model list for the right credential, 401 for any other, and 500
    /// for the key `flaky`.
    async fn vendor() -> Mock {
        Mock::start(|seen| {
            let bearer = seen.header("authorization");
            let x_key = seen.header("x-api-key");
            let list = json!({ "data": [{ "id": "m-1" }, { "id": "m-2" }] });
            match (seen.route(), bearer, x_key) {
                ("/v1/models", Some("Bearer sk-good"), None) => testkit::json(200, list),
                ("/v1/models", None, Some("sk-ant-good"))
                    if seen.header("anthropic-version") == Some("2023-06-01") =>
                {
                    testkit::json(200, list)
                }
                ("/v1/models", Some("Bearer flaky"), _) => testkit::reply(500, ""),
                ("/v1/models", Some("Bearer garbled"), _) => testkit::reply(200, "not json"),
                ("/v1/models", None, None) => testkit::json(200, json!({ "data": [] })),
                _ => testkit::reply(401, ""),
            }
        })
        .await
    }

    const VENDORS: &[&str] = &[
        "https://api.openai.com",
        "https://api.anthropic.com",
        "https://api.x.ai",
    ];

    fn key_options(key: Option<&str>) -> LoginOptions {
        LoginOptions {
            key: key.map(Into::into),
            ..LoginOptions::default()
        }
    }

    #[tokio::test]
    async fn logging_in_checks_the_key_with_the_vendor() {
        let mock = vendor().await;
        let http = mock.client(VENDORS);
        let prompt = || Prompt::new(|_| {});
        let account = OPENAI
            .login(&http, key_options(Some("sk-good")), prompt())
            .await
            .unwrap();
        assert_eq!(account.provider, ProviderId::OpenAI);
        assert_eq!(account.tokens.access_token, "sk-good");
        assert_eq!(OPENAI.identity(&account).as_deref(), Some("sk-good"));

        let anthropic = ANTHROPIC
            .login(&http, key_options(Some("sk-ant-good")), prompt())
            .await
            .unwrap();
        assert_eq!(anthropic.provider, ProviderId::Anthropic);

        let err = XAI
            .login(&http, key_options(Some("sk-wrong")), prompt())
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("rejected the key (401 Unauthorized)"),
            "{err}"
        );
        for missing in [None, Some("")] {
            let err = OPENAI
                .login(&http, key_options(missing), prompt())
                .await
                .unwrap_err();
            assert_eq!(err.to_string(), "no OpenAI API key entered");
        }
        // A vendor that cannot answer right now does not block the login.
        let flaky = OPENAI
            .login(&http, key_options(Some("flaky")), prompt())
            .await
            .unwrap();
        assert_eq!(flaky.tokens.access_token, "flaky");
    }

    #[tokio::test]
    async fn checks_tolerate_outages_and_open_endpoints() {
        let mock = vendor().await;
        let url = format!("{}/v1/models", mock.url);
        let http = crate::net::Client::builder().plain_http().build();
        let listed = check(&http, &url, KeyHeader::Bearer, "sk-good")
            .await
            .unwrap();
        assert_eq!(listed.unwrap(), ["m-1", "m-2"]);
        // No key, no credential header.
        let open = check(&http, &url, KeyHeader::XApiKey, "").await.unwrap();
        assert_eq!(open, Some(Vec::new()));
        let garbled = check(&http, &url, KeyHeader::Bearer, "garbled")
            .await
            .unwrap();
        assert_eq!(garbled, None);
        let down = check(
            &http,
            "http://127.0.0.1:9/v1/models",
            KeyHeader::Bearer,
            "k",
        )
        .await
        .unwrap();
        assert_eq!(down, None);
        let forbidden = Mock::start(|_| testkit::reply(403, "")).await;
        let url = format!("{}/models", forbidden.url);
        let err = check(&http, &url, KeyHeader::Bearer, "k")
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .ends_with("rejected the key (403 Forbidden)")
        );
    }

    #[tokio::test]
    async fn catalogs_list_what_the_key_can_use() {
        let mock = vendor().await;
        let http = mock.client(VENDORS);
        let key = |k: &str| {
            Account::new(
                ProviderId::OpenAI,
                Tokens {
                    access_token: k.into(),
                    ..Tokens::default()
                },
            )
        };
        let models = OPENAI.catalog(&http, &key("sk-good"), "").await.unwrap();
        assert_eq!(models, ["m-1", "m-2"]);
        assert!(
            OPENAI
                .catalog(&http, &key("flaky"), "")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(OPENAI.catalog(&http, &key("revoked"), "").await.is_err());
    }

    #[tokio::test]
    async fn keys_have_no_windows_refreshes_or_state() {
        let account = Account::new(
            ProviderId::Xai,
            Tokens {
                access_token: "xai-key".into(),
                ..Tokens::default()
            },
        );
        let http = crate::net::Client::builder().plain_http().build();
        let usage: Result<Reading, UsageError> = XAI.usage(&http, &account).await;
        let Err(UsageError::Other(e)) = usage else {
            panic!("keys have no usage");
        };
        assert_eq!(e.to_string(), "xAI API has no usage windows");
        let refreshed = XAI.refresh(&http, "rt").await.unwrap_err();
        assert_eq!(
            refreshed.to_string(),
            "xAI API keys cannot be refreshed; log in again"
        );
        let mut identified = account.clone();
        XAI.identify(&http, &mut identified).await;
        assert_eq!(identified.email, None);
        assert_eq!(XAI.api(&account), "https://api.x.ai/v1");
        assert_eq!(XAI.dialects(&account), [Dialect::Chat]);
        assert!(XAI.serves(&account, "grok-4"));
        assert!(!XAI.serves(&account, "gpt-6"));
        assert_eq!(XAI.rebind(b"{}"), None);
        let mut body = json!({ "max_tokens": 5 });
        XAI.shape(Dialect::Chat, &mut body);
        assert_eq!(body, json!({ "max_tokens": 5 }));
        assert!(XAI.limits(&HeaderMap::new(), Timestamp::now()).is_none());
        let mut headers = HeaderMap::new();
        XAI.show_pool(&[], &mut headers);
        assert!(headers.is_empty());
        assert!(XAI.credits().is_none());

        let sent = XAI.headers(&HeaderMap::new(), &account, false);
        assert_eq!(sent["authorization"], "Bearer xai-key");
        let sent = ANTHROPIC.headers(&HeaderMap::new(), &account, false);
        assert_eq!(sent["x-api-key"], "xai-key");
        assert_eq!(
            XAI.verdict(
                StatusCode::PAYMENT_REQUIRED,
                &HeaderMap::new(),
                b"",
                None,
                Timestamp::now()
            ),
            Verdict::Exhausted {
                until: None,
                model: None
            }
        );
    }

    #[test]
    fn overload_throttles_briefly() {
        let now = Timestamp::from_second(1_000).unwrap();
        for status in [503, 529] {
            let verdict = metered_verdict(
                StatusCode::from_u16(status).unwrap(),
                &HeaderMap::new(),
                b"overloaded",
                now,
            );
            assert_eq!(verdict, Verdict::Throttled { until: None });
        }
        assert_eq!(
            metered_verdict(StatusCode::FORBIDDEN, &HeaderMap::new(), b"", now),
            Verdict::Forbidden
        );
        assert_eq!(
            KeyHeader::for_dialect(Dialect::Responses),
            KeyHeader::Bearer
        );
        assert_eq!(
            KeyHeader::for_dialect(Dialect::Messages),
            KeyHeader::XApiKey
        );
    }
}
