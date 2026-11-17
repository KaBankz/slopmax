//! Usage and Performance: what the ledger says of a span, as figures and
//! charts. Both read the same history, so switching between them fetches
//! nothing new.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use slopmax_client::api::Tone;
use slopmax_client::api::ledger::{History, NamedTotals, Totals};

use super::widgets::{Flow, Stat, axis_labels, bar_row, change, column_chart, shade, stats, tabs};
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
                    format!("in {}", format::count(history.sessions, "conversation"))
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
            Stat {
                title: "Month at this pace".into(),
                value: history.monthly.map_or("—".into(), format::dollars),
                note: "at API prices".into(),
                change: None,
            },
        ],
    );
    flow.gap();

    let by = if app.range == slopmax_client::api::ledger::HistoryRange::Today {
        "by hour"
    } else {
        "by day"
    };
    flow.section("Tokens", Some(Line::from(Span::styled(by, theme.muted()))));
    let values: Vec<f64> = history
        .buckets
        .iter()
        .map(|b| b.tokens.iter().sum())
        .collect();
    let most = values.iter().copied().fold(0.0, f64::max);
    flow.line(Line::from(Span::styled(
        format!(" {} at the most", format::compact(most as u64)),
        theme.muted(),
    )));
    let area = flow.take(7);
    let style = theme.ink();
    column_chart(flow.buf, inset(area), &values, |_| style, true);
    let labels: Vec<String> = history.buckets.iter().map(|b| b.label.clone()).collect();
    flow.line(Line::from(Span::styled(
        format!(" {}", axis_labels(&labels, inset(area).width)),
        theme.muted(),
    )));
    flow.gap();

    let wide = flow.width >= 100;
    let widths = if wide {
        flow.even(2, 4)
    } else {
        vec![flow.width]
    };
    flow.columns(&widths, 4, |i, column| {
        if i == 0 {
            column.section("Models", None);
            named_bars(column, &top(&history.models, 5));
        }
        if i == 1 || !wide {
            if !wide {
                column.gap();
            }
            column.section("Agents", None);
            named_bars(column, &history.agents);
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
            );
        }
        flow.gap();
    }

    if let Some(summary) = &app.data.machines.value {
        let rows: Vec<NamedTotals> = summary
            .rows
            .iter()
            .filter(|r| !matches!(r.key.as_str(), "this machine" | "hub"))
            .map(|r| NamedTotals {
                name: r.key.clone(),
                totals: r.totals,
            })
            .collect();
        if !rows.is_empty() {
            flow.section("Machines", None);
            named_bars(flow, &rows);
            flow.gap();
        }
    }

    if history
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

fn name_width<'a>(flow: &Flow<'_>, names: impl Iterator<Item = &'a str>) -> u16 {
    let longest = names.map(|n| n.chars().count() as u16).max().unwrap_or(8);
    longest.clamp(8, (flow.width / 4).max(8)) + 1
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
        totals: rest,
    });
    shown
}

fn named_bars(flow: &mut Flow<'_>, rows: &[NamedTotals]) {
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
        bar_row(
            flow,
            &row.name,
            tokens(t) as f64 / most as f64,
            &[
                format::compact(tokens(t)),
                format::priced(t.cost, t.unpriced, t.requests),
            ],
            name_w,
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
            ((*n as f64 / all) * width).round() as usize
        };
        given += w;
        spans.push(Span::styled(symbol.repeat(w), theme.ink()));
    }
    flow.line(Line::from(spans));
    let mut legend = vec![Span::raw(" ")];
    for (i, (title, n, symbol)) in parts.iter().enumerate() {
        if i > 0 {
            legend.push(Span::raw("   "));
        }
        legend.push(Span::styled(*symbol, theme.ink()));
        legend.push(Span::raw(format!(" {title} ")));
        legend.push(Span::styled(
            format!("{} · {:.0}%", format::compact(*n), *n as f64 / all * 100.0),
            theme.muted(),
        ));
    }
    flow.line(Line::from(legend));
}

/// Requests by weekday and hour, in shades.
fn activity(flow: &mut Flow<'_>, activity: &[Vec<u64>]) {
    let theme = flow.theme;
    let most = activity.iter().flatten().copied().max().unwrap_or(0);
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
    for (day, hours) in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        .iter()
        .zip(activity)
    {
        let mut spans = vec![Span::styled(format!("  {day} "), theme.muted())];
        for n in hours {
            let symbol = shade(*n, most);
            let style = if *n == 0 { theme.rule() } else { theme.ink() };
            spans.push(Span::styled(symbol.repeat(cell - 1), style));
            spans.push(Span::raw(" "));
        }
        flow.line(Line::from(spans));
    }
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
            Span::styled("█", theme.ink()),
            Span::styled(" answered  ", theme.muted()),
            Span::styled("█", theme.tone(Tone::Bad)),
            Span::styled(" failed  ", theme.muted()),
            Span::styled("█", theme.tone(Tone::Warn)),
            Span::styled(" rescued", theme.muted()),
        ])),
    );
    let answered: Vec<f64> = history.buckets.iter().map(|b| b.requests as f64).collect();
    let area = inset(flow.take(5));
    let style = theme.ink();
    column_chart(flow.buf, area, &answered, |_| style, true);
    let failed: Vec<f64> = history.buckets.iter().map(|b| b.failed as f64).collect();
    let row = inset(flow.take(1));
    let bad = theme.tone(Tone::Bad);
    column_chart(flow.buf, row, &failed, |_| bad, true);
    let rescued: Vec<f64> = history.buckets.iter().map(|b| b.rescued as f64).collect();
    let row = inset(flow.take(1));
    let warn = theme.tone(Tone::Warn);
    column_chart(flow.buf, row, &rescued, |_| warn, true);
    flow.line(Line::from(Span::styled(
        format!(" {}", axis_labels(&labels, area.width)),
        theme.muted(),
    )));
    flow.gap();

    let wide = flow.width >= 100;
    let widths = if wide {
        flow.even(2, 4)
    } else {
        vec![flow.width]
    };
    flow.columns(&widths, 4, |i, column| {
        if i == 0 {
            column.section("Input from cache", None);
            let cached: Vec<f64> = history
                .buckets
                .iter()
                .map(|b| b.cached.unwrap_or(0.0))
                .collect();
            let area = inset(column.take(4));
            column_chart(column.buf, area, &cached, |_| style, true);
            column.line(Line::from(Span::styled(
                format!(" {}", cache_note(history.cached)),
                theme.muted(),
            )));
        }
        if i == 1 || !wide {
            if !wide {
                column.gap();
            }
            column.section("Time to first byte", None);
            let median: Vec<f64> = history
                .buckets
                .iter()
                .map(|b| b.first_byte.map_or(0.0, |(p50, _)| p50))
                .collect();
            let area = inset(column.take(4));
            column_chart(column.buf, area, &median, |_| style, true);
            let p90 = history
                .buckets
                .iter()
                .filter_map(|b| b.first_byte.map(|(_, p90)| p90))
                .fold(0.0, f64::max);
            let words = match history.first_byte {
                Some(ms) => format!(
                    " median {} · slowest p90 {}",
                    format::millis(ms),
                    format::millis(p90)
                ),
                None => " no streamed answers".into(),
            };
            column.line(Line::from(Span::styled(words, theme.muted())));
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
            bar_row(
                flow,
                &speed.model,
                speed.tokens_per_second / most,
                &[
                    format!("{:.0} tok/s", speed.tokens_per_second),
                    speed.provider.title().into(),
                ],
                name_w,
            );
        }
    }
}
