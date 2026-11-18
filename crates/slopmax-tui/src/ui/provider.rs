//! A provider's page: its accounts read as one pool, each account with its
//! windows, what they have served, and how its requests went over the
//! last day, and where the pool is heading at the pace it fills.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use slopmax_client::api::pools::{AccountDetail, Point, PoolDetail, Trend, WindowSpend};
use slopmax_client::api::report::{AccountView, Condition, Note, Report, Window, tone_of_use};
use slopmax_client::api::{Instant, Provider, Span as WindowSpan, Tone};

use super::widgets::{Flow, Segment, braille_lines, dot, segmented_bar, usage_bar};
use crate::app::{App, Hit, held_resets, serving};
use crate::format::{self, Now};

/// One of a pool's windows, as a line of the overview and the pool.
pub struct PoolLine {
    pub title: String,
    pub used: f64,
    pub resets_at: Option<Instant>,
    pub segments: Vec<Segment>,
}

/// Every kind of window the accounts report: those over every request
/// first, shortest first, then those on one model.
pub fn slots(accounts: &[&AccountView]) -> Vec<(WindowSpan, Option<String>)> {
    let mut found: Vec<(WindowSpan, Option<String>)> = Vec::new();
    for account in accounts {
        for window in &account.windows {
            let slot = (window.span, window.model.clone());
            if !found.contains(&slot) {
                found.push(slot);
            }
        }
    }
    found.sort_by(|a, b| (a.1.is_some(), a.0, &a.1).cmp(&(b.1.is_some(), b.0, &b.1)));
    found
}

fn holds(window: &Window, slot: &(WindowSpan, Option<String>)) -> bool {
    window.span == slot.0 && window.model == slot.1
}

/// A provider's windows read as one pool, each with every account's part.
pub fn pool_lines(report: &Report, provider: Provider, now: &Now) -> Vec<PoolLine> {
    let accounts: Vec<&AccountView> = report
        .accounts
        .iter()
        .filter(|a| a.provider == provider)
        .collect();
    let pool = report.pools.iter().find(|p| p.provider == provider);
    let weighted = pool.is_some_and(|p| !p.shares.is_empty());
    slots(&accounts)
        .into_iter()
        .filter_map(|slot| {
            let window: Option<Window> = match (pool, &slot.1) {
                (Some(pool), None) => pool.window(slot.0).map(|w| w.as_window()),
                (Some(pool), Some(_)) => pool.scoped.iter().find(|w| holds(w, &slot)).cloned(),
                (None, _) if accounts.len() == 1 => accounts[0]
                    .windows
                    .iter()
                    .find(|w| holds(w, &slot))
                    .cloned(),
                (None, _) => None,
            };
            let window = window?;
            let segments = accounts
                .iter()
                .map(|a| Segment {
                    weight: if weighted {
                        pool.and_then(|p| p.shares.get(&a.id))
                            .copied()
                            .unwrap_or(0.0)
                    } else {
                        1.0
                    },
                    used: a
                        .windows
                        .iter()
                        .find(|w| holds(w, &slot))
                        .map_or(0.0, |w| w.used_at(now.at)),
                    idle: !serving(a),
                })
                .collect();
            Some(PoolLine {
                title: format::window_title(slot.0, slot.1.as_deref()),
                used: window.used_at(now.at),
                resets_at: window
                    .upcoming_reset(now.at)
                    .filter(|_| window.used_at(now.at) > 0.0),
                segments,
            })
        })
        .collect()
}

