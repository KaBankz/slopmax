//! The requests the proxy answered, newest first, as they come in: what
//! each was, which account took it, what it cost and how long it took.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use slopmax_client::api::Tone;
use slopmax_client::api::ledger::{LedgerRecord, RequestEnd, RequestRow};

use super::widgets::{Flow, tabs};
use crate::app::{App, Hit, OUTCOMES, RANGES, outcome_title, range_title};
use crate::format::{self, Now, agent_title};
use crate::theme::Theme;

pub fn end_words(end: RequestEnd) -> &'static str {
    match end {
        RequestEnd::UpstreamError => "the provider broke it off",
        RequestEnd::ClientGone => "the agent hung up first",
        RequestEnd::Stalled => "the provider went quiet",
        RequestEnd::Cut => "the proxy stopped while it streamed",
    }
}

/// Column widths of the feed at `width`: time, status, model, account,
/// agent, tokens, cost, time taken.
struct Columns {
    model: usize,
    account: usize,
    agent: usize,
    first_byte: bool,
}

fn columns(width: u16, detailed: bool) -> Columns {
    let agent = if detailed && width >= 110 { 13 } else { 0 };
    let first_byte = detailed && width >= 96;
    let fixed = 1 + 10 + 7 + 8 + 9 + 8 + agent + if first_byte { 8 } else { 0 };
    let rest = (width as usize).saturating_sub(fixed).max(16);
    let model = rest * 11 / 20;
    Columns {
        model,
        account: rest - model,
        agent,
        first_byte,
    }
}

fn pad(text: &str, width: usize) -> String {
    let text = format::fit(text, width.saturating_sub(1));
    let w = Line::from(text.as_str()).width();
    format!("{text}{}", " ".repeat(width.saturating_sub(w)))
}

/// The feed's column titles.
fn heading(width: u16, detailed: bool) -> String {
    let c = columns(width, detailed);
    let mut out = format!(
        " {:<10}{:<7}{}{}",
        "Time",
        "Status",
        pad("Model", c.model),
        pad("Account", c.account)
    );
    if c.agent > 0 {
        out.push_str(&pad("Agent", c.agent));
    }
    out.push_str(&format!("{:>8}{:>9}{:>8}", "Tokens", "Value", "Took"));
    if c.first_byte {
        out.push_str(&format!("{:>8}", "1st byte"));
    }
    out
}

/// One request as a row of the feed.
pub fn feed_row(
    app: &App,
    theme: &Theme,
    row: &RequestRow,
    now: &Now,
    width: u16,
    selected: bool,
    detailed: bool,
) -> Line<'static> {
    let LedgerRecord::Request(r) = &row.record;
    let c = columns(width, detailed);
    let (mark, tone) = if r.status >= 400 {
        ("✕", Tone::Bad)
    } else if r.attempts > 1 {
        ("↻", Tone::Warn)
    } else {
        ("●", Tone::Good)
    };
    let account = match r.account.as_deref() {
        Some("") | None => "—".to_owned(),
        Some(id) => app.data.account_name(id).to_owned(),
    };
    let marker = if selected {
        Span::styled("▌", theme.accent())
    } else {
        Span::raw(" ")
    };
    let mut spans = vec![
        marker,
        Span::styled(format!("{:<10}", now.stamp(r.at)), theme.muted()),
        Span::styled(mark, theme.tone(tone)),
        Span::styled(
            format!(" {:<5}", r.status),
            if r.status >= 400 {
                theme.tone(Tone::Bad)
            } else {
                theme.muted()
            },
        ),
        Span::styled(
            pad(r.model.as_deref().unwrap_or("—"), c.model),
            if selected {
                theme.strong()
            } else {
                ratatui::style::Style::new()
            },
        ),
        Span::raw(pad(&account, c.account)),
    ];
    if c.agent > 0 {
        spans.push(Span::styled(
            pad(r.agent.map_or("—", agent_title), c.agent),
            theme.muted(),
        ));
    }
    let tokens = r.usage.tokens();
    spans.push(Span::raw(format!(
        "{:>8}",
        if tokens == 0 {
            "—".to_owned()
        } else {
            format::compact(tokens)
        }
    )));
    let cost = match row.cost {
        Some(cost) => Span::raw(format!("{:>9}", format::dollars(cost))),
        None if r.status < 400 && tokens > 0 => Span::styled(format!("{:>9}", "…"), theme.muted()),
        None => Span::styled(format!("{:>9}", "—"), theme.muted()),
    };
    spans.push(cost);
    spans.push(Span::raw(format!("{:>8}", short_ms(r.ms))));
    if c.first_byte {
        let first = r.first_byte_ms.map_or("—".into(), short_ms);
        spans.push(Span::styled(format!("{first:>8}"), theme.muted()));
    }
    Line::from(spans)
}

