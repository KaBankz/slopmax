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
use slopmax_client::api::ledger::{LedgerRecord, RequestRow};
use slopmax_client::api::report::{Condition, Level};
use slopmax_client::api::{Strategy, Tone};

use self::widgets::{Flow, dot, panel, wrap, wrap_hard};
use crate::app::{App, Hit, Modal, Page, held_resets, range_title};
use crate::attention::{Remedy, attention};
use crate::data::Link;
use crate::format::{self, Now};
use crate::fx::Effects;
use crate::theme::Theme;

/// How tall a page is laid out at first; a taller page is laid out again
/// on a canvas as tall as it is, up to `TALLEST`.
const CANVAS: u16 = 480;
/// The tallest a page is laid out: past it, a page says it was cut.
const TALLEST: u16 = 4096;
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
        // What would have come in did so unseen.
        app.entered = false;
        app.arrived = 0;
        if let Some(fx) = fx {
            fx.still();
        }
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
        fx.arrive(&arrived, app.scroll);
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
    // The request dialog scrolls no further than its last field.
    let deepest = match &app.modal {
        Some(Modal::Request { row, .. }) => Some(request_scroll(app, row, area, now)),
        _ => None,
    };
    if let (Some(deepest), Some(Modal::Request { scroll, .. })) = (deepest, &mut app.modal) {
        *scroll = (*scroll).min(deepest);
    }
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
    let tones: Vec<Tone> = attention(report, now)
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
    if app.data.any_loading() {
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
                            Condition::Ready | Condition::Active { .. }
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
        Page::Usage | Page::Performance => Some(range_title(app.range).into()),
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
            let worst = findings.clone().filter(|f| f.level >= Level::Warn).count();
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
    // Laid out first as tall as the page was last frame, so a page taller
    // than the first canvas isn't laid out twice on every frame.
    let first = app.tall.clamp(CANVAS, TALLEST);
    let (canvas, hits, used) = {
        let (canvas, hits, height) = lay_out(app, area.width, first, theme, now);
        if height > first && first < TALLEST {
            lay_out(app, area.width, height.min(TALLEST), theme, now)
        } else {
            (canvas, hits, height)
        }
    };
    app.tall = used;
    let used = used.min(canvas.area.height);
    let deepest = used.saturating_sub(area.height);
    // The view is kept on the page first: End asks for the very bottom,
    // and a terminal grown taller has less to scroll.
    app.scroll = app.scroll.min(deepest);
    // A selection that just moved is scrolled into view, the first row
    // with the page's top; otherwise the view stays where it was put.
    if std::mem::take(&mut app.follow)
        && let Some((rect, _)) = hits.iter().find(|(_, h)| *h == Hit::Row(app.cursor))
    {
        if app.cursor == 0 && rect.bottom() <= area.height {
            app.scroll = 0;
        } else if rect.y < app.scroll || rect.height >= area.height {
            app.scroll = rect.y.saturating_sub(1);
        } else if rect.bottom() > app.scroll.saturating_add(area.height) {
            app.scroll = rect.bottom().saturating_sub(area.height);
        }
    }
    app.scroll = app.scroll.min(deepest);
    let scroll = app.scroll;
    let view_end = scroll.saturating_add(area.height);
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
        if rect.bottom() <= scroll || rect.y >= view_end {
            continue;
        }
        let y = rect.y.max(scroll);
        let bottom = rect.bottom().min(view_end);
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

/// Lays the open page out on a canvas `height` rows tall; gives back the
/// canvas, where its rows can be clicked, and how tall the page is, which
/// may be taller than the canvas.
fn lay_out(
    app: &App,
    width: u16,
    height: u16,
    theme: &Theme,
    now: &Now,
) -> (Buffer, Vec<(Rect, Hit)>, u16) {
    let mut canvas = Buffer::empty(Rect::new(0, 0, width, height));
    let mut hits = Vec::new();
    let mut flow = Flow {
        buf: &mut canvas,
        theme,
        hits: &mut hits,
        x: 0,
        width: width.saturating_sub(1),
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
    let used = flow.y;
    if used > height && height >= TALLEST {
        // Too tall to lay out whole: its last line says so.
        let y = height - 1;
        let line = Line::from(Span::styled(
            " … the rest of this page is cut off here",
            theme.muted(),
        ));
        for x in 0..width {
            canvas[(x, y)].reset();
        }
        canvas.set_line(0, y, &line, width);
    }
    (canvas, hits, used)
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

/// The keys the page takes, as they apply to what is selected.
fn page_hints(app: &App) -> Vec<(&'static str, &'static str)> {
    match app.page {
        Page::Overview => {
            let mut keys = vec![("↑↓", "select"), ("⏎", "open")];
            if app
                .selected_attention()
                .is_some_and(|item| item.remedy == Remedy::Redeem)
            {
                keys.push(("R", "redeem"));
            }
            keys
        }
        Page::Provider(_) => {
            let mut keys = vec![("↑↓", "select")];
            if let Some(account) = app.selected_account() {
                keys.extend([("␣", "on/off"), ("p", "prefer"), ("c", "check")]);
                if held_resets(account, app.now()) > 0 {
                    keys.push(("R", "redeem"));
                }
            }
            if app.accounts().iter().any(|a| a.pinned) {
                keys.push(("a", "auto"));
            }
            keys
        }
        Page::Usage | Page::Performance => vec![("r", "range"), ("↑↓", "scroll")],
        Page::Requests if app.filtering => vec![("⏎", "done"), ("esc", "clear")],
        Page::Requests => {
            let mut keys = vec![("/", "filter"), ("o", "outcome"), ("r", "range")];
            if !app.feed().is_empty() {
                keys.push(("⏎", "details"));
            }
            keys
        }
        Page::Agents => {
            let mut keys = vec![("↑↓", "select")];
            let agent = app
                .data
                .agents
                .value
                .as_ref()
                .and_then(|agents| agents.get(app.cursor));
            match agent {
                Some(agent) if agent.wired => keys.push(("x", "disconnect")),
                Some(_) => keys.push(("c", "connect")),
                None => {}
            }
            keys
        }
        Page::Access => {
            let any = app.data.keys.value.as_ref().is_some_and(|k| !k.is_empty());
            let mut keys = Vec::new();
            if any {
                keys.push(("↑↓", "select"));
            }
            keys.push(("a", "add key"));
            if any {
                keys.push(("x", "revoke"));
            }
            keys
        }
        Page::Diagnostics => vec![("↑↓", "scroll"), ("F5", "check again")],
        Page::Settings => vec![("↑↓", "select"), ("⏎", "change")],
    }
}

/// The keys every page takes, as the footer lists them.
const GLOBAL_HINTS: [(&str, &str); 3] = [("⇥", "pages"), ("?", "help"), ("q", "quit")];

/// The hints that fit in `width` columns, whole: the page's last ones are
/// left out first, then the ones every page takes, from the right.
fn hints(app: &App, width: u16) -> Vec<(&'static str, &'static str)> {
    let wide = |keys: &[(&str, &str)]| -> usize {
        keys.iter()
            .map(|(key, what)| Line::from(format!("{key} {what}")).width() + 3)
            .sum::<usize>()
            .saturating_sub(3)
    };
    let mut page = page_hints(app);
    let mut global = GLOBAL_HINTS.to_vec();
    let fits = |page: &[(&str, &str)], global: &[(&str, &str)]| {
        let all: Vec<_> = page.iter().chain(global).copied().collect();
        wide(&all) <= width as usize
    };
    while !fits(&page, &global) && page.pop().is_some() {}
    while !fits(&page, &global) && global.pop().is_some() {}
    page.extend(global);
    page
}

fn draw_footer(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme) {
    let width = area.width.saturating_sub(3);
    let mut spans = Vec::new();
    for (i, (key, what)) in hints(app, width).into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw("   "));
        }
        spans.push(Span::styled(key, theme.strong()));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(what, theme.muted()));
    }
    buf.set_line(area.x + 2, area.y, &Line::from(spans), width);
}