/// A pool's window as a line: its title, the bar split by account, how
/// full, and when it resets.
pub fn pool_row(flow: &mut Flow<'_>, line: &PoolLine, now: &Now, indent: u16) {
    let theme = flow.theme;
    let title_w = 16u16;
    let reset_w: u16 = if flow.width >= 90 { 31 } else { 0 };
    let bar_w = flow
        .width
        .saturating_sub(indent + title_w + 6 + reset_w + 1)
        .clamp(8, 64);
    let mut spans = vec![
        Span::raw(" ".repeat(indent as usize)),
        Span::styled(
            format!(
                "{:<w$}",
                format::fit(&line.title, title_w as usize - 1),
                w = title_w as usize
            ),
            theme.muted(),
        ),
    ];
    spans.extend(segmented_bar(theme, &line.segments, bar_w));
    spans.push(Span::styled(
        format!("{:>5}", format::percent(line.used)),
        theme.strong().patch(theme.tone(tone_of_use(line.used))),
    ));
    if reset_w > 0 {
        let resets = match line.resets_at {
            Some(at) => format!("   resets in {} · {}", now.until(at), now.clock(at)),
            None => String::new(),
        };
        spans.push(Span::styled(resets, theme.muted()));
    }
    flow.line(Line::from(spans));
    if reset_w == 0
        && let Some(at) = line.resets_at
    {
        flow.line(Line::from(Span::styled(
            format!(
                "{}resets in {} · {}",
                " ".repeat((indent + title_w) as usize),
                now.until(at),
                now.clock(at)
            ),
            theme.muted(),
        )));
    }
}

/// Where a new session would go, and why; a warning when none can take
/// one.
pub fn next_line(report: &Report, provider: Provider, now: &Now) -> (String, Tone) {
    let accounts: Vec<&AccountView> = report
        .accounts
        .iter()
        .filter(|a| a.provider == provider)
        .collect();
    let pool = report.pools.iter().find(|p| p.provider == provider);
    if let Some(next) = pool.and_then(|p| p.next.as_ref()) {
        let name = accounts
            .iter()
            .find(|a| a.id == next.account)
            .map_or(next.account.as_str(), |a| a.name.as_str());
        return (
            format!("→ New sessions go to {name} · {}", next.why),
            Tone::Muted,
        );
    }
    // A limit that has passed holds nothing back.
    let back = accounts
        .iter()
        .filter(|a| !a.disabled)
        .filter_map(|a| match a.condition.at(now.at) {
            Condition::Limited { until } => Some((until, a.name.as_str())),
            _ => None,
        })
        .min_by_key(|(until, _)| *until);
    match back {
        Some((until, name)) => (
            format!(
                "No account can take a new session until {}, when {name} is back",
                now.clock(until)
            ),
            Tone::Warn,
        ),
        None => ("No account can take a new session".into(), Tone::Warn),
    }
}

pub fn draw(app: &App, provider: Provider, flow: &mut Flow<'_>, now: &Now) {
    let theme = flow.theme;
    let Some(report) = &app.data.report else {
        flow.line(Line::from(Span::styled(
            "Looking for slopmax…",
            theme.muted(),
        )));
        return;
    };
    let accounts = app.accounts();
    let pool = app.data.pool(provider).and_then(|s| s.value.as_ref());
    if provider.is_subscription() {
        let lines = pool_lines(report, provider, now);
        if !lines.is_empty() {
            let (next, tone) = next_line(report, provider, now);
            flow.section("Pool", None);
            for line in &lines {
                pool_row(flow, line, now, 1);
            }
            let weighted = report
                .pools
                .iter()
                .find(|p| p.provider == provider)
                .is_some_and(|p| !p.shares.is_empty());
            let working = accounts.iter().filter(|a| serving(a)).count();
            let basis = if weighted {
                "weighted by plan"
            } else {
                "each account counted alike"
            };
            let across = if working >= accounts.len() {
                format!(
                    "Across {}, {basis}",
                    format::count(accounts.len() as u64, "account")
                )
            } else {
                format!(
                    "Across {working} of {}, {basis}; the rest are out of service",
                    format::count(accounts.len() as u64, "account")
                )
            };
            flow.line(Line::from(Span::styled(
                format!(" {across}"),
                theme.muted(),
            )));
            flow.line(Line::from(vec![
                Span::raw(" "),
                Span::styled(next, theme.tone(tone)),
            ]));
            flow.gap();
        }
    }
    let pinned = accounts.iter().any(|a| a.pinned);
    let trailing = pinned.then(|| {
        Line::from(vec![
            Span::styled("a", theme.strong()),
            Span::styled(" let slopmax choose", theme.muted()),
        ])
    });
    let title = if provider.is_subscription() {
        "Accounts"
    } else {
        "Keys"
    };
    flow.section(title, trailing);
    let columns = slots(&accounts);
    for (i, account) in accounts.iter().enumerate() {
        let top = flow.y;
        let detail = pool.and_then(|p| p.accounts.iter().find(|d| d.id == account.id));
        account_rows(
            flow,
            app,
            account,
            &columns,
            detail,
            pool,
            i == app.cursor,
            now,
        );
        flow.hit(
            Rect::new(flow.x, top, flow.width, flow.y - top),
            Hit::Row(i),
        );
        flow.gap();
    }
    // Where the pool is heading comes after the accounts, so the one
    // selected is on screen as the page opens, as the keys act on it.
    if provider.is_subscription()
        && let Some(pool) = pool
        && !pool.trends.is_empty()
    {
        flow.section("Forecast", None);
        for trend in &pool.trends {
            forecast(flow, trend, report, now);
        }
    }
}

