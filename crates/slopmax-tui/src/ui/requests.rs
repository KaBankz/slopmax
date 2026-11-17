//! The requests the proxy answered, newest first, as they come in: what
//! each was, which account took it, what it cost and how long it took.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use slopmax_client::api::Tone;
use slopmax_client::api::ledger::{LedgerRecord, RequestEnd, RequestRow};

use super::widgets::{Flow, tabs};
use crate::app::{App, Hit, OUTCOMES, RANGES, outcome_title, range_title};
use crate::data;
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

/// Narrower than this, a row of the overview's latest requests leaves out
/// the status and the account, so its tokens, value and time still show.
const COMPACT_BELOW: u16 = 60;

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
    let failed = data::failed(row);
    let (mark, tone) = if failed {
        ("✕", Tone::Bad)
    } else if data::rescued(row) {
        ("↻", Tone::Warn)
    } else {
        ("●", Tone::Good)
    };
    let marker = if selected {
        Span::styled("▌", theme.accent())
    } else {
        Span::raw(" ")
    };
    let model_style = if selected {
        theme.strong()
    } else {
        ratatui::style::Style::new()
    };
    let model = r.model.as_deref().unwrap_or("—");
    let tokens = r.usage.tokens();
    let tokens_text = if tokens == 0 {
        "—".to_owned()
    } else {
        format::compact(tokens)
    };
    let cost = |w: usize| match row.cost {
        Some(cost) => Span::raw(format!("{:>w$}", format::dollars(cost))),
        None if !failed && tokens > 0 => Span::styled(format!("{:>w$}", "…"), theme.muted()),
        None => Span::styled(format!("{:>w$}", "—"), theme.muted()),
    };
    if !detailed && width < COMPACT_BELOW {
        // The time, how it went, the model, and the figures.
        let model_w = (width as usize)
            .saturating_sub(1 + 6 + 2 + 7 + 8 + 7)
            .max(8);
        return Line::from(vec![
            marker,
            Span::styled(format!("{:<6}", now.hm(r.at)), theme.muted()),
            Span::styled(mark, theme.tone(tone)),
            Span::raw(" "),
            Span::styled(pad(model, model_w), model_style),
            Span::raw(format!("{tokens_text:>7}")),
            cost(8),
            Span::raw(format!("{:>7}", short_ms(r.ms))),
        ]);
    }
    let c = columns(width, detailed);
    let account = match r.account.as_deref() {
        Some("") | None => "—".to_owned(),
        Some(id) => app.data.account_name(id).to_owned(),
    };
    let mut spans = vec![
        marker,
        Span::styled(format!("{:<10}", now.stamp(r.at)), theme.muted()),
        Span::styled(mark, theme.tone(tone)),
        Span::styled(
            format!(" {:<5}", r.status),
            if failed {
                theme.tone(Tone::Bad)
            } else {
                theme.muted()
            },
        ),
        Span::styled(pad(model, c.model), model_style),
        Span::raw(pad(&account, c.account)),
    ];
    if c.agent > 0 {
        spans.push(Span::styled(
            pad(r.agent.map_or("—", agent_title), c.agent),
            theme.muted(),
        ));
    }
    spans.push(Span::raw(format!("{tokens_text:>8}")));
    spans.push(cost(9));
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
        let mut parts = Vec::new();
        // The totals are the whole range's; how many of its rows the
        // filter lets through comes first.
        if !app.filter.is_empty() {
            parts.push(format!(
                "{} shown",
                format::grouped(app.feed().len() as u64)
            ));
        }
        parts.push(format::count(page.matched, "request"));
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
    // A page of rows still shows when asking for it again failed: the
    // failure is said above it.
    if let Some(error) = &slot.error {
        flow.line(Line::from(Span::styled(
            format!(" Couldn't read the ledger again: {error}"),
            theme.tone(Tone::Bad),
        )));
        flow.gap();
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

    use crate::app::Page;
    use crate::ui::tests::{app, now};

    /// The mark a row of the feed leads with.
    fn mark(row: &RequestRow) -> String {
        let app = app(Page::Requests);
        let line = feed_row(&app, &Theme::plain(), row, &now(), 120, false, true);
        line.spans[2].content.to_string()
    }

    #[test]
    fn a_stream_the_provider_broke_off_is_a_failure_not_a_rescue() {
        let app = app(Page::Requests);
        let mut row = app.feed()[0].clone();
        let LedgerRecord::Request(r) = &mut row.record;
        r.status = 200;
        r.attempts = 2;
        assert_eq!(mark(&row), "↻");
        for end in [
            RequestEnd::UpstreamError,
            RequestEnd::Stalled,
            RequestEnd::Cut,
        ] {
            row.end = Some(end);
            assert!(data::failed(&row) && !data::rescued(&row));
            assert_eq!(mark(&row), "✕", "{end:?}");
        }
        // An agent that hung up first didn't make it fail.
        row.end = Some(RequestEnd::ClientGone);
        assert_eq!(mark(&row), "↻");
    }

    #[test]
    fn a_narrow_row_keeps_its_figures() {
        let app = app(Page::Overview);
        let row = app.feed()[0].clone();
        let line = feed_row(&app, &Theme::plain(), &row, &now(), 47, false, false);
        let text: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(line.width() <= 47, "{text:?}");
        assert!(text.trim_end().ends_with("4.2s"), "{text:?}");
    }

    #[test]
    fn durations_are_short() {
        assert_eq!(short_ms(840), "840ms");
        assert_eq!(short_ms(4_200), "4.2s");
        assert_eq!(short_ms(72_000), "1m12s");
    }
}
