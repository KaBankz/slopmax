//! Drawing the screen: the sidebar of pages, the page's header, the page
//! itself (laid out on a canvas taller than the screen and scrolled into
//! view), the key hints along the bottom, and dialogs, toasts and help
//! over all of it.

mod overview;
mod provider;
mod requests;
mod system;
mod usage;
pub mod widgets;

use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Margin, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Widget};
use slopmax_client::api::Tone;
use slopmax_client::api::ledger::LedgerRecord;

use self::widgets::{Flow, dot, panel, wrap};
use crate::app::{App, Hit, Modal, Page};
use crate::data::Link;
use crate::format::{self, Now};
use crate::fx::Effects;
use crate::theme::Theme;

/// How tall a page may be: the canvas it is laid out on.
const CANVAS: u16 = 480;
const SIDEBAR: u16 = 24;

/// Draws the screen. Effects are left out where `fx` is `None`, as in
/// tests.
pub fn draw(
    frame: &mut Frame<'_>,
    app: &mut App,
    theme: &Theme,
    now: &Now,
    fx: Option<&mut Effects>,
) {
    let area = frame.area();
    app.width = area.width;
    app.hits.clear();
    let buf = frame.buffer_mut();
    if area.width < 48 || area.height < 12 {
        too_small(buf, area, theme);
        return;
    }
    let sidebar = app.sidebar_shown(area.width);
    let [side, main] = Layout::horizontal([
        Constraint::Length(if sidebar { SIDEBAR } else { 0 }),
        Constraint::Min(0),
    ])
    .areas(area);
    if sidebar {
        draw_sidebar(buf, side, app, theme, now);
    }
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(main);
    draw_header(buf, header, app, theme, now, sidebar);
    let body = body.inner(Margin::new(2, 0));
    let body = Rect {
        y: body.y + 1,
        height: body.height.saturating_sub(1),
        ..body
    };
    let arrived = draw_body(buf, body, app, theme, now);
    let mut fx = fx;
    if let Some(fx) = fx.as_deref_mut() {
        if app.entered {
            fx.enter_page(body);
        }
        fx.arrive(&arrived);
        fx.process_page(buf, body);
    }
    app.entered = false;
    app.arrived = 0;
    draw_footer(buf, footer, app, theme);
    draw_toasts(
        buf,
        Rect {
            height: area.height - 1,
            ..main
        },
        app,
        theme,
    );
    let overlay = if app.help {
        Some(draw_help(buf, area, app, theme))
    } else {
        app.modal
            .as_ref()
            .map(|modal| draw_modal(buf, area, modal, app, theme, now))
    };
    if let Some(fx) = fx {
        fx.overlay(overlay, buf);
    }
}

fn too_small(buf: &mut Buffer, area: Rect, theme: &Theme) {
    let lines = [
        Line::from(Span::styled("slopmax", theme.strong())),
        Line::from(Span::styled("Make the terminal larger", theme.muted())),
    ];
    let y = area.y + area.height / 2;
    for (i, line) in lines.iter().enumerate() {
        let w = line.width() as u16;
        let x = area.x + area.width.saturating_sub(w) / 2;
        if y + (i as u16) < area.bottom() {
            buf.set_line(x, y + i as u16, line, area.width);
        }
    }
}

/// The worst tone among what wants a look on a provider's accounts.
fn provider_tone(app: &App, page: Page, now: &Now) -> Option<Tone> {
    let Page::Provider(provider) = page else {
        return None;
    };
    let report = app.data.report.as_ref()?;
    let tones: Vec<Tone> = overview::attention(report, now)
        .into_iter()
        .filter(|item| item.provider == provider)
        .map(|item| item.tone)
        .collect();
    if tones.contains(&Tone::Bad) {
        Some(Tone::Bad)
    } else if tones.contains(&Tone::Warn) {
        Some(Tone::Warn)
    } else {
        None
    }
}