/// A trend's figures, and its use as recorded and projected as a chart.
fn forecast(flow: &mut Flow<'_>, trend: &Trend, report: &Report, now: &Now) {
    let theme = flow.theme;
    let name = |id: &str| {
        report
            .accounts
            .iter()
            .find(|a| a.id == id)
            .map_or(id.to_owned(), |a| a.name.clone())
    };
    let mut figures = vec![Span::styled(
        format!(" {:<9}", format::span_title(trend.span)),
        theme.strong(),
    )];
    figures.push(Span::styled(
        format!("{:.0}% used", trend.used),
        theme.tone(tone_of_use(trend.used)),
    ));
    if let Some(burn) = trend.burn {
        figures.push(Span::styled(
            format!(" · {burn:.1}%/h recently"),
            Style::new(),
        ));
    }
    if let Some(sustainable) = trend.sustainable {
        figures.push(Span::styled(
            format!(" · {sustainable:.1}%/h sustainable"),
            theme.muted(),
        ));
    }
    match (trend.runs_out_at, trend.dry_until) {
        (Some(out), Some(back)) => figures.push(Span::styled(
            format!(
                " · runs out ~{}, room again {}",
                now.clock(out),
                now.clock(back)
            ),
            theme.tone(Tone::Warn),
        )),
        (Some(out), None) => figures.push(Span::styled(
            format!(" · runs out ~{}", now.clock(out)),
            theme.tone(Tone::Warn),
        )),
        _ => figures.push(Span::styled(
            " · lasts to its resets",
            theme.tone(Tone::Good),
        )),
    }
    flow.line(Line::from(figures));
    let chart_w = flow.width.saturating_sub(8);
    let area = flow.take(4);
    let area = Rect {
        x: area.x + 6,
        width: chart_w.min(area.width.saturating_sub(6)),
        ..area
    };
    // Past the canvas's end there is nothing to draw on.
    if area.height == 0 || area.width == 0 {
        flow.gap();
        return;
    }
    flow.buf
        .set_string(area.x - 6, area.y, "100%", theme.muted());
    flow.buf
        .set_string(area.x - 6, area.bottom() - 1, "  0%", theme.muted());
    let (from, to) = {
        let first = trend
            .recorded
            .first()
            .or(trend.projected.first())
            .map(|p| p.at);
        let last = trend
            .projected
            .last()
            .or(trend.recorded.last())
            .map(|p| p.at);
        (first, last)
    };
    let points = |list: &[Point], offset: usize, all: usize| -> Vec<(f64, f64)> {
        list.iter()
            .enumerate()
            .map(|(i, p)| {
                let x = match (from, to) {
                    (Some(a), Some(b)) if b > a => {
                        p.at.duration_since(a).as_secs() as f64
                            / b.duration_since(a).as_secs() as f64
                    }
                    _ => (i + offset) as f64 / all.saturating_sub(1).max(1) as f64,
                };
                (x, p.used / 100.0)
            })
            .collect()
    };
    let all = trend.recorded.len() + trend.projected.len();
    let recorded = points(&trend.recorded, 0, all);
    let projected = points(
        &trend.projected,
        trend.recorded.len().saturating_sub(1),
        all,
    );
    // Where the pool runs dry, as a faint line along the top.
    for x in area.x..area.right() {
        flow.buf[(x, area.y)]
            .set_symbol("┈")
            .set_style(theme.rule());
    }
    braille_lines(
        flow.buf,
        area,
        &[
            (projected.as_slice(), theme.muted()),
            (recorded.as_slice(), theme.ink()),
        ],
    );
    let mut notes = Vec::new();
    if let Some(first) = &trend.first_out {
        notes.push(format!(
            "{} is out first ~{}, at its recent pace",
            name(&first.account),
            now.clock(first.at)
        ));
    }
    let resets: Vec<String> = trend
        .resets
        .iter()
        .take(3)
        .map(|r| {
            format!(
                "{} +{:.0}% at {}",
                name(&r.account),
                r.gives_back,
                now.clock(r.at)
            )
        })
        .collect();
    if !resets.is_empty() {
        notes.push(format!("resets ahead: {}", resets.join(", ")));
    }
    if !notes.is_empty() {
        flow.wrapped(&notes.join(" · "), theme.muted(), 6);
    }
    flow.gap();
}

