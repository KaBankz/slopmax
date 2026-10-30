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
            app.shutdown.notify_one();
            json_reply(StatusCode::OK, &json!({ "status": "stopping" }))
        }
        (&Method::GET, ["usage"]) => usage(&app, &query),
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
fn usage(app: &App, query: &str) -> Response {
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
    let report = summary::build(&app.home.usage(), since, &by, &app.config().prices, &names);
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
    let dir = app.home.usage();
    let prices = app.config().prices.clone();
    // Reading a month of the ledger takes a moment: off the request threads.
    let loaded = tokio::task::spawn_blocking(move || {
        history::load(&dir, range, Timestamp::now(), &prices, &names)
    })
    .await;
    match loaded {
        Ok(history) => json_reply(StatusCode::OK, &history),
        Err(e) => error(None, StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
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
    })
}

/// `POST /slopmax/settings` with any of [`settings`]' fields as form
/// values: writes them to config.toml, keeping its comments, and applies
/// them at once.
fn change_settings(app: &App, form: &str) -> Response {
    let mut values: Vec<(&str, toml_edit::Value)> = Vec::new();
    for (key, value) in crate::net::form::decode(form) {
        let value = value.trim();
        let parsed = match key.as_str() {
            "strategy" => match Strategy::parse(value) {
                Some(strategy) => toml_edit::Value::from(strategy.to_string()),
                None => {
                    let names: Vec<String> = Strategy::ALL.iter().map(|s| s.to_string()).collect();
                    let message = format!("strategy is one of {}", names.join(", "));
                    return error(None, StatusCode::BAD_REQUEST, &message);
                }
            },
            "session_ttl_mins" => match value.parse::<i64>() {
                Ok(mins) if mins > 0 => toml_edit::Value::from(mins),
                _ => {
                    return error(
                        None,
                        StatusCode::BAD_REQUEST,
                        "session_ttl_mins is a number of minutes",
                    );
                }
            },
            "session_affinity"
            | "redeem_expiring_credits"
            | "redeem_when_exhausted"
            | "warm_windows"
            | "paid_overflow" => match value {
                "true" | "on" | "1" => toml_edit::Value::from(true),
                "false" | "off" | "0" => toml_edit::Value::from(false),
                _ => {
                    let message = format!("{key} is true or false");
                    return error(None, StatusCode::BAD_REQUEST, &message);
                }
            },
            "" => continue,
            _ => {
                let message = format!("{key} is not a setting slopmax changes while it runs");
                return error(None, StatusCode::BAD_REQUEST, &message);
            }
        };
        let key: &'static str = SETTABLE.iter().find(|k| **k == key).expect("matched above");
        values.push((key, parsed));
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
            json_reply(StatusCode::OK, &{
                let reply = settings(&config);
                app.set_config(config);
                reply
            })
        }
        Err(e) => error(None, StatusCode::BAD_REQUEST, &format!("{e:#}")),
    }
}

/// The settings [`change_settings`] takes.
const SETTABLE: &[&str] = &[
    "strategy",
    "session_ttl_mins",
    "session_affinity",
    "redeem_expiring_credits",
    "redeem_when_exhausted",
    "warm_windows",
    "paid_overflow",
];

/// A server-sent event for each request answered from now on.
fn events(app: &App) -> Response {
    let mut feed = app.events.subscribe();
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
    let changed = match action {
        "enable" | "disable" => {
            let disabled = action == "disable";
            app.store.update(&id, |a| a.disabled = disabled).map(|_| ())
        }
        "priority" => {
            let Some(priority) = value.and_then(|v| v.parse::<i32>().ok()) else {
                return error(
                    None,
                    StatusCode::BAD_REQUEST,
                    "priority needs ?value=<number>",
                );
            };
            app.store.update(&id, |a| a.priority = priority).map(|_| ())
        }
        "label" => {
            let label = value.filter(|v| !v.trim().is_empty());
            app.store.update(&id, |a| a.label = label).map(|_| ())
        }
        "use" => pin(&app.home, &account),
        "remove" => forget(&app.store, &app.home, &account),
        "redeem" => return redeem(app, &account, value).await,
        _ => return error(None, StatusCode::NOT_FOUND, "no such account action"),
    };
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
