//! What a window draws, worked out once for every UI: the accounts grouped
//! by provider with their gauges and status, the lines about the proxy,
//! agents, and service, a sign-in's instructions, and the menu bar's line.
//! Account words come from the core, so they read as `slopmax status` does.

use slopmax_core::agent::Wiring;
use slopmax_core::human;
use slopmax_core::limits::Window;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::{AccountReport, Report, Tone};
use slopmax_core::service;
use slopmax_core::time::{SignedDuration, Timestamp};

use crate::{AgentStatus, Proxy, SignIn, Snapshot, Step};

/// One provider's accounts.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub provider: ProviderId,
    pub title: &'static str,
    /// Whether its accounts have usage windows; keys bill per token.
    pub subscription: bool,
    /// The usage windows its accounts report, as columns: `5-hour`,
    /// `Weekly`, then any limited to one model, such as `Weekly · Fable`.
    pub limits: Vec<String>,
    pub accounts: Vec<Row>,
    /// Each window across the working accounts, as agents see them, with
    /// every account's share of it. Empty for keys.
    pub overview: Vec<Overview>,
    /// How many working accounts the overview reads as one.
    pub working: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    pub name: String,
    /// The plan, or how a key is billed.
    pub plan: String,
    /// A gauge for each of the group's `limits`, or `None` where this
    /// account reports no such window.
    pub limits: Vec<Option<Gauge>>,
    pub status: Label,
    pub notes: Vec<Label>,
    pub pinned: bool,
    pub disabled: bool,
    pub priority: i32,
    /// When it last answered: `used 3m ago`.
    pub last_used: Option<String>,
}

/// One usage window across a provider's accounts.
#[derive(Debug, Clone, PartialEq)]
pub struct Overview {
    pub title: String,
    /// The working accounts' use, read as one.
    pub gauge: Gauge,
    /// Each account's use of it, in the group's order.
    pub shares: Vec<Share>,
}

/// One account's use of a window, as a segment of the overview's bar.
#[derive(Debug, Clone, PartialEq)]
pub struct Share {
    pub fraction: f32,
    pub tone: Tone,
    /// Not serving: disabled, or its sign-in failed.
    pub idle: bool,
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
    /// When it resets on this machine's clock: `22:59` today, `Wed 20:27`
    /// within the week, `Nov 3` after.
    pub resets_at: Option<String>,
    pub tone: Tone,
    /// How the use compares with spending the window evenly until it
    /// resets.
    pub pace: Option<Pace>,
}

/// A window's use against an even spend.
#[derive(Debug, Clone, PartialEq)]
pub struct Pace {
    /// How far through the window it is, from 0 to 1: where an even spend
    /// would have reached.
    pub elapsed: f32,
    /// `On pace`, `Runs out ~14:10`, or `18% in reserve`.
    pub label: Label,
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
            let accounts: Vec<&AccountReport> = report
                .accounts
                .iter()
                .filter(|a| a.provider == provider)
                .collect();
            if accounts.is_empty() {
                return None;
            }
            let slots = slots(&accounts);
            let pool = report.pools.iter().find(|p| p.provider == provider);
            let overview = slots
                .iter()
                .filter_map(|slot| {
                    // The pool's window, or a lone account's own.
                    let window = match pool {
                        Some(pool) => pool.windows.iter().find(|w| slot.holds(w)),
                        None if accounts.len() == 1 => slot.of(accounts[0]),
                        None => None,
                    }?;
                    Some(Overview {
                        title: slot.title(),
                        // Pooled accounts reset at staggered times, so an
                        // even spend of the pool means nothing.
                        gauge: Gauge {
                            pace: None,
                            ..gauge(window, now)
                        },
                        shares: accounts.iter().map(|a| share(a, slot, now)).collect(),
                    })
                })
                .collect();
            Some(Group {
                provider,
                title: provider.spec().title,
                subscription: provider.spec().is_subscription(),
                limits: slots.iter().map(Slot::title).collect(),
                accounts: accounts.iter().map(|a| row(a, &slots, now)).collect(),
                overview,
                working: pool.map_or_else(
                    || accounts.iter().filter(|a| serving(a)).count(),
                    |pool| pool.accounts,
                ),
            })
        })
        .collect()
}

/// A kind of usage window: its span, and the model it is limited to. Sorts
/// windows covering every request first, shortest first, then the rest.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Slot {
    scoped: bool,
    order: u8,
    span: String,
    model: Option<String>,
}