#[allow(clippy::too_many_arguments)]
fn account_rows(
    flow: &mut Flow<'_>,
    app: &App,
    account: &AccountView,
    columns: &[(WindowSpan, Option<String>)],
    detail: Option<&AccountDetail>,
    pool: Option<&PoolDetail>,
    selected: bool,
    now: &Now,
) {
    let theme = flow.theme;
    let marker = if selected {
        Span::styled("▌", theme.accent())
    } else {
        Span::raw(" ")
    };
    let mut name_style = theme.strong();
    if account.disabled {
        name_style = theme.muted();
    } else if selected {
        name_style = name_style.patch(theme.accent());
    }
    let mut title = vec![marker, Span::styled(account.name.clone(), name_style)];
    let next = app
        .data
        .report
        .as_ref()
        .and_then(|r| r.pools.iter().find(|p| p.provider == account.provider))
        .and_then(|p| p.next.as_ref())
        .is_some_and(|n| n.account == account.id);
    if next {
        title.push(Span::styled("  next", theme.tone(Tone::Accent)));
    }
    if account.pinned && !account.disabled {
        title.push(Span::styled("  pinned", theme.tone(Tone::Accent)));
    }
    let plan = match &account.plan {
        Some(plan) => format::title_case(plan),
        None if !account.provider.is_subscription() => "per token".into(),
        None => String::new(),
    };
    flow.split_line(
        Line::from(title),
        Line::from(Span::styled(plan, theme.muted())),
    );
    let condition = account.condition.at(now.at);
    let mut status = vec![
        Span::raw("  "),
        dot(theme, condition.tone()),
        Span::raw(" "),
        Span::styled(
            condition
                .describe(now.at)
                .trim_start_matches("● ")
                .to_owned(),
            theme.tone(condition.tone()),
        ),
    ];
    if let Some(used) = account.last_used {
        status.push(Span::styled(
            format!(" · used {}", now.ago(used)),
            theme.muted(),
        ));
    }
    if let Some(follows) = &account.follows {
        status.push(Span::styled(format!(" · follows {follows}"), theme.muted()));
    }
    flow.line(Line::from(status));
    if account.provider.is_subscription() {
        for slot in columns {
            let Some(window) = account.windows.iter().find(|w| holds(w, slot)) else {
                continue;
            };
            let spend = slot
                .1
                .is_none()
                .then(|| detail.and_then(|d| d.windows.iter().find(|w| w.span == slot.0)))
                .flatten();
            window_row(flow, account, window, spend, now);
        }
    } else {
        if let Some(endpoint) = &account.endpoint {
            flow.line(Line::from(Span::styled(
                format!("  {endpoint}"),
                theme.muted(),
            )));
        }
        let models = if account.models.is_empty() {
            "Any model".to_owned()
        } else {
            account.models.join(", ")
        };
        flow.line(Line::from(Span::styled(
            format!("  {models}"),
            theme.muted(),
        )));
    }
    let mut notes: Vec<Span<'static>> = Vec::new();
    let held = held_resets(account, now.at);
    if held > 0 {
        let expiry = account
            .unexpired_resets(now.at)
            .filter_map(|r| r.expires_at)
            .min()
            .map(|at| format!(", the next expires in {}", now.until(at)))
            .unwrap_or_default();
        notes.push(Span::styled(
            format!("{}{expiry}", format::count(held, "limit reset")),
            theme.tone(Tone::Accent),
        ));
    }
    for note in &account.notes {
        let text = match note {
            Note::Resets { .. } | Note::Pinned | Note::Follows { .. } => continue,
            Note::Served { requests, tokens } => format!(
                "{}, {} tokens all time",
                format::count(*requests, "request"),
                format::compact(*tokens)
            ),
            other => other.describe(),
        };
        notes.push(Span::styled(text, theme.tone(note.tone())));
    }
    if !notes.is_empty() {
        let mut line = vec![Span::raw("  ")];
        for (i, note) in notes.into_iter().enumerate() {
            if i > 0 {
                line.push(Span::styled(" · ", theme.muted()));
            }
            line.push(note);
        }
        flow.line(Line::from(line));
    }
    if let (Some(detail), Some(pool)) = (detail, pool)
        && !detail.health.is_empty()
    {
        health(flow, detail, pool, now);
    }
}

