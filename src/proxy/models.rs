//! `GET /v1/models` for OpenAI-style clients: every model a connected
//! account offers them, read from each provider and kept a while.
//!
//! Claude Code and Codex list models through their own providers' APIs
//! (see `route`); this list is for everything else, so Claude models,
//! which serve Claude Code only, are not on it.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

use super::{App, json_reply};
use crate::account::Account;
use crate::config::ClientKey;
use crate::log;
use crate::net::server::Response;

/// How long a provider's list is reused.
const FRESH: Duration = Duration::from_secs(600);
/// The Codex release whose catalog ChatGPT is asked for, until a Codex
/// client says which one it runs.
const CODEX_VERSION: &str = "0.159.3";

/// Whether a `/v1/models` request wants the OpenAI-style list rather than
/// Anthropic's (Claude Code) or Codex's catalog.
pub(super) fn wants_list(headers: &HeaderMap, query: &str) -> bool {
    let claude_code = headers
        .get(http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ua| ua.starts_with("claude-cli/"));
    !claude_code && !headers.contains_key("anthropic-version") && !query.contains("client_version=")
}

/// The list, narrowed to what `key` may use when a client key asks.
pub(super) async fn list(app: &Arc<App>, key: Option<&ClientKey>) -> Response {
    let version = app
        .codex_version
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| CODEX_VERSION.to_owned());
    let accounts = app.pool.accounts().into_iter().filter(|a| {
        !a.disabled && a.auth_error.is_none() && a.provider.spec().agent_only.is_none()
    });
    let mut lists = tokio::task::JoinSet::new();
    for account in accounts {
        let (app, version) = (Arc::clone(app), version.clone());
        lists.spawn(async move {
            let models = catalog(&app, &account, &version).await;
            (account.provider.as_str(), models)
        });
    }
    let mut models: BTreeMap<String, &str> = BTreeMap::new();
    while let Some(joined) = lists.join_next().await {
        let Ok((owner, list)) = joined else { continue };
        for id in list {
            models.entry(id).or_insert(owner);
        }
    }
    for alias in app.config.aliases.keys() {
        models.entry(alias.clone()).or_insert("slopmax");
    }
    if let Some(key) = key {
        models.retain(|id, _| key.allows(id));
    }
    let data: Vec<Value> = models
        .into_iter()
        .map(|(id, owner)| json!({"id": id, "object": "model", "created": 0, "owned_by": owner}))
        .collect();
    json_reply(StatusCode::OK, &json!({"object": "list", "data": data}))
}

/// The account's models, from the cache while fresh.
async fn catalog(app: &App, account: &Account, version: &str) -> Vec<String> {
    {
        let cache = app.catalogs.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, models)) = cache.get(&account.id)
            && at.elapsed() < FRESH
        {
            return models.clone();
        }
    }
    let Some(account) = app.ready(account).await else {
        return Vec::new();
    };
    let provider = account.provider.get();
    match provider.catalog(&app.auth_http, &account, version).await {
        Ok(models) => {
            let mut cache = app.catalogs.lock().unwrap_or_else(|p| p.into_inner());
            cache.insert(account.id.clone(), (Instant::now(), models.clone()));
            models
        }
        Err(e) => {
            log::warn!("{}: listing its models: {e:#}", account.id);
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    #[test]
    fn claude_code_and_codex_keep_their_own_lists() {
        let mut headers = HeaderMap::new();
        assert!(wants_list(&headers, "limit=20"));
        assert!(!wants_list(&headers, "client_version=0.159.3"));
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        assert!(!wants_list(&headers, ""));
        let mut claude = HeaderMap::new();
        claude.insert(
            "user-agent",
            HeaderValue::from_static("claude-cli/2.1.287 (external, cli)"),
        );
        assert!(!wants_list(&claude, "limit=1000"));
    }
}