/// `840ms`, `4.2s`, `1m12s`.
fn short_ms(ms: u64) -> String {
    match ms {
        ms if ms < 1_000 => format!("{ms}ms"),
        ms if ms < 60_000 => format!("{:.1}s", ms as f64 / 1000.0),
        ms => format!("{}m{:02}s", ms / 60_000, ms / 1000 % 60),
    }
}

pub fn draw(app: &App, flow: &mut Flow<'_>, now: &Now) {
    let theme = flow.theme;
    let query = &app.data.query;
    let y = flow.y;
    if y < flow.buf.area.bottom() {
        let ranges: Vec<_> = RANGES.iter().map(|r| (*r, range_title(*r))).collect();
        let x = flow.x + 1;
        let end = tabs(flow, x, y, &ranges, query.range, Hit::Range);
        let outcomes: Vec<_> = OUTCOMES.iter().map(|o| (*o, outcome_title(*o))).collect();
        let x = (end + 6).max(flow.x + flow.width / 2);
        tabs(flow, x, y, &outcomes, query.outcome, Hit::Outcome);
    }
    flow.gap();
    let filter = if app.filtering {
        Line::from(vec![
            Span::styled(" / ", theme.accent()),
            Span::raw(app.filter.clone()),
            Span::styled("▏", theme.accent()),
        ])
    } else if !app.filter.is_empty() {
        Line::from(vec![
            Span::styled(" / ", theme.muted()),
            Span::styled(app.filter.clone(), theme.accent()),
            Span::styled("  esc clears", theme.muted()),
        ])
    } else {
        Line::default()
    };
    let summary = app.data.requests.value.as_ref().map(|page| {
        let mut parts = vec![format::count(page.matched, "request")];
        if page.failed > 0 {
            parts.push(format!("{} failed", format::grouped(page.failed)));
        }
        if page.rescued > 0 {
            parts.push(format!("{} rescued", format::grouped(page.rescued)));
        }
        parts.push(format!("{} tokens", format::compact(page.tokens)));
        parts.push(format::dollars(page.cost));
        Line::from(Span::styled(parts.join(" · "), theme.muted()))
    });
    flow.split_line(filter, summary.unwrap_or_default());
    flow.gap();
    let slot = &app.data.requests;
    if slot.value.is_none() {
        let text = match &slot.error {
            Some(error) => Span::styled(format!(" {error}"), theme.tone(Tone::Bad)),
            None => Span::styled(" Reading the ledger…", theme.muted()),
        };
        flow.line(Line::from(text));
        return;
    }
    let rows = app.feed();
    flow.line(Line::from(Span::styled(
        heading(flow.width, true),
        theme.muted(),
    )));
    if rows.is_empty() {
        flow.gap();
        let words = if app.filter.is_empty() {
            " No requests in this range yet"
        } else {
            " No requests match the filter"
        };
        flow.line(Line::from(Span::styled(words, theme.muted())));
        return;
    }
    for (i, row) in rows.iter().enumerate() {
        let selected = i == app.cursor;
        let y = flow.y;
        flow.line(feed_row(app, theme, row, now, flow.width, selected, true));
        let rect = Rect::new(flow.x, y, flow.width, 1);
        if selected && y < flow.buf.area.bottom() {
            flow.buf.set_style(rect, theme.raised());
        }
        flow.hit(rect, Hit::Row(i));
    }
    if let Some(page) = &slot.value
        && page.matched > page.rows.len() as u64
    {
        flow.gap();
        flow.line(Line::from(Span::styled(
            format!(
                " The latest {} of {}",
                page.rows.len(),
                format::grouped(page.matched)
            ),
            theme.muted(),
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_are_short() {
        assert_eq!(short_ms(840), "840ms");
        assert_eq!(short_ms(4_200), "4.2s");
        assert_eq!(short_ms(72_000), "1m12s");
    }
}
