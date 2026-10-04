//! Compatible endpoints: any API that speaks OpenAI Chat Completions or
//! Responses, or Anthropic Messages, such as a local model server or
//! another vendor's gateway. The provider is code; each endpoint, its
//! format, and its models are the account's data.

use anyhow::{Result, bail};
use http::{HeaderMap, StatusCode};

use super::keys::{self, KeyHeader};
use super::{Billing, BoxFuture, Provider, ProviderId, Spec, Verdict};
use crate::account::{Account, Endpoint, Tokens};
use crate::auth::LoginOptions;
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::ui;
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
    device_login: false,
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
    ) -> BoxFuture<'a, Result<Account>> {
        Box::pin(async move {
            let Some(mut endpoint) = options.endpoint else {
                bail!("a compatible endpoint needs its address: --url <base url>");
            };
            let key = ui::read_secret("API key (leave empty if it needs none)")?;
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
}
