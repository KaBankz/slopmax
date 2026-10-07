//! A provider's page: its pool, each window across the working accounts
//! side by side; then its accounts as a table, a column for each window
//! and their controls at the right, with an account's reset credits opened
//! beneath it.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::Proxy;
use slopmax_app::view::{self, Credits, Gauge, Group, Row};
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::theme::{Colors, tabular};
use crate::ui::{
    self, badge, caption, dot, figure, icon, label, meter, panel, push, resets, segments,
};
use crate::{Main, motion};

/// The table's columns: an account's name and standing, and its controls.
/// Its windows share what is left.
const NAME: Pixels = px(240.);
const CONTROLS: Pixels = px(124.);
const WINDOW: Pixels = px(120.);

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
                &format!("No {} accounts", provider.spec().title),
                "Add one with Add account, above.",
                c,
            ));
        };
        v_flex()
            .gap(px(32.))
            .children((!group.overview.is_empty()).then(|| pool(&group, c)))
            .child(self.accounts(&group, c, cx))
    }

    /// The accounts as a table: what each is, a column for each usage
    /// window, and its controls.
    fn accounts(&self, group: &Group, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let auto = self.app.clone();
        // Only a pin has anything to undo.
        let unpin = group.accounts.iter().any(|row| row.pinned).then(|| {
            push("unpin", "Let slopmax choose")
                .on_click(move |_, _, _| auto.unpin_all())
                .into_any_element()
        });
        let head = h_flex()
            .px(px(16.))
            .py(px(8.))
            .gap(px(16.))
            .text_size(px(ui::SMALL))
            .text_color(c.muted)
            .child(div().w(NAME).flex_shrink_0().child("Account"))
            .children(
                group
                    .limits
                    .iter()
                    .map(|title| div().flex_1().min_w(WINDOW).truncate().child(title.clone())),
            )
            .when(group.limits.is_empty(), |head| head.child(div().flex_1()))
            .child(div().w(CONTROLS).flex_shrink_0());
        let mut table = panel(c).child(head);
        for row in &group.accounts {
            table = table.child(self.account(row, group, c, cx));
        }
        ui::section("Accounts", unpin, c).child(table)
    }

    /// An account: its name, plan, and standing, its use of each window,
    /// and its switches; beneath, what it notes, and its reset credits when
    /// opened.
    fn account(
        &self,
        row: &Row,
        group: &Group,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (pin, toggle) = (self.app.clone(), self.app.clone());
        let (id, id2) = (row.id.clone(), row.id.clone());
        let open = row.credits.is_some() && self.credits_open.contains(&row.id);
        // Out of quota on one window, it waits on that one alone, so the
        // others fade.
        let held = row.limits.iter().flatten().any(|g| g.fraction >= 1.0);
        let name = v_flex()
            .w(NAME)
            .flex_shrink_0()
            .gap(px(4.))
            .child(
                h_flex()
                    .min_w_0()
                    .gap(px(8.))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if row.disabled { c.muted } else { c.fg })
                            .child(row.name.clone()),
                    )
                    .when(!row.plan.is_empty(), |line| {
                        line.child(badge(row.plan.clone(), c))
                    }),
            )
            .child(label(&row.status, c).text_size(px(ui::SMALL)))
            .when_some(row.last_used.clone(), |name, used| {
                name.child(caption(used, c).text_color(c.faint))
            });
        let controls = h_flex()
            .w(CONTROLS)
            .flex_shrink_0()
            .justify_end()
            .gap(px(12.))
            .child(if row.pinned {
                badge("Pinned", c).into_any_element()
            } else {
                push(SharedString::from(format!("use-{}", row.id)), "Use")
                    .tooltip("Send requests here first")
                    .accessibility_label(format!("Use {}", row.name))
                    .disabled(row.disabled)
                    .on_click(move |_, _, _| pin.pin(&id))
                    .into_any_element()
            })
            .child(
                Switch::new(SharedString::from(format!("enabled-{}", row.id)))
                    .checked(!row.disabled)
                    .accessibility_label(format!("Enable {}", row.name))
                    .on_click(move |enabled, _, _| toggle.set_disabled(&id2, !*enabled)),
            );
        let line = h_flex()
            .items_start()
            .gap(px(16.))
            .child(name)
            .children(row.limits.iter().map(|gauge| {
                let faded =
                    row.disabled || (held && gauge.as_ref().is_some_and(|g| g.fraction < 1.0));
                limit(gauge.as_ref(), faded, c)
            }))
            .when(row.limits.is_empty(), |line| line.child(div().flex_1()))
            .child(controls);
        let notes = (!row.notes.is_empty() || row.credits.is_some()).then(|| {
            h_flex()
                .gap(px(16.))
                .overflow_hidden()
                .text_size(px(ui::SMALL))
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
        let credits = row
            .credits
            .as_ref()
            .filter(|_| open)
            .map(|credits| self.credits(row, credits, group.title, c, cx));
        v_flex()
            .px(px(16.))
            .py(px(14.))
            .gap(px(10.))
            .border_t_1()
            .border_color(c.separator)
            .child(line)
            .children(notes)
            .children(credits)
    }

    /// An account's reset credits, inset beneath it: when each was granted
    /// and expires, what redeeming one clears, and the button that does,
    /// which asks first. They drop into place from the line that opened
    /// them.
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
                        .text_size(px(ui::SMALL))
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
                    push(SharedString::from(format!("redeem-{id}")), "Redeem")
                        .primary()
                        .accessibility_label(format!("Redeem it now on {}", row.name))
                        .on_click(cx.listener(move |main, _, _, cx| {
                            main.confirming = None;
                            app.redeem(&id);
                            cx.notify();
                        })),
                )
        } else {
            h_flex()
                .gap(px(12.))
                .children(held.as_deref().map(|why| caption(why, c)))
                .child(
                    push(
                        SharedString::from(format!("ask-redeem-{id}")),
                        "Redeem one…",
                    )
                    .disabled(held.is_some())
                    .accessibility_label(format!("Redeem a reset credit on {}…", row.name))
                    .on_click(cx.listener(move |main, _, _, cx| {
                        main.confirming = Some(id.clone());
                        cx.notify();
                    })),
                )
        };
        let mut well = v_flex()
            .p(px(14.))
            .gap(px(10.))
            .rounded(px(6.))
            .bg(c.well)
            .child(
                h_flex()
                    .gap(px(12.))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(div().font_weight(FontWeight::MEDIUM).child("Reset credits"))
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
            well = well.child(caption("Listing them…", c));
        }
        for credit in &credits.credits {
            let soon = credit.tone == Tone::Warn;
            well = well.child(
                h_flex()
                    .gap(px(8.))
                    .pt(px(10.))
                    .border_t_1()
                    .border_color(c.border)
                    .text_size(px(ui::SMALL))
                    .text_color(if soon { c.warn } else { c.fg })
                    .when(soon, |line| line.child(dot(c.warn)))
                    .child(credit.expires.clone())
                    .children(credit.left.as_ref().map(|left| {
                        div()
                            .text_color(if soon { c.warn } else { c.muted })
                            .child(left.clone())
                    }))
                    .child(div().flex_1())
                    .children(
                        credit
                            .granted
                            .as_deref()
                            .map(|granted| caption(granted, c).text_color(c.faint)),
                    ),
            );
        }
        let well = well.children(
            view::auto_redeem(self.app.config(), provider).map(|policy| caption(policy, c)),
        );
        let drop = Animation::new(motion::APPEAR).with_easing(motion::ease_out);
        well.relative().with_animation(
            SharedString::from(format!("credits-well-{}", row.id)),
            drop,
            |well, along| well.top(px(-6. * (1. - along))).opacity(along),
        )
    }
}

