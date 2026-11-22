//! Usage and Performance: what the ledger says of a span, as figures and
//! charts. Both read the same history, so switching between them fetches
//! nothing new.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use slopmax_client::api::ledger::{History, HistoryBucket, HistoryRange, NamedTotals, Totals};
use slopmax_client::api::{Provider, Tone};

use super::widgets::{
    Flow, Stat, TWO_COLUMNS, axis_labels, bar_row, braille_lines, change, scaled_columns, shade,
    stacked_columns, stats, tabs,
};
use crate::app::{App, Hit, RANGES, range_title};
use crate::format::{self, Now};

/// What a history's cache reads come to: `96% from cache`.
pub fn cache_note(cached: Option<f64>) -> String {
    match cached {
        Some(cached) => format!("{:.0}% from cache", cached * 100.0),
        None => "no cache reads".into(),
    }
}

/// Today's tokens hour by hour, all 24 hours.
pub fn hourly(history: &History) -> Vec<f64> {
    let mut hours = vec![0.0; 24];
    for (i, bucket) in history.buckets.iter().enumerate() {
        let hour = bucket
            .label
            .split(':')
            .next()
            .filter(|h| h.len() == 2)
            .and_then(|h| h.parse::<usize>().ok())
            .unwrap_or(i);
        if let Some(slot) = hours.get_mut(hour) {
            *slot = bucket.tokens.iter().sum();
        }
    }
    hours
}

fn tokens(t: &Totals) -> u64 {
    t.input + t.output + t.cache_read + t.cache_write
}

/// The model-name prefixes a provider serves, to color a model by.
fn serves(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Claude | Provider::Anthropic => &["claude-"],
        Provider::Codex | Provider::OpenAi => &["gpt-", "codex-", "o1", "o3", "o4"],
        Provider::Grok | Provider::Xai => &["grok-"],
        Provider::Compat => &[],
    }
}

/// The provider of the history's that serves a model, first in its order;
/// none for a name no provider claims.
pub fn model_provider(providers: &[Provider], model: &str) -> Option<Provider> {
    providers
        .iter()
        .copied()
        .find(|p| serves(*p).iter().any(|prefix| model.starts_with(prefix)))
}

/// The provider an agent is made for, by its name; none for `Other` and
/// `Warmups`.
pub fn agent_provider(name: &str) -> Option<Provider> {
    match name {
        "Claude Code" => Some(Provider::Claude),
        "Codex" => Some(Provider::Codex),
        "Grok Build" => Some(Provider::Grok),
        _ => None,
    }
}

/// A provider's color, as the Tokens chart gives it; the foreground for a
/// row no one provider owns.
fn provider_ink(flow: &Flow<'_>, providers: &[Provider], provider: Option<Provider>) -> Style {
    provider
        .and_then(|p| providers.iter().position(|q| *q == p))
        .map_or(flow.theme.ink(), |i| flow.theme.series(i))
}

/// How many whole days the month's pace averages: as many as the 7-day
/// range holds besides today, so it reads the same there as on 30 days.
const PACE_DAYS: usize = 6;

/// What 30 days at the recent pace would be worth, and how it was had:
/// the average of the last [`PACE_DAYS`] whole days, from the first of them
/// that held a request (today left out, as it is not over); for today, the
/// hours so far. The same figure on 7 and 30 days.
pub fn month_pace(history: &History) -> (String, String) {
    if history.range == HistoryRange::Today {
        let hours = history.buckets.len();
        return if hours < 3 {
            ("—".into(), "after a few hours of today".into())
        } else {
            let total: f64 = history.buckets.iter().map(|b| b.cost).sum();
            (
                format::dollars(total / hours as f64 * 24.0 * 30.0),
                "at today's pace".into(),
            )
        };
    }
    // The window first, then from its first day of use, so a request
    // older than the 7-day range can't stretch it.
    let whole = &history.buckets[..history.buckets.len().saturating_sub(1)];
    let window = &whole[whole.len().saturating_sub(PACE_DAYS)..];
    let Some(first) = window.iter().position(|d| d.requests + d.failed > 0) else {
        return ("—".into(), "after a whole day of use".into());
    };
    let days: &[HistoryBucket] = &window[first..];
    let per_day = days.iter().map(|d| d.cost).sum::<f64>() / days.len() as f64;
    let note = format!("from the last {}", format::count(days.len() as u64, "day"));
    (format::dollars(per_day * 30.0), note)
}

