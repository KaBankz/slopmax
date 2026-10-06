//! The menu bar panel: what slopmax's menu bar item opens, as iStat Menus
//! and CodexBar open theirs, on the system's popover material. How the
//! accounts stand; each subscription's windows across its pool, the
//! accounts that want a look, and its reset credits; today's work in
//! brief; and the way into the window. A provider, or today, opens its
//! page.
//!
//! It hangs under the item and fits its content. As a popover does, it
//! closes on a click anywhere else, when the window comes forward, or on
//! Escape; not merely on losing focus, which the app in front may take
//! back.

use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::History;
use slopmax_app::view::{self, Group, Status};
use slopmax_app::{App as Slopmax, Proxy, Snapshot};
use slopmax_core::human;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::accounts::{resets, segments};
use crate::native::{self, Material};
use crate::usage::{grouped, priced};
use crate::{Colors, OpenSettings, OpenWindow, Quit, Section, Shared, provider_color, symbols};

actions!(panel, [ClosePanel]);

/// The panel's width, a little wider than a menu's.
const WIDTH: f32 = 340.;
/// How often today's work is read again while the panel shows.
const TODAY_EVERY: Duration = Duration::from_secs(60);

/// Binds the panel's keys, and has a click in another app close it.
pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", ClosePanel, Some("Panel"))]);
    if let Some(clicks) = native::outside_clicks() {
        cx.spawn(async move |cx: &mut AsyncApp| {
            while clicks.recv().await.is_ok() {
                cx.update(dismiss);
            }
        })
        .detach();
    }
}

/// Opens the panel under the menu bar item, or closes it if it is open.
pub(crate) fn toggle(cx: &mut App) {
    if cx.global::<Shared>().panel.is_some() {
        dismiss(cx);
    } else {
        open(cx);
    }
}

/// Closes the panel, if it is open.
pub(crate) fn dismiss(cx: &mut App) {
    if let Some(panel) = cx.global_mut::<Shared>().panel.take() {
        let _ = panel.update(cx, |_, window, _| window.remove_window());
    }
}

fn open(cx: &mut App) {
    let Some(item) = native::status_item() else {
        // No menu bar item to hang from: the window serves instead.
        crate::open_window(cx);
        return;
    };
    let anchor = point(item.center().x, item.bottom());
    let display = cx
        .displays()
        .into_iter()
        .find(|d| d.bounds().contains(&point(anchor.x, anchor.y - px(1.))));
    let (display_id, area) = match &display {
        Some(d) => (Some(d.id()), d.bounds()),
        None => (
            None,
            Bounds::new(point(px(0.), px(0.)), size(px(1e5), px(1e5))),
        ),
    };
    // Centered under the item, kept on its screen, a little below the bar.
    let width = px(WIDTH);
    let x = (anchor.x - width / 2.)
        .max(area.left() + px(8.))
        .min(area.right() - width - px(8.));
    let origin = point(x - area.origin.x, anchor.y - area.origin.y + px(5.));
    let options = WindowOptions {
        titlebar: None,
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            origin,
            size(width, px(480.)),
        ))),
        kind: WindowKind::PopUp,
        focus: true,
        show: true,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        display_id,
        window_background: WindowBackgroundAppearance::Transparent,
        ..WindowOptions::default()
    };
    let app = cx.global::<Shared>().app.clone();
    match gpui_kit::open_window(options, cx, |window, cx| {
        crate::macos_theme(window, cx);
        native::frost(window, Material::Popover, 12.);
        cx.new(|cx| Panel::new(app, cx))
    }) {
        Ok((window, _)) => cx.global_mut::<Shared>().panel = Some(window),
        Err(e) => eprintln!("slopmax: could not open the menu bar panel: {e:#}"),
    }
}

/// Closes the panel and brings the window forward at `section`.
fn go(section: Section, cx: &mut App) {
    dismiss(cx);
    crate::show(section, cx);
}

pub(crate) struct Panel {
    app: Arc<Slopmax>,
    snapshot: Snapshot,
    /// The height last fitted to, so the window resizes only on a change.
    fitted: Pixels,
    _tasks: [Task<()>; 2],
}

