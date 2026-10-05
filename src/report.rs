//! Account status: what `slopmax status` shows and `/slopmax/status` serves.

use std::collections::HashMap;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::account::Account;
use crate::config::Strategy;
use crate::limits::{self, Window};
use crate::pool::{AccountState, Pins};
use crate::provider::ProviderId;
use crate::time::Timestamp;
use crate::{human, ui};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub version: String,
    pub strategy: Strategy,
    /// Whether this came from a running proxy (live sessions and state).
    pub live: bool,
    pub generated_at: Timestamp,
    pub accounts: Vec<AccountReport>,
    /// Each subscription's working accounts read as one, as agents see them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pools: Vec<PoolReport>,
}

/// A provider's working accounts (enabled and signed in) read as one: each
/// window's average use, and the soonest reset that frees capacity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolReport {
    pub provider: ProviderId,
    pub accounts: usize,
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountReport {
    pub id: String,
    pub provider: ProviderId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub disabled: bool,
    pub priority: i32,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_error: Option<String>,
    /// The tool whose copy of the tokens slopmax follows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<Timestamp>,
    /// For keys and endpoints: where requests go and the models served.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    pub sessions: usize,
    pub state: AccountState,
}

pub fn build(
    accounts: Vec<Account>,
    state_of: impl Fn(&str) -> AccountState,
    pins: &Pins,
    sessions: &HashMap<String, usize>,
    strategy: Strategy,
    live: bool,
    now: Timestamp,
) -> Report {
    let accounts: Vec<AccountReport> = accounts
        .into_iter()
        .map(|a| AccountReport {
            endpoint: (!a.provider.spec().is_subscription())
                .then(|| a.provider.get().api(&a).to_owned()),
            models: match &a.endpoint {
                Some(endpoint) => endpoint.models.clone(),
                None if !a.provider.spec().is_subscription() => a
                    .provider
                    .spec()
                    .models
                    .iter()
                    .map(|m| m.to_string())
                    .collect(),
                None => Vec::new(),
            },
            name: a.name(),
            pinned: pins.get(&a.provider) == Some(&a.id),
            sessions: sessions.get(&a.id).copied().unwrap_or(0),
            state: state_of(&a.id),
            token_expires_at: a.tokens.expires_at,
            id: a.id,
            provider: a.provider,
            email: a.email,
            plan: a.plan,
            disabled: a.disabled,
            priority: a.priority,
            auth_error: a.auth_error,
            follows: a.link.map(|link| link.tool),
        })
        .collect();
    let pools = ProviderId::ALL
        .into_iter()
        .filter(|p| p.spec().is_subscription())
        .filter_map(|p| pool(p, &accounts, now))
        .collect();
    Report {
        version: env!("CARGO_PKG_VERSION").into(),
        strategy,
        live,
        generated_at: now,
        accounts,
        pools,
    }
}

/// See [`limits::pooled`].
fn pool(provider: ProviderId, accounts: &[AccountReport], now: Timestamp) -> Option<PoolReport> {
    let working: Vec<&AccountReport> = accounts
        .iter()
        .filter(|a| a.provider == provider && !a.disabled && a.auth_error.is_none())
        .collect();
    if working.is_empty() {
        return None;
    }
    let windows = limits::pooled(
        working
            .iter()
            .map(|a| (&a.state.limits, a.state.is_blocked(now))),
        now,
    )
    .into_iter()
    .map(|w| Window::new(w.span, w.used, w.resets_at))
    .collect();
    Some(PoolReport {
        provider,
        accounts: working.len(),
        windows,
    })
}

const BAR: usize = 10;
const PLAN: usize = 9;
/// Width of a usage cell: bar, percentage, and reset countdown.
const CELL: usize = BAR + 12;