/// The "When you work" grid's levels, as a contribution graph has them: 0
/// for an hour with no request, else 1 to 4 by where it ranks among the
/// busy hours, so one burst does not wash the rest out.
pub fn levels(activity: &[Vec<u64>]) -> Vec<Vec<u8>> {
    // Ranked among the distinct counts, so many quiet hours alike can't
    // share the peak's level.
    let mut busy: Vec<u64> = activity
        .iter()
        .flatten()
        .copied()
        .filter(|n| *n > 0)
        .collect();
    busy.sort_unstable();
    busy.dedup();
    activity
        .iter()
        .map(|hours| {
            hours
                .iter()
                .map(|n| {
                    if *n == 0 {
                        return 0;
                    }
                    let at_most = busy.iter().filter(|v| **v <= *n).count();
                    (4 * at_most).div_ceil(busy.len()).clamp(1, 4) as u8
                })
                .collect()
        })
        .collect()
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_NAMES: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
const DAY_PARTS: [&str; 4] = ["Nights", "Mornings", "Afternoons", "Evenings"];

/// What the grid says in words, as (title, figure, note): the busiest hour,
/// the busiest day, the part of the day most requests fall in, and the
/// weekends' share. None when no request was made.
pub fn rhythm(activity: &[Vec<u64>]) -> Vec<(&'static str, String, String)> {
    let total: u64 = activity.iter().flatten().sum();
    if total == 0 {
        return Vec::new();
    }
    let share = |n: u64| format!("{:.0}%", n as f64 / total as f64 * 100.0);
    let mut hour = (0, 0, 0);
    for (day, hours) in activity.iter().enumerate() {
        for (h, n) in hours.iter().enumerate() {
            if *n > hour.2 {
                hour = (day, h, *n);
            }
        }
    }
    let days: Vec<u64> = activity.iter().map(|h| h.iter().sum()).collect();
    // The first of the busiest, as the dashboard picks it.
    let first_most = |values: &[u64]| {
        values
            .iter()
            .enumerate()
            .fold(0, |best, (i, n)| if *n > values[best] { i } else { best })
    };
    let day = first_most(&days);
    let parts: Vec<u64> = (0..4)
        .map(|part| {
            activity
                .iter()
                .map(|h| h.iter().skip(part * 6).take(6).sum::<u64>())
                .sum()
        })
        .collect();
    let part = first_most(&parts);
    let weekend = days.get(5).copied().unwrap_or(0) + days.get(6).copied().unwrap_or(0);
    vec![
        (
            "Busiest hour",
            format!("{} {:02}:00", WEEKDAYS[hour.0.min(6)], hour.1),
            format::count(hour.2, "request"),
        ),
        (
            "Busiest day",
            WEEKDAY_NAMES[day.min(6)].into(),
            format!("{} of requests", share(days[day])),
        ),
        (
            "Most active",
            DAY_PARTS[part].into(),
            format!("{} of requests", share(parts[part])),
        ),
        ("Weekends", share(weekend), "of requests".into()),
    ]
}

/// The span tabs, and the history once it is read; what the page says
/// while it isn't.
fn header<'h>(app: &'h App, flow: &mut Flow<'_>) -> Option<&'h History> {
    let theme = flow.theme;
    if flow.y < flow.buf.area.bottom() {
        let ranges: Vec<_> = RANGES.iter().map(|r| (*r, range_title(*r))).collect();
        let (x, y) = (flow.x + 1, flow.y);
        tabs(flow, x, y, &ranges, app.range, Hit::Range);
    }
    flow.gap();
    flow.gap();
    let slot = app.data.history(app.range);
    match (&slot.value, &slot.error) {
        (Some(history), _) => Some(history),
        (None, Some(error)) => {
            flow.wrapped(error, theme.tone(Tone::Bad), 1);
            None
        }
        (None, None) => {
            flow.line(Line::from(Span::styled(
                " Reading the ledger…",
                theme.muted(),
            )));
            None
        }
    }
}

fn quiet(history: &History) -> bool {
    history.total.requests == 0 && history.total.failed == 0
}

fn nothing_yet(flow: &mut Flow<'_>) {
    let theme = flow.theme;
    flow.line(Line::from(Span::styled(
        " Nothing in this span yet",
        theme.strong(),
    )));
    flow.line(Line::from(Span::styled(
        " Requests show here once your agents go through slopmax.",
        theme.muted(),
    )));
}

pub fn draw_usage(app: &App, flow: &mut Flow<'_>, _now: &Now) {
    let Some(history) = header(app, flow) else {
        return;
    };
    if quiet(history) {
        nothing_yet(flow);
        return;
    }
    let theme = flow.theme;
    let total = &history.total;
    let previous = history.previous.as_ref().map(|p| &p.total);
    let value_note = if history.billed > 0.0 {
        format!("billed to API keys {}", format::dollars(history.billed))
    } else if total.unpriced == 0 || total.unpriced < total.requests {
        "at API prices".into()
    } else {
        format!("{} unpriced", format::count(total.unpriced, "request"))
    };
    stats(
        flow,
        &[
            Stat {
                title: "Tokens".into(),
                value: format::compact(tokens(total)),
                note: cache_note(history.cached),
                change: previous.and_then(|p| change(tokens(total) as f64, tokens(p) as f64, true)),
            },
            Stat {
                title: "Requests".into(),
                value: format::grouped(total.requests),
                note: if history.sessions > 0 {
                    format::count(history.sessions, "conversation")
                } else {
                    "answered".into()
                },
                change: previous
                    .and_then(|p| change(total.requests as f64, p.requests as f64, true)),
            },
            Stat {
                title: "API value".into(),
                value: format::priced(total.cost, total.unpriced, total.requests),
                note: value_note,
                change: previous.and_then(|p| change(total.cost, p.cost, true)),
            },
            {
                let (value, note) = month_pace(history);
                Stat {
                    title: "Month at this pace".into(),
                    value,
                    note,
                    change: None,
                }
            },
        ],
    );
    flow.gap();

    let by = if app.range == HistoryRange::Today {
        "by hour"
    } else {
        "by day"
    };
    // The providers' colors, as the dashboard's legend, then the span.
    let mut legend = Vec::new();
    for (i, provider) in history.providers.iter().enumerate() {
        legend.push(Span::styled("█", theme.series(i)));
        legend.push(Span::styled(
            format!(" {}  ", provider.title()),
            theme.muted(),
        ));
    }
    legend.push(Span::styled(by, theme.muted()));
    flow.section("Tokens", Some(Line::from(legend)));
    let stacks: Vec<Vec<f64>> = history.buckets.iter().map(|b| b.tokens.clone()).collect();
    let most = stacks
        .iter()
        .map(|s| s.iter().sum::<f64>())
        .fold(0.0, f64::max);
    flow.line(Line::from(Span::styled(
        format!(" {} at the most", format::compact(most as u64)),
        theme.muted(),
    )));
    let area = flow.take(7);
    let styles: Vec<Style> = (0..history.providers.len())
        .map(|i| theme.series(i))
        .collect();
    stacked_columns(flow.buf, inset(area), &stacks, &styles, true);
    let labels: Vec<String> = history.buckets.iter().map(|b| b.label.clone()).collect();
    flow.line(Line::from(Span::styled(
        format!(" {}", axis_labels(&labels, inset(area).width)),
        theme.muted(),
    )));
    flow.gap();

    let wide = flow.width >= TWO_COLUMNS;
    let widths = if wide {
        flow.even(2, 4)
    } else {
        vec![flow.width]
    };
    flow.columns(&widths, 4, |i, column| {
        if i == 0 {
            column.section("Models", None);
            let providers = &history.providers;
            named_bars(column, &top(&history.models, 5), providers, |name| {
                model_provider(providers, name)
            });
        }
        if i == 1 || !wide {
            if !wide {
                column.gap();
            }
            column.section("Agents", None);
            named_bars(column, &history.agents, &history.providers, agent_provider);
        }
    });
    flow.gap();

    flow.section("Token mix", None);
    token_mix(flow, total);
    flow.gap();

    if !history.accounts.is_empty() {
        flow.section("Accounts", None);
        let most = history
            .accounts
            .iter()
            .map(|a| tokens(&a.totals))
            .max()
            .unwrap_or(1)
            .max(1);
        let name_w = name_width(flow, history.accounts.iter().map(|a| a.name.as_str()));
        for account in &history.accounts {
            let t = &account.totals;
            let ink = provider_ink(flow, &history.providers, Some(account.provider));
            bar_row(
                flow,
                &account.name,
                tokens(t) as f64 / most as f64,
                &[
                    format::compact(tokens(t)),
                    format::count(t.requests, "request"),
                    format::priced(t.cost, t.unpriced, t.requests),
                    account.provider.title().into(),
                ],
                name_w,
                ink,
            );
        }
        flow.gap();
    }

    if let Some(summary) = &app.data.machines(app.range).value {
        let rows: Vec<NamedTotals> = summary
            .rows
            .iter()
            .filter(|r| !matches!(r.key.as_str(), "this machine" | "hub"))
            .map(|r| NamedTotals {
                name: r.key.clone(),
                provider: None,
                totals: r.totals,
            })
            .collect();
        if !rows.is_empty() {
            flow.section("Machines", None);
            named_bars(flow, &rows, &[], |_| None);
            flow.gap();
        }
    }

    // A day has no weekdays to compare.
    if app.range != HistoryRange::Today
        && history
            .activity
            .iter()
            .any(|day| day.iter().any(|n| *n > 0))
    {
        flow.section(
            "When you work",
            Some(Line::from(Span::styled("requests by hour", theme.muted()))),
        );
        activity(flow, &history.activity);
        flow.gap();
    }

    let left = &history.left;
    if left.windows > 0 {
        flow.section("Left on the table", None);
        let windows = if left.windows == 1 {
            format!("1 weekly window · {:.0}% unused", left.unused)
        } else {
            format!(
                "{} weekly windows · {:.0}% unused on average across them",
                left.windows, left.unused
            )
        };
        flow.line(Line::from(vec![
            Span::raw(" "),
            Span::styled(format::dollars(left.dollars), theme.strong()),
            Span::styled(
                format!("  of plans' quota reset unused · {windows}"),
                theme.muted(),
            ),
        ]));
        flow.gap();
        let name_w = name_width(flow, left.accounts.iter().map(|a| a.name.as_str()));
        for account in &left.accounts {
            let ink = provider_ink(flow, &history.providers, Some(account.provider));
            bar_row(
                flow,
                &account.name,
                account.unused / 100.0,
                &[
                    format!("{:.0}% unused", account.unused),
                    format::dollars(account.dollars),
                    format::count(account.windows, "window"),
                ],
                name_w,
                ink,
            );
        }
        flow.gap();
    }
}

/// An area with a column's margin on the left.
fn inset(area: Rect) -> Rect {
    Rect {
        x: area.x + 1,
        width: area.width.saturating_sub(1),
        ..area
    }
}

/// How wide a column of names is: as wide as the longest, up to a quarter
/// of the width, or up to 18 columns in a narrow pane, where a quarter
/// would cut a model's name.
fn name_width<'a>(flow: &Flow<'_>, names: impl Iterator<Item = &'a str>) -> u16 {
    let longest = names.map(|n| n.chars().count() as u16).max().unwrap_or(8);
    let most = (flow.width / 4).max((flow.width * 2 / 5).min(18)).max(8);
    longest.clamp(8, most) + 1
}

