//! What a window draws, worked out once for every UI: the accounts grouped
//! by provider with their gauges and status, and the menu bar's line. The
//! words come from the core, so they read as `slopmax status` does.

use slopmax_core::human;
use slopmax_core::limits::Window;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::{AccountReport, PoolReport, Report, Tone};
use slopmax_core::time::Timestamp;

/// One provider's accounts.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub provider: ProviderId,
    pub title: &'static str,
    /// Whether its accounts have usage windows; keys bill per token.
    pub subscription: bool,
    pub accounts: Vec<Row>,
    /// The working accounts read as one, as agents see them, when there are
    /// several.
    pub pool: Option<PoolRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    pub name: String,
    /// The plan, or how a key is billed.
    pub plan: String,
    pub five_hour: Option<Gauge>,
    pub week: Option<Gauge>,
    pub status: Label,
    pub notes: Vec<Label>,
    pub pinned: bool,
    pub disabled: bool,
    pub priority: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PoolRow {
    pub accounts: usize,
    pub five_hour: Option<Gauge>,
    pub week: Option<Gauge>,
}

/// A usage window as a bar.
#[derive(Debug, Clone, PartialEq)]
pub struct Gauge {
    /// How full, from 0 to 1.
    pub fraction: f32,
    /// `42%`.
    pub percent: String,
    /// Time until it resets, when it has use to reset: `2h05m`.
    pub resets_in: Option<String>,
    pub tone: Tone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub text: String,
    pub tone: Tone,
}

/// The accounts grouped by provider, in the order requests try them.
pub fn groups(report: &Report, now: Timestamp) -> Vec<Group> {
    ProviderId::ALL
        .into_iter()
        .filter_map(|provider| {
            let accounts: Vec<Row> = report
                .accounts
                .iter()
                .filter(|a| a.provider == provider)
                .map(|a| row(a, now))
                .collect();
            if accounts.is_empty() {
                return None;
            }
            let pool = report
                .pools
                .iter()
                .find(|p| p.provider == provider && p.accounts > 1)
                .map(|p| pool_row(p, now));
            Some(Group {
                provider,
                title: provider.spec().title,
                subscription: provider.spec().is_subscription(),
                accounts,
                pool,
            })
        })
        .collect()
}

/// The menu bar's line: each subscription's use in its 5-hour window,
/// across its working accounts, as `Claude 42% · ChatGPT 18%`.
pub fn menu_bar(report: &Report, now: Timestamp) -> String {
    let parts: Vec<String> = report
        .pools
        .iter()
        .map(|pool| {
            let title = pool.provider.spec().title;
            match pool.window("5h") {
                Some(window) => format!("{title} {:.0}%", window.used_at(now)),
                None => format!("{title} —"),
            }
        })
        .collect();
    if parts.is_empty() {
        "slopmax".to_owned()
    } else {
        parts.join(" · ")
    }
}

pub fn gauge(window: &Window, now: Timestamp) -> Gauge {
    let used = window.used_at(now);
    Gauge {
        fraction: (used / 100.0).clamp(0.0, 1.0) as f32,
        percent: format!("{used:.0}%"),
        resets_in: window
            .upcoming_reset(now)
            .filter(|_| used > 0.0)
            .map(|at| human::until(at, now)),
        tone: Tone::of_use(used),
    }
}

fn row(account: &AccountReport, now: Timestamp) -> Row {
    let condition = account.condition(now);
    let plan = match &account.plan {
        Some(plan) => plan.clone(),
        None if !account.provider.spec().is_subscription() => "per token".to_owned(),
        None => String::new(),
    };
    Row {
        id: account.id.clone(),
        name: account.name.clone(),
        plan,
        five_hour: account.window("5h").map(|w| gauge(w, now)),
        week: account.long_window().map(|w| gauge(w, now)),
        status: Label {
            text: condition.describe(now),
            tone: condition.tone(),
        },
        notes: account
            .notes(now)
            .iter()
            .map(|note| Label {
                text: note.describe(),
                tone: note.tone(),
            })
            .collect(),
        pinned: account.pinned,
        disabled: account.disabled,
        priority: account.priority,
    }
}

fn pool_row(pool: &PoolReport, now: Timestamp) -> PoolRow {
    PoolRow {
        accounts: pool.accounts,
        five_hour: pool.window("5h").map(|w| gauge(w, now)),
        week: pool.long_window().map(|w| gauge(w, now)),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use slopmax_core::account::{Account, Tokens};
    use slopmax_core::config::Strategy;
    use slopmax_core::limits::Limits;
    use slopmax_core::pool::{AccountState, Pins};
    use slopmax_core::report::build;

    use super::*;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    fn window(span: &str, used: f64, resets_at: i64) -> Window {
        Window {
            span: span.into(),
            model: None,
            used,
            resets_at: Some(ts(resets_at)),
        }
    }

    fn report(now: Timestamp) -> Report {
        let accounts: Vec<(Account, f64)> = [("a@x.dev", 80.0), ("b@x.dev", 20.0)]
            .into_iter()
            .map(|(email, used)| {
                let mut account = Account::new(ProviderId::Claude, Tokens::default());
                account.email = Some(email.into());
                account.org_id = Some(email.into());
                account.assign_id();
                (account, used)
            })
            .collect();
        let states: HashMap<String, f64> = accounts
            .iter()
            .map(|(a, used)| (a.id.clone(), *used))
            .collect();
        build(
            accounts.into_iter().map(|(a, _)| a).collect(),
            |id| AccountState {
                limits: Limits {
                    windows: vec![window("5h", states[id], 4_600), window("7d", 10.0, 90_000)],
                    observed_at: Some(now),
                    reset_credits: None,
                },
                ..AccountState::default()
            },
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            true,
            now,
        )
    }

    #[test]
    fn groups_carry_gauges_status_and_the_pool() {
        let now = ts(1_000);
        let groups = groups(&report(now), now);
        assert_eq!(groups.len(), 1);
        let claude = &groups[0];
        assert_eq!(claude.title, "Claude");
        assert_eq!(claude.accounts.len(), 2);
        let busy = &claude.accounts[0];
        let five_hour = busy.five_hour.as_ref().unwrap();
        assert_eq!(five_hour.percent, "80%");
        assert_eq!(five_hour.resets_in.as_deref(), Some("1h00m"));
        assert_eq!(five_hour.tone, Tone::Warn);
        assert_eq!(busy.status.text, "ready");
        let pool = claude.pool.as_ref().unwrap();
        assert_eq!(pool.accounts, 2);
        assert_eq!(pool.five_hour.as_ref().unwrap().percent, "50%");
    }

    #[test]
    fn the_menu_bar_shows_each_pool() {
        let now = ts(1_000);
        assert_eq!(menu_bar(&report(now), now), "Claude 50%");
        // Once the window resets, its use is gone.
        assert_eq!(menu_bar(&report(now), ts(5_000)), "Claude 0%");
    }
}