fn draw_sidebar(buf: &mut Buffer, area: Rect, app: &mut App, theme: &Theme, now: &Now) {
    buf.set_style(area, theme.surface());
    let x = area.x + 2;
    let width = area.width.saturating_sub(4);
    buf.set_line(
        x,
        area.y + 1,
        &Line::from(vec![
            Span::styled("◆ ", theme.accent()),
            Span::styled("slopmax", theme.strong()),
        ]),
        width,
    );
    let place = match &app.hub {
        Some(hub) => format!("hub {hub}"),
        None => "this machine".into(),
    };
    buf.set_string(
        x,
        area.y + 2,
        format::fit(&place, width as usize),
        theme.muted(),
    );
    let mut y = area.y + 4;
    for (i, page) in app.pages().into_iter().enumerate() {
        if y + 1 >= area.bottom().saturating_sub(3) {
            break;
        }
        let selected = page == app.page;
        let row = Rect::new(area.x, y, area.width, 1);
        if selected {
            buf.set_style(row, theme.raised());
            buf.set_string(area.x, y, "▌", theme.accent());
        }
        let style = if selected {
            theme.strong()
        } else {
            Style::new()
        };
        let indent = if matches!(page, Page::Provider(_)) {
            2
        } else {
            0
        };
        buf.set_string(x + indent, y, page.title(), style);
        if let Some(tone) = provider_tone(app, page, now) {
            buf.set_span(area.right().saturating_sub(6), y, &dot(theme, tone), 1);
        }
        if i < 9 {
            buf.set_string(
                area.right().saturating_sub(3),
                y,
                (i + 1).to_string(),
                theme.muted(),
            );
        }
        app.hits.push((row, Hit::Page(i)));
        y += 1;
        // The pages after the providers are the ledger's and the setup's.
        if matches!(page, Page::Overview) || page == Page::Requests {
            y += 1;
        }
    }
    let bottom = area.bottom().saturating_sub(2);
    let (mark, tone, words) = link_words(&app.data.link);
    buf.set_line(
        x,
        bottom,
        &Line::from(vec![
            Span::styled(mark, theme.tone(tone)),
            Span::raw(" "),
            Span::styled(words, theme.muted()),
        ]),
        width,
    );
}

fn link_words(link: &Link) -> (&'static str, Tone, String) {
    match link {
        Link::Connecting => ("◌", Tone::Warn, "connecting…".into()),
        Link::Live(version) => ("●", Tone::Good, format!("live · v{version}")),
        Link::Lost(_) => ("●", Tone::Bad, "reconnecting…".into()),
    }
}

fn draw_header(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme, now: &Now, sidebar: bool) {
    let x = area.x + 2;
    let width = area.width.saturating_sub(3);
    let mut left = Vec::new();
    if !sidebar {
        let pages = app.pages();
        let at = pages.iter().position(|p| *p == app.page).unwrap_or(0);
        left.push(Span::styled("◆ ", theme.accent()));
        left.push(Span::styled(
            format!("{}/{} ", at + 1, pages.len()),
            theme.muted(),
        ));
    }
    left.push(Span::styled(app.page.title(), theme.strong()));
    if let Some(sub) = subtitle(app, now) {
        left.push(Span::raw("  "));
        left.push(Span::styled(sub, theme.muted()));
    }
    let mut right = Vec::new();
    if !sidebar {
        let (mark, tone, words) = link_words(&app.data.link);
        right.push(Span::styled(mark, theme.tone(tone)));
        if !matches!(app.data.link, Link::Live(_)) {
            right.push(Span::styled(format!(" {words}"), theme.muted()));
        }
        right.push(Span::raw(" "));
    }
    if app.data.history.iter().any(|s| s.loading)
        || app.data.requests.loading
        || app.data.pools.values().any(|s| s.loading)
    {
        right.push(Span::styled("↻ ", theme.muted()));
    }
    right.push(Span::styled(now.hm(now.at), theme.muted()));
    let right = Line::from(right);
    let rw = right.width() as u16;
    buf.set_line(x, area.y, &Line::from(left), width.saturating_sub(rw + 2));
    buf.set_line(x + width.saturating_sub(rw), area.y, &right, rw);
    for cx in area.x + 1..area.right().saturating_sub(1) {
        buf[(cx, area.y + 1)]
            .set_symbol("─")
            .set_style(theme.rule());
    }
}

