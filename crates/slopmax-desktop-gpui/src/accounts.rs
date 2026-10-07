//! A provider's page: its pool's windows across the accounts, large, then
//! each account with its windows, standing, switches, and reset credits.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable, Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::Proxy;
use slopmax_app::view::{self, Credits, Gauge, Group, Overview, Row, Share};
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::overview::provider_mark;
use crate::theme::Colors;
use crate::ui::{
    self, avatar, caption, card, card_header, dot, figure, gauge, icon, icon_tile, label, pill,
    status,
};
use crate::{Main, push};

/// The width of an account's name and standing.
const NAME: Pixels = px(220.);

impl Main {
    pub(crate) fn provider(
        &self,
        provider: ProviderId,
        c: &Colors,
        now: Timestamp,
        cx: &mut Context<Self>,
    ) -> Div {
        let groups = self
            .snapshot
            .report
            .as_ref()
            .map(|report| view::groups(report, now))
            .unwrap_or_default();
        let Some(group) = groups.into_iter().find(|g| g.provider == provider) else {
            return v_flex().child(ui::empty(
                IconName::Users,
                &format!("No {} accounts", provider.spec().title),
                "Add one with Add account, above.",
                c,
            ));
        };
        let auto = self.app.clone();
        let pinned = group.accounts.iter().any(|row| row.pinned);
        let mut list = v_flex();
        for (i, row) in group.accounts.iter().enumerate() {
            list = list.child(self.row(row, &group, i == 0, c, cx));
        }
        let noun = if group.accounts.len() == 1 {
            "account"
        } else {
            "accounts"
        };
        v_flex()
            .gap(px(20.))
            .children((!group.overview.is_empty()).then(|| pool(&group, c)))
            .child(
                card(c)
                    .gap(px(4.))
                    .child(
                        card_header("Accounts", c)
                            .child(pill(format!("{} {noun}", group.accounts.len()), c.muted, c))
                            // Only a pin has anything to undo.
                            .when(pinned, |heading| {
                                heading.child(
                                    push("unpin", "Let slopmax choose")
                                        .icon(IconName::Sparkles)
                                        .on_click(move |_, _, _| auto.unpin_all()),
                                )
                            }),
                    )
                    .child(list),
            )
    }

