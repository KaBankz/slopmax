//! `/slopmax/api/*`: slopmax's typed API ([`slopmax_api`]).
//!
//! A request is parsed once into a [`Route`] and matched exhaustively, so
//! every endpoint is listed in one place. Handlers return the API's types
//! or an [`ApiError`], which goes out as its `_tag`ged body and status.
//! Bodies are capped at 64 KiB and read strictly: a key the API does not
//! know is refused. Each endpoint names the access it needs: the owner key
//! and admin machines may do everything, the tailnet's other machines of
//! the user may look, and client keys reach none of it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode, header};
use serde::Serialize;
use serde::de::DeserializeOwned;
use slopmax_api::events::{Event, LoginEvent};
use slopmax_api::ledger::{HistoryRange, RequestOutcome, Sender, SummaryBy, SummaryRange};
use slopmax_api::report::{AgentWiring, Finding, Level, RedeemOutcome, RedeemResult, Section};
use slopmax_api::requests::{
    AccountAdded, AccountPatch, AddAccount, AgentConnected, AgentDisconnected, ImportOutcome,
    ImportRequest, ImportResult, ImportSource, LoginStarted, MakeKey, PasteAddress, RedeemRequest,
    Shutdown, StartLogin, Stopping, StoppingStatus,
};
use slopmax_api::settings::{LivePatch, NewKey, SettingsView};
use slopmax_api::tailnet::{Access, TailnetPatch, TailnetView};
use slopmax_api::{AgentId, ApiError};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use super::tailnet::Seen;
use super::{App, Caller, Denied, RedeemError};
use crate::config::Config;
use crate::net::body;
use crate::net::server::{Channel, Request, Response};
use crate::provider::credits::Outcome;
use crate::tailscale::{self, Target};
use crate::time::Timestamp;
use crate::{api, doctor, log, summary};

/// Largest request body read.
const MAX_BODY: usize = 64 * 1024;
/// How often an open event stream says it is still there.
const PING: Duration = Duration::from_secs(15);
/// How often an open event stream checks whether the report changed.
const STATUS_EVERY: Duration = Duration::from_secs(1);

type Answer = Result<Response, ApiError>;

