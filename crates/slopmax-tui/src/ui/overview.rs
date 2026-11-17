//! The overview: how the accounts stand in a line, what wants a look, each
//! subscription's pool at a glance, keys and endpoints, today so far, and
//! the latest requests.

use ratatui::text::{Line, Span};
use slopmax_client::api::ledger::History;
use slopmax_client::api::report::{Condition, Report};
use slopmax_client::api::{NoticeKind, Provider, Tone};

use super::provider::{next_line, pool_lines, pool_row};
use super::requests::feed_row;
use super::usage::{cache_note, hourly};
use super::widgets::{Flow, Stat, axis_labels, change, column_chart, dot, stats};
use crate::app::{App, Hit, held_resets};
use crate::format::{self, Now};

/// How the accounts stand: the headline, what keeps the rest, and its tone.
pub fn standing(report: &Report) -> (String, Option<String>, Tone) {
    let enabled: Vec<_> = report.accounts.iter().filter(|a| !a.disabled).collect();
    let ready = enabled
        .iter()
        .filter(|a| matches!(a.condition, Condition::Ready | Condition::Active { .. }))
        .count();
    let limited = enabled
        .iter()
        .filter(|a| {
            matches!(
                a.condition,
                Condition::Limited { .. } | Condition::Throttled { .. }
            )
        })
        .count();
    let signed_out = enabled
        .iter()
        .filter(|a| matches!(a.condition, Condition::SignInNeeded { .. }))
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

/// Something about an account that wants a look, and what to do about it.
pub struct Attention {
    pub provider: Provider,
    pub text: String,
    pub tone: Tone,
    /// The key that does something about it, and what.
    pub remedy: (&'static str, &'static str),
}

/// What wants a look, most pressing first: an account signed out, one
/// limited that holds a limit reset, a window running out before it
/// resets, a limit reset soon to expire, then the report's nudges. An
/// account merely limited is slopmax's to work around.
pub fn attention(report: &Report, now: &Now) -> Vec<Attention> {
    let mut found = Vec::new();
    let three_days = slopmax_common::time::SignedDuration::from_hours(72);
    for account in report.accounts.iter().filter(|a| !a.disabled) {
        let held = held_resets(account, now.at);
        let item = |text: String, tone: Tone, remedy| Attention {
            provider: account.provider,
            text,
            tone,
            remedy,
        };
        match account.condition.at(now.at) {
            Condition::SignInNeeded { .. } => {
                found.push(item(
                    format!("{} needs signing in again", account.name),
                    Tone::Bad,
                    ("slopmax login", account.provider.as_str()),
                ));
                continue;
            }
            Condition::Limited { until } if held > 0 => found.push(item(
                format!(
                    "{} is limited until {}, and holds {}",
                    account.name,
                    now.clock(until),
                    format::count(held, "limit reset")
                ),
                Tone::Warn,
                ("R", "redeem"),
            )),
            _ => {}
        }
        for window in account.windows.iter().filter(|w| w.model.is_none()) {
            if let Some((text, Tone::Warn)) = format::pace(window, now) {
                let title = format::span_title(window.span).to_lowercase();
                found.push(item(
                    format!(
                        "{}'s {title} window {}",
                        account.name,
                        lowercase_first(&text)
                    ),
                    Tone::Warn,
                    ("⏎", "show"),
                ));
            }
        }
        let expiring = account
            .unexpired_resets(now.at)
            .filter_map(|r| r.expires_at)
            .find(|at| at.duration_since(now.at) < three_days);
        if let Some(at) = expiring {
            found.push(item(
                format!(
                    "A limit reset on {} expires in {} · {}",
                    account.name,
                    now.until(at),
                    now.clock(at)
                ),
                Tone::Warn,
                ("R", "redeem"),
            ));
        }
    }
    for nudge in &report.nudges {
        let Some(account) = report.accounts.iter().find(|a| {
            nudge.account.as_deref() == Some(a.name.as_str())
                && nudge.provider.is_none_or(|p| p == a.provider)
        }) else {
            continue;
        };
        let already = found.iter().any(|f| {
            f.provider == account.provider && f.text.contains(&account.name) && f.remedy.0 == "R"
        });
        match nudge.kind {
            NoticeKind::ResetExpiring if !already => found.push(Attention {
                provider: account.provider,
                text: first_sentence(&nudge.message),
                tone: Tone::Warn,
                remedy: ("R", "redeem"),
            }),
            NoticeKind::QuotaUnused => {
                let at = nudge.until.unwrap_or(now.at);
                let (period, unused) = match account.long_window() {
                    Some(w) => (
                        if w.span == slopmax_client::api::Span::Month {
                            "month"
                        } else {
                            "week"
                        },
                        100.0 - w.used_at(now.at).clamp(0.0, 100.0),
                    ),
                    None => ("week", 0.0),
                };
                let worth = match nudge.worth {
                    Some(worth) if worth >= 0.5 => format!(", about ${worth:.0} of its plan"),
                    _ => String::new(),
                };
                found.push(Attention {
                    provider: account.provider,
                    text: format!(
                        "{}'s {period} resets in {} · {} with {unused:.0}% of it unused{worth}",
                        account.name,
                        now.until(at),
                        now.clock(at)
                    ),
                    tone: Tone::Warn,
                    remedy: ("⏎", "show"),
                });
            }
            _ => {}
        }
    }
    found.sort_by_key(|f| f.tone != Tone::Bad);
    found
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A notice's first sentence, without its full stop or the marks around a
/// command.
fn first_sentence(message: &str) -> String {
    let first = message.split(". ").next().unwrap_or(message);
    first.trim_end_matches('.').replace('`', "")
}

pub fn draw(app: &App, flow: &mut Flow<'_>, now: &Now) {
    let theme = flow.theme;
    let Some(report) = &app.data.report else {
        flow.line(Line::from(Span::styled(
            "Looking for slopmax…",
            theme.strong(),
        )));
        let detail = match &app.data.link {
            crate::data::Link::Lost(why) => format!("It didn't answer: {why}"),
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
    let (headline, detail, tone) = standing(report);
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

    let items = attention(report, now);
    if !items.is_empty() {
        let count = Line::from(Span::styled(
            items.len().to_string(),
            theme.tone(Tone::Warn),
        ));
        flow.section("Needs attention", Some(count));
        for item in &items {
            let remedy = Line::from(vec![
                Span::styled(item.remedy.0, theme.strong()),
                Span::styled(format!(" {}", item.remedy.1), theme.muted()),
            ]);
            // Long items wrap beneath themselves, the remedy on the first line.
            let room = flow.width.saturating_sub(remedy.width() as u16 + 5) as usize;
            for (i, text) in super::widgets::wrap(&item.text, room)
                .into_iter()
                .enumerate()
            {
                let lead = if i == 0 {
                    dot(theme, item.tone)
                } else {
                    Span::raw(" ")
                };
                let line = Line::from(vec![Span::raw(" "), lead, Span::raw(" "), Span::raw(text)]);
                if i == 0 {
                    flow.split_line(line, remedy.clone());
                } else {
                    flow.line(line);
                }
            }
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
            let selected = app.cursor == i;
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
            let rect = ratatui::layout::Rect::new(flow.x, top, flow.width, flow.y - top);
            flow.hit(rect, Hit::Row(i));
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
            let selected = app.cursor == i;
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
            flow.hit(
                ratatui::layout::Rect::new(flow.x, top, flow.width, 1),
                Hit::Row(i),
            );
        }
        flow.gap();
    }

    flow.section("Today", None);
    let today = app
        .data
        .history(slopmax_client::api::ledger::HistoryRange::Today);
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
            let wide = flow.width >= 100;
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
    let tokens = |t: &slopmax_client::api::ledger::Totals| {
        (t.input + t.output + t.cache_read + t.cache_write) as f64
    };
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

/// The latest requests, from the feed.
fn recent(app: &App, flow: &mut Flow<'_>, now: &Now) {
    let theme = flow.theme;
    flow.line(Line::from(Span::styled("Latest requests", theme.strong())));
    let rows = app
        .data
        .requests
        .value
        .as_ref()
        .map(|p| p.rows.iter().take(6).collect::<Vec<_>>())
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