    /// An account: its name, plan, and standing, a column for each of its
    /// usage windows, and its switches; beneath, its reset credits when
    /// opened.
    fn row(
        &self,
        row: &Row,
        group: &Group,
        first: bool,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let limits = &group.limits;
        let (pin, toggle) = (self.app.clone(), self.app.clone());
        let (id, id2) = (row.id.clone(), row.id.clone());
        let open = row.credits.is_some() && self.credits_open.contains(&row.id);
        // Out of quota on one window, it waits on that one alone, so the
        // others fade.
        let held = row.limits.iter().flatten().any(|g| g.fraction >= 1.0);
        let color = c.provider(group.provider);
        let name = h_flex()
            .w(NAME)
            .flex_shrink_0()
            .gap(px(12.))
            .child(avatar(&row.name, color, c).when(row.disabled, |a| a.opacity(0.5)))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(5.))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(13.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if row.disabled { c.muted } else { c.fg })
                            .child(row.name.clone()),
                    )
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap(px(6.))
                            .child(status(&row.status, c))
                            .when(!row.plan.is_empty(), |line| {
                                line.child(pill(row.plan.clone(), c.violet, c))
                            }),
                    )
                    .when_some(row.last_used.clone(), |name, used| {
                        name.child(caption(used, c).text_size(px(ui::TINY)))
                    }),
            );
        let line = h_flex()
            .items_start()
            .gap(px(16.))
            .child(name)
            .children(limits.iter().zip(&row.limits).map(|(title, gauge)| {
                let faded =
                    row.disabled || (held && gauge.as_ref().is_some_and(|g| g.fraction < 1.0));
                limit(title, gauge.as_ref(), group.provider, faded, c)
            }))
            .when(limits.is_empty(), |line| line.child(div().flex_1()))
            .child(
                h_flex()
                    .flex_shrink_0()
                    .gap(px(12.))
                    .child(if row.pinned {
                        pill("Pinned", c.accent, c)
                            .h(px(26.))
                            .px(px(10.))
                            .child(icon(IconName::Pin, 12., ui::ink(c.accent, c)))
                            .into_any_element()
                    } else {
                        Button::new(SharedString::from(format!("use-{}", row.id)))
                            .label("Use")
                            .accessibility_label(format!("Use {}", row.name))
                            .outline()
                            .small()
                            .disabled(row.disabled)
                            .on_click(move |_, _, _| pin.pin(&id))
                            .into_any_element()
                    })
                    .child(
                        Switch::new(SharedString::from(format!("enabled-{}", row.id)))
                            .checked(!row.disabled)
                            .accessibility_label(format!("Enable {}", row.name))
                            .on_click(move |enabled, _, _| toggle.set_disabled(&id2, !*enabled)),
                    ),
            );
        let notes = (!row.notes.is_empty() || row.credits.is_some()).then(|| {
            h_flex()
                .pl(px(44.))
                .gap(px(14.))
                .overflow_hidden()
                .text_size(px(ui::SMALL))
                .text_color(c.muted)
                .children(
                    row.credits
                        .as_ref()
                        .map(|credits| disclosure(row, credits, open, c, cx)),
                )
                // Only the last note gives way, so a long error never
                // squeezes the short ones.
                .children(row.notes.iter().enumerate().map(|(i, note)| {
                    label(note, c).when(i + 1 < row.notes.len(), |note| note.flex_shrink_0())
                }))
        });
        let panel = row
            .credits
            .as_ref()
            .filter(|_| open)
            .map(|credits| self.credits(row, credits, group.title, c, cx));
        v_flex()
            .py(px(16.))
            .gap(px(12.))
            .when(!first, |row| row.border_t_1().border_color(c.separator))
            .child(line)
            .children(notes)
            .children(panel)
    }

    /// An account's reset credits: when each was granted and expires, what
    /// redeeming one clears, and the button that does, which asks first.
    fn credits(
        &self,
        row: &Row,
        credits: &Credits,
        provider: &str,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let redeeming = self.snapshot.redeeming.as_deref() == Some(row.id.as_str());
        let confirming = self.confirming.as_deref() == Some(row.id.as_str());
        let running = matches!(self.snapshot.proxy, Proxy::Running { .. });
        let held = credits
            .held
            .clone()
            .or_else(|| (!running).then(|| "Start the proxy to redeem one".to_owned()));
        let id = row.id.clone();
        let action = if redeeming {
            h_flex().child(caption("Redeeming…", c))
        } else if confirming {
            let app = self.app.clone();
            h_flex()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .child("Redeem one now?"),
                )
                .child(
                    push(SharedString::from(format!("keep-{id}")), "Cancel").on_click(cx.listener(
                        |main, _, _, cx| {
                            main.confirming = None;
                            cx.notify();
                        },
                    )),
                )
                .child(
                    Button::new(SharedString::from(format!("redeem-{id}")))
                        .label("Redeem")
                        .icon(IconName::RotateCcw)
                        .primary()
                        .small()
                        .accessibility_label(format!("Redeem it now on {}", row.name))
                        .on_click(cx.listener(move |main, _, _, cx| {
                            main.confirming = None;
                            app.redeem(&id);
                            cx.notify();
                        })),
                )
        } else {
            h_flex()
                .gap(px(10.))
                .children(held.as_deref().map(|why| caption(why, c)))
                .child(
                    push(
                        SharedString::from(format!("ask-redeem-{id}")),
                        "Redeem one…",
                    )
                    .icon(IconName::RotateCcw)
                    .disabled(held.is_some())
                    .accessibility_label(format!("Redeem a reset credit on {}…", row.name))
                    .on_click(cx.listener(move |main, _, _, cx| {
                        main.confirming = Some(id.clone());
                        cx.notify();
                    })),
                )
        };
        let mut panel = v_flex()
            .ml(px(44.))
            .p(px(16.))
            .gap(px(12.))
            .rounded(px(12.))
            .bg(c.well)
            .border_1()
            .border_color(c.border)
            .child(
                h_flex()
                    .gap(px(12.))
                    .child(icon_tile(IconName::RotateCcw, c.accent, 30., c))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Reset credits"),
                            )
                            .child(caption(
                                format!(
                                    "Each one resets this account's {} windows at once.",
                                    credits.clears
                                ),
                                c,
                            )),
                    )
                    .child(action),
            );
        if credits.credits.is_empty() {
            panel = panel.child(caption("Listing them…", c));
        }
        for credit in &credits.credits {
            let color = match credit.tone {
                Tone::Muted => c.muted,
                tone => c.tone(tone),
            };
            panel = panel.child(
                h_flex()
                    .gap(px(10.))
                    .pt(px(10.))
                    .border_t_1()
                    .border_color(c.separator)
                    .text_size(px(12.5))
                    .child(dot(color))
                    .child(credit.expires.clone())
                    .children(
                        credit
                            .left
                            .as_ref()
                            .map(|left| pill(left.clone(), color, c)),
                    )
                    .child(div().flex_1())
                    .children(credit.granted.as_deref().map(|granted| caption(granted, c))),
            );
        }
        panel.children(
            view::auto_redeem(self.app.config(), provider)
                .map(|policy| caption(policy, c).pt(px(2.))),
        )
    }
}

