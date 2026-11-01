//! slopmax's own API under `/slopmax/`: status, usage, a live feed of
//! answered requests, account actions, and the dashboard that uses them.
//! Account actions call the same functions as the CLI, so both behave
//! alike.
//!
//! Everything but the dashboard page itself needs the slopmax key. The page
//! carries no data; it reads the key from its URL fragment (`#key=…`),
//! which browsers never send to the server.

use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode, header};
use hyper::body::{Body as HttpBody, Frame};
use serde_json::json;
use tokio::sync::{broadcast, mpsc};

use super::{App, authorized, error, json_reply};
use crate::account::{forget, pin, unpin_all};
use crate::config::{Config, Strategy};
use crate::net::body;
use crate::net::server::{Request, Response};
use crate::provider::ProviderId;
use crate::provider::credits::Outcome;
use crate::time::Timestamp;
use crate::{daemon, history, log, summary};

const DASHBOARD: &str = include_str!("dashboard.html");
/// How often an idle feed says it is still there.
const KEEPALIVE: Duration = Duration::from_secs(15);

/// Answers a request under `/slopmax/`.
pub(super) async fn handle(app: Arc<App>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    if method == Method::GET && path == "/slopmax/dashboard" {
        return dashboard();
    }
    if !authorized(&app.config(), request.headers()) {
        return error(
            None,
            StatusCode::UNAUTHORIZED,
            "missing or invalid slopmax key; see `slopmax env`",
        );
    }
    let segments: Vec<&str> = path.trim_start_matches("/slopmax/").split('/').collect();
    match (&method, segments.as_slice()) {
        (&Method::GET, ["status"]) => json_reply(StatusCode::OK, &app.report()),
        // Polls every account's usage and lists its reset credits now, then
        // reports.
        (&Method::POST, ["refresh"]) => {
            daemon::poll_all(&app, true).await;
            daemon::list_credits(&app, true).await;
            json_reply(StatusCode::OK, &app.report())
        }
        // Picks up changes on disk now, config.toml's too, then reports.
        (&Method::POST, ["sync"]) => {
            app.reload_config();
            reload(&app, Ok(()))
        }
        (&Method::POST, ["shutdown"]) => {
            app.stop.cancel();
            json_reply(StatusCode::OK, &json!({ "status": "stopping" }))
        }
        (&Method::GET, ["usage"]) => usage(&app, &query).await,
        (&Method::GET, ["history"]) => history(&app, &query).await,
        (&Method::GET, ["settings"]) => json_reply(StatusCode::OK, &settings(&app.config())),
        (&Method::POST, ["settings"]) => {
            let body = match body::read(request.into_body(), 64 * 1024).await {
                Ok(body) => body,
                Err(e) => return error(None, StatusCode::BAD_REQUEST, &format!("{e}")),
            };
            // The fields come in the query, the form body, or both.
            let form = format!("{query}&{}", String::from_utf8_lossy(&body));
            change_settings(&app, &form)
        }
        (&Method::GET, ["events"]) => events(&app),
        (&Method::POST, ["use", "auto"]) => unpin(&app),
        (&Method::POST, ["accounts", id, action]) => account(&app, id, action, &query).await,
        // Adds an API key or a compatible endpoint; subscriptions sign in
        // with a browser, through the CLI or the app.
        (&Method::POST, ["accounts"]) => {
            let form = match form(request, &query).await {
                Ok(form) => form,
                Err(e) => return error(None, StatusCode::BAD_REQUEST, &e),
            };
            add_account(&app, &form).await
        }
        (&Method::GET, ["keys"]) => json_reply(StatusCode::OK, &keys(&app.config())),
        (&Method::POST, ["keys"]) => {
            let form = match form(request, &query).await {
                Ok(form) => form,
                Err(e) => return error(None, StatusCode::BAD_REQUEST, &e),
            };
            add_key(&app, &form)
        }
        (&Method::POST, ["keys", name, "remove"]) => {
            remove_key(&app, &crate::net::form::percent_decode(name))
        }
        (&Method::GET, ["doctor"]) => match crate::doctor::check(&app.config(), &app.store).await {
            Ok(sections) => json_reply(StatusCode::OK, &sections),
            Err(e) => error(None, StatusCode::INTERNAL_SERVER_ERROR, &format!("{e:#}")),
        },
        _ => error(None, StatusCode::NOT_FOUND, "no such slopmax endpoint"),
    }
}

