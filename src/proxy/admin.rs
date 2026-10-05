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
use crate::net::body;
use crate::net::server::{Request, Response};
use crate::provider::credits::Outcome;
use crate::time::Timestamp;
use crate::{account as accounts, daemon, log, summary};

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
    if !authorized(&app.config, request.headers()) {
        return error(
            None,
            StatusCode::UNAUTHORIZED,
            "missing or invalid slopmax key; see `slopmax env`",
        );
    }
    let segments: Vec<&str> = path.trim_start_matches("/slopmax/").split('/').collect();
    match (&method, segments.as_slice()) {
        (&Method::GET, ["status"]) => json_reply(StatusCode::OK, &app.report()),
        // Polls every account's usage now, then reports.
        (&Method::POST, ["refresh"]) => {
            daemon::poll_all(&app, true).await;
            json_reply(StatusCode::OK, &app.report())
        }
        // Picks up changes on disk now, then reports.
        (&Method::POST, ["sync"]) => reload(&app, Ok(())),
        (&Method::POST, ["shutdown"]) => {
            app.shutdown.notify_one();
            json_reply(StatusCode::OK, &json!({ "status": "stopping" }))
        }
        (&Method::GET, ["usage"]) => usage(&app, &query),
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
    let report = summary::build(&app.home.usage(), since, &by, &app.config.prices, &names);
    json_reply(StatusCode::OK, &report)
}

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
    reload(app, accounts::unpin_all(&app.home))
}

/// `POST /slopmax/accounts/<id>/<action>`: enable, disable, use, redeem,
/// remove, priority (`?value=N`), or label (`?value=name`, empty to clear).
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
        "use" => accounts::pin(&app.home, &account),
        "remove" => accounts::forget(&app.store, &app.home, &account),
        "redeem" => return redeem(app, &account).await,
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

async fn redeem(app: &App, account: &crate::account::Account) -> Response {
    let Some(credits) = account.provider.get().credits() else {
        return error(
            None,
            StatusCode::BAD_REQUEST,
            "this account has no reset credits",
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
    match credits.redeem(&app.auth_http, &account, None).await {
        Ok(outcome) => {
            if outcome == Outcome::Reset {
                log::info!("{}: redeemed a reset credit from the dashboard", account.id);
                app.pool.record_reset(&account.id, Timestamp::now());
            }
            json_reply(
                StatusCode::OK,
                &json!({ "outcome": outcome, "report": app.report() }),
            )
        }
        Err(e) => error(None, StatusCode::BAD_GATEWAY, &format!("{e:#}")),
    }
}