/// A provider's pool: each window across its working accounts, large, over
/// each account's share.
fn pool(group: &Group, c: &Colors) -> impl IntoElement {
    let total = group.accounts.len();
    let noun = if total == 1 { "account" } else { "accounts" };
    let accounts = if group.working == total {
        format!("Across {total} {noun}")
    } else {
        format!(
            "Across {} of {total} {noun}, the rest out of service",
            group.working
        )
    };
    card(c)
        .p(px(24.))
        .gap(px(22.))
        .child(
            h_flex()
                .gap(px(12.))
                .child(provider_mark(group.provider, c))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(ui::HEADING + 1.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("{} pool", group.title)),
                        )
                        .child(caption(accounts, c)),
                )
                .children(
                    group
                        .credits
                        .as_deref()
                        .map(|credits| pill(credits.to_owned(), c.accent, c)),
                ),
        )
        .child(
            h_flex()
                .flex_wrap()
                .items_start()
                .gap(px(32.))
                .children(group.overview.iter().map(|o| metric(o, group.provider, c))),
        )
}

/// A window across the pool: its use, large, over each account's share.
fn metric(overview: &Overview, provider: ProviderId, c: &Colors) -> Div {
    v_flex()
        .flex_1()
        .min_w(px(260.))
        .gap(px(10.))
        .child(caption(overview.title.clone(), c).text_size(px(12.5)))
        .child(
            h_flex()
                .items_end()
                .gap(px(6.))
                .child(figure(overview.gauge.percent.clone(), 34., c))
                .child(caption("used", c).pb(px(5.)))
                .child(div().flex_1())
                .children(
                    overview
                        .gauge
                        .pace
                        .as_ref()
                        .map(|pace| pill(pace.label.text.clone(), c.tone(pace.label.tone), c)),
                ),
        )
        .child(segments(&overview.shares, provider, c))
        .child(resets(&overview.gauge, c))
}

/// A segment per account, each filled to its use; an account out of the
/// pool fades.
pub(crate) fn segments(shares: &[Share], provider: ProviderId, c: &Colors) -> Div {
    h_flex().gap(px(4.)).children(shares.iter().map(|share| {
        gauge(share.fraction, c.gauge(share.tone, provider), c)
            .flex_1()
            .when(share.idle, |bar| bar.opacity(0.35))
    }))
}