/// The `n` largest, and the rest as one row.
fn top(rows: &[NamedTotals], n: usize) -> Vec<NamedTotals> {
    if rows.len() <= n + 1 {
        return rows.to_vec();
    }
    let mut shown = rows[..n].to_vec();
    let mut rest = Totals::default();
    for row in &rows[n..] {
        let t = &row.totals;
        rest.requests += t.requests;
        rest.input += t.input;
        rest.output += t.output;
        rest.cache_read += t.cache_read;
        rest.cache_write += t.cache_write;
        rest.cost += t.cost;
        rest.unpriced += t.unpriced;
        rest.failed += t.failed;
    }
    shown.push(NamedTotals {
        name: format!("{} others", rows.len() - n),
        provider: None,
        totals: rest,
    });
    shown
}

/// Rows of names and bars, each bar in the color of the provider `owner`
/// names for the row.
fn named_bars(
    flow: &mut Flow<'_>,
    rows: &[NamedTotals],
    providers: &[Provider],
    owner: impl Fn(&str) -> Option<Provider>,
) {
    if rows.is_empty() {
        let theme = flow.theme;
        flow.line(Line::from(Span::styled(" None", theme.muted())));
        return;
    }
    let most = rows
        .iter()
        .map(|r| tokens(&r.totals))
        .max()
        .unwrap_or(1)
        .max(1);
    let name_w = name_width(flow, rows.iter().map(|r| r.name.as_str()));
    for row in rows {
        let t = &row.totals;
        let ink = provider_ink(flow, providers, row.provider.or_else(|| owner(&row.name)));
        bar_row(
            flow,
            &row.name,
            tokens(t) as f64 / most as f64,
            &[
                format::compact(tokens(t)),
                format::priced(t.cost, t.unpriced, t.requests),
            ],
            name_w,
            ink,
        );
    }
}