impl Panel {
    fn new(app: Arc<Slopmax>, cx: &mut Context<Self>) -> Self {
        app.load_today();
        let mut changes = app.subscribe();
        let follow = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                let snapshot = changes.borrow_and_update().clone();
                let drawn = this.update(cx, |panel, cx| {
                    panel.snapshot = snapshot;
                    cx.notify();
                });
                if drawn.is_err() || changes.changed().await.is_err() {
                    break;
                }
            }
        });
        // Countdowns move every second; today's work is read now and then.
        let tick = cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let mut since = Duration::ZERO;
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                since += Duration::from_secs(1);
                let reread = since >= TODAY_EVERY;
                if reread {
                    since = Duration::ZERO;
                }
                let ticked = this.update(cx, |panel, cx| {
                    if reread {
                        panel.app.load_today();
                    }
                    cx.notify();
                });
                if ticked.is_err() {
                    break;
                }
            }
        });
        Self {
            snapshot: app.snapshot(),
            app,
            fitted: px(480.),
            _tasks: [follow, tick],
        }
    }

    /// Resizes the window to `height`, keeping its top under the menu bar.
    fn fit(&mut self, height: Pixels, window: &mut Window) {
        if (height - self.fitted).abs() > px(1.) {
            self.fitted = height;
            native::hang(window, height.as_f32());
        }
    }

    /// The panel's title, how the accounts and the proxy stand, and a
    /// refresh.
    fn header(&self, status: Option<&Status>, c: &Colors, cx: &mut Context<Self>) -> Div {
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let (line, tone) = match (&self.snapshot.proxy, status) {
            (Proxy::Running { .. }, Some(status)) => (status.headline.clone(), status.tone),
            (Proxy::Running { .. }, None) => ("Running".to_owned(), Tone::Good),
            (Proxy::Starting | Proxy::Checking, _) => {
                ("Starting the proxy…".to_owned(), Tone::Muted)
            }
            (Proxy::Stopped, _) => ("The proxy is stopped".to_owned(), Tone::Bad),
        };
        let app = self.app.clone();
        h_flex()
            .gap(px(10.))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("slopmax"))
                    .child(
                        h_flex()
                            .gap(px(6.))
                            .text_size(px(11.))
                            .text_color(c.muted)
                            .child(crate::dot(c.tone(tone)))
                            .child(div().truncate().child(line)),
                    ),
            )
            .child(
                div()
                    .id("refresh")
                    .size(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .hover(|button| button.bg(c.fg.opacity(0.08)))
                    .role(Role::Button)
                    .aria_label("Refresh usage")
                    .when(!running, |button| button.opacity(0.4))
                    .children(symbols::symbol(
                        "arrow.clockwise",
                        c.fg.opacity(0.75),
                        14.,
                        cx,
                    ))
                    .on_click(move |_, _, _| {
                        if running {
                            app.refresh();
                        }
                    }),
            )
    }
}

impl Render for Panel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Colors::of(cx);
        let now = Timestamp::now();
        let report = self.snapshot.report.as_ref();
        let groups = report.map(|r| view::groups(r, now)).unwrap_or_default();
        let status = report.map(|r| view::status(r, now));
        let this = cx.entity().downgrade();
        let mut body = v_flex()
            .w_full()
            .px(px(14.))
            .pt(px(12.))
            .pb(px(6.))
            .gap(px(10.))
            .text_color(c.fg)
            .child(self.header(status.as_ref(), &c, cx));
        let pools: Vec<&Group> = groups.iter().filter(|g| !g.overview.is_empty()).collect();
        if pools.is_empty() {
            body = body.child(divider(&c)).child(
                div()
                    .text_size(px(12.))
                    .text_color(c.muted)
                    .child("No accounts yet. Open slopmax to add one."),
            );
        }
        for group in pools {
            body = body.child(divider(&c)).child(pool(group, &c, cx));
        }
        if let Some(today) = self.snapshot.today.as_ref() {
            body = body.child(divider(&c)).child(today_section(today, &c, cx));
        }
        body = body.child(divider(&c)).child(
            v_flex()
                .gap(px(1.))
                .child(command("open", "Open slopmax", "⌘O", &c, |cx| {
                    dismiss(cx);
                    cx.dispatch_action(&OpenWindow);
                }))
                .child(command("settings", "Settings…", "⌘,", &c, |cx| {
                    dismiss(cx);
                    cx.dispatch_action(&OpenSettings);
                }))
                .child(command("quit", "Quit slopmax", "⌘Q", &c, |cx| {
                    cx.dispatch_action(&Quit);
                })),
        );
        div()
            .key_context("Panel")
            .on_action(|_: &ClosePanel, _, cx| dismiss(cx))
            .size_full()
            .text_size(px(13.))
            .child(body.on_children_prepainted(move |children, window, cx| {
                let (Some(first), Some(last)) = (children.first(), children.last()) else {
                    return;
                };
                let height = last.bottom() - first.top() + px(18.);
                let _ = this.update(cx, |panel, _| panel.fit(height, window));
            }))
    }
}