fn draw_toasts(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme) {
    let width = 44.min(area.width.saturating_sub(4));
    let mut bottom = area.bottom().saturating_sub(1);
    for toast in app.toasts.iter().rev() {
        let room = width.saturating_sub(4);
        let lines = wrap_hard(&toast.text, room as usize);
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
            let y = rect.y + 1 + i as u16;
            buf.set_stringn(rect.x + 2, y, line, room as usize, Style::new());
        }
        bottom = rect.y;
    }
}

/// A box centered over `area`, cleared and on the raised surface; gives
/// back the box and the room inside it.
fn dialog(
    buf: &mut Buffer,
    area: Rect,
    width: u16,
    height: u16,
    theme: &Theme,
    title: &str,
) -> (Rect, Rect) {
    let width = dialog_width(area, width);
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
    (rect, inner.inner(Margin::new(1, 0)))
}

/// How wide a dialog asked to be `width` columns is over `area`.
fn dialog_width(area: Rect, width: u16) -> u16 {
    width.min(area.width.saturating_sub(4))
}

/// How wide the text in a dialog `width` columns wide may run.
fn text_width(area: Rect, width: u16) -> u16 {
    dialog_width(area, width).saturating_sub(4).max(1)
}

/// The keys a dialog takes, along its bottom.
fn dialog_keys(buf: &mut Buffer, inner: Rect, keys: Vec<Span<'_>>) {
    if inner.height > 0 {
        buf.set_line(inner.x, inner.bottom() - 1, &Line::from(keys), inner.width);
    }
}