fn dashboard() -> Response {
    let mut response = Response::new(body::full(DASHBOARD));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    // The page loads nothing from elsewhere, and nothing may frame it.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
             connect-src 'self'; img-src data:; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// `?range=7d&by=day` → a usage summary.
async fn usage(app: &App, query: &str) -> Response {
    let params = crate::net::form::decode(query);
    let param = |name: &str, default: &'static str| {
        params
            .iter()
            .find(|(k, _)| k == name)
            .map_or(default.to_owned(), |(_, v)| v.clone())
    };
    let (range, by) = (param("range", "7d"), param("by", "day"));
    let Some(since) = summary::since(&range, Timestamp::now()) else {
        return error(
            None,
            StatusCode::BAD_REQUEST,
            "range is today, 7d, 30d, or all",
        );
    };
    if !summary::GROUPS.contains(&by.as_str()) {
        return error(
            None,
            StatusCode::BAD_REQUEST,
            "by is day, model, or account",
        );
    }
    let names: HashMap<String, String> = app
        .pool
        .accounts()
        .into_iter()
        .map(|a| (a.id.clone(), a.name()))
        .collect();
    let (dir, prices) = (app.home.usage(), app.config());
    // Reading the ledger takes a moment: off the thread serving requests.
    let report =
        crate::blocking::run(move || summary::build(&dir, since, &by, &prices.prices, &names))
            .await;
    json_reply(StatusCode::OK, &report)
}

/// `?range=today|7d|30d` → what went through slopmax over the range, as
/// the desktop app charts it.
async fn history(app: &App, query: &str) -> Response {
    let range = crate::net::form::decode(query)
        .into_iter()
        .find_map(|(k, v)| (k == "range").then_some(v))
        .unwrap_or_else(|| "7d".to_owned());
    let Some(range) = history::Range::parse(&range) else {
        return error(None, StatusCode::BAD_REQUEST, "range is today, 7d, or 30d");
    };
    let names: HashMap<String, String> = app
        .pool
        .accounts()
        .into_iter()
        .map(|a| (a.id.clone(), a.name()))
        .collect();
    let home = app.home.clone();
    let config = app.config();
    // Reading a month of the ledger takes a moment: off the request threads.
    let history = crate::blocking::run(move || {
        let prices = history::Prices::of(&config);
        history::load(&home, range, Timestamp::now(), &prices, &names)
    })
    .await;
    json_reply(StatusCode::OK, &history)
}

/// The form fields of a POST, from its query and its body.
async fn form(request: Request, query: &str) -> Result<Vec<(String, String)>, String> {
    let body = body::read(request.into_body(), 64 * 1024)
        .await
        .map_err(|e| e.to_string())?;
    let text = format!("{query}&{}", String::from_utf8_lossy(&body));
    Ok(crate::net::form::decode(&text))
}

fn field<'a>(form: &'a [(String, String)], name: &str) -> Option<&'a str> {
    form.iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
}

/// `POST /slopmax/accounts` with `provider` (`anthropic`, `openai`, `xai`,
/// or `compat`), `key`, and for `compat` its `url`, `dialect`, and
/// `models`; `label` names it. The key is checked before it is saved.
async fn add_account(app: &App, form: &[(String, String)]) -> Response {
    let Some(provider) = field(form, "provider").and_then(|p| p.parse::<ProviderId>().ok()) else {
        return error(
            None,
            StatusCode::BAD_REQUEST,
            "provider is anthropic, openai, xai, or compat",
        );
    };
    if provider.spec().is_subscription() {
        let message = format!(
            "{} accounts sign in with a browser: `slopmax login {provider}`, or the app",
            provider.spec().title
        );
        return error(None, StatusCode::BAD_REQUEST, &message);
    }
    let endpoint = match (provider, field(form, "url")) {
        (ProviderId::Compat, None) => {
            return error(
                None,
                StatusCode::BAD_REQUEST,
                "a compatible endpoint needs its url",
            );
        }
        (ProviderId::Compat, Some(url)) => {
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return error(
                    None,
                    StatusCode::BAD_REQUEST,
                    "url is an http:// or https:// base URL",
                );
            }
            let dialect = match field(form, "dialect").unwrap_or("chat") {
                "chat" => crate::wire::Dialect::Chat,
                "responses" => crate::wire::Dialect::Responses,
                "messages" => crate::wire::Dialect::Messages,
                _ => {
                    return error(
                        None,
                        StatusCode::BAD_REQUEST,
                        "dialect is chat, responses, or messages",
                    );
                }
            };
            let models = field(form, "models")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_owned)
                .collect();
            Some(crate::account::Endpoint {
                base_url: url.trim_end_matches('/').to_owned(),
                dialect,
                models,
            })
        }
        _ => None,
    };
    let options = crate::auth::LoginOptions {
        endpoint,
        key: Some(field(form, "key").unwrap_or_default().to_owned()),
        ..crate::auth::LoginOptions::default()
    };
    let label = field(form, "label").map(str::to_owned);
    // A key needs no one to answer anything.
    let prompt = crate::auth::Prompt::new(|_| {});
    match crate::auth::connect(&app.store, provider, label, options, prompt).await {
        Ok(_) => reload(app, Ok(())),
        Err(e) => error(None, StatusCode::BAD_REQUEST, &format!("{e:#}")),
    }
}

