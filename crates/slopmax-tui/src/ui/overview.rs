//! The overview: how the accounts stand in a line, what wants a look, each
//! subscription's pool at a glance, keys and endpoints, today so far, and
//! the latest requests.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use slopmax_client::api::ledger::{History, HistoryRange, Totals};
use slopmax_client::api::report::{Condition, Report};
use slopmax_client::api::{Provider, Tone};

use super::provider::{next_line, pool_lines, pool_row};
use super::requests::feed_row;
use super::usage::{cache_note, hourly};
use super::widgets::{
    Flow, Stat, TWO_COLUMNS, axis_labels, change, column_chart, dot, stats, wrap,
};
use crate::app::{App, Hit, held_resets};
use crate::attention::{Remedy, attention};
use crate::data::Link;
use crate::format::{self, Now};

/// How the accounts stand: the headline, what keeps the rest, and its
/// tone. A limit that has passed counts as ready, as everywhere else.
pub fn standing(report: &Report, now: &Now) -> (String, Option<String>, Tone) {
    let enabled: Vec<_> = report.accounts.iter().filter(|a| !a.disabled).collect();
    let conditions: Vec<Condition> = enabled.iter().map(|a| a.condition.at(now.at)).collect();
    let ready = conditions
        .iter()
        .filter(|c| matches!(c, Condition::Ready | Condition::Active { .. }))
        .count();
    let limited = conditions
        .iter()
        .filter(|c| matches!(c, Condition::Limited { .. } | Condition::Throttled { .. }))
        .count();
    let signed_out = conditions
        .iter()
        .filter(|c| matches!(c, Condition::SignInNeeded { .. }))
        .count();
    let off = report.accounts.len() - enabled.len();
    let headline = match (enabled.len(), ready) {
        (0, _) if off == 0 => "No accounts yet".to_owned(),
        (0, _) => "Every account is turned off".to_owned(),
        (1, 1) => "Your account is ready".to_owned(),
        (n, r) if n == r => format!("All {n} accounts are ready"),
        (n, r) => format!("{r} of {n} accounts are ready"),
    };
    let mut parts = Vec::new();
    if limited > 0 {
        parts.push(format!("{limited} limited"));
    }
    match signed_out {
        0 => {}
        1 => parts.push("1 needs signing in".into()),
        n => parts.push(format!("{n} need signing in")),
    }
    if off > 0 {
        parts.push(format!("{off} turned off"));
    }
    let tone = if signed_out > 0 {
        Tone::Bad
    } else if limited > 0 {
        Tone::Warn
    } else {
        Tone::Good
    };
    let detail = (!parts.is_empty()).then(|| parts.join(" · "));
    (headline, detail, tone)
}