impl Slot {
    fn of_window(window: &Window) -> Self {
        Self {
            scoped: window.model.is_some(),
            order: match window.span.as_str() {
                "5h" => 0,
                "7d" => 1,
                "30d" => 2,
                _ => 3,
            },
            span: window.span.clone(),
            model: window.model.clone(),
        }
    }

    fn holds(&self, window: &Window) -> bool {
        window.span == self.span && window.model == self.model
    }

    fn of<'a>(&self, account: &'a AccountReport) -> Option<&'a Window> {
        account.state.limits.windows.iter().find(|w| self.holds(w))
    }

    fn title(&self) -> String {
        let span = match self.span.as_str() {
            "5h" => "5-hour",
            "7d" => "Weekly",
            "30d" => "Monthly",
            other => other,
        };
        match &self.model {
            Some(model) => format!("{span} · {model}"),
            None => span.to_owned(),
        }
    }
}

/// Every kind of window the accounts report, in column order.
fn slots(accounts: &[&AccountReport]) -> Vec<Slot> {
    let mut slots: Vec<Slot> = accounts
        .iter()
        .flat_map(|a| a.state.limits.windows.iter().map(Slot::of_window))
        .collect();
    slots.sort();
    slots.dedup();
    slots
}

fn serving(account: &AccountReport) -> bool {
    !account.disabled && account.auth_error.is_none()
}

fn share(account: &AccountReport, slot: &Slot, now: Timestamp) -> Share {
    let used = slot.of(account).map_or(0.0, |w| w.used_at(now));
    Share {
        fraction: (used / 100.0).clamp(0.0, 1.0) as f32,
        tone: Tone::of_use(used),
        idle: !serving(account),
    }
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

/// The header's line about the proxy.
pub fn proxy_line(snapshot: &Snapshot) -> String {
    match &snapshot.proxy {
        Proxy::Checking => "Looking for the proxy…".to_owned(),
        Proxy::Starting => "Starting the proxy…".to_owned(),
        Proxy::Running { version } => format!("Running {version} at {}", snapshot.address),
        Proxy::Stopped => "Stopped: agents cannot reach slopmax".to_owned(),
    }
}

/// How an agent is wired, and whether that is through slopmax.
pub fn agent_line(agent: &AgentStatus) -> (String, bool) {
    match &agent.wiring {
        Wiring::Slopmax => ("Goes through slopmax".to_owned(), true),
        Wiring::Elsewhere(target) => (format!("Goes to {target}"), false),
        Wiring::Direct => ("Goes straight to its provider".to_owned(), false),
    }
}

/// The login service's line, and whether it can be installed.
pub fn service_line(service: Option<&service::Status>) -> (String, bool) {
    match service {
        None => (
            "Runs while you are signed in to this machine".to_owned(),
            false,
        ),
        Some(s) if s.installed && s.running => ("Starts at login; running".to_owned(), false),
        Some(s) if s.installed => ("Starts at login; not running now".to_owned(), false),
        Some(_) => ("Not started at login yet".to_owned(), true),
    }
}

/// What a sign-in in progress asks of the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInView {
    pub title: String,
    pub detail: String,
    /// The address to open, to show in full and copy.
    pub link: Option<String>,
    /// A device code to enter.
    pub code: Option<String>,
    /// Notes while waiting, such as a rejected paste.
    pub notes: String,
}

pub fn sign_in(sign_in: &SignIn) -> SignInView {
    let title = sign_in.provider.spec().title;
    let (detail, link, code) = match &sign_in.step {
        Step::Starting => ("Starting…".to_owned(), None, None),
        Step::Authorize { url, opened: true } => (
            format!("Finish signing in to {title} in your browser, which opened this address:"),
            Some(url.clone()),
            None,
        ),
        Step::Authorize { url, opened: false } => (
            format!("Open this address in a browser and sign in to {title}:"),
            Some(url.clone()),
            None,
        ),
        Step::DeviceCode { url, code } => (
            format!("Open {url} and enter this code:"),
            None,
            Some(code.clone()),
        ),
    };
    SignInView {
        title: format!("Signing in to {title}"),
        detail,
        link,
        code,
        notes: sign_in.notes.join("\n"),
    }
}

pub fn gauge(window: &Window, now: Timestamp) -> Gauge {
    let used = window.used_at(now);
    let reset = window.upcoming_reset(now).filter(|_| used > 0.0);
    Gauge {
        fraction: (used / 100.0).clamp(0.0, 1.0) as f32,
        percent: format!("{used:.0}%"),
        resets_in: reset.map(|at| human::until(at, now)),
        resets_at: reset.map(|at| clock(at, now, at.local_offset())),
        tone: Tone::of_use(used),
        pace: pace(window, used, now),
    }
}

