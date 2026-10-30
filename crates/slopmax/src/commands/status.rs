//! `slopmax status`: the accounts, their usage windows, and when limits
//! reset, from the running proxy or from disk.

use std::fmt::Write as _;
use std::io::Write as _;
use std::time::Duration;

use anyhow::Result;

use super::StatusArgs;
use crate::ui;
use slopmax_core::account::Store;
use slopmax_core::background::Daemon;
use slopmax_core::config::Config;
use slopmax_core::human;
use slopmax_core::limits::Window;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::{self, AccountReport, PoolReport, Report};
use slopmax_core::time::Timestamp;

pub(super) async fn run(config: &Config, store: &Store, args: StatusArgs) -> Result<()> {
    let daemon = Daemon::new(config);
    let mut refresh = args.refresh;
    loop {
        let report = match daemon.report(refresh).await {
            Some(report) => report,
            None => report::offline(config, store, refresh).await?,
        };
        if args.json {
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }
        let text = render(&report, Timestamp::now());
        if args.watch {
            print!("\x1b[2J\x1b[H{text}");
            std::io::stdout().flush()?;
        } else {
            print!("{text}");
            return Ok(());
        }
        refresh = false;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

const BAR: usize = 10;
const PLAN: usize = 9;
/// Width of a usage cell: bar, percentage, and reset countdown.
const CELL: usize = BAR + 12;

/// Renders the report as a table grouped by provider.
fn render(report: &Report, now: Timestamp) -> String {
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
            let name: String = account.name.chars().take(name_width).collect();
            let _ = writeln!(
                out,
                "{} {}  {}  {}  {}  {}",
                ui::dim(format!("{index:>2}")),
                ui::pad(&name, name_width + 1),
                ui::pad(account.plan.as_deref().unwrap_or("—"), PLAN),
                window_cell(account.window("5h"), now),
                window_cell(account.long_window(), now),
                status_cell(account, now),
            );
            scoped_rows(&mut out, account.scoped_windows(), name_width, now);
        }
        let pool = report.pools.iter().find(|p| p.provider == provider);
        pool_row(&mut out, pool, name_width, now);
        if let Some(next) = pool.and_then(|p| p.next.as_ref()) {
            let name = accounts
                .iter()
                .find(|a| a.id == next.account)
                .map_or(next.account.as_str(), |a| a.name.as_str());
            let _ = writeln!(
                out,
                "   {}",
                ui::dim(format!("next session → {name}, {}", next.why))
            );
        }
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

/// Windows that cover one model, each under its column.
fn scoped_rows<'a>(
    out: &mut String,
    windows: impl Iterator<Item = &'a Window>,
    name_width: usize,
    now: Timestamp,
) {
    for scoped in windows {
        // Under the matching column: the row prefix is the index and name,
        // then the plan, then each usage cell.
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

/// The pool as the agents see it, when it has more than one account.
fn pool_row(out: &mut String, pool: Option<&PoolReport>, name_width: usize, now: Timestamp) {
    let Some(pool) = pool.filter(|p| p.accounts > 1) else {
        return;
    };
    let _ = writeln!(
        out,
        "   {}  {}  {}  {}  {}",
        ui::pad(&ui::bold("pool"), name_width + 1),
        ui::pad(&ui::dim(format!("{} accts", pool.accounts)), PLAN),
        window_cell(pool.window("5h"), now),
        window_cell(pool.long_window(), now),
        ui::dim("what the agents see"),
    );
    scoped_rows(out, pool.scoped_windows(), name_width, now);
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
    let condition = account.condition(now);
    let parts: Vec<String> = std::iter::once(ui::toned(condition.tone(), condition.describe(now)))
        .chain(
            account
                .notes(now)
                .iter()
                .map(|note| ui::toned(note.tone(), note.describe())),
        )
        .collect();
    parts.join(&ui::dim(" · "))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use slopmax_core::account::{Account, Tokens};
    use slopmax_core::config::Strategy;
    use slopmax_core::limits::Limits;
    use slopmax_core::pool::{AccountState, Pins};
    use slopmax_core::report::build;

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
                    windows: vec![Window {
                        span: "5h".into(),
                        model: None,
                        used,
                        resets_at: Some(ts(4_600)),
                    }],
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
