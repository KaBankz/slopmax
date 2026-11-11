//! Compatible endpoints: any API that speaks OpenAI Chat Completions or
//! Responses, or Anthropic Messages, such as a local model server or
//! another vendor's gateway. The provider is code; each endpoint, its
//! format, and its models are the account's data.

use anyhow::{Result, bail};
use http::{HeaderMap, StatusCode};

use super::keys::{self, KeyHeader};
use super::{Billing, BoxFuture, Credential, Provider, ProviderId, Spec, Verdict};
use crate::account::{Account, Endpoint, Tokens};
use crate::auth::{LoginOptions, Prompt};
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

pub struct Compat;

static SPEC: Spec = Spec {
    id: "compat",
    title: "Compatible API",
    // Each account names its own endpoint, format, and models.
    api: "",
    dialects: &[],
    models: &[],
    billing: Billing::Metered { backs: None },
    agent_only: None,
    refresh_lead: SignedDuration::ZERO,
    credential: Credential::Key { optional: true },
};

impl Provider for Compat {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn identity(&self, account: &Account) -> Option<String> {
        let endpoint = account.endpoint.as_ref()?;
        Some(format!(
            "{} {}",
            endpoint.base_url, account.tokens.access_token
        ))
    }

    fn login<'a>(
        &'a self,
        http: &'a Client,
        options: LoginOptions,
        _prompt: Prompt,
    ) -> BoxFuture<'a, Result<Account>> {
        Box::pin(async move {
            let Some(mut endpoint) = options.endpoint else {
                bail!("a compatible endpoint needs its address: --url <base url>");
            };
            let key = options.key.unwrap_or_default();
            let header = KeyHeader::for_dialect(endpoint.dialect);
            let listed = keys::check(http, &models_url(&endpoint), header, &key).await?;
            if endpoint.models.is_empty() {
                endpoint.models = listed.unwrap_or_default();
            }
            if endpoint.models.is_empty() {
                bail!(
                    "could not list the models at {}; name them with --models",
                    endpoint.base_url
                );
            }
            let tokens = Tokens {
                access_token: key,
                ..Tokens::default()
            };
            let mut account = Account::new(ProviderId::Compat, tokens);
            account.endpoint = Some(endpoint);
            account.assign_id();
            Ok(account)
        })
    }

    fn api<'a>(&self, account: &'a Account) -> &'a str {
        account
            .endpoint
            .as_ref()
            .map_or("", |e| e.base_url.as_str())
    }

    fn dialects<'a>(&self, account: &'a Account) -> &'a [Dialect] {
        account
            .endpoint
            .as_ref()
            .map_or(&[], |e| std::slice::from_ref(&e.dialect))
    }

    /// Local servers and gateways that speak Responses refuse Codex's
    /// compaction items, or answer them as an ordinary turn.
    fn compacts(&self) -> bool {
        false
    }

    fn catalog<'a>(
        &'a self,
        _http: &'a Client,
        account: &'a Account,
        _version: &'a str,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        // Named models; patterns cannot be listed.
        let models = account
            .endpoint
            .iter()
            .flat_map(|e| &e.models)
            .filter(|m| !m.contains('*'))
            .cloned()
            .collect();
        Box::pin(std::future::ready(Ok(models)))
    }

    fn serves(&self, account: &Account, model: &str) -> bool {
        account
            .endpoint
            .as_ref()
            .is_some_and(|e| e.models.iter().any(|p| super::matches(p, model)))
    }

    fn headers(&self, client: &HeaderMap, account: &Account, _moved: bool) -> HeaderMap {
        let dialect = account
            .endpoint
            .as_ref()
            .map_or(Dialect::Chat, |e| e.dialect);
        keys::with_key(
            client,
            KeyHeader::for_dialect(dialect),
            &account.tokens.access_token,
        )
    }

    fn verdict(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
        _model: Option<&str>,
        now: Timestamp,
    ) -> Verdict {
        keys::metered_verdict(status, headers, body, now)
    }
}