/// Lines of a dialog's text from row `top` of `inner`, as many as fit
/// above its keys.
fn dialog_lines(buf: &mut Buffer, inner: Rect, top: u16, lines: &[String], style: Style) -> u16 {
    let last = inner.bottom().saturating_sub(2);
    let mut y = inner.y + top;
    for line in lines {
        if y >= last {
            break;
        }
        buf.set_stringn(inner.x, y, line, inner.width as usize, style);
        y += 1;
    }
    y - inner.y
}

fn draw_help(buf: &mut Buffer, area: Rect, app: &App, theme: &Theme) -> Rect {
    let mut global = vec![
        ("⇥ / →", "next page"),
        ("⇧⇥ / ←", "previous page"),
        ("1–9", "go to a page"),
        ("↑ ↓ / j k", "select or scroll"),
        ("PgUp PgDn", "ten rows at a time"),
        ("g / G", "top / bottom"),
        ("b", "show or hide the sidebar"),
        ("F5", "fetch the page again"),
        ("ctrl-r", "read every account's usage"),
        ("esc", "back to the overview"),
        ("?", "this help"),
        ("q / ctrl-c", "quit"),
    ];
    // Only a Unix shell's job control takes slopmax back after a suspend.
    if cfg!(unix) {
        global.push(("ctrl-z", "suspend"));
    }
    let page = page_hints(app);
    let height = (global.len().max(page.len()) as u16) + 6;
    let (outer, inner) = dialog(buf, area, 76, height, theme, "Keys");
    let [left, right] =
        Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(inner);
    let mut write = |column: Rect, heading: &str, rows: &[(&str, &str)]| {
        if column.height < 2 {
            return;
        }
        buf.set_stringn(
            column.x,
            column.y + 1,
            heading,
            column.width as usize,
            theme.muted(),
        );
        for (i, (key, what)) in rows.iter().enumerate() {
            let y = column.y + 3 + i as u16;
            if y >= column.bottom() {
                break;
            }
            buf.set_stringn(column.x, y, *key, column.width as usize, theme.accent());
            if column.width > 12 {
                buf.set_stringn(
                    column.x + 12,
                    y,
                    *what,
                    (column.width - 12) as usize,
                    Style::new(),
                );
            }
        }
    };
    write(left, "Everywhere", &global);
    write(right, app.page.title(), &page);
    outer
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
            let lines = wrap(body, text_width(area, 60) as usize);
            let (outer, inner) = dialog(buf, area, 60, lines.len() as u16 + 6, theme, title);
            dialog_lines(buf, inner, 1, &lines, Style::new());
            dialog_keys(
                buf,
                inner,
                vec![
                    Span::styled("y", theme.tone(Tone::Bad).add_modifier(Modifier::BOLD)),
                    Span::styled(format!(" {yes}   "), Style::new()),
                    Span::styled("n", theme.strong()),
                    Span::styled(" / ", theme.muted()),
                    Span::styled("esc", theme.strong()),
                    Span::styled(" cancel", theme.muted()),
                ],
            );
            outer
        }
        Modal::Input {
            title, hint, value, ..
        } => {
            let hint = wrap(hint, text_width(area, 60) as usize);
            let (outer, inner) = dialog(buf, area, 60, hint.len() as u16 + 7, theme, title);
            // The hint in full where there is room; the field comes first
            // where there isn't.
            let shown = hint.len().min(inner.height.saturating_sub(5) as usize);
            dialog_lines(buf, inner, 1, &hint[..shown], theme.muted());
            // The end of a long value shows, where the cursor is.
            let room = inner.width.saturating_sub(3) as usize;
            let field = Line::from(vec![
                Span::styled("› ", theme.accent()),
                Span::raw(format::tail(value, room)),
                Span::styled("▏", theme.accent()),
            ]);
            let y = inner.y + shown as u16 + 2;
            if y < inner.bottom().saturating_sub(1) {
                buf.set_line(inner.x, y, &field, inner.width);
            }
            dialog_keys(
                buf,
                inner,
                vec![
                    Span::styled("⏎", theme.strong()),
                    Span::styled(" save   ", theme.muted()),
                    Span::styled("esc", theme.strong()),
                    Span::styled(" cancel", theme.muted()),
                ],
            );
            outer
        }
        Modal::Strategy { selected } => {
            let strategies = Strategy::ALL;
            let n = strategies.len() as u16;
            let (outer, inner) = dialog(
                buf,
                area,
                64,
                n * 2 + 5,
                theme,
                "How new sessions pick an account",
            );
            // Each with its summary beneath where there is room, else alone.
            let step = if inner.height > n * 2 { 2 } else { 1 };
            let current = app.data.report.as_ref().map(|r| r.strategy);
            for (i, strategy) in strategies.iter().enumerate() {
                let y = inner.y + 1 + i as u16 * step;
                if y >= inner.bottom() {
                    break;
                }
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
                if step == 2 && y + 1 < inner.bottom() {
                    buf.set_stringn(
                        inner.x + 2,
                        y + 1,
                        strategy.summary(),
                        inner.width.saturating_sub(2) as usize,
                        theme.muted(),
                    );
                }
            }
            outer
        }
        Modal::Secret { title, text, note } => {
            // The key in full, broken anywhere, so none of it is ever cut.
            let width = text_width(area, 70) as usize;
            let chars: Vec<char> = text.chars().collect();
            let key: Vec<String> = chars
                .chunks(width)
                .map(|chunk| chunk.iter().collect())
                .collect();
            let note = wrap(note, width);
            let height = (key.len() + note.len()) as u16 + 7;
            let (outer, inner) = dialog(buf, area, 70, height, theme, title);
            let strong = theme.accent().add_modifier(Modifier::BOLD);
            let below = dialog_lines(buf, inner, 1, &key, strong);
            dialog_lines(buf, inner, below + 1, &note, theme.muted());
            dialog_keys(
                buf,
                inner,
                vec![
                    Span::styled("c", theme.strong()),
                    Span::styled(" copy   ", theme.muted()),
                    Span::styled("esc", theme.strong()),
                    Span::styled(" close", theme.muted()),
                ],
            );
            outer
        }
        Modal::Request { row, scroll } => {
            let fields = request_fields(app, row, now);
            let (outer, inner) = dialog(buf, area, 64, fields.len() as u16 + 5, theme, "Request");
            let room = request_rows(inner);
            let top = usize::from(*scroll).min(fields.len().saturating_sub(room));
            for (i, (name, value)) in fields.iter().skip(top).take(room).enumerate() {
                let y = inner.y + 1 + i as u16;
                buf.set_stringn(inner.x, y, *name, inner.width as usize, theme.muted());
                buf.set_stringn(
                    inner.x + 14,
                    y,
                    value,
                    inner.width.saturating_sub(14) as usize,
                    Style::new(),
                );
            }
            let mut keys = Vec::new();
            if fields.len() > room {
                keys.extend([
                    Span::styled("↑↓", theme.strong()),
                    Span::styled(" scroll   ", theme.muted()),
                ]);
            }
            keys.extend([
                Span::styled("esc", theme.strong()),
                Span::styled(" close", theme.muted()),
            ]);
            dialog_keys(buf, inner, keys);
            outer
        }
    }
}

/// How many of a request's fields its dialog shows at once: all but its
/// first row, and the blank row and keys at its bottom.
fn request_rows(inner: Rect) -> usize {
    inner.height.saturating_sub(3) as usize
}

/// How far the request dialog can scroll over `area`.
fn request_scroll(app: &App, row: &RequestRow, area: Rect, now: &Now) -> u16 {
    let n = request_fields(app, row, now).len();
    let height = (n as u16 + 5).min(area.height.saturating_sub(2));
    // The dialog's border takes a row above and below.
    let inner = Rect::new(0, 0, 1, height.saturating_sub(2));
    n.saturating_sub(request_rows(inner)) as u16
}

/// A request of the feed, field by field, as its dialog lists it.
fn request_fields(app: &App, row: &RequestRow, now: &Now) -> Vec<(&'static str, String)> {
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
        fields.push(("Agent", format::agent_title(agent).into()));
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
    fields
}

#[cfg(test)]
pub(crate) mod tests;