/// The tokens by kind, as one bar in four shades and a legend.
fn token_mix(flow: &mut Flow<'_>, total: &Totals) {
    let theme = flow.theme;
    let all = tokens(total).max(1) as f64;
    let parts = [
        ("Input", total.input, "█"),
        ("Cache read", total.cache_read, "▓"),
        ("Cache write", total.cache_write, "▒"),
        ("Output", total.output, "░"),
    ];
    let width = flow.width.saturating_sub(2) as f64;
    let mut spans = vec![Span::raw(" ")];
    let mut given = 0usize;
    for (i, (_, n, symbol)) in parts.iter().enumerate() {
        let w = if i + 1 == parts.len() {
            (width as usize).saturating_sub(given)
        } else {
            (((*n as f64 / all) * width).round() as usize)
                .min((width as usize).saturating_sub(given))
        };
        given += w;
        spans.push(Span::styled(symbol.repeat(w), theme.ink()));
    }
    flow.line(Line::from(spans));
    // The legend, an item at a time, onto another line where the next
    // doesn't fit whole.
    let mut legend = vec![Span::raw(" ")];
    let mut used = 1usize;
    for (title, n, symbol) in parts {
        let item = [
            Span::styled(symbol, theme.ink()),
            Span::raw(format!(" {title} ")),
            Span::styled(
                format!("{} · {:.0}%", format::compact(n), n as f64 / all * 100.0),
                theme.muted(),
            ),
        ];
        let w: usize = item.iter().map(Span::width).sum();
        if used > 1 && used + 3 + w > flow.width as usize {
            flow.line(Line::from(std::mem::replace(
                &mut legend,
                vec![Span::raw(" ")],
            )));
            used = 1;
        }
        if used > 1 {
            legend.push(Span::raw("   "));
            used += 3;
        }
        legend.extend(item);
        used += w;
    }
    flow.line(Line::from(legend));
}