/// How far within an even spend counts as on pace, in points.
const ON_PACE: f64 = 5.;

/// The window's use against spending it evenly until it resets: nothing
/// before 3% of it has passed, too soon to say, nor once it is spent.
fn pace(window: &Window, used: f64, now: Timestamp) -> Option<Pace> {
    let length = match window.span.as_str() {
        "5h" => 5 * 3_600,
        "7d" => 7 * 86_400,
        "30d" => 30 * 86_400,
        _ => return None,
    };
    let resets = window.upcoming_reset(now)?;
    let passed = length - resets.duration_since(now).as_secs();
    let elapsed = passed as f64 / length as f64;
    if !(0.03..1.).contains(&elapsed) || used >= 100. {
        return None;
    }
    let ahead = used - elapsed * 100.;
    let label = if ahead.abs() < ON_PACE {
        Label {
            text: "On pace".to_owned(),
            tone: Tone::Muted,
        }
    } else if ahead > 0. {
        // Ahead of an even spend, the same rate fills it before the reset.
        let rate = used / passed as f64;
        let out = now + SignedDuration::from_secs(((100. - used) / rate) as i64);
        Label {
            text: format!("Runs out ~{}", clock(out, now, out.local_offset())),
            tone: Tone::Warn,
        }
    } else {
        Label {
            text: format!("{:.0}% in reserve", -ahead),
            tone: Tone::Muted,
        }
    };
    Some(Pace {
        elapsed: elapsed as f32,
        label,
    })
}