/// What the header says beside the page's title.
fn subtitle(app: &App, now: &Now) -> Option<String> {
    let report = app.data.report.as_ref();
    match app.page {
        Page::Overview => None,
        Page::Provider(p) => {
            let accounts = app.accounts();
            let ready = accounts
                .iter()
                .filter(|a| {
                    !a.disabled
                        && matches!(
                            a.condition.at(now.at),
                            slopmax_client::api::report::Condition::Ready
                                | slopmax_client::api::report::Condition::Active { .. }
                        )
                })
                .count();
            let words = if p.is_subscription() {
                format!("{ready} of {} ready", accounts.len())
            } else {
                format::count(accounts.len() as u64, "key")
            };
            Some(words)
        }
        Page::Usage | Page::Performance => Some(crate::app::range_title(app.range).into()),
        Page::Requests => app
            .data
            .requests
            .value
            .as_ref()
            .map(|p| format::count(p.matched, "request")),
        Page::Agents => app.data.agents.value.as_ref().map(|agents| {
            let wired = agents.iter().filter(|a| a.wired).count();
            format!("{wired} of {} connected", agents.len())
        }),
        Page::Access => app
            .data
            .keys
            .value
            .as_ref()
            .map(|keys| format::count(keys.len() as u64, "client key")),
        Page::Diagnostics => app.data.doctor.value.as_ref().map(|sections| {
            let findings = sections.iter().flat_map(|s| &s.findings);
            let worst = findings
                .clone()
                .filter(|f| f.level >= slopmax_client::api::report::Level::Warn)
                .count();
            match worst {
                0 => "nothing wrong".into(),
                1 => "1 thing to look at".into(),
                n => format!("{n} things to look at"),
            }
        }),
        Page::Settings => report.map(|r| format!("routing {}", r.strategy.as_str())),
    }
}

/// Lays the page out on a canvas and copies the part scrolled to into
/// view; gives back the rows of requests that just arrived, on screen.
fn draw_body(buf: &mut Buffer, area: Rect, app: &mut App, theme: &Theme, now: &Now) -> Vec<Rect> {
    if area.width == 0 || area.height == 0 {
        return Vec::new();
    }
    let mut canvas = Buffer::empty(Rect::new(0, 0, area.width, CANVAS));
    let mut hits = Vec::new();
    let used = {
        let mut flow = Flow {
            buf: &mut canvas,
            theme,
            hits: &mut hits,
            x: 0,
            width: area.width.saturating_sub(1),
            y: 0,
        };
        match app.page {
            Page::Overview => overview::draw(app, &mut flow, now),
            Page::Provider(p) => provider::draw(app, p, &mut flow, now),
            Page::Usage => usage::draw_usage(app, &mut flow, now),
            Page::Performance => usage::draw_performance(app, &mut flow, now),
            Page::Requests => requests::draw(app, &mut flow, now),
            Page::Agents => system::draw_agents(app, &mut flow, now),
            Page::Access => system::draw_access(app, &mut flow, now),
            Page::Diagnostics => system::draw_diagnostics(app, &mut flow, now),
            Page::Settings => system::draw_settings(app, &mut flow, now),
        }
        flow.y.min(CANVAS)
    };
    // The selected row stays in view; the first shows the page's top.
    if app.rows() > 0 {
        if app.cursor == 0 {
            app.scroll = 0;
        } else if let Some((rect, _)) = hits.iter().find(|(_, h)| *h == Hit::Row(app.cursor)) {
            if rect.y < app.scroll {
                app.scroll = rect.y.saturating_sub(1);
            } else if rect.bottom() > app.scroll + area.height {
                app.scroll = rect.bottom() - area.height;
            }
        }
    }
    app.scroll = app.scroll.min(used.saturating_sub(area.height));
    let scroll = app.scroll;
    for dy in 0..area.height {
        let cy = scroll + dy;
        if cy >= used {
            break;
        }
        for dx in 0..area.width {
            buf[(area.x + dx, area.y + dy)] = canvas[(dx, cy)].clone();
        }
    }
    for (rect, hit) in hits {
        if rect.bottom() <= scroll || rect.y >= scroll + area.height {
            continue;
        }
        let y = rect.y.max(scroll);
        let bottom = rect.bottom().min(scroll + area.height);
        app.hits.push((
            Rect::new(area.x + rect.x, area.y + y - scroll, rect.width, bottom - y),
            hit,
        ));
    }
    if used > area.height {
        scrollbar(buf, area, scroll, used, theme);
    }
    // Rows of requests that just came in, at the top of the feed.
    let mut arrived = Vec::new();
    if app.page == Page::Requests {
        for i in 0..app.arrived {
            if let Some((rect, _)) = app.hits.iter().find(|(_, h)| *h == Hit::Row(i)) {
                arrived.push(*rect);
            }
        }
    }
    arrived
}