/// Requests by weekday and hour, as a contribution graph: a cell per hour
/// in four levels of the Requests blue by where it ranks among the busy
/// hours, and what the grid says in words beneath.
fn activity(flow: &mut Flow<'_>, activity: &[Vec<u64>]) {
    let theme = flow.theme;
    let grid = levels(activity);
    let cell = if flow.width >= 6 + 24 * 3 { 3 } else { 2 };
    let mut axis = String::from("      ");
    for hour in 0..24 {
        let label = if hour % 6 == 0 {
            format!("{hour:02}")
        } else {
            String::new()
        };
        axis.push_str(&format!("{label:<w$}", w = cell));
    }
    flow.line(Line::from(Span::styled(axis, theme.muted())));
    let blue = theme.spark(3);
    for (day, hours) in WEEKDAYS.iter().zip(&grid) {
        let mut spans = vec![Span::styled(format!("  {day} "), theme.muted())];
        for level in hours {
            let style = if *level == 0 { theme.rule() } else { blue };
            spans.push(Span::styled(shade(*level).repeat(cell - 1), style));
            spans.push(Span::raw(" "));
        }
        flow.line(Line::from(spans));
    }
    let mut key = vec![Span::styled("      less ", theme.muted())];
    for level in 0..=4 {
        let style = if level == 0 { theme.rule() } else { blue };
        key.push(Span::styled(shade(level), style));
        key.push(Span::raw(" "));
    }
    key.push(Span::styled("more", theme.muted()));
    flow.line(Line::from(key));
    flow.gap();
    // The facts, a pair at a time, onto another line where the next
    // doesn't fit whole.
    let mut line = vec![Span::raw(" ")];
    let mut used = 1usize;
    for (title, value, note) in rhythm(activity) {
        let item = [
            Span::styled(format!("{title} "), theme.muted()),
            Span::styled(value, theme.strong()),
            Span::styled(format!(" · {note}"), theme.muted()),
        ];
        let w: usize = item.iter().map(Span::width).sum();
        if used > 1 && used + 3 + w > flow.width as usize {
            flow.line(Line::from(std::mem::replace(
                &mut line,
                vec![Span::raw(" ")],
            )));
            used = 1;
        }
        if used > 1 {
            line.push(Span::raw("   "));
            used += 3;
        }
        line.extend(item);
        used += w;
    }
    flow.line(Line::from(line));
}