/// A subscription: its windows across the pool, the accounts that want a
/// look, and its reset credits. A click opens its page.
fn pool(group: &Group, c: &Colors, cx: &mut Context<Panel>) -> impl IntoElement {
    let provider = group.provider;
    let enabled: Vec<_> = group.accounts.iter().filter(|r| !r.disabled).collect();
    let ready = enabled
        .iter()
        .filter(|r| r.status.tone == Tone::Good)
        .count();
    // Only accounts out of service show by name; the rest are counted.
    let troubled: Vec<_> = enabled
        .iter()
        .filter(|r| matches!(r.status.tone, Tone::Warn | Tone::Bad))
        .collect();
    let credits = group.credits.as_deref().map(|credits| {
        h_flex()
            .gap(px(6.))
            .text_size(px(11.))
            .text_color(c.muted)
            .children(symbols::symbol("arrow.counterclockwise", c.muted, 11., cx))
            .child(credits.to_owned())
    });
    v_flex()
        .id(SharedString::from(format!("pool-{provider}")))
        .gap(px(9.))
        .mx(px(-6.))
        .px(px(6.))
        .py(px(4.))
        .rounded(px(8.))
        .hover(|section| section.bg(c.fg.opacity(0.05)))
        .role(Role::Button)
        .aria_label(format!("{} accounts", group.title))
        .on_click(move |_, _, cx| go(Section::Provider(provider), cx))
        .child(
            h_flex()
                .gap(px(7.))
                .child(
                    div()
                        .size(px(8.))
                        .rounded_full()
                        .bg(provider_color(provider, c)),
                )
                .child(div().font_weight(FontWeight::SEMIBOLD).child(group.title))
                .child(div().flex_1())
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(c.muted)
                        .child(format!("{ready} of {} ready", enabled.len())),
                ),
        )
        .children(group.overview.iter().map(|overview| {
            v_flex()
                .gap(px(5.))
                .child(
                    h_flex()
                        .text_size(px(12.))
                        .child(overview.title.clone())
                        .child(div().flex_1())
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .child(format!("{} used", overview.gauge.percent)),
                        ),
                )
                .child(segments(&overview.shares, provider, c))
                .child(resets(&overview.gauge, c))
        }))
        .children(troubled.into_iter().map(|row| {
            h_flex()
                .gap(px(6.))
                .text_size(px(11.))
                .child(crate::dot(c.tone(row.status.tone)))
                .child(div().flex_shrink_0().child(row.name.clone()))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(c.muted)
                        .child(row.status.text.clone()),
                )
        }))
        .children(credits)
}

/// Today's totals over its hours; a click opens the Usage page.
fn today_section(today: &History, c: &Colors, cx: &mut Context<Panel>) -> impl IntoElement {
    let total = &today.total;
    let quiet = total.requests == 0 && total.failed == 0;
    let most = today
        .buckets
        .iter()
        .map(|b| b.requests)
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let chevron = symbols::symbol("chevron.right", c.muted, 10., cx);
    v_flex()
        .id("today")
        .gap(px(7.))
        .mx(px(-6.))
        .px(px(6.))
        .py(px(4.))
        .rounded(px(8.))
        .hover(|section| section.bg(c.fg.opacity(0.05)))
        .role(Role::Button)
        .aria_label("Today's usage")
        .on_click(|_, _, cx| go(Section::Usage, cx))
        .child(
            h_flex()
                .child(div().font_weight(FontWeight::SEMIBOLD).child("Today"))
                .child(div().flex_1())
                .children(chevron),
        )
        .child(
            div()
                .text_size(px(12.))
                .text_color(c.muted)
                .child(if quiet {
                    "Nothing has gone through slopmax yet.".to_owned()
                } else {
                    format!(
                        "{} requests · {} tokens · {}",
                        grouped(total.requests),
                        human::compact(slopmax_app::history::tokens(total)),
                        priced(total.cost, total)
                    )
                }),
        )
        .when(!quiet, |section| {
            section.child(
                h_flex()
                    .h(px(28.))
                    .items_end()
                    .gap(px(2.))
                    .children((0..24).map(|hour| {
                        let requests = today.buckets.get(hour).map_or(0, |b| b.requests);
                        let column = div().flex_1().rounded(px(1.5));
                        if requests > 0 {
                            column
                                .h(relative(requests as f32 / most))
                                .min_h(px(2.))
                                .bg(c.accent.opacity(0.8))
                        } else {
                            column.h(px(2.)).bg(c.track)
                        }
                    })),
            )
        })
}

/// A command at the panel's foot, as a menu's item: highlighted under the
/// pointer, its shortcut at the right.
fn command(
    id: &'static str,
    title: &'static str,
    shortcut: &'static str,
    c: &Colors,
    run: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    let accent = c.accent;
    h_flex()
        .id(id)
        .h(px(24.))
        .mx(px(-6.))
        .px(px(8.))
        .rounded(px(5.))
        .text_size(px(13.))
        .hover(move |row| row.bg(accent).text_color(white()))
        .role(Role::MenuItem)
        .aria_label(title)
        .child(div().flex_1().child(title))
        .child(div().text_color(c.muted).child(shortcut))
        .on_click(move |_, _, cx| run(cx))
}

fn divider(c: &Colors) -> Div {
    div().h(px(1.)).bg(c.separator)
}