/// Renders the report as a table grouped by provider.
pub fn render(report: &Report, now: Timestamp) -> String {
    let mut out = String::new();
    if report.accounts.is_empty() {
        out.push_str(
            "No accounts yet. Connect one with `slopmax login claude` or `slopmax login codex`,\n",
        );
        out.push_str("or bring existing logins over with `slopmax import`.\n");
        return out;
    }
    let name_width = report
        .accounts
        .iter()
        .map(|a| ui::visible_width(&a.name))
        .max()
        .unwrap_or(0)
        .clamp(7, 36);
    let mut index = 0;
    for provider in ProviderId::ALL {
        let accounts: Vec<&AccountReport> = report
            .accounts
            .iter()
            .filter(|a| a.provider == provider)
            .collect();
        if accounts.is_empty() {
            continue;
        }
        if !provider.spec().is_subscription() {
            index = metered(&mut out, provider, &accounts, index, name_width, now);
            continue;
        }
        let _ = writeln!(
            out,
            "\n{}  {}  {}  {}  {}",
            ui::bold(ui::pad(&provider.as_str().to_uppercase(), name_width + 4)),
            ui::dim(ui::pad("PLAN", PLAN)),
            ui::dim(ui::pad("5H", CELL)),
            ui::dim(ui::pad("WEEK", CELL)),
            ui::dim("STATUS"),
        );
        for &account in &accounts {
            index += 1;
            let shared: Vec<&Window> = account
                .state
                .limits
                .windows
                .iter()
                .filter(|w| w.model.is_none())
                .collect();
            let span = |name: &str| shared.iter().find(|w| w.span == name).copied();
            let week = span("7d").or_else(|| span("30d"));
            let name: String = account.name.chars().take(name_width).collect();
            let _ = writeln!(
                out,
                "{} {}  {}  {}  {}  {}",
                ui::dim(format!("{index:>2}")),
                ui::pad(&name, name_width + 1),
                ui::pad(account.plan.as_deref().unwrap_or("—"), PLAN),
                window_cell(span("5h"), now),
                window_cell(week, now),
                status_cell(account, now),
            );
            for scoped in account
                .state
                .limits
                .windows
                .iter()
                .filter(|w| w.model.is_some())
            {
                // Under the matching column: the row prefix is the index and
                // name, then the plan, then each usage cell.
                let five_hour_column = name_width + 4 + 2 + PLAN + 2;
                let column = match scoped.span.as_str() {
                    "5h" => five_hour_column,
                    _ => five_hour_column + CELL + 2,
                };
                let label = format!("└ {}", scoped.label());
                let _ = writeln!(
                    out,
                    "   {}{}",
                    ui::dim(ui::pad(&label, column - 3)),
                    window_cell(Some(scoped), now),
                );
            }
        }
        let pool = report.pools.iter().find(|p| p.provider == provider);
        pool_row(&mut out, pool, name_width, now);
    }
    let _ = writeln!(
        out,
        "\n{}",
        ui::dim(format!(
            "strategy {} · {}",
            report.strategy,
            if report.live {
                "proxy running"
            } else {
                "proxy not running (last known state)"
            }
        ))
    );
    out
}

/// Rows for pay-per-token accounts, which have models instead of windows.
/// Returns the last row number used.
fn metered(
    out: &mut String,
    provider: ProviderId,
    accounts: &[&AccountReport],
    mut index: usize,
    name_width: usize,
    now: Timestamp,
) -> usize {
    let width = CELL * 2 + 2;
    let _ = writeln!(
        out,
        "\n{}  {}  {}  {}",
        ui::bold(ui::pad(&provider.as_str().to_uppercase(), name_width + 4)),
        ui::dim(ui::pad("BILLING", PLAN)),
        ui::dim(ui::pad("MODELS", width)),
        ui::dim("STATUS"),
    );
    for account in accounts {
        index += 1;
        let name: String = account.name.chars().take(name_width).collect();
        let mut models = account.models.join(", ");
        if models.chars().count() > width {
            models = models.chars().take(width - 1).collect::<String>() + "…";
        }
        let _ = writeln!(
            out,
            "{} {}  {}  {}  {}",
            ui::dim(format!("{index:>2}")),
            ui::pad(&name, name_width + 1),
            ui::pad("per token", PLAN),
            ui::pad(&models, width),
            status_cell(account, now),
        );
    }
    index
}

/// The pool as the agents see it, when it has more than one account.
fn pool_row(out: &mut String, pool: Option<&PoolReport>, name_width: usize, now: Timestamp) {
    let Some(pool) = pool.filter(|p| p.accounts > 1) else {
        return;
    };
    let window = |span: &str| pool.windows.iter().find(|w| w.span == span);
    let week = window("7d").or_else(|| window("30d"));
    let _ = writeln!(
        out,
        "   {}  {}  {}  {}  {}",
        ui::pad(&ui::bold("pool"), name_width + 1),
        ui::pad(&ui::dim(format!("{} accts", pool.accounts)), PLAN),
        window_cell(window("5h"), now),
        window_cell(week, now),
        ui::dim("what the agents see"),
    );
}

fn window_cell(window: Option<&Window>, now: Timestamp) -> String {
    let Some(window) = window else {
        return ui::pad(&ui::dim("—"), CELL);
    };
    let used = window.used_at(now);
    let reset = window
        .upcoming_reset(now)
        .filter(|_| used > 0.0)
        .map(|at| human::until(at, now))
        .unwrap_or_default();
    let cell = format!(
        "{} {} {}",
        ui::bar(used, BAR),
        ui::by_level(used, format!("{:>3.0}%", used)),
        ui::dim(reset)
    );
    ui::pad(&cell, CELL)
}