pub fn draw_performance(app: &App, flow: &mut Flow<'_>, _now: &Now) {
    let Some(history) = header(app, flow) else {
        return;
    };
    if quiet(history) {
        nothing_yet(flow);
        return;
    }
    let theme = flow.theme;
    let total = &history.total;
    let asked = total.requests + total.failed;
    stats(
        flow,
        &[
            Stat {
                title: "Answered".into(),
                value: if asked == 0 {
                    "—".into()
                } else {
                    format!("{:.1}%", total.requests as f64 / asked as f64 * 100.0)
                },
                note: match total.failed {
                    0 => "none failed".into(),
                    n => format!("{} failed", format::grouped(n)),
                },
                change: None,
            },
            Stat {
                title: "Saved by failover".into(),
                value: format::grouped(history.rescued),
                note: "on another account".into(),
                change: None,
            },
            Stat {
                title: "From cache".into(),
                value: history
                    .cached
                    .map_or("—".into(), |c| format!("{:.0}%", c * 100.0)),
                note: format!("saving {}", format::dollars(history.cache_saved)),
                change: None,
            },
            Stat {
                title: "First byte".into(),
                value: history
                    .first_byte
                    .map_or("—".into(), |ms| format!("{:.2} s", ms / 1000.0)),
                note: "the median wait".into(),
                change: None,
            },
        ],
    );
    flow.gap();
    let labels: Vec<String> = history.buckets.iter().map(|b| b.label.clone()).collect();

    flow.section(
        "Reliability",
        Some(Line::from(vec![
            Span::styled("█", theme.spark(3)),
            Span::styled(" answered  ", theme.muted()),
            Span::styled("█", theme.tone(Tone::Bad)),
            Span::styled(" failed  ", theme.muted()),
            Span::styled("█", theme.tone(Tone::Warn)),
            Span::styled(" rescued", theme.muted()),
        ])),
    );
    // The three on one scale, so a failure or two stays a sliver.
    let answered: Vec<f64> = history.buckets.iter().map(|b| b.requests as f64).collect();
    let failed: Vec<f64> = history.buckets.iter().map(|b| b.failed as f64).collect();
    let rescued: Vec<f64> = history.buckets.iter().map(|b| b.rescued as f64).collect();
    let most = answered
        .iter()
        .chain(&failed)
        .chain(&rescued)
        .copied()
        .fold(0.0, f64::max);
    flow.line(Line::from(Span::styled(
        format!(" {} at the most", format::count(most as u64, "request")),
        theme.muted(),
    )));
    let area = inset(flow.take(5));
    let ink = theme.ink();
    let blue = theme.spark(3);
    scaled_columns(flow.buf, area, &answered, most, |_| blue, true);
    let row = inset(flow.take(1));
    let bad = theme.tone(Tone::Bad);
    scaled_columns(flow.buf, row, &failed, most, |_| bad, true);
    let row = inset(flow.take(1));
    let warn = theme.tone(Tone::Warn);
    scaled_columns(flow.buf, row, &rescued, most, |_| warn, true);
    flow.line(Line::from(Span::styled(
        format!(" {}", axis_labels(&labels, area.width)),
        theme.muted(),
    )));
    flow.gap();

    let wide = flow.width >= TWO_COLUMNS;
    let widths = if wide {
        flow.even(2, 4)
    } else {
        vec![flow.width]
    };
    flow.columns(&widths, 4, |i, column| {
        if i == 0 {
            column.section("Input from cache", None);
            cache_chart(column, history, &labels);
        }
        if i == 1 || !wide {
            if !wide {
                column.gap();
            }
            column.section(
                "Time to first byte",
                Some(Line::from(vec![
                    Span::styled("━", ink),
                    Span::styled(" p50  ", theme.muted()),
                    Span::styled("━", theme.muted()),
                    Span::styled(" p90", theme.muted()),
                ])),
            );
            first_byte_chart(column, history, &labels);
        }
    });
    flow.gap();

    if !history.speeds.is_empty() {
        flow.section(
            "Output speed",
            Some(Line::from(Span::styled("tokens a second", theme.muted()))),
        );
        let most = history
            .speeds
            .iter()
            .map(|s| s.tokens_per_second)
            .fold(0.0, f64::max)
            .max(f64::EPSILON);
        let name_w = name_width(flow, history.speeds.iter().map(|s| s.model.as_str()));
        for speed in history.speeds.iter().take(8) {
            let ink = provider_ink(flow, &history.providers, Some(speed.provider));
            bar_row(
                flow,
                &speed.model,
                speed.tokens_per_second / most,
                &[
                    format!("{:.0} tok/s", speed.tokens_per_second),
                    speed.provider.title().into(),
                ],
                name_w,
                ink,
            );
        }
    }
}