/// One usage window of an account: its use over a bar marked where an even
/// spend would be, when it resets, and how its pace compares.
fn limit(title: &str, gauge: Option<&Gauge>, provider: ProviderId, faded: bool, c: &Colors) -> Div {
    let cell = v_flex()
        .flex_1()
        .min_w(px(120.))
        .gap(px(7.))
        .when(faded, |cell| cell.opacity(0.4));
    let Some(g) = gauge else {
        return cell;
    };
    cell.child(
        h_flex().child(caption(title, c).flex_1()).child(
            div()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .font_features(crate::theme::tabular())
                .child(g.percent.clone()),
        ),
    )
    .child(
        ui::gauge(g.fraction, c.gauge(g.tone, provider), c).when_some(
            g.pace.as_ref(),
            |bar, pace| {
                bar.relative().child(
                    div()
                        .absolute()
                        .left(relative(pace.elapsed))
                        .top(px(-3.))
                        .w(px(2.))
                        .h(px(14.))
                        .rounded_full()
                        .bg(c.fg.opacity(0.6)),
                )
            },
        ),
    )
    .child(resets_soon(g, c))
    .when_some(g.pace.as_ref(), |cell, pace| {
        cell.child(
            div()
                .text_size(px(ui::TINY))
                .text_color(c.tone(pace.label.tone))
                .child(pace.label.text.clone()),
        )
    })
}

/// `Resets in 1h07m · 22:59`, or that nothing waits to reset.
pub(crate) fn resets(gauge: &Gauge, c: &Colors) -> Div {
    let line = h_flex()
        .gap(px(6.))
        .text_size(px(ui::TINY + 0.5))
        .text_color(c.muted)
        .child(icon(IconName::Clock, 12., c.faint));
    match (&gauge.resets_in, &gauge.resets_at) {
        (Some(left), Some(at)) => line
            .child(div().text_color(c.fg).child(format!("Resets in {left}")))
            .child(div().text_color(c.faint).child("·"))
            .child(at.clone()),
        _ => line.child("No reset pending"),
    }
}

/// `1h07m · 22:59`, as a narrow column has room for.
fn resets_soon(gauge: &Gauge, c: &Colors) -> Div {
    let line = h_flex()
        .gap(px(5.))
        .text_size(px(ui::TINY))
        .text_color(c.muted)
        .child(icon(IconName::Clock, 11., c.faint));
    match (&gauge.resets_in, &gauge.resets_at) {
        (Some(left), Some(at)) => line
            .child(div().text_color(c.fg).child(left.clone()))
            .child(div().text_color(c.faint).child("·"))
            .child(div().truncate().child(at.clone())),
        _ => line.child("No reset"),
    }
}

/// The way to an account's reset credits: their count, and a chevron that
/// turns down while they show.
fn disclosure(
    row: &Row,
    credits: &Credits,
    open: bool,
    c: &Colors,
    cx: &mut Context<Main>,
) -> impl IntoElement {
    let id = row.id.clone();
    let accent = c.accent;
    h_flex()
        .id(SharedString::from(format!("credits-{}", row.id)))
        .flex_shrink_0()
        .gap(px(5.))
        .text_color(accent)
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .role(Role::DisclosureTriangle)
        .aria_label(format!("{} on {}", credits.title, row.name))
        .aria_expanded(open)
        .child(icon(IconName::RotateCcw, 13., accent))
        .child(credits.title.clone())
        .child(icon(
            if open {
                IconName::ChevronDown
            } else {
                IconName::ChevronRight
            },
            13.,
            accent,
        ))
        .on_click(cx.listener(move |main, _, _, cx| {
            if !main.credits_open.remove(&id) {
                main.credits_open.insert(id.clone());
            }
            if main.confirming.as_ref() == Some(&id) {
                main.confirming = None;
            }
            cx.notify();
        }))
}