/// `used 3m ago`, coarsely.
fn ago(at: Timestamp, now: Timestamp) -> String {
    let secs = now.duration_since(at).as_secs().max(0);
    match secs {
        0..60 => "used just now".to_owned(),
        60..3_600 => format!("used {}m ago", secs / 60),
        3_600..86_400 => format!("used {}h ago", secs / 3_600),
        _ => format!("used {}d ago", secs / 86_400),
    }
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// When `at` comes on a clock `offset` east of UTC: `22:59` on `now`'s day,
/// `Wed 20:27` within the week, `Nov 3` after.
fn clock(at: Timestamp, now: Timestamp, offset: SignedDuration) -> String {
    let day = |t: Timestamp| (t.as_second() + offset.as_secs()).div_euclid(86_400);
    let (hour, minute) = at.time_of_day(offset);
    match day(at) - day(now) {
        0 => format!("{hour:02}:{minute:02}"),
        // The first day, January 1st 1970, was a Thursday.
        1..=6 => format!(
            "{} {hour:02}:{minute:02}",
            WEEKDAYS[(day(at) + 3).rem_euclid(7) as usize]
        ),
        _ => {
            let (_, month, date) = at.date(offset);
            format!("{} {date}", MONTHS[month as usize - 1])
        }
    }
}

fn row(account: &AccountReport, slots: &[Slot], now: Timestamp) -> Row {
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
        limits: slots
            .iter()
            .map(|slot| slot.of(account).map(|w| gauge(w, now)))
            .collect(),
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
        last_used: account.state.last_used.map(|at| ago(at, now)),
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

    /// Claude accounts with these windows each.
    fn report_of(now: Timestamp, accounts: Vec<(&str, Vec<Window>)>) -> Report {
        let accounts: Vec<(Account, Vec<Window>)> = accounts
            .into_iter()
            .map(|(email, windows)| {
                let mut account = Account::new(ProviderId::Claude, Tokens::default());
                account.email = Some(email.into());
                account.org_id = Some(email.into());
                account.assign_id();
                (account, windows)
            })
            .collect();
        let windows: HashMap<String, Vec<Window>> = accounts
            .iter()
            .map(|(a, windows)| (a.id.clone(), windows.clone()))
            .collect();
        build(
            accounts.into_iter().map(|(a, _)| a).collect(),
            |id| AccountState {
                limits: Limits {
                    windows: windows[id].clone(),
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

    fn report(now: Timestamp) -> Report {
        report_of(
            now,
            [("a@x.dev", 80.0), ("b@x.dev", 20.0)]
                .into_iter()
                .map(|(email, used)| {
                    (
                        email,
                        vec![window("5h", used, 4_600), window("7d", 10.0, 90_000)],
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn groups_carry_gauges_status_and_the_pool() {
        let now = ts(1_000);
        let groups = groups(&report(now), now);
        assert_eq!(groups.len(), 1);
        let claude = &groups[0];
        assert_eq!(claude.title, "Claude");
        assert_eq!(claude.limits, ["5-hour", "Weekly"]);
        assert_eq!(claude.accounts.len(), 2);
        let busy = &claude.accounts[0];
        let five_hour = busy.limits[0].as_ref().unwrap();
        assert_eq!(five_hour.percent, "80%");
        assert_eq!(five_hour.resets_in.as_deref(), Some("1h00m"));
        assert_eq!(five_hour.tone, Tone::Warn);
        assert_eq!(busy.status.text, "ready");
        assert_eq!(claude.working, 2);
        let pool = &claude.overview[0];
        assert_eq!(pool.title, "5-hour");
        assert_eq!(pool.gauge.percent, "50%");
        let shares: Vec<f32> = pool.shares.iter().map(|s| s.fraction).collect();
        assert_eq!(shares, [0.8, 0.2]);
    }

    #[test]
    fn a_window_for_one_model_gets_a_column_after_the_shared_ones() {
        let now = ts(1_000);
        let fable = Window {
            model: Some("Fable".into()),
            ..window("7d", 30.0, 90_000)
        };
        let report = report_of(
            now,
            vec![
                ("a@x.dev", vec![fable, window("5h", 10.0, 4_600)]),
                ("b@x.dev", vec![window("7d", 5.0, 90_000)]),
            ],
        );
        let claude = &groups(&report, now)[0];
        assert_eq!(claude.limits, ["5-hour", "Weekly", "Weekly · Fable"]);
        let percents = |row: &Row| -> Vec<Option<String>> {
            row.limits
                .iter()
                .map(|g| g.as_ref().map(|g| g.percent.clone()))
                .collect()
        };
        assert_eq!(
            percents(&claude.accounts[0]),
            [Some("10%".into()), None, Some("30%".into())]
        );
        assert_eq!(
            percents(&claude.accounts[1]),
            [None, Some("5%".into()), None]
        );
    }

    #[test]
    fn resets_read_on_the_local_clock() {
        // 1970-01-01 00:16:40 UTC, a Thursday.
        let now = ts(1_000);
        let utc = SignedDuration::ZERO;
        assert_eq!(clock(ts(1_000 + 22 * 3_600), now, utc), "22:16");
        assert_eq!(clock(ts(1_000 + 2 * 86_400), now, utc), "Sat 00:16");
        assert_eq!(clock(ts(1_000 + 10 * 86_400), now, utc), "Jan 11");
        // Five hours west, `now` is still Wednesday evening, so 00:16 UTC
        // the next morning lands on Thursday there.
        let west = SignedDuration::from_secs(-5 * 3_600);
        assert_eq!(clock(ts(1_000 + 5 * 3_600), now, west), "Thu 00:16");
    }

    #[test]
    fn pace_compares_use_with_an_even_spend() {
        let now = ts(100_000);
        // Halfway through a 5-hour window.
        let half = |used: f64| window("5h", used, 100_000 + 9_000);
        let label = |used| pace(&half(used), used, now).unwrap().label;
        assert_eq!(pace(&half(50.), 50., now).unwrap().elapsed, 0.5);
        assert_eq!(label(52.).text, "On pace");
        assert_eq!(label(20.).text, "30% in reserve");
        let ahead = label(70.);
        assert!(ahead.text.starts_with("Runs out ~"), "{}", ahead.text);
        assert_eq!(ahead.tone, Tone::Warn);
        // Too soon to say, and nothing left to pace.
        assert_eq!(pace(&window("5h", 10., 100_000 + 17_900), 10., now), None);
        assert_eq!(pace(&half(100.), 100., now), None);
    }

    #[test]
    fn last_use_reads_coarsely() {
        let now = ts(100_000);
        assert_eq!(ago(ts(99_990), now), "used just now");
        assert_eq!(ago(ts(100_000 - 180), now), "used 3m ago");
        assert_eq!(ago(ts(100_000 - 7_300), now), "used 2h ago");
        assert_eq!(ago(ts(100_000 - 200_000), now), "used 2d ago");
    }

    #[test]
    fn the_menu_bar_shows_each_pool() {
        let now = ts(1_000);
        assert_eq!(menu_bar(&report(now), now), "Claude 50%");
        // Once the window resets, its use is gone.
        assert_eq!(menu_bar(&report(now), ts(5_000)), "Claude 0%");
    }
}