/// The pool: each window across the working accounts, side by side, over
/// each account's share of it.
fn pool(group: &Group, c: &Colors) -> impl IntoElement {
    let total = group.accounts.len();
    let noun = if total == 1 { "account" } else { "accounts" };
    let across = if group.working == total {
        format!("Across {total} {noun}")
    } else {
        format!(
            "Across {} of {total} {noun}; the rest are out of service",
            group.working
        )
    };
    let cells = h_flex()
        .items_stretch()
        .children(group.overview.iter().enumerate().map(|(i, overview)| {
            v_flex()
                .flex_1()
                .min_w_0()
                .p(px(16.))
                .gap(px(8.))
                .when(i > 0, |cell| cell.border_l_1().border_color(c.separator))
                .child(caption(overview.title.clone(), c))
                .child(
                    h_flex()
                        .items_end()
                        .gap(px(6.))
                        .child(figure(overview.gauge.percent.clone(), ui::TITLE, c))
                        .child(caption("used", c).pb(px(3.))),
                )
                .child(segments(&overview.shares, c))
                .child(caption(resets(&overview.gauge), c).truncate())
        }));
    ui::section("Pool", Some(caption(across, c).into_any_element()), c).child(
        panel(c)
            .child(cells)
            .children(group.credits.as_deref().map(|credits| {
                ui::row(false, c)
                    .py(px(10.))
                    .child(caption(ui::sentence(credits), c))
            })),
    )
}

/// An account's use of one window: how much, over a meter marked where an
/// even spend would be, when it resets, and how its pace compares.
fn limit(gauge: Option<&Gauge>, faded: bool, c: &Colors) -> Div {
    let cell = v_flex()
        .flex_1()
        .min_w(WINDOW)
        .gap(px(6.))
        .when(faded, |cell| cell.opacity(0.45));
    let Some(g) = gauge else {
        return cell.child(div().text_color(c.faint).child("—"));
    };
    let pace = g.pace.as_ref();
    cell.child(
        div()
            .font_features(tabular())
            .font_weight(FontWeight::MEDIUM)
            .child(g.percent.clone()),
    )
    .child(
        meter(g.fraction, c.fill(g.tone), c).when_some(pace, |bar, pace| {
            bar.relative().child(
                div()
                    .absolute()
                    .left(relative(pace.elapsed))
                    .top(px(-3.))
                    .w(px(2.))
                    .h(px(10.))
                    .rounded_full()
                    .bg(c.muted),
            )
        }),
    )
    .child(
        v_flex()
            .gap(px(2.))
            .child(caption(
                match &g.resets_in {
                    Some(left) => format!("Resets in {left}"),
                    None => "Nothing to reset".to_owned(),
                },
                c,
            ))
            .children(
                pace.map(|pace| caption(&pace.label.text, c).text_color(c.tone(pace.label.tone))),
            ),
    )
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
    let fg = c.fg;
    h_flex()
        .id(SharedString::from(format!("credits-{}", row.id)))
        .flex_shrink_0()
        .gap(px(4.))
        .text_color(if open { c.fg } else { c.muted })
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .hover(move |line| line.text_color(fg))
        .role(Role::DisclosureTriangle)
        .aria_label(format!("{} on {}", credits.title, row.name))
        .aria_expanded(open)
        .child(credits.title.clone())
        .child(icon(
            if open {
                IconName::ChevronDown
            } else {
                IconName::ChevronRight
            },
            13.,
            c.muted,
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