/// How much input came from the cache, bucket by bucket, as a line zoomed
/// to where it moves.
fn cache_chart(flow: &mut Flow<'_>, history: &History, labels: &[String]) {
    let theme = flow.theme;
    let cached: Vec<Option<f64>> = history.buckets.iter().map(|b| b.cached).collect();
    let (lo, hi) = cached
        .iter()
        .flatten()
        .copied()
        .fold(None, |span: Option<(f64, f64)>, v| match span {
            Some((lo, hi)) => Some((lo.min(v), hi.max(v))),
            None => Some((v, v)),
        })
        .unwrap_or((0.0, 1.0));
    // A rate that never moves sits mid-chart.
    let (lo, hi) = if hi - lo < 0.002 {
        ((lo - 0.01).max(0.0), (hi + 0.01).min(1.0))
    } else {
        (lo, hi)
    };
    let mark = |v: f64| {
        if hi - lo < 0.05 {
            format!("{:.1}%", v * 100.0)
        } else {
            format!("{:.0}%", v * 100.0)
        }
    };
    line_chart(
        flow,
        4,
        &[(cached, theme.ink())],
        (lo, hi),
        (mark(hi), mark(lo)),
        labels,
    );
    flow.line(Line::from(Span::styled(
        format!(" {}", cache_note(history.cached)),
        theme.muted(),
    )));
}

/// The wait for the first byte, bucket by bucket: the median, and the
/// slowest tenth's.
fn first_byte_chart(flow: &mut Flow<'_>, history: &History, labels: &[String]) {
    let theme = flow.theme;
    let p50: Vec<Option<f64>> = history
        .buckets
        .iter()
        .map(|b| b.first_byte.map(|(p50, _)| p50))
        .collect();
    let p90: Vec<Option<f64>> = history
        .buckets
        .iter()
        .map(|b| b.first_byte.map(|(_, p90)| p90))
        .collect();
    let slowest = p90
        .iter()
        .chain(&p50)
        .flatten()
        .copied()
        .fold(0.0, f64::max);
    let words = match history.first_byte {
        Some(ms) => {
            line_chart(
                flow,
                4,
                &[(p90, theme.muted()), (p50, theme.ink())],
                (0.0, slowest.max(1.0)),
                (format::millis(slowest), "0".into()),
                labels,
            );
            format!(
                " median {} · slowest p90 {}",
                format::millis(ms),
                format::millis(slowest)
            )
        }
        None => " no streamed answers".into(),
    };
    flow.line(Line::from(Span::styled(words, theme.muted())));
}