/// The client keys, by name and the models each may use; the keys
/// themselves are shown once, when made.
fn keys(config: &Config) -> serde_json::Value {
    let keys: Vec<_> = config
        .keys
        .iter()
        .map(|k| json!({ "name": k.name, "models": k.models }))
        .collect();
    json!({ "keys": keys })
}

/// `POST /slopmax/keys` with `name` and, to hold it to some, `models`
/// (patterns, comma-separated): makes a key and answers it once.
fn add_key(app: &App, form: &[(String, String)]) -> Response {
    let Some(name) = field(form, "name") else {
        return error(None, StatusCode::BAD_REQUEST, "a key needs a name");
    };
    let models: Vec<String> = field(form, "models")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .collect();
    match Config::add_key(&app.home.config(), name, &models) {
        Ok(key) => {
            app.reload_config();
            json_reply(
                StatusCode::OK,
                &json!({ "name": name, "key": key, "models": models }),
            )
        }
        Err(e) => error(None, StatusCode::BAD_REQUEST, &format!("{e:#}")),
    }
}

fn remove_key(app: &App, name: &str) -> Response {
    match Config::remove_key(&app.home.config(), name) {
        Ok(true) => {
            app.reload_config();
            json_reply(StatusCode::OK, &keys(&app.config()))
        }
        Ok(false) => error(None, StatusCode::NOT_FOUND, "no such key"),
        Err(e) => error(None, StatusCode::INTERNAL_SERVER_ERROR, &format!("{e:#}")),
    }
}

/// The settings a front end may change while the proxy runs.
fn settings(config: &Config) -> serde_json::Value {
    let strategies: Vec<_> = Strategy::ALL
        .iter()
        .map(|s| json!({ "id": s.to_string(), "summary": s.summary() }))
        .collect();
    json!({
        "strategy": config.strategy,
        "strategies": strategies,
        "session_affinity": config.session_affinity,
        "session_ttl_mins": config.session_ttl_mins,
        "redeem_expiring_credits": config.redeem_expiring_credits,
        "redeem_when_exhausted": config.redeem_when_exhausted,
        "warm_windows": config.warm_windows,
        "paid_overflow": config.paid_overflow,
        "poll_mins": config.poll_mins,
    })
}

/// `POST /slopmax/settings` with any of [`settings`]' fields as form
/// values: writes them to config.toml, keeping its comments, and applies
/// them at once.
fn change_settings(app: &App, form: &str) -> Response {
    let mut values: Vec<(&str, toml_edit::Value)> = Vec::new();
    for (key, value) in crate::net::form::decode(form) {
        if key.is_empty() {
            continue;
        }
        match crate::config::live_value(&key, &value) {
            Ok(setting) => values.push(setting),
            Err(message) => return error(None, StatusCode::BAD_REQUEST, &message),
        }
    }
    if values.is_empty() {
        return error(None, StatusCode::BAD_REQUEST, "no settings to change");
    }
    let path = app.home.config();
    match Config::set(&path, &values) {
        Ok(mut config) => {
            let current = app.config();
            config.listen = current.listen;
            config.api_key.clone_from(&current.api_key);
            log::info!("settings changed from the API");
            let reply = settings(&config);
            app.set_config(config);
            json_reply(StatusCode::OK, &reply)
        }
        Err(e) => error(None, StatusCode::BAD_REQUEST, &format!("{e:#}")),
    }
}

/// A server-sent event for each request answered from now on.
fn events(app: &App) -> Response {
    let mut feed = app.events.subscribe();
    let stop = app.stop.clone();
    let (tx, rx) = mpsc::channel::<Bytes>(64);
    tokio::spawn(async move {
        let _ = tx.send(Bytes::from_static(b": connected\n\n")).await;
        loop {
            let chunk = tokio::select! {
                event = feed.recv() => match event {
                    Ok(line) => [&b"data: "[..], &line, b"\n\n"].concat().into(),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                () = tokio::time::sleep(KEEPALIVE) => Bytes::from_static(b": keepalive\n\n"),
                // The daemon is stopping: end the stream so it can.
                () = stop.cancelled() => break,
            };
            // The client went away.
            if tx.send(chunk).await.is_err() {
                break;
            }
        }
    });
    let mut response = Response::new(body::boxed(Feed(rx)));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// A body fed from a channel.
struct Feed(mpsc::Receiver<Bytes>);

impl HttpBody for Feed {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|chunk| chunk.map(|c| Ok(Frame::data(c))))
    }
}