fn scrollbar(buf: &mut Buffer, area: Rect, scroll: u16, used: u16, theme: &Theme) {
    let x = area.right() - 1;
    let h = f64::from(area.height);
    let thumb = (h * h / f64::from(used)).round().max(1.0) as u16;
    let top = ((f64::from(scroll) / f64::from(used)) * h).round() as u16;
    for dy in 0..area.height {
        let on = dy >= top && dy < top + thumb;
        let (symbol, style) = if on {
            ("┃", Style::new())
        } else {
            ("│", theme.rule())
        };
        buf[(x, area.y + dy)].set_symbol(symbol).set_style(style);
    }
}

/// The keys the page takes, then the ones every page takes.
fn hints(app: &App) -> Vec<(&'static str, &'static str)> {
    let mut keys: Vec<(&str, &str)> = match app.page {
        Page::Overview => vec![("↑↓", "select"), ("⏎", "open")],
        Page::Provider(_) => {
            let mut keys = vec![
                ("↑↓", "select"),
                ("␣", "on/off"),
                ("p", "prefer"),
                ("c", "check"),
            ];
            if app.accounts().iter().any(|a| a.pinned) {
                keys.push(("a", "auto"));
            }
            if app
                .accounts()
                .iter()
                .any(|a| crate::app::held_resets(a, app.now()) > 0)
            {
                keys.push(("R", "redeem"));
            }
            keys
        }
        Page::Usage | Page::Performance => vec![("r", "range"), ("↑↓", "scroll")],
        Page::Requests if app.filtering => vec![("⏎", "done"), ("esc", "clear")],
        Page::Requests => vec![
            ("/", "filter"),
            ("o", "outcome"),
            ("r", "range"),
            ("⏎", "details"),
        ],
        Page::Agents => vec![("↑↓", "select"), ("c", "connect"), ("x", "disconnect")],
        Page::Access => vec![("↑↓", "select"), ("a", "add key"), ("x", "revoke")],
        Page::Diagnostics => vec![("↑↓", "scroll"), ("F5", "check again")],
        Page::Settings => vec![("↑↓", "select"), ("⏎", "change")],
    };
    keys.extend([("⇥", "pages"), ("?", "help"), ("q", "quit")]);
    keys
}

fn draw_footer(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme) {
    let mut spans = Vec::new();
    for (key, what) in hints(app) {
        spans.push(Span::styled(key, theme.strong()));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(what, theme.muted()));
        spans.push(Span::raw("   "));
    }
    buf.set_line(
        area.x + 2,
        area.y,
        &Line::from(spans),
        area.width.saturating_sub(3),
    );
}

fn draw_toasts(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme) {
    let width = 44.min(area.width.saturating_sub(4));
    let mut bottom = area.bottom().saturating_sub(1);
    for toast in app.toasts.iter().rev() {
        let lines = wrap(&toast.text, width.saturating_sub(4) as usize);
        let height = lines.len() as u16 + 2;
        if bottom < area.y + height {
            break;
        }
        let rect = Rect::new(
            area.right().saturating_sub(width + 2),
            bottom - height,
            width,
            height,
        );
        Clear.render(rect, buf);
        buf.set_style(rect, theme.raised());
        for dy in 0..height {
            buf[(rect.x, rect.y + dy)]
                .set_symbol("▌")
                .set_style(theme.tone(toast.tone));
        }
        for (i, line) in lines.iter().enumerate() {
            buf.set_string(rect.x + 2, rect.y + 1 + i as u16, line, Style::new());
        }
        bottom = rect.y;
    }
}