pub fn draw(app: &App, flow: &mut Flow<'_>, now: &Now) {
    let theme = flow.theme;
    let Some(report) = &app.data.report else {
        flow.line(Line::from(Span::styled(
            "Looking for slopmax…",
            theme.strong(),
        )));
        let detail = match &app.data.link {
            Link::Lost(why) => format!("It didn't answer: {why}"),
            _ => "The accounts show as soon as it answers.".into(),
        };
        flow.wrapped(&detail, theme.muted(), 0);
        return;
    };
    if report.accounts.is_empty() {
        flow.line(Line::from(Span::styled("No accounts yet", theme.strong())));
        flow.gap();
        for (command, what) in [
            ("slopmax login claude", "sign in to a Claude account"),
            ("slopmax login codex", "sign in to a ChatGPT account"),
            (
                "slopmax account import",
                "bring over the logins your agents hold",
            ),
        ] {
            flow.line(Line::from(vec![
                Span::styled(format!("  {command:<26}"), theme.accent()),
                Span::styled(what, theme.muted()),
            ]));
        }
        return;
    }
    if let Some(update) = &report.update {
        flow.line(Line::from(vec![
            Span::styled("▲ ", theme.accent()),
            Span::styled(format!("slopmax {} is out", update.version), theme.strong()),
            Span::styled(format!("  this is {} · ", report.version), theme.muted()),
            Span::styled(update.command.clone(), theme.accent()),
        ]));
        flow.gap();
    }
    let (headline, detail, tone) = standing(report, now);
    let banked: u64 = report.accounts.iter().map(|a| held_resets(a, now.at)).sum();
    let mut detail: Vec<String> = detail.into_iter().collect();
    if banked > 0 {
        detail.push(format!("{} banked", format::count(banked, "limit reset")));
    }
    let mut left = vec![
        dot(theme, tone),
        Span::raw(" "),
        Span::styled(headline, theme.strong()),
    ];
    if !detail.is_empty() {
        left.push(Span::styled(
            format!("  {}", detail.join(" · ")),
            theme.muted(),
        ));
    }
    let affinity = app
        .data
        .settings
        .value
        .as_ref()
        .map(|s| {
            if s.settings.live.session_affinity {
                " · affinity on"
            } else {
                " · affinity off"
            }
        })
        .unwrap_or_default();
    let affinity = if flow.width >= 96 { affinity } else { "" };
    let routing = Line::from(Span::styled(
        format!("{}{affinity}", report.strategy.as_str()),
        theme.muted(),
    ));
    flow.split_line(Line::from(left), routing);
    flow.gap();

    // What wants a look comes first, a row each, then the providers.
    let items = attention(report, now);
    let first = items.len();
    if !items.is_empty() {
        let count = Line::from(Span::styled(
            items.len().to_string(),
            theme.tone(Tone::Warn),
        ));
        flow.section("Needs attention", Some(count));
        for (row, item) in items.iter().enumerate() {
            let top = flow.y;
            let selected = app.cursor == row;
            // The key that does something about it; opening it is ⏎.
            let remedy = match item.remedy {
                Remedy::Redeem => Line::from(vec![
                    Span::styled("R", theme.strong()),
                    Span::styled(" redeem", theme.muted()),
                ]),
                Remedy::Show => Line::from(vec![
                    Span::styled("⏎", theme.strong()),
                    Span::styled(" show", theme.muted()),
                ]),
                Remedy::SignIn => Line::from(Span::styled(
                    format!("slopmax login {}", item.provider.as_str()),
                    theme.accent(),
                )),
            };
            // Long items wrap beneath themselves, the remedy on the first line.
            let room = flow.width.saturating_sub(remedy.width() as u16 + 5) as usize;
            for (i, text) in wrap(&item.text, room).into_iter().enumerate() {
                let marker = if selected && i == 0 {
                    Span::styled("▌", theme.accent())
                } else {
                    Span::raw(" ")
                };
                let lead = if i == 0 {
                    dot(theme, item.tone)
                } else {
                    Span::raw(" ")
                };
                let text = if selected {
                    Span::styled(text, theme.strong())
                } else {
                    Span::raw(text)
                };
                let line = Line::from(vec![marker, lead, Span::raw(" "), text]);
                if i == 0 {
                    flow.split_line(line, remedy.clone());
                } else {
                    flow.line(line);
                }
            }
            flow.hit(
                Rect::new(flow.x, top, flow.width, flow.y - top),
                Hit::Row(row),
            );
        }
        flow.gap();
    }

    let providers = app.data.providers();
    let subscriptions: Vec<(usize, Provider)> = providers
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, p)| p.is_subscription())
        .collect();
    if !subscriptions.is_empty() {
        flow.section("Subscriptions", None);
        for (i, provider) in subscriptions {
            let top = flow.y;
            let accounts: Vec<_> = report
                .accounts
                .iter()
                .filter(|a| a.provider == provider)
                .collect();
            let enabled = accounts.iter().filter(|a| !a.disabled).count();
            let ready = accounts
                .iter()
                .filter(|a| {
                    !a.disabled
                        && matches!(
                            a.condition.at(now.at),
                            Condition::Ready | Condition::Active { .. }
                        )
                })
                .count();
            let selected = app.cursor == first + i;
            let marker = if selected {
                Span::styled("▌", theme.accent())
            } else {
                Span::raw(" ")
            };
            let title_style = if selected {
                theme.strong().patch(theme.accent())
            } else {
                theme.strong()
            };
            flow.split_line(
                Line::from(vec![marker, Span::styled(provider.title(), title_style)]),
                Line::from(Span::styled(
                    format!("{ready} of {enabled} ready"),
                    theme.muted(),
                )),
            );
            let lines = pool_lines(report, provider, now);
            if lines.is_empty() {
                flow.line(Line::from(Span::styled(
                    "   No usage read yet",
                    theme.muted(),
                )));
            }
            for line in &lines {
                pool_row(flow, line, now, 3);
            }
            let (text, tone) = next_line(report, provider, now);
            flow.wrapped(&text, theme.tone(tone), 3);
            flow.gap();
            let rect = Rect::new(flow.x, top, flow.width, flow.y - top);
            flow.hit(rect, Hit::Row(first + i));
        }
    }

    let metered: Vec<(usize, Provider)> = providers
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, p)| !p.is_subscription())
        .collect();
    if !metered.is_empty() {
        flow.section("Keys and endpoints", None);
        for (i, provider) in metered {
            let top = flow.y;
            let selected = app.cursor == first + i;
            let mut spans = vec![
                if selected {
                    Span::styled("▌", theme.accent())
                } else {
                    Span::raw(" ")
                },
                Span::styled(format!("{:<16}", provider.title()), theme.strong()),
            ];
            for account in report.accounts.iter().filter(|a| a.provider == provider) {
                let tone = account.condition.at(now.at).tone();
                spans.push(dot(theme, tone));
                spans.push(Span::raw(format!(" {}   ", account.name)));
            }
            flow.line(Line::from(spans));
            flow.hit(Rect::new(flow.x, top, flow.width, 1), Hit::Row(first + i));
        }
        flow.gap();
    }

    flow.section("Today", None);
    let today = app.data.history(HistoryRange::Today);
    match &today.value {
        None if today.error.is_some() => {
            flow.wrapped(
                today.error.as_deref().unwrap_or_default(),
                theme.tone(Tone::Bad),
                1,
            );
        }
        None => flow.line(Line::from(Span::styled(
            " Reading today's ledger…",
            theme.muted(),
        ))),
        Some(history) if history.total.requests == 0 && history.total.failed == 0 => {
            flow.line(Line::from(Span::styled(
                " Nothing yet today",
                theme.muted(),
            )));
        }
        Some(history) => {
            stats(flow, &today_stats(history));
            flow.gap();
            let wide = flow.width >= TWO_COLUMNS;
            let widths = if wide {
                let left = flow.width * 5 / 11;
                vec![left, flow.width - left - 3]
            } else {
                vec![flow.width]
            };
            flow.columns(&widths, 3, |i, column| {
                if i == 0 {
                    hours_chart(column, history);
                }
                if i == 1 || !wide {
                    if !wide {
                        column.gap();
                    }
                    recent(app, column, now);
                }
            });
        }
    }
}