/// One endpoint, with what its path names.
#[derive(Debug, PartialEq, Eq)]
enum Route<'a> {
    Status,
    Refresh,
    Sync,
    Shutdown,
    Doctor,
    AddAccount,
    UpdateAccount(&'a str),
    Pin(&'a str),
    UnpinAll,
    Own(&'a str),
    RemoveAccount(&'a str),
    Redeem(&'a str),
    Check(&'a str),
    Import,
    StartLogin,
    PasteLogin(&'a str),
    CancelLogin(&'a str),
    Settings,
    ChangeSettings,
    Keys,
    MakeKey,
    RemoveKey(String),
    Agents,
    Connect(AgentId),
    Disconnect(AgentId),
    Usage,
    History,
    Pool(slopmax_api::Provider),
    Requests,
    Events,
    NotifyTest,
    Tailnet,
    ChangeTailnet,
}

impl<'a> Route<'a> {
    /// The endpoint `method` and `path` (below the API's prefix) name.
    fn parse(method: &Method, path: &'a str) -> Option<Self> {
        let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
        let agent = |id: &str| serde_json::from_value::<AgentId>(id.into()).ok();
        let provider = |id: &str| serde_json::from_value::<slopmax_api::Provider>(id.into()).ok();
        Some(match (method, segments.as_slice()) {
            (&Method::GET, ["status"]) => Self::Status,
            (&Method::POST, ["refresh"]) => Self::Refresh,
            (&Method::POST, ["sync"]) => Self::Sync,
            (&Method::POST, ["shutdown"]) => Self::Shutdown,
            (&Method::GET, ["doctor"]) => Self::Doctor,
            (&Method::POST, ["accounts"]) => Self::AddAccount,
            (&Method::PATCH, ["accounts", id]) => Self::UpdateAccount(id),
            (&Method::DELETE, ["accounts", id]) => Self::RemoveAccount(id),
            (&Method::POST, ["accounts", id, "pin"]) => Self::Pin(id),
            (&Method::POST, ["accounts", id, "own"]) => Self::Own(id),
            (&Method::POST, ["accounts", id, "redeem"]) => Self::Redeem(id),
            (&Method::POST, ["accounts", id, "check"]) => Self::Check(id),
            (&Method::DELETE, ["pins"]) => Self::UnpinAll,
            (&Method::POST, ["imports"]) => Self::Import,
            (&Method::POST, ["logins"]) => Self::StartLogin,
            (&Method::POST, ["logins", id, "paste"]) => Self::PasteLogin(id),
            (&Method::DELETE, ["logins", id]) => Self::CancelLogin(id),
            (&Method::GET, ["settings"]) => Self::Settings,
            (&Method::PATCH, ["settings"]) => Self::ChangeSettings,
            (&Method::GET, ["keys"]) => Self::Keys,
            (&Method::POST, ["keys"]) => Self::MakeKey,
            (&Method::DELETE, ["keys", name]) => {
                Self::RemoveKey(crate::net::form::percent_decode(name))
            }
            (&Method::GET, ["agents"]) => Self::Agents,
            (&Method::POST, ["agents", id, "connect"]) => Self::Connect(agent(id)?),
            (&Method::POST, ["agents", id, "disconnect"]) => Self::Disconnect(agent(id)?),
            (&Method::GET, ["usage"]) => Self::Usage,
            (&Method::GET, ["history"]) => Self::History,
            (&Method::GET, ["pools", id]) => Self::Pool(provider(id)?),
            (&Method::GET, ["requests"]) => Self::Requests,
            (&Method::GET, ["events"]) => Self::Events,
            (&Method::POST, ["notify", "test"]) => Self::NotifyTest,
            (&Method::GET, ["tailnet"]) => Self::Tailnet,
            (&Method::PATCH, ["tailnet"]) => Self::ChangeTailnet,
            _ => return None,
        })
    }

    /// What a caller may do to use it: look, or manage.
    fn needs(&self) -> Access {
        match self {
            Self::Status
            | Self::Usage
            | Self::History
            | Self::Pool(_)
            | Self::Events
            | Self::Tailnet => Access::View,
            Self::Refresh
            | Self::Sync
            | Self::Shutdown
            | Self::Doctor
            | Self::AddAccount
            | Self::UpdateAccount(_)
            | Self::Pin(_)
            | Self::UnpinAll
            | Self::Own(_)
            | Self::RemoveAccount(_)
            | Self::Redeem(_)
            | Self::Import
            | Self::StartLogin
            | Self::PasteLogin(_)
            | Self::CancelLogin(_)
            | Self::Settings
            | Self::ChangeSettings
            | Self::Keys
            | Self::MakeKey
            | Self::RemoveKey(_)
            | Self::Agents
            | Self::Connect(_)
            | Self::Disconnect(_)
            | Self::NotifyTest
            | Self::ChangeTailnet => Access::Admin,
        }
    }
}

/// Who asked, as far as the answer depends on it.
struct Asker {
    /// What they may do.
    access: Access,
    /// Whether they are this machine's own: the owner key, over TCP.
    here: bool,
    /// The request's headers and what it said about where it came from,
    /// for an event stream to check them again as the config changes.
    headers: http::HeaderMap,
    seen: Seen,
}

/// Answers a request under `/slopmax/api/`.
pub(super) async fn handle(app: Arc<App>, request: Request, seen: &Seen) -> Response {
    let (parts, incoming) = request.into_parts();
    let path = parts
        .uri
        .path()
        .trim_start_matches(slopmax_api::PREFIX)
        .to_owned();
    let query = parts.uri.query().unwrap_or("").to_owned();
    let config = app.config();
    let Some(route) = Route::parse(&parts.method, &path) else {
        // Only a caller slopmax knows learns which endpoints there are.
        return match super::caller(&app, &config, &parts.headers, seen, Access::Use).await {
            Ok(_) => fail(&ApiError::not_found("slopmax endpoint")),
            Err(denied) => refuse(&denied),
        };
    };
    let asker = match super::caller(&app, &config, &parts.headers, seen, route.needs()).await {
        Ok(caller) => Asker {
            access: caller.access(),
            here: matches!(caller, Caller::Owner) && seen.channel == Channel::Tcp,
            headers: parts.headers.clone(),
            seen: seen.clone(),
        },
        Err(denied) => return refuse(&denied),
    };
    drop(config);
    let body = match body::read(incoming, MAX_BODY).await {
        Ok(body) => body,
        Err(e) => return fail(&ApiError::bad_request(format!("reading the body: {e}"))),
    };
    match answer(&app, route, &query, &body, asker).await {
        Ok(response) => response,
        Err(error) => fail(&error),
    }
}

/// A refusal, as the API's error: `Unauthorized`, with 401 or 403 as the
/// reason has it.
fn refuse(denied: &Denied) -> Response {
    let (status, message) = denied.answer();
    json(status, &ApiError::Unauthorized { message })
}

async fn answer(
    app: &Arc<App>,
    route: Route<'_>,
    query: &str,
    body: &[u8],
    asker: Asker,
) -> Answer {
    match route {
        Route::Status => ok(&app.api_report()),
        Route::Refresh => {
            app.refresh().await;
            ok(&app.api_report())
        }
        Route::Sync => {
            app.reload_config();
            changed(app, Ok(()))
        }
        Route::Shutdown => {
            let asked: Shutdown = optional(body)?;
            let stopping = Stopping {
                status: StoppingStatus::Stopping,
            };
            // Both name this machine's processes and files: a binary to run,
            // a daemon to make way for. Only its own slopmax may ask.
            let elsewhere =
                asked.make_way || asked.exe.as_ref().is_some_and(|e| !e.trim().is_empty());
            if elsewhere && !asker.here {
                return Ok(json(
                    StatusCode::FORBIDDEN,
                    &ApiError::Unauthorized {
                        message:
                            "only slopmax on the hub itself may move its proxy to another process"
                                .into(),
                    },
                ));
            }
            if asked.make_way {
                return match crate::handoff::make_way(app).await {
                    Ok(()) => ok(&stopping),
                    Err(e) => Err(ApiError::conflict(format!("{e:#}"))),
                };
            }
            if let Some(exe) = asked.exe.filter(|e| !e.trim().is_empty()) {
                return match crate::handoff::hand_off(app, std::path::Path::new(&exe), false).await
                {
                    Ok(()) => ok(&stopping),
                    Err(e) => Err(ApiError::conflict(format!("{e:#}"))),
                };
            }
            if asked.restart {
                // Into a new process on the same socket where it can be
                // handed over: the binary the service runs, else this one.
                let exe = Some(app.home.service_exe())
                    .filter(|p| p.exists())
                    .or_else(|| app.running.as_ref().map(|r| r.path.clone()));
                if cfg!(unix)
                    && let Some(exe) = exe
                    && crate::handoff::hand_off(app, &exe, false).await.is_ok()
                {
                    return ok(&stopping);
                }
                app.restart
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            app.stop.cancel();
            ok(&stopping)
        }
        Route::Doctor => doctor(app).await,
        Route::AddAccount => add_account(app, strict(body)?).await,
        Route::UpdateAccount(id) => update_account(app, id, strict(body)?).await,
        Route::Pin(id) => {
            let account = find(app, id)?;
            app.pool.pin(account.provider, &account.id);
            crate::save_soon(app);
            ok(&app.api_report())
        }
        Route::UnpinAll => {
            app.pool.unpin_all();
            crate::save_soon(app);
            ok(&app.api_report())
        }
        Route::Own(id) => {
            let id = find(app, id)?.id.clone();
            let store = app.store.clone();
            let owned =
                crate::blocking::run(move || store.update(&id, |a| a.link = None).map(|_| ()))
                    .await;
            changed(app, owned)
        }
        Route::RemoveAccount(id) => {
            let account = find(app, id)?;
            app.pool.unpin(&account.id);
            crate::save_soon(app);
            let store = app.store.clone();
            changed(
                app,
                crate::blocking::run(move || store.remove(&account.id)).await,
            )
        }
        Route::Redeem(id) => redeem(app, id, optional(body)?).await,
        Route::Check(id) => {
            // Lifts slopmax's own hold on the account, then reads its usage
            // again (when usage polling is on), so a limit that has passed
            // shows at once and one that has not is set aside anew.
            let account = find(app, id)?;
            app.pool.clear_blocks(&account.id);
            if app.config().poll_mins > 0
                && account.auth_error.is_none()
                && account.provider.spec().is_subscription()
            {
                crate::poll_one(app, &account).await;
            }
            crate::save_soon(app);
            ok(&app.api_report())
        }
        Route::Import => import(app, optional(body)?).await,
        Route::StartLogin => start_login(app, strict(body)?),
        Route::PasteLogin(id) => {
            let PasteAddress { address } = strict(body)?;
            let logins = app.logins.lock().unwrap_or_else(|p| p.into_inner());
            let login = logins
                .get(id)
                .ok_or_else(|| ApiError::not_found("sign-in"))?;
            let _ = login.paste.send(address);
            empty()
        }
        Route::CancelLogin(id) => {
            let login = app
                .logins
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(id)
                .ok_or_else(|| ApiError::not_found("sign-in"))?;
            login.cancel.cancel();
            empty()
        }
        Route::Settings => ok(&settings_view(app)),
        Route::ChangeSettings => change_settings(app, body),
        Route::Keys => ok(&keys(&app.config())),
        Route::MakeKey => make_key(app, strict(body)?),
        Route::RemoveKey(name) => match Config::remove_key(&app.home.config(), &name) {
            Ok(true) => {
                app.reload_config();
                ok(&keys(&app.config()))
            }
            Ok(false) => Err(ApiError::not_found("key")),
            Err(e) => Err(e.into()),
        },
        Route::Agents => ok(&agents(&app.config(), &app.home)),
        Route::Connect(id) => connect_agent(app, id).await,
        Route::Disconnect(id) => disconnect_agent(app, id).await,
        Route::Usage => usage(app, query, asker.here).await,
        Route::History => history(app, query).await,
        Route::Requests => requests(app, query).await,
        Route::Pool(provider) => match app.pool_detail(api::provider_id(provider)).await {
            Some(detail) => ok(&detail),
            None => Err(ApiError::not_found("pool")),
        },
        Route::Events => Ok(events(app, asker)),
        Route::NotifyTest => notify_test(app).await,
        Route::Tailnet => ok(&tailnet_view(app).await),
        Route::ChangeTailnet => change_tailnet(app, strict(body)?).await,
    }
}

/// An answer of `value` as JSON.
fn ok(value: &impl Serialize) -> Answer {
    Ok(json(StatusCode::OK, value))
}

/// An answer with no body, for endpoints that return nothing.
fn empty() -> Answer {
    let mut response = Response::new(body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    Ok(response)
}

fn json(status: StatusCode, value: &impl Serialize) -> Response {
    let body = serde_json::to_vec(value).expect("API types serialize");
    let mut response = Response::new(body::full(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn fail(error: &ApiError) -> Response {
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    json(status, error)
}

/// A body read strictly: what it is missing or has too many of, as a 400.
fn strict<T: DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|e| ApiError::bad_request(clean(&e)))
}

/// A body every field of which may be left out, as may the body itself.
fn optional<T: DeserializeOwned + Default>(body: &[u8]) -> Result<T, ApiError> {
    if body.trim_ascii().is_empty() || body.trim_ascii() == b"null" {
        return Ok(T::default());
    }
    strict(body)
}

/// serde's message without its position, which means nothing to a person.
fn clean(error: &serde_json::Error) -> String {
    let text = error.to_string();
    match text.find(" at line ") {
        Some(at) => text[..at].to_owned(),
        None => text,
    }
}

/// The account `id` names, as the pool holds it.
fn find(app: &App, id: &str) -> Result<crate::account::Account, ApiError> {
    let known = |app: &App| {
        app.pool
            .account(id)
            .map(|a| crate::account::Account::clone(&a))
    };
    if let Some(account) = known(app) {
        return Ok(account);
    }
    // One saved since the proxy last read its accounts, as by a tool
    // writing the files itself.
    let _ = app.sync();
    known(app).ok_or_else(|| ApiError::NotFound {
        what: "account".into(),
        message: format!("no account {id}; `slopmax status` lists them"),
    })
}

/// Applies a change made on disk at once, then reports.
fn changed(app: &App, change: Result<(), crate::error::StoreError>) -> Answer {
    change?;
    app.sync()
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    ok(&app.api_report())
}

async fn doctor(app: &App) -> Answer {
    let sections = doctor::check(&app.config(), &app.store, &app.home, app.tailscale_cli())
        .await
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    let sections: Vec<Section> = sections
        .into_iter()
        .map(|s| Section {
            title: s.title.into(),
            findings: s
                .findings
                .into_iter()
                .map(|f| Finding {
                    level: match f.level {
                        doctor::Level::Ok => Level::Ok,
                        doctor::Level::Note => Level::Info,
                        doctor::Level::Warn => Level::Warn,
                        doctor::Level::Fail => Level::Fail,
                    },
                    text: f.text,
                    fix: f.fix,
                })
                .collect(),
        })
        .collect();
    ok(&sections)
}

async fn add_account(app: &App, add: AddAccount) -> Answer {
    let (provider, key, label, endpoint) = match add {
        AddAccount::Key {
            provider,
            key,
            label,
        } => {
            let provider = api::provider_id(provider);
            if provider.spec().is_subscription() {
                return Err(ApiError::bad_request(format!(
                    "{} accounts sign in with a browser: `slopmax login {provider}`, or the app",
                    provider.spec().title
                )));
            }
            if provider == crate::provider::ProviderId::Compat {
                return Err(ApiError::bad_request(
                    "a compatible endpoint is added with its url, as an Endpoint",
                ));
            }
            (provider, Some(key), label, None)
        }
        AddAccount::Endpoint {
            url,
            dialect,
            models,
            key,
            label,
        } => {
            let url = url.trim().trim_end_matches('/').to_owned();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(ApiError::bad_request(
                    "url is an http:// or https:// base URL",
                ));
            }
            let endpoint = crate::account::Endpoint {
                base_url: url,
                dialect: api::wire_dialect(dialect),
                models: models
                    .into_iter()
                    .map(|m| m.trim().to_owned())
                    .filter(|m| !m.is_empty())
                    .collect(),
            };
            (
                crate::provider::ProviderId::Compat,
                key,
                label,
                Some(endpoint),
            )
        }
    };
    let options = crate::auth::LoginOptions {
        endpoint,
        key: Some(key.unwrap_or_default()),
        ..crate::auth::LoginOptions::default()
    };
    let label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
    // What the check of the key says, for the answer.
    let notices = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let told = notices.clone();
    let prompt = crate::auth::Prompt::new(move |event| {
        if let crate::auth::LoginEvent::Notice(text) = event {
            told.lock().unwrap_or_else(|e| e.into_inner()).push(text);
        }
    });
    let (account, _) = crate::auth::connect(&app.store, provider, label, options, prompt).await?;
    let notices = std::mem::take(&mut *notices.lock().unwrap_or_else(|e| e.into_inner()));
    app.sync()
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    let report = app.api_report();
    let account = report
        .accounts
        .iter()
        .find(|a| a.id == account.id)
        .cloned()
        .ok_or_else(|| ApiError::internal("the account was saved but is not listed"))?;
    ok(&AccountAdded {
        account,
        report,
        notices,
    })
}

async fn update_account(app: &App, id: &str, patch: AccountPatch) -> Answer {
    let id = find(app, id)?.id.clone();
    if let Some(Some(label)) = &patch.label
        && !label.trim().is_empty()
    {
        app.store.check_label(label.trim(), &id)?;
    }
    let store = app.store.clone();
    let updated = crate::blocking::run(move || {
        store
            .update(&id, |a| {
                if let Some(label) = patch.label {
                    a.label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
                }
                if let Some(priority) = patch.priority {
                    a.priority = priority;
                }
                if let Some(order) = patch.order {
                    a.order = Some(order);
                }
                if let Some(disabled) = patch.disabled {
                    a.disabled = disabled;
                }
            })
            .map(|_| ())
    })
    .await;
    changed(app, updated)
}

async fn redeem(app: &App, id: &str, asked: RedeemRequest) -> Answer {
    let account = find(app, id)?;
    let outcome = match app.redeem(&account, asked.reset.as_deref(), None).await {
        Ok(outcome) => outcome,
        Err(RedeemError::NoResets) => {
            return Err(ApiError::bad_request(
                "this account's provider has no limit resets",
            ));
        }
        Err(RedeemError::SignedOut) => {
            return Err(ApiError::conflict("the account needs signing in again"));
        }
        Err(RedeemError::Failed(e)) => return Err(crate::error::ProviderError::Failed(e).into()),
    };
    let outcome = match outcome {
        Outcome::Reset => RedeemOutcome::Reset,
        Outcome::NothingToReset => RedeemOutcome::NothingToReset,
        Outcome::NoCredit => RedeemOutcome::NoCredit,
        Outcome::AlreadyRedeemed => RedeemOutcome::AlreadyRedeemed,
        Outcome::Declined => RedeemOutcome::Declined,
    };
    ok(&RedeemResult {
        outcome,
        report: app.api_report(),
    })
}

async fn import(app: &App, asked: ImportRequest) -> Answer {
    use crate::import::{self, Source};
    let sources = asked.sources.unwrap_or_else(|| {
        vec![
            ImportSource::ClaudeCode,
            ImportSource::Codex,
            ImportSource::CliProxyApi,
        ]
    });
    let mut outcomes = Vec::new();
    for source in sources {
        let from = match source {
            ImportSource::ClaudeCode => Source::ClaudeCode,
            ImportSource::Codex => Source::Codex,
            ImportSource::CliProxyApi => Source::Cliproxyapi,
        };
        let found = import::discover(&app.auth_http, from, &app.home).await;
        let (store, own) = (app.store.clone(), asked.own);
        let saved = crate::blocking::run(move || import::save(&store, found, own)).await;
        app.sync()
            .map_err(|e| ApiError::internal(format!("{e:#}")))?;
        let report = app.report();
        let now = Timestamp::now();
        for saved in saved {
            outcomes.push(match saved.account {
                Ok((account, is_new)) => {
                    match report.accounts.iter().find(|a| a.id == account.id) {
                        Some(view) => ImportOutcome::Saved {
                            source,
                            origin: saved.origin,
                            account: Box::new(api::account(view, now)),
                            is_new,
                        },
                        None => ImportOutcome::Failed {
                            source,
                            origin: saved.origin,
                            message: "saved, but not listed".into(),
                        },
                    }
                }
                Err(e) => ImportOutcome::Failed {
                    source,
                    origin: saved.origin,
                    message: format!("{e:#}"),
                },
            });
        }
    }
    ok(&ImportResult {
        outcomes,
        report: app.api_report(),
    })
}

/// A sign-in running for the API: where pasted addresses go, and how to
/// stop it.
pub(crate) struct Login {
    paste: mpsc::UnboundedSender<String>,
    cancel: CancellationToken,
}

/// Starts a sign-in whose progress goes out as `Login` events, and answers
/// with its id at once.
fn start_login(app: &Arc<App>, asked: StartLogin) -> Answer {
    let provider = api::provider_id(asked.provider);
    if !provider.spec().is_subscription() {
        return Err(ApiError::bad_request(
            "only claude, codex and grok accounts sign in",
        ));
    }
    let id = crate::ids::token()[..16].to_owned();
    let (paste, pasted) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    app.logins.lock().unwrap_or_else(|p| p.into_inner()).insert(
        id.clone(),
        Login {
            paste,
            cancel: cancel.clone(),
        },
    );
    let tell = {
        let (events, id) = (app.api_events.clone(), id.clone());
        move |event: LoginEvent| {
            let frame = Event::Login {
                id: id.clone(),
                event,
            }
            .frame();
            let _ = events.send(frame.into());
        }
    };
    let prompt = crate::auth::Prompt::new({
        let tell = tell.clone();
        move |event| {
            tell(match event {
                crate::auth::LoginEvent::Authorize {
                    title,
                    url,
                    opened,
                    port,
                } => LoginEvent::Authorize {
                    title: title.into(),
                    url,
                    port,
                    opened,
                },
                crate::auth::LoginEvent::DeviceCode { url, code } => {
                    LoginEvent::DeviceCode { url, code }
                }
                crate::auth::LoginEvent::Notice(text) => LoginEvent::Note { text },
            })
        }
    })
    .with_pasted(pasted);
    let options = crate::auth::LoginOptions {
        device: asked.device,
        no_browser: asked.no_browser,
        ..crate::auth::LoginOptions::default()
    };
    let label = asked
        .label
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty());
    let (worker, login_id) = (Arc::clone(app), id.clone());
    app.spawn(async move {
        let signing = crate::auth::connect(&worker.store, provider, label, options, prompt);
        let result = tokio::select! {
            result = signing => Some(result),
            () = cancel.cancelled() => None,
            () = worker.stop.cancelled() => None,
        };
        worker
            .logins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&login_id);
        match result {
            Some(Ok((account, is_new))) => {
                let _ = worker.sync();
                let now = Timestamp::now();
                let report = worker.report();
                if let Some(view) = report.accounts.iter().find(|a| a.id == account.id) {
                    tell(LoginEvent::Done {
                        account: Box::new(api::account(view, now)),
                        is_new,
                    });
                }
            }
            Some(Err(e)) => tell(LoginEvent::Failed {
                message: format!("{e:#}"),
            }),
            None => tell(LoginEvent::Failed {
                message: "the sign-in was cancelled".into(),
            }),
        }
    });
    ok(&LoginStarted { id })
}

fn settings_view(app: &App) -> SettingsView {
    let running = app.config();
    // What the file says but needs a restart to apply.
    let file = Config::load_from(&app.home.config()).ok();
    let mut restart = Vec::new();
    if let Some(file) = &file {
        if file.listen != running.listen && std::env::var_os("SLOPMAX_LISTEN").is_none() {
            restart.push("listen".to_owned());
        }
        if file.proxy != running.proxy {
            restart.push("upstreamProxy".to_owned());
        }
    }
    SettingsView::new(api::settings(&running), restart)
}

fn change_settings(app: &App, body: &[u8]) -> Answer {
    let patch = LivePatch::from_json(body).map_err(ApiError::bad_request)?;
    let values: Vec<(&str, toml_edit::Value)> = patch
        .changes()
        .into_iter()
        .map(|(live, value)| (live.toml, api::toml_value(value)))
        .collect();
    let mut config = Config::set(&app.home.config(), &values)?;
    let current = app.config();
    config.listen = current.listen;
    config.api_key.clone_from(&current.api_key);
    log::info!("settings changed from the API");
    app.set_config(config);
    ok(&settings_view(app))
}

fn keys(config: &Config) -> Vec<slopmax_api::settings::KeyInfo> {
    config.keys.iter().map(api::key_info).collect()
}

fn make_key(app: &App, asked: MakeKey) -> Answer {
    let name = asked.name.trim().to_owned();
    if name.is_empty() {
        return Err(ApiError::bad_request("a key needs a name"));
    }
    if app.config().keys.iter().any(|k| k.name == name) {
        return Err(ApiError::conflict(format!("a key named {name:?} exists")));
    }
    let models: Vec<String> = asked
        .models
        .into_iter()
        .map(|m| m.trim().to_owned())
        .filter(|m| !m.is_empty())
        .collect();
    let key = Config::add_key(&app.home.config(), &name, &models)?;
    app.reload_config();
    ok(&NewKey { name, key, models })
}

fn agent_of(id: AgentId) -> &'static dyn crate::agent::Agent {
    crate::agent::of_api(id)
}

fn agents(config: &Config, home: &crate::paths::Home) -> Vec<AgentWiring> {
    crate::agent::AGENTS
        .into_iter()
        .map(|agent| {
            let id = agent.api();
            let file = agent.config_file(home);
            let wiring = crate::agent::wiring(agent, config, home);
            AgentWiring {
                id,
                title: agent.title().into(),
                installed: file.parent().is_some_and(std::path::Path::exists),
                config_path: file.display().to_string(),
                wired_to: match &wiring {
                    crate::agent::Wiring::Elsewhere(target) => Some(target.clone()),
                    _ => None,
                },
                wired: wiring == crate::agent::Wiring::Slopmax,
                backed_up: crate::agent::backed_up(agent, home),
            }
        })
        .collect()
}

async fn connect_agent(app: &App, id: AgentId) -> Answer {
    let (agent, config) = (agent_of(id), app.config());
    let home = app.home.clone();
    let path = crate::blocking::run(move || crate::agent::setup(agent, &config, &home))
        .await
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    ok(&AgentConnected {
        path: path.display().to_string(),
        note: agent.setup_note().into(),
    })
}

async fn disconnect_agent(app: &App, id: AgentId) -> Answer {
    let agent = agent_of(id);
    let home = app.home.clone();
    let path = crate::blocking::run(move || crate::agent::undo(agent, &home))
        .await
        .map_err(|e| ApiError::conflict(format!("{e:#}")))?;
    ok(&AgentDisconnected {
        path: path.display().to_string(),
    })
}

/// A query parameter as an API enum, else `default`.
fn param<T: DeserializeOwned>(
    query: &str,
    name: &str,
    default: T,
    says: &str,
) -> Result<T, ApiError> {
    match crate::net::form::decode(query)
        .into_iter()
        .find(|(k, _)| k == name)
    {
        None => Ok(default),
        Some((_, value)) => {
            serde_json::from_value(value.into()).map_err(|_| ApiError::bad_request(says))
        }
    }
}

fn names(app: &App) -> HashMap<String, String> {
    app.pool
        .accounts()
        .iter()
        .map(|a| (a.id.clone(), a.name()))
        .collect()
}

/// Usage over a range. Requests the owner key sent are this machine's own:
/// `this machine` to this machine's own tools, `hub` to other machines.
async fn usage(app: &App, query: &str, here: bool) -> Answer {
    let range = param(
        query,
        "range",
        SummaryRange::Week,
        "range is today, 7d, 30d, or all",
    )?;
    let by = param(
        query,
        "by",
        SummaryBy::Day,
        "by is day, model, account, or machine",
    )?;
    let range_text = match range {
        SummaryRange::Today => "today",
        SummaryRange::Week => "7d",
        SummaryRange::Month => "30d",
        SummaryRange::All => "all",
    };
    let by_text = match by {
        SummaryBy::Day => "day",
        SummaryBy::Model => "model",
        SummaryBy::Account => "account",
        SummaryBy::Machine => "machine",
    };
    let since = summary::since(range_text, Timestamp::now()).expect("every range has a start");
    let (dir, config, names) = (app.home.usage(), app.config(), names(app));
    let built = crate::blocking::run(move || {
        summary::build(
            &dir,
            since,
            by_text,
            &config.prices,
            &names,
            match here {
                true => summary::HERE_LOCAL,
                false => summary::HERE_HUB,
            },
        )
    })
    .await;
    ok(&api::summary(&built, range, by))
}

/// A text parameter, if given and not blank.
fn text(query: &str, name: &str) -> Option<String> {
    crate::net::form::decode(query)
        .into_iter()
        .find(|(k, v)| k == name && !v.trim().is_empty())
        .map(|(_, v)| v)
}

/// A whole-number parameter.
fn whole(query: &str, name: &str, default: usize) -> Result<usize, ApiError> {
    match text(query, name) {
        None => Ok(default),
        Some(value) => value
            .parse()
            .map_err(|_| ApiError::bad_request(format!("{name} is a whole number"))),
    }
}

/// The ledger's requests over a range, filtered, newest first, a page at a
/// time.
async fn requests(app: &App, query: &str) -> Answer {
    let range = param(
        query,
        "range",
        HistoryRange::Today,
        "range is today, 7d, or 30d",
    )?;
    let outcome = param(
        query,
        "outcome",
        RequestOutcome::All,
        "outcome is all, answered, failed, or rescued",
    )?;
    let agent = param::<Option<Sender>>(
        query,
        "agent",
        None,
        "agent is claude-code, codex, or slopmax",
    )?;
    let asked = crate::browse::Query {
        account: text(query, "account"),
        model: text(query, "model"),
        agent,
        outcome,
        offset: whole(query, "offset", 0)?,
        limit: whole(query, "limit", 100)?,
    };
    let since = summary::since(api::history_range(range).key(), Timestamp::now())
        .expect("every range has a start");
    let (dir, config) = (app.home.usage(), app.config());
    let page = crate::blocking::run(move || {
        let entries = crate::ledger::read(&dir, since);
        crate::browse::page(&entries, &asked, range, since, &config.prices)
    })
    .await;
    ok(&page)
}

async fn history(app: &Arc<App>, query: &str) -> Answer {
    let range = param(
        query,
        "range",
        HistoryRange::Week,
        "range is today, 7d, or 30d",
    )?;
    let built = app.history(api::history_range(range)).await;
    ok(&api::history(&built, range))
}

async fn notify_test(app: &App) -> Answer {
    let config = app.config();
    if !config.notify.is_enabled() {
        return Err(ApiError::bad_request(
            "no notifications are set up: add a webhook or a command under [notify]",
        ));
    }
    config
        .notify
        .send(
            &app.auth_http,
            &crate::notify::Event::test(Timestamp::now()),
        )
        .await
        .map_err(crate::error::ProviderError::Failed)?;
    empty()
}

/// The event stream: `Hello`, the report, then each request answered, each
/// sign-in's progress, and the report again whenever it changes. The report
/// is built only while someone watches; the stream ends when the daemon
/// stops, or when the asker may do less than it could before: the config
/// no longer lets it look, or its machine may no longer manage slopmax.
///
/// Sign-in progress carries the addresses and codes that finish a sign-in,
/// so only those who may manage slopmax now see it, asked as each comes.
fn events(app: &Arc<App>, asker: Asker) -> Response {
    let mut feed = app.api_events.subscribe();
    let mut machine = None;
    // What the asker could do at most so far; less ends the stream.
    let mut held =
        access_now(app, &asker, &mut machine).map_or(asker.access, |now| now.max(asker.access));
    let (app, stop) = (Arc::clone(app), app.stop.clone());
    let (tx, rx) = mpsc::channel::<Bytes>(64);
    app.clone().spawn(async move {
        let hello = Event::Hello {
            version: env!("CARGO_PKG_VERSION").into(),
            exe: std::env::current_exe()
                .ok()
                .map(|p| p.display().to_string()),
        };
        let (mut last, first) = status(&app);
        if tx.send(hello.frame().into()).await.is_err() || tx.send(first).await.is_err() {
            return;
        }
        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING, PING);
        let mut check =
            tokio::time::interval_at(tokio::time::Instant::now() + STATUS_EVERY, STATUS_EVERY);
        check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let frame = tokio::select! {
                event = feed.recv() => match event {
                    Ok(frame) if frame.starts_with(LOGIN_FRAME) => {
                        match access_now(&app, &asker, &mut machine) {
                            Some(now) if now >= held => held = now,
                            _ => break,
                        }
                        if held < Access::Admin {
                            continue;
                        }
                        frame
                    }
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = check.tick() => {
                    match access_now(&app, &asker, &mut machine) {
                        Some(now) if now >= held => held = now,
                        _ => break,
                    }
                    let (seen, frame) = status(&app);
                    if seen == last {
                        continue;
                    }
                    last = seen;
                    frame
                }
                _ = ping.tick() => Event::Ping {}.frame().into(),
                () = stop.cancelled() => break,
            };
            if tx.send(frame).await.is_err() {
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

/// How a sign-in's progress starts on the event stream.
const LOGIN_FRAME: &[u8] = br#"data: {"_tag":"Login""#;

/// What `asker` may do as the config stands now; `None` once its key no
/// longer matches or its login is no longer allowed. A tailnet machine is
/// judged by what whois said of it lately, kept in `machine` between asks:
/// when nothing recent is known, the last answer stands while whois is
/// asked again in the background, so an answer running out does not demote
/// it, but an answer naming another login, or none, does.
fn access_now(
    app: &Arc<App>,
    asker: &Asker,
    machine: &mut Option<super::tailnet::Machine>,
) -> Option<Access> {
    let config = app.config();
    let login = match super::known(&config, &asker.headers, &asker.seen) {
        Ok(super::Known::Key(caller @ Caller::Client(_))) => {
            super::login_beside_key(&config, &asker.headers, &asker.seen).ok_or(caller)
        }
        Ok(super::Known::Key(caller)) => Err(caller),
        Ok(super::Known::Login(login)) => Ok(login),
        Err(_) => return None,
    };
    match login {
        Err(caller) => Some(caller.access()),
        Ok(login) => {
            if let Some(peer) = asker.seen.peer {
                match app.peers.lately(peer) {
                    Some(found) => *machine = found.filter(|m| m.is(login)),
                    None => app.peers.warm(app, peer, login),
                }
            }
            Some(super::member_access(&config, machine.as_ref()))
        }
    }
}

/// How long what Tailscale said about publishing is reused.
const TAILNET_FRESH: Duration = Duration::from_secs(30);

/// slopmax on the tailnet: as Tailscale last told it (within
/// [`TAILNET_FRESH`]), and who may use it as the config says now.
async fn tailnet_view(app: &App) -> TailnetView {
    let config = app.config();
    let kept = app
        .tailnet_view
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(at, _)| at.elapsed() < TAILNET_FRESH)
        .map(|(_, view)| view.clone());
    let view = match kept {
        Some(view) => view,
        None => {
            let port = config.listen.port();
            let targets = [
                Target::Socket(app.home.tailnet_socket()),
                Target::Loopback(port),
            ];
            let cli = app.tailscale_cli();
            let inspection = tailscale::inspect(cli.as_ref(), &targets, port).await;
            let view = inspection.view();
            *app.tailnet_view.lock().unwrap_or_else(|p| p.into_inner()) =
                Some((Instant::now(), view.clone()));
            view
        }
    };
    tailscale::with_config(view, &config)
}

/// Changes who may use slopmax over the tailnet: checked as config.toml is,
/// written there, and in force at once. A login or a machine named twice is
/// kept once.
async fn change_tailnet(app: &App, patch: TailnetPatch) -> Answer {
    let mut tailnet = app.config().tailscale.clone().unwrap_or_default();
    if let Some(users) = patch.users {
        tailnet.users = Vec::new();
        for user in users.iter().map(|u| u.trim()) {
            if !tailnet.users.iter().any(|u| u.eq_ignore_ascii_case(user)) {
                tailnet.users.push(user.to_owned());
            }
        }
    }
    if let Some(admins) = patch.admins {
        tailnet.admins = Vec::new();
        for admin in admins {
            let (machine, id) = (admin.machine.trim(), admin.id.trim());
            if !tailnet.admins.iter().any(|a| a.id == id) {
                tailnet.admins.push(crate::config::AdminMachine {
                    machine: machine.to_owned(),
                    id: id.to_owned(),
                });
            }
        }
    }
    let path = app.home.config();
    crate::blocking::run(move || Config::set_tailnet(&path, &tailnet)).await?;
    app.reload_config();
    log::info!("who may use slopmax over the tailnet changed from the API");
    *app.tailnet_view.lock().unwrap_or_else(|p| p.into_inner()) = None;
    let view = tailnet_view(app).await;
    // A change of who may use it comes before Tailscale publishes it, as
    // `slopmax tailscale on` makes them: the next look asks Tailscale again
    // rather than keeping what it said before.
    *app.tailnet_view.lock().unwrap_or_else(|p| p.into_inner()) = None;
    ok(&view)
}

/// The report as a `Status` event, and what tells it apart from the last:
/// the same report without the time it was built, which changes every time.
fn status(app: &App) -> (Vec<u8>, Bytes) {
    let mut report = app.api_report();
    let built = report.generated_at;
    report.generated_at = Timestamp::UNIX_EPOCH;
    let seen = serde_json::to_vec(&report).expect("API types serialize");
    report.generated_at = built;
    let frame = Event::Status {
        report: Box::new(report),
    };
    (seen, frame.frame().into())
}

/// The event stream's body: frames as they come, ending when the sender
/// does.
struct Feed(tokio::sync::mpsc::Receiver<Bytes>);

impl hyper::body::Body for Feed {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        self.0
            .poll_recv(cx)
            .map(|chunk| chunk.map(|c| Ok(hyper::body::Frame::data(c))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_path_names_one_endpoint() {
        let at = |method: Method, path: &'static str| Route::parse(&method, path);
        assert_eq!(at(Method::GET, "/status"), Some(Route::Status));
        assert_eq!(
            at(Method::PATCH, "/accounts/claude-1"),
            Some(Route::UpdateAccount("claude-1"))
        );
        assert_eq!(
            at(Method::DELETE, "/accounts/claude-1"),
            Some(Route::RemoveAccount("claude-1"))
        );
        assert_eq!(
            at(Method::POST, "/accounts/a/redeem"),
            Some(Route::Redeem("a"))
        );
        assert_eq!(
            at(Method::DELETE, "/keys/my%20laptop"),
            Some(Route::RemoveKey("my laptop".into()))
        );
        assert_eq!(
            at(Method::POST, "/agents/claude-code/connect"),
            Some(Route::Connect(AgentId::ClaudeCode))
        );
        assert_eq!(at(Method::POST, "/agents/vim/connect"), None);
        assert_eq!(
            at(Method::GET, "/pools/claude"),
            Some(Route::Pool(slopmax_api::Provider::Claude))
        );
        assert_eq!(at(Method::GET, "/pools/vim"), None);
        assert_eq!(at(Method::GET, "/requests"), Some(Route::Requests));
        assert_eq!(
            at(Method::POST, "/accounts/a/check"),
            Some(Route::Check("a"))
        );
        assert_eq!(at(Method::GET, "/accounts/a"), None);
        assert_eq!(at(Method::POST, "/status"), None);
        assert_eq!(at(Method::GET, "/tailnet"), Some(Route::Tailnet));
        assert_eq!(at(Method::PATCH, "/tailnet"), Some(Route::ChangeTailnet));
    }

    #[test]
    fn looking_needs_view_and_everything_else_admin() {
        let needs =
            |method: Method, path: &'static str| Route::parse(&method, path).unwrap().needs();
        for (method, path) in [
            (Method::GET, "/status"),
            (Method::GET, "/usage"),
            (Method::GET, "/history"),
            (Method::GET, "/pools/claude"),
            (Method::GET, "/events"),
            (Method::GET, "/tailnet"),
        ] {
            assert_eq!(needs(method, path), Access::View, "{path}");
        }
        for (method, path) in [
            (Method::GET, "/settings"),
            (Method::GET, "/keys"),
            (Method::GET, "/doctor"),
            (Method::GET, "/agents"),
            (Method::POST, "/logins"),
            (Method::POST, "/refresh"),
            (Method::POST, "/shutdown"),
            (Method::PATCH, "/settings"),
            (Method::PATCH, "/tailnet"),
            (Method::DELETE, "/keys/x"),
        ] {
            assert_eq!(needs(method, path), Access::Admin, "{path}");
        }
    }

    #[test]
    fn sign_in_progress_is_told_from_other_events() {
        let login = Event::Login {
            id: "x".into(),
            event: LoginEvent::Note { text: "hi".into() },
        };
        assert!(login.frame().starts_with(LOGIN_FRAME));
        for other in [
            Event::Ping {},
            Event::Hello {
                version: "1".into(),
                exe: None,
            },
        ] {
            assert!(!other.frame().starts_with(LOGIN_FRAME));
        }
    }
}