/// A box centered over `area`, cleared and on the raised surface.
fn dialog(
    buf: &mut Buffer,
    area: Rect,
    width: u16,
    height: u16,
    theme: &Theme,
    title: &str,
) -> Rect {
    let width = width.min(area.width.saturating_sub(4));
    let height = height.min(area.height.saturating_sub(2));
    let rect = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    Clear.render(rect, buf);
    buf.set_style(rect, theme.raised());
    let title = Line::from(vec![
        Span::raw(" "),
        Span::styled(title.to_owned(), theme.strong()),
        Span::raw(" "),
    ]);
    let inner = panel(buf, theme, rect, Some(title));
    inner.inner(Margin::new(1, 0))
}

fn draw_help(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme) -> Rect {
    let global: [(&str, &str); 12] = [
        ("⇥ / →", "next page"),
        ("⇧⇥ / ←", "previous page"),
        ("1–9", "go to a page"),
        ("↑ ↓ / j k", "select or scroll"),
        ("PgUp PgDn", "a screen at a time"),
        ("g / G", "top / bottom"),
        ("b", "show or hide the sidebar"),
        ("F5", "fetch the page again"),
        ("ctrl-r", "read every account's usage"),
        ("?", "this help"),
        ("q / esc", "quit"),
        ("ctrl-z", "suspend"),
    ];
    let page: Vec<(&str, &str)> = hints(app)
        .into_iter()
        .filter(|(k, _)| !matches!(*k, "⇥" | "?" | "q"))
        .collect();
    let height = (global.len().max(page.len()) as u16) + 6;
    let inner = dialog(buf, area, 76, height, theme, "Keys");
    let [left, right] =
        Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(inner);
    let mut write = |column: Rect, heading: &str, rows: &[(&str, &str)]| {
        buf.set_string(column.x, column.y + 1, heading, theme.muted());
        for (i, (key, what)) in rows.iter().enumerate() {
            let y = column.y + 3 + i as u16;
            if y >= column.bottom() {
                break;
            }
            buf.set_string(column.x, y, *key, theme.accent());
            buf.set_stringn(
                column.x + 12,
                y,
                *what,
                column.width.saturating_sub(12) as usize,
                Style::new(),
            );
        }
    };
    write(left, "Everywhere", &global);
    write(right, app.page.title(), &page);
    Rect::new(inner.x, inner.y, inner.width, inner.height)
}