fn unpin(app: &App) -> Response {
    reload(app, unpin_all(&app.home))
}

/// `POST /slopmax/accounts/<id>/<action>`: enable, disable, use, redeem (a
/// reset credit: `?value=<credit id>`, else the soonest to expire), remove,
/// priority (`?value=N`), or label (`?value=name`, empty to clear).
async fn account(app: &App, id: &str, action: &str, query: &str) -> Response {
    let Some(account) = app.pool.accounts().into_iter().find(|a| a.id == id) else {
        return error(None, StatusCode::NOT_FOUND, "no such account");
    };
    let id = account.id.clone();
    let value = crate::net::form::decode(query)
        .into_iter()
        .find_map(|(k, v)| (k == "value").then_some(v));
    // The account's lock is waited for while a refresh holds it, so the
    // change is made on a blocking thread.
    let (store, home) = (app.store.clone(), app.home.clone());
    let change: Box<dyn FnOnce() -> anyhow::Result<()> + Send> = match action {
        "enable" | "disable" => {
            let disabled = action == "disable";
            Box::new(move || store.update(&id, |a| a.disabled = disabled).map(|_| ()))
        }
        "priority" => {
            let Some(priority) = value.and_then(|v| v.parse::<i32>().ok()) else {
                return error(
                    None,
                    StatusCode::BAD_REQUEST,
                    "priority needs ?value=<number>",
                );
            };
            Box::new(move || store.update(&id, |a| a.priority = priority).map(|_| ()))
        }
        "label" => {
            let label = value.filter(|v| !v.trim().is_empty());
            Box::new(move || store.update(&id, |a| a.label = label).map(|_| ()))
        }
        "use" => Box::new(move || pin(&home, &account)),
        // Refresh here, rather than follow the tool it was imported from.
        "own" => Box::new(move || store.update(&id, |a| a.link = None).map(|_| ())),
        "remove" => Box::new(move || forget(&store, &home, &account)),
        "redeem" => return redeem(app, &account, value).await,
        _ => return error(None, StatusCode::NOT_FOUND, "no such account action"),
    };
    let changed = crate::blocking::run(change).await;
    reload(app, changed)
}

/// Picks up a change on disk right away, then reports.
fn reload(app: &App, changed: anyhow::Result<()>) -> Response {
    if let Err(e) = changed.and_then(|()| app.sync()) {
        return error(None, StatusCode::INTERNAL_SERVER_ERROR, &format!("{e:#}"));
    }
    json_reply(StatusCode::OK, &app.report())
}

/// Redeems `credit`, or the account's soonest to expire as listed now, and
/// answers how it went with the report.
async fn redeem(app: &App, account: &crate::account::Account, credit: Option<String>) -> Response {
    let Some(credits) = account.provider.get().credits() else {
        return error(
            None,
            StatusCode::BAD_REQUEST,
            "this account has no limit resets",
        );
    };
    let _redeeming = app.redeeming.lock().await;
    let Some(account) = app.ready(account).await else {
        return error(
            None,
            StatusCode::CONFLICT,
            "the account needs signing in again",
        );
    };
    let agent = app.pool.agent(account.provider);
    let credit = match credit {
        Some(credit) => credit,
        None => match credits
            .list(&app.auth_http, &account, agent.as_deref())
            .await
        {
            Ok(listed) => {
                let soonest = listed.first().map(|c| c.id.clone());
                app.pool
                    .record_credits(&account.id, listed, Timestamp::now());
                match soonest {
                    Some(credit) => credit,
                    None => {
                        return json_reply(
                            StatusCode::OK,
                            &json!({ "outcome": Outcome::NoCredit, "report": app.report() }),
                        );
                    }
                }
            }
            Err(e) => return error(None, StatusCode::BAD_GATEWAY, &format!("{e:#}")),
        },
    };
    match credits
        .redeem(&app.auth_http, &account, agent.as_deref(), Some(&credit))
        .await
    {
        Ok(outcome) => {
            if outcome == Outcome::Reset {
                log::info!("{}: redeemed a limit reset on request", account.id);
                app.pool
                    .record_reset(&account.id, Timestamp::now(), Some(&credit));
            }
            json_reply(
                StatusCode::OK,
                &json!({ "outcome": outcome, "report": app.report() }),
            )
        }
        Err(e) => error(None, StatusCode::BAD_GATEWAY, &format!("{e:#}")),
    }
}