/// One of an account's windows: bar, use, reset, pace, and what it has
/// served since it began.
fn window_row(
    flow: &mut Flow<'_>,
    account: &AccountView,
    window: &Window,
    spend: Option<&WindowSpend>,
    now: &Now,
) {
    let theme = flow.theme;
    let used = window.used_at(now.at);
    let full = account.windows.iter().any(|w| w.used_at(now.at) >= 100.0);
    let faded = account.disabled || (full && used < 100.0);
    let bar_w = if flow.width >= 100 { 28 } else { 16 };
    let mut spans = vec![Span::styled(
        format!(
            "  {:<15}",
            format::fit(
                &format::window_title(window.span, window.model.as_deref()),
                14
            )
        ),
        theme.muted(),
    )];
    spans.extend(usage_bar(theme, used, bar_w, faded));
    spans.push(Span::styled(
        format!("{:>5}", format::percent(used)),
        theme.strong().patch(theme.tone(tone_of_use(used))),
    ));
    if let Some(at) = window.upcoming_reset(now.at).filter(|_| used > 0.0) {
        spans.push(Span::styled(
            format!("  {} · {}", now.until(at), now.clock(at)),
            theme.muted(),
        ));
    }
    if let Some((text, tone)) = format::pace(window, now) {
        spans.push(Span::styled(format!("  {text}"), theme.tone(tone)));
    }
    if let Some(spend) = spend
        && flow.width >= 110
    {
        let per = spend
            .per_percent
            .map(|p| format!(" · {}/1%", format::dollars(p)))
            .unwrap_or_default();
        spans.push(Span::styled(
            format!("  {} served{per}", format::dollars(spend.cost)),
            theme.muted(),
        ));
    }
    flow.line(Line::from(spans));
}

/// The last day's answers and failures, a cell per stretch of time.
fn health(flow: &mut Flow<'_>, detail: &AccountDetail, pool: &PoolDetail, now: &Now) {
    let theme = flow.theme;
    // Room after the title for the summary at the end, its longest
    // (`  1234 ok since Mon 09:30`) whole.
    let room = flow.width.saturating_sub(17 + 26) as usize;
    let cells = &detail.health[detail.health.len().saturating_sub(room)..];
    let mut spans = vec![Span::styled(format!("  {:<15}", "Last day"), theme.muted())];
    for cell in cells {
        let (symbol, style) = match (cell.answered, cell.failed) {
            (0, 0) => ("·", theme.muted()),
            (_, 0) => ("▪", theme.tone(Tone::Good)),
            (0, _) => ("▪", theme.tone(Tone::Bad)),
            _ => ("▪", theme.tone(Tone::Warn)),
        };
        spans.push(Span::styled(symbol, style));
    }
    let answered: u64 = cells.iter().map(|c| c.answered).sum();
    let failed: u64 = cells.iter().map(|c| c.failed).sum();
    // The first cell shown, not the day's first: a narrow screen shows
    // fewer of them.
    let skipped = (detail.health.len() - cells.len()) as i64;
    let since = pool.health_since
        + slopmax_common::time::SignedDuration::from_secs(
            skipped * i64::from(pool.cell_minutes) * 60,
        );
    let when = now.clock_back(since);
    let words = if failed > 0 {
        format!("  {answered} ok, {failed} failed since {when}")
    } else {
        format!("  {answered} ok since {when}")
    };
    spans.push(Span::styled(words, theme.muted()));
    flow.line(Line::from(spans));
}