fn draw_modal(
    buf: &mut Buffer,
    area: Rect,
    modal: &Modal,
    app: &App,
    theme: &Theme,
    now: &Now,
) -> Rect {
    match modal {
        Modal::Confirm {
            title, body, yes, ..
        } => {
            let lines = wrap(body, 52);
            let inner = dialog(buf, area, 60, lines.len() as u16 + 6, theme, title);
            for (i, line) in lines.iter().enumerate() {
                buf.set_string(inner.x, inner.y + 1 + i as u16, line, Style::new());
            }
            let keys = Line::from(vec![
                Span::styled("y", theme.tone(Tone::Bad).add_modifier(Modifier::BOLD)),
                Span::styled(format!(" {yes}   "), Style::new()),
                Span::styled("n", theme.strong()),
                Span::styled(" cancel", theme.muted()),
            ]);
            buf.set_line(
                inner.x,
                inner.bottom().saturating_sub(1),
                &keys,
                inner.width,
            );
            inner
        }
        Modal::Input {
            title, hint, value, ..
        } => {
            let inner = dialog(buf, area, 60, 8, theme, title);
            buf.set_stringn(
                inner.x,
                inner.y + 1,
                hint,
                inner.width as usize,
                theme.muted(),
            );
            let field = Line::from(vec![
                Span::styled("› ", theme.accent()),
                Span::raw(value.clone()),
                Span::styled("▏", theme.accent()),
            ]);
            buf.set_line(inner.x, inner.y + 3, &field, inner.width);
            let keys = Line::from(vec![
                Span::styled("⏎", theme.strong()),
                Span::styled(" save   ", theme.muted()),
                Span::styled("esc", theme.strong()),
                Span::styled(" cancel", theme.muted()),
            ]);
            buf.set_line(
                inner.x,
                inner.bottom().saturating_sub(1),
                &keys,
                inner.width,
            );
            inner
        }
        Modal::Strategy { selected } => {
            let strategies = slopmax_client::api::Strategy::ALL;
            let inner = dialog(
                buf,
                area,
                64,
                strategies.len() as u16 * 2 + 5,
                theme,
                "How new sessions pick an account",
            );
            let current = app.data.report.as_ref().map(|r| r.strategy);
            for (i, strategy) in strategies.iter().enumerate() {
                let y = inner.y + 1 + i as u16 * 2;
                let chosen = i == *selected;
                let mark = if chosen { "› " } else { "  " };
                let mut line = vec![
                    Span::styled(mark, theme.accent()),
                    Span::styled(
                        strategy.as_str(),
                        if chosen { theme.strong() } else { Style::new() },
                    ),
                ];
                if current == Some(*strategy) {
                    line.push(Span::styled("  current", theme.tone(Tone::Accent)));
                }
                buf.set_line(inner.x, y, &Line::from(line), inner.width);
                buf.set_stringn(
                    inner.x + 2,
                    y + 1,
                    strategy.summary(),
                    inner.width.saturating_sub(2) as usize,
                    theme.muted(),
                );
            }
            inner
        }
        Modal::Secret { title, text, note } => {
            let lines = wrap(note, 60);
            let inner = dialog(buf, area, 70, lines.len() as u16 + 7, theme, title);
            buf.set_stringn(
                inner.x,
                inner.y + 1,
                text,
                inner.width as usize,
                theme.accent().add_modifier(Modifier::BOLD),
            );
            for (i, line) in lines.iter().enumerate() {
                buf.set_string(inner.x, inner.y + 3 + i as u16, line, theme.muted());
            }
            buf.set_string(
                inner.x,
                inner.bottom().saturating_sub(1),
                "esc close",
                theme.muted(),
            );
            inner
        }
        Modal::Request(row) => {
            let LedgerRecord::Request(r) = &row.record;
            let account = r
                .account
                .as_deref()
                .map_or("no account could take it".to_owned(), |id| {
                    app.data.account_name(id).to_owned()
                });
            let mut fields: Vec<(&str, String)> = vec![
                ("When", format!("{} · {}", now.stamp(r.at), now.ago(r.at))),
                ("Status", r.status.to_string()),
                ("Model", r.model.clone().unwrap_or_else(|| "—".into())),
                ("Account", format!("{account} ({})", r.provider.title())),
                ("Attempts", r.attempts.to_string()),
                ("Time", format::millis(r.ms as f64)),
            ];
            if let Some(first) = r.first_byte_ms {
                fields.push(("First byte", format::millis(first as f64)));
            }
            fields.extend([
                ("Input", format::grouped(r.usage.input)),
                ("Output", format::grouped(r.usage.output)),
                ("Cache read", format::grouped(r.usage.cache_read)),
                ("Cache write", format::grouped(r.usage.cache_write)),
                ("API value", row.cost.map_or("—".into(), format::dollars)),
            ]);
            if let Some(agent) = r.agent {
                fields.push(("Agent", requests::agent_title(agent).into()));
            }
            if let Some(machine) = &r.machine {
                fields.push(("Machine", machine.clone()));
            }
            if let Some(session) = &r.session {
                fields.push(("Session", session.clone()));
            }
            if let Some(end) = row.end {
                fields.push(("Ended", requests::end_words(end).into()));
            }
            let inner = dialog(buf, area, 64, fields.len() as u16 + 4, theme, "Request");
            for (i, (name, value)) in fields.iter().enumerate() {
                let y = inner.y + 1 + i as u16;
                if y >= inner.bottom() {
                    break;
                }
                buf.set_string(inner.x, y, *name, theme.muted());
                buf.set_stringn(
                    inner.x + 14,
                    y,
                    value,
                    inner.width.saturating_sub(14) as usize,
                    Style::new(),
                );
            }
            inner
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