fn today_stats(history: &History) -> Vec<Stat> {
    let total = &history.total;
    let tokens = |t: &Totals| (t.input + t.output + t.cache_read + t.cache_write) as f64;
    let previous = history.previous.as_ref().map(|p| &p.total);
    vec![
        Stat {
            title: "Requests".into(),
            value: format::grouped(total.requests),
            note: match total.failed {
                0 => "none failed".into(),
                n => format!("{} failed", format::grouped(n)),
            },
            change: previous.and_then(|p| change(total.requests as f64, p.requests as f64, true)),
        },
        Stat {
            title: "Tokens".into(),
            value: format::compact(tokens(total) as u64),
            note: cache_note(history.cached),
            change: previous.and_then(|p| change(tokens(total), tokens(p), true)),
        },
        Stat {
            title: "API value".into(),
            value: format::priced(total.cost, total.unpriced, total.requests),
            note: "at API prices".into(),
            change: previous.and_then(|p| change(total.cost, p.cost, true)),
        },
        Stat {
            title: "Saved by failover".into(),
            value: format::grouped(history.rescued),
            note: "on another account".into(),
            change: None,
        },
    ]
}

fn hours_chart(flow: &mut Flow<'_>, history: &History) {
    let theme = flow.theme;
    flow.line(Line::from(vec![Span::styled(
        "Tokens by hour",
        theme.strong(),
    )]));
    let values = hourly(history);
    let area = flow.take(5);
    let style = theme.ink();
    column_chart(flow.buf, area, &values, |_| style, false);
    let labels: Vec<String> = (0..24)
        .map(|h| {
            if h % 6 == 0 {
                format!("{h:02}")
            } else {
                String::new()
            }
        })
        .collect();
    let axis = axis_labels(&labels, area.width);
    flow.line(Line::from(Span::styled(axis, theme.muted())));
}

/// Today's latest requests, whatever the Requests page is filtered to.
fn recent(app: &App, flow: &mut Flow<'_>, now: &Now) {
    let theme = flow.theme;
    flow.line(Line::from(Span::styled("Latest requests", theme.strong())));
    let rows = app
        .data
        .latest
        .value
        .as_ref()
        .map(|p| p.rows.iter().collect::<Vec<_>>())
        .unwrap_or_default();
    if rows.is_empty() {
        flow.line(Line::from(Span::styled("None yet", theme.muted())));
        return;
    }
    for row in rows {
        let line = feed_row(app, theme, row, now, flow.width, false, false);
        flow.line(line);
    }
}