/// Lines through a value (or none) per bucket, over `lo..hi`, `height`
/// rows tall: the top and bottom marked on the left, the buckets'
/// labels beneath.
fn line_chart(
    flow: &mut Flow<'_>,
    height: u16,
    series: &[(Vec<Option<f64>>, Style)],
    (lo, hi): (f64, f64),
    (top, bottom): (String, String),
    labels: &[String],
) {
    let theme = flow.theme;
    let area = flow.take(height);
    let gutter = top.chars().count().max(bottom.chars().count()) as u16 + 2;
    let plot = Rect {
        x: area.x + gutter,
        width: area.width.saturating_sub(gutter + 1),
        ..area
    };
    if plot.height == 0 || plot.width == 0 {
        return;
    }
    let muted = theme.muted();
    let at = |mark: &str, y: u16| {
        let w = mark.chars().count() as u16;
        (area.x + gutter.saturating_sub(w + 1), y)
    };
    let (x, y) = at(&top, plot.y);
    flow.buf.set_string(x, y, &top, muted);
    let (x, y) = at(&bottom, plot.bottom() - 1);
    flow.buf.set_string(x, y, &bottom, muted);
    let n = labels.len().max(1);
    let x_of = |i: usize| {
        if n > 1 {
            i as f64 / (n - 1) as f64
        } else {
            0.5
        }
    };
    let span = (hi - lo).max(f64::EPSILON);
    let points: Vec<Vec<(f64, f64)>> = series
        .iter()
        .map(|(values, _)| {
            values
                .iter()
                .enumerate()
                .filter_map(|(i, v)| v.map(|v| (x_of(i), (v - lo) / span)))
                .collect()
        })
        .collect();
    let lines: Vec<(&[(f64, f64)], Style)> = points
        .iter()
        .zip(series)
        .map(|(points, (_, style))| (points.as_slice(), *style))
        .collect();
    braille_lines(flow.buf, plot, &lines);
    // Each label under its point, as many as fit apart.
    let mut axis = vec![' '; plot.width as usize];
    let mut free = 0;
    for (i, label) in labels.iter().enumerate() {
        let w = label.chars().count();
        let centre = (x_of(i) * f64::from(plot.width - 1)).round() as usize;
        let from = centre
            .saturating_sub(w / 2)
            .min(axis.len().saturating_sub(w));
        if from < free || from + w > axis.len() {
            continue;
        }
        for (j, c) in label.chars().enumerate() {
            axis[from + j] = c;
        }
        free = from + w + 1;
    }
    let axis: String = axis.into_iter().collect();
    flow.line(Line::from(vec![
        Span::raw(" ".repeat(gutter as usize)),
        Span::styled(axis.trim_end().to_owned(), muted),
    ]));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_month_at_this_pace_averages_the_last_whole_days() {
        let mut history: History = super::super::tests::fixture("usage.history.ok");
        assert_eq!(
            month_pace(&history),
            ("—".into(), "after a whole day of use".into())
        );
        // Days of $20, $30, $40 and today: today is left out.
        let n = history.buckets.len();
        for (bucket, cost) in history.buckets[n - 4..]
            .iter_mut()
            .zip([20.0, 30.0, 40.0, 5.0])
        {
            bucket.cost = cost;
            bucket.requests = 1;
        }
        assert_eq!(
            month_pace(&history),
            ("$900.00".into(), "from the last 3 days".into())
        );
        // A full week reads the same on 7 days (six whole days besides
        // today) as on 30 (a seventh before them, left out on both).
        let day = |cost: f64| HistoryBucket {
            cost,
            requests: 1,
            ..history.buckets[0].clone()
        };
        let mut month = history.clone();
        month.range = HistoryRange::Month;
        month.buckets = [999.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 5.0]
            .map(day)
            .to_vec();
        let mut week = month.clone();
        week.range = HistoryRange::Week;
        week.buckets.remove(0);
        assert_eq!(
            month_pace(&month),
            ("$1,050".into(), "from the last 6 days".into())
        );
        assert_eq!(month_pace(&week), month_pace(&month));
        // A request older than the 7-day range, then idle days: 30 days
        // reads as 7 do.
        let mut sparse = week.clone();
        sparse.range = HistoryRange::Month;
        for (bucket, cost) in sparse
            .buckets
            .iter_mut()
            .zip([0.0, 0.0, 0.0, 20.0, 30.0, 40.0])
        {
            bucket.cost = cost;
            bucket.requests = u64::from(cost > 0.0);
        }
        let short = sparse.clone();
        sparse.buckets.insert(0, day(999.0));
        assert_eq!(month_pace(&sparse), month_pace(&short));
        assert_eq!(
            month_pace(&sparse),
            ("$900.00".into(), "from the last 3 days".into())
        );
        history.range = HistoryRange::Today;
        history.buckets.truncate(2);
        assert_eq!(
            month_pace(&history),
            ("—".into(), "after a few hours of today".into())
        );
    }

    #[test]
    fn the_grid_levels_hours_by_rank_and_says_when_the_work_falls() {
        assert_eq!(
            levels(&[vec![0, 1, 2, 3, 4, 100]]),
            vec![vec![0, 1, 2, 3, 4, 4]]
        );
        assert_eq!(levels(&[vec![5, 5, 5, 0]]), vec![vec![4, 4, 4, 0]]);
        assert_eq!(
            levels(&[vec![1, 1, 1, 1, 1, 1, 1, 1, 1, 25]]),
            vec![vec![2, 2, 2, 2, 2, 2, 2, 2, 2, 4]]
        );
        let week: Vec<Vec<u64>> = (0..7)
            .map(|day| {
                (0..24)
                    .map(|hour| match (day, hour) {
                        (1, 20) => 9,
                        (5, 3) => 1,
                        _ => 0,
                    })
                    .collect()
            })
            .collect();
        assert_eq!(
            rhythm(&week),
            vec![
                ("Busiest hour", "Tue 20:00".into(), "9 requests".into()),
                ("Busiest day", "Tuesday".into(), "90% of requests".into()),
                ("Most active", "Evenings".into(), "90% of requests".into()),
                ("Weekends", "10%".into(), "of requests".into()),
            ]
        );
        assert!(rhythm(&[vec![0, 0]]).is_empty());
    }

    #[test]
    fn models_and_agents_take_the_provider_they_belong_to() {
        let providers = [Provider::Claude, Provider::Codex, Provider::Grok];
        assert_eq!(
            model_provider(&providers, "claude-opus-5-5"),
            Some(Provider::Claude)
        );
        assert_eq!(
            model_provider(&[Provider::Anthropic], "claude-opus-5-5"),
            Some(Provider::Anthropic)
        );
        assert_eq!(
            model_provider(&providers, "gpt-6.1-sol"),
            Some(Provider::Codex)
        );
        assert_eq!(model_provider(&providers, "unknown"), None);
        assert_eq!(agent_provider("Grok Build"), Some(Provider::Grok));
        assert_eq!(agent_provider("Other"), None);
    }
}