fn status_cell(account: &AccountReport, now: Timestamp) -> String {
    let state = &account.state;
    let mut parts = Vec::new();
    if let Some(error) = &account.auth_error {
        parts.push(ui::red(format!("re-login needed ({error})")));
    } else if account.disabled {
        parts.push(ui::dim("disabled"));
    } else if let Some(until) = state.limited_until(now) {
        parts.push(ui::yellow(format!(
            "limited · back in {}",
            human::until(until, now)
        )));
    } else if state.throttled_until.is_some_and(|at| at > now) {
        parts.push(ui::yellow("throttled"));
    } else if account.sessions > 0 {
        let s = if account.sessions == 1 { "" } else { "s" };
        parts.push(ui::green(format!(
            "● active · {} session{s}",
            account.sessions
        )));
    } else {
        parts.push(ui::green("ready"));
    }
    if account.pinned {
        parts.push(ui::cyan("pinned"));
    }
    if account.priority != 0 {
        parts.push(ui::dim(format!("priority {}", account.priority)));
    }
    if let Some(tool) = &account.follows {
        parts.push(ui::dim(format!("follows {tool}")));
    }
    if let Some(credits) = state.limits.reset_credits.filter(|n| *n > 0) {
        parts.push(ui::cyan(format!(
            "{credits} reset credit{}",
            if credits == 1 { "" } else { "s" }
        )));
    }
    if state.usage.requests > 0 {
        parts.push(ui::dim(format!(
            "{} req · {} tok",
            state.usage.requests,
            human::compact(state.usage.total_tokens())
        )));
    }
    if let Some(error) = state
        .last_error
        .as_ref()
        .filter(|_| account.auth_error.is_none() && state.limited_until(now).is_none())
    {
        parts.push(ui::dim(format!("last error: {error}")));
    }
    parts.join(ui::dim(" · ").as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;
    use crate::limits::Limits;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    #[test]
    fn pools_get_a_row_of_their_own() {
        let now = ts(1_000);
        let account = |email: &str, used: f64| {
            let mut account = Account::new(ProviderId::Claude, Tokens::default());
            account.email = Some(email.into());
            account.org_id = Some(email.into());
            account.assign_id();
            let state = AccountState {
                limits: Limits {
                    windows: vec![Window::new("5h", used, Some(ts(4_600)))],
                    observed_at: Some(now),
                    reset_credits: None,
                },
                ..AccountState::default()
            };
            (account, state)
        };
        let accounts = [account("a@x.dev", 80.0), account("b@x.dev", 20.0)];
        let states: HashMap<String, AccountState> = accounts
            .iter()
            .map(|(a, s)| (a.id.clone(), s.clone()))
            .collect();
        let report = build(
            accounts.iter().map(|(a, _)| a.clone()).collect(),
            |id| states[id].clone(),
            &Pins::new(),
            &HashMap::new(),
            Strategy::ResetFirst,
            true,
            now,
        );
        let text = render(&report, now);
        let pool = text.lines().find(|l| l.contains("pool")).unwrap();
        assert!(pool.contains(" 50%"), "{pool}");
        assert!(pool.contains("2 accts"), "{pool}");
    }

    #[test]
    fn renders_windows_status_and_scoped_limits() {
        let mut account = Account::new(ProviderId::Claude, Tokens::default());
        account.email = Some("me@x.dev".into());
        account.plan = Some("max 20x".into());
        account.org_id = Some("org".into());
        account.assign_id();
        let state = AccountState {
            limits: Limits {
                windows: vec![
                    Window {
                        span: "5h".into(),
                        model: None,
                        used: 100.0,
                        resets_at: Some(ts(4600)),
                    },
                    Window {
                        span: "7d".into(),
                        model: None,
                        used: 47.0,
                        resets_at: Some(ts(90_000)),
                    },
                    Window {
                        span: "7d".into(),
                        model: Some("Fable".into()),
                        used: 58.0,
                        resets_at: Some(ts(90_000)),
                    },
                ],
                observed_at: Some(ts(1000)),
                reset_credits: None,
            },
            ..AccountState::default()
        };
        let report = build(
            vec![account],
            |_| state.clone(),
            &Pins::new(),
            &HashMap::new(),
            Strategy::ResetFirst,
            true,
            ts(1000),
        );
        let text = render(&report, ts(1000));
        assert!(text.contains("CLAUDE"), "{text}");
        assert!(text.contains("me@x.dev"));
        assert!(text.contains("max 20x"));
        assert!(text.contains("100%"));
        assert!(text.contains(" 47%"));
        assert!(text.contains("└ 7d Fable"));
        assert!(text.contains("limited · back in 1h00m"), "{text}");
    }

    #[test]
    fn empty_report_explains_next_steps() {
        let report = build(
            Vec::new(),
            |_| AccountState::default(),
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            false,
            ts(0),
        );
        assert!(render(&report, ts(0)).contains("slopmax login claude"));
    }
}