/// Where the endpoint lists its models.
fn models_url(endpoint: &Endpoint) -> String {
    let base = endpoint.base_url.trim_end_matches('/');
    match endpoint.dialect {
        Dialect::Messages => format!("{base}/v1/models"),
        Dialect::Responses | Dialect::Chat => format!("{base}/models"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(models: &[&str]) -> Account {
        let mut account = Account::new(ProviderId::Compat, Tokens::default());
        account.endpoint = Some(Endpoint {
            base_url: "http://localhost:11434/v1".into(),
            dialect: Dialect::Chat,
            models: models.iter().map(|m| m.to_string()).collect(),
        });
        account.assign_id();
        account
    }

    #[test]
    fn endpoints_are_the_accounts_data() {
        let local = account(&["qwen3-*", "llama4"]);
        assert!(Compat.serves(&local, "qwen3-coder"));
        assert!(!Compat.serves(&local, "gpt-6-sol"));
        assert_eq!(Compat.api(&local), "http://localhost:11434/v1");
        assert_eq!(Compat.dialects(&local), [Dialect::Chat]);
        assert_eq!(local.name(), "localhost:11434");
        assert_eq!(
            models_url(local.endpoint.as_ref().unwrap()),
            "http://localhost:11434/v1/models"
        );
        // The same server under two keys is two accounts.
        let mut other = local.clone();
        other.tokens.access_token = "key".into();
        other.assign_id();
        assert_ne!(other.id, local.id);
    }

    use crate::testkit::{self, Mock};
    use serde_json::json;

    /// An endpoint listing two models for the key `good` (by the dialect's
    /// header), failing for `flaky`, and refusing anything else.
    async fn server() -> Mock {
        Mock::start(|seen| {
            let list = json!({ "data": [{ "id": "local-1" }, { "id": "local-2" }] });
            match (
                seen.route(),
                seen.header("authorization"),
                seen.header("x-api-key"),
            ) {
                ("/v1/models" | "/v1/v1/models", Some("Bearer good"), _) => {
                    testkit::json(200, list)
                }
                ("/anthropic/v1/models", None, Some("good")) => testkit::json(200, list),
                (_, Some("Bearer flaky"), _) | (_, _, Some("flaky")) => testkit::reply(500, ""),
                _ => testkit::reply(401, ""),
            }
        })
        .await
    }

    fn options(base_url: String, dialect: Dialect, models: &[&str], key: &str) -> LoginOptions {
        LoginOptions {
            endpoint: Some(Endpoint {
                base_url,
                dialect,
                models: models.iter().map(|m| m.to_string()).collect(),
            }),
            key: Some(key.into()),
            ..LoginOptions::default()
        }
    }

    async fn login(options: LoginOptions) -> Result<Account> {
        let http = Client::builder().plain_http().build();
        Compat.login(&http, options, Prompt::new(|_| {})).await
    }

    #[tokio::test]
    async fn logins_list_the_models_when_none_are_named() {
        let mock = server().await;
        let base = format!("{}/v1/", mock.url);
        let account = login(options(base.clone(), Dialect::Chat, &[], "good"))
            .await
            .unwrap();
        let endpoint = account.endpoint.as_ref().unwrap();
        assert_eq!(endpoint.models, ["local-1", "local-2"]);
        assert_eq!(account.tokens.access_token, "good");
        assert!(account.id.starts_with("compat-"));
        assert_eq!(Compat.identity(&account), Some(format!("{base} good")));

        // Anthropic-style endpoints list under /v1 with x-api-key.
        let messages = login(options(
            format!("{}/anthropic", mock.url),
            Dialect::Messages,
            &[],
            "good",
        ))
        .await
        .unwrap();
        assert_eq!(messages.endpoint.unwrap().models.len(), 2);
    }

    #[tokio::test]
    async fn named_models_survive_an_endpoint_that_cannot_list() {
        let mock = server().await;
        let base = format!("{}/v1", mock.url);
        let named = login(options(
            base.clone(),
            Dialect::Responses,
            &["m-*", "m-1"],
            "flaky",
        ))
        .await
        .unwrap();
        assert_eq!(named.endpoint.as_ref().unwrap().models, ["m-*", "m-1"]);

        let err = login(options(base.clone(), Dialect::Chat, &[], "flaky"))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("could not list the models at {base}; name them with --models")
        );
        let err = login(options(base, Dialect::Chat, &[], "wrong"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("rejected the key"), "{err}");
    }

    #[tokio::test]
    async fn logins_need_an_address() {
        let err = login(LoginOptions::default()).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "a compatible endpoint needs its address: --url <base url>"
        );
    }

    #[tokio::test]
    async fn catalogs_name_models_but_not_patterns() {
        let local = account(&["qwen3-*", "llama4", "phi"]);
        let http = Client::builder().plain_http().build();
        let models = Compat.catalog(&http, &local, "").await.unwrap();
        assert_eq!(models, ["llama4", "phi"]);
    }

    #[test]
    fn accounts_without_an_endpoint_serve_nothing() {
        let bare = Account::new(ProviderId::Compat, Tokens::default());
        assert_eq!(Compat.identity(&bare), None);
        assert_eq!(Compat.api(&bare), "");
        assert!(Compat.dialects(&bare).is_empty());
        assert!(!Compat.serves(&bare, "anything"));
        let mut keyed = bare.clone();
        keyed.tokens.access_token = "k".into();
        // Without an endpoint the key goes as a bearer token.
        assert_eq!(
            Compat.headers(&HeaderMap::new(), &keyed, false)["authorization"],
            "Bearer k"
        );
    }

    #[test]
    fn keys_go_in_the_header_the_dialect_expects() {
        let mut messages = account(&["glm-*"]);
        messages.tokens.access_token = "k".into();
        messages.endpoint.as_mut().unwrap().dialect = Dialect::Messages;
        let sent = Compat.headers(&HeaderMap::new(), &messages, false);
        assert_eq!(sent["x-api-key"], "k");
        assert!(!sent.contains_key("authorization"));
        assert_eq!(
            models_url(messages.endpoint.as_ref().unwrap()),
            "http://localhost:11434/v1/v1/models"
        );
        assert_eq!(
            Compat.verdict(
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                b"",
                None,
                Timestamp::now()
            ),
            Verdict::Throttled { until: None }
        );
    }
}
