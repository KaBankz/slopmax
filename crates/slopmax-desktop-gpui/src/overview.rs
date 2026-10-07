//! The Overview page, where the window opens: how the accounts stand, in a
//! line; what wants a look, only when something does; each subscription's
//! windows across its pool, each leading to its accounts; and today's work.

use gpui_kit::assets::IconName;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::History;
use slopmax_app::view::{self, Attention, Group, Remedy, Status};
use slopmax_core::human;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::theme::{Colors, tabular};
use crate::ui::{self, caption, dot, icon, panel, resets, segments, stat, stats};
use crate::usage::{grouped, priced};
use crate::{Main, Section, push};

/// The width of a window's title, beside its meter.
const WINDOW: f32 = 100.;

impl Main {
    pub(crate) fn overview(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> Div {
        let Some(report) = &self.snapshot.report else {
            return v_flex().child(ui::empty(
                "Looking for the proxy…",
                "slopmax shows your accounts as soon as it answers.",
                c,
            ));
        };
        let groups = view::groups(report, now);
        let attention = view::attention(report, now);
        let pools: Vec<&Group> = groups.iter().filter(|g| !g.overview.is_empty()).collect();
        let page = v_flex().gap(px(32.));
        let page = if groups.is_empty() {
            page.child(ui::empty(
                "No accounts yet",
                "Sign in, import your agents' logins, or add an API key, with Add account above.",
                c,
            ))
        } else {
            page.child(standing(&view::status(report, now), c))
        };
        page.when(!attention.is_empty(), |page| {
            page.child(self.needs(&attention, c, cx))
        })
        .when(!pools.is_empty(), |page| {
            page.child(subscriptions(&pools, c, cx))
        })
        .child(self.today(c))
    }

    /// What wants a look, each with what to do about it.
    fn needs(&self, items: &[Attention], c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let mut list = panel(c);
        for (i, item) in items.iter().enumerate() {
            let (remedy, provider, account) = (item.remedy, item.provider, item.account.clone());
            let title = match remedy {
                Remedy::SignIn => "Sign in…",
                Remedy::Redeem => "Redeem…",
                Remedy::Look => "Show",
            };
            list = list.child(
                ui::row(i == 0, c)
                    .py(px(10.))
                    .child(dot(c.tone(item.tone)))
                    .child(div().flex_1().min_w_0().child(item.text.clone()))
                    .child(
                        push(SharedString::from(format!("remedy-{i}")), title).on_click(
                            cx.listener(move |main, _, _, cx| match remedy {
                                Remedy::SignIn => main.app.sign_in(provider),
                                Remedy::Redeem => {
                                    main.credits_open.insert(account.clone());
                                    main.go(Section::Provider(provider), cx);
                                }
                                Remedy::Look => main.go(Section::Provider(provider), cx),
                            }),
                        ),
                    ),
            );
        }
        ui::section("Needs attention", None, c).child(list)
    }

    /// Today's requests, tokens, value, and failover saves, over its
    /// requests by the hour.
    fn today(&self, c: &Colors) -> impl IntoElement {
        let section = ui::section("Today", None, c);
        let Some(today) = self.snapshot.today.as_ref() else {
            return section.child(
                panel(c)
                    .p(px(16.))
                    .child(caption("Reading today's ledger…", c)),
            );
        };
        let total = &today.total;
        section.child(
            panel(c)
                .child(stats(
                    [
                        stat(
                            "Requests",
                            grouped(total.requests),
                            match total.failed {
                                0 => "none failed".to_owned(),
                                n => format!("{} failed", grouped(n)),
                            },
                            c,
                        ),
                        stat(
                            "Tokens",
                            human::compact(slopmax_app::history::tokens(total)),
                            today.cached.map_or_else(
                                || "no cache reads".to_owned(),
                                |r| format!("{:.0}% from cache", r * 100.),
                            ),
                            c,
                        ),
                        stat(
                            "API value",
                            priced(total.cost, total),
                            "what the API would charge",
                            c,
                        ),
                        stat(
                            "Saved by failover",
                            grouped(today.rescued),
                            "taken by another account",
                            c,
                        ),
                    ],
                    c,
                ))
                .child(hours(today, c)),
        )
    }
}

/// How the accounts stand, in a line: a dot of its tone, the headline, and
/// what keeps the rest.
fn standing(status: &Status, c: &Colors) -> impl IntoElement {
    h_flex()
        .gap(px(8.))
        .child(dot(c.tone(status.tone)))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .child(status.headline.clone()),
        )
        .children(
            status
                .detail
                .as_ref()
                .map(|detail| div().text_color(c.muted).child(detail.replace(" · ", ", "))),
        )
}

/// Each subscription's windows across its pool, a block apiece that opens
/// its accounts.
fn subscriptions(pools: &[&Group], c: &Colors, cx: &mut Context<Main>) -> impl IntoElement {
    let last = pools.len() - 1;
    let mut list = panel(c);
    for (i, group) in pools.iter().enumerate() {
        list = list.child(pool(group, i == 0, i == last, c, cx));
    }
    ui::section("Subscriptions", None, c).child(list)
}

/// A subscription: how many of its accounts are ready, each window across
/// them with a segment per account, and its reset credits. A click opens
/// its accounts.
fn pool(
    group: &Group,
    first: bool,
    last: bool,
    c: &Colors,
    cx: &mut Context<Main>,
) -> impl IntoElement {
    let provider = group.provider;
    let enabled = group.accounts.iter().filter(|r| !r.disabled).count();
    let ready = group
        .accounts
        .iter()
        .filter(|r| !r.disabled && r.status.tone == Tone::Good)
        .count();
    let hover = c.hover;
    // Lines under the title start where its words do.
    let indent = px(14.);
    v_flex()
        .id(SharedString::from(format!("pool-{provider}")))
        .px(px(16.))
        .py(px(14.))
        .gap(px(10.))
        .when(!first, |block| block.border_t_1().border_color(c.separator))
        .when(first, |block| block.rounded_t(px(7.)))
        .when(last, |block| block.rounded_b(px(7.)))
        .cursor_pointer()
        .hover(move |block| block.bg(hover))
        .role(Role::Button)
        .aria_label(format!("{} accounts", group.title))
        .on_click(cx.listener(move |main, _, _, cx| main.go(Section::Provider(provider), cx)))
        .child(
            h_flex()
                .gap(px(8.))
                .child(dot(c.provider(provider)))
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::MEDIUM)
                        .child(group.title),
                )
                .child(caption(format!("{ready} of {enabled} ready"), c))
                .child(icon(IconName::ChevronRight, 14., c.faint)),
        )
        .children(group.overview.iter().map(|overview| {
            h_flex()
                .pl(indent)
                .gap(px(16.))
                .child(
                    caption(overview.title.clone(), c)
                        .w(px(WINDOW))
                        .flex_shrink_0()
                        .truncate(),
                )
                .child(segments(&overview.shares, c).flex_1())
                .child(
                    div()
                        .w(px(40.))
                        .flex_shrink_0()
                        .flex()
                        .justify_end()
                        .font_features(tabular())
                        .font_weight(FontWeight::MEDIUM)
                        .child(overview.gauge.percent.clone()),
                )
                .child(
                    caption(resets(&overview.gauge), c)
                        .w(px(200.))
                        .flex_shrink_0()
                        .truncate(),
                )
        }))
        .children(
            group
                .credits
                .as_deref()
                .map(|credits| caption(credits.replace(" · ", ", "), c).pl(indent)),
        )
}

/// Today's requests by the hour, the hours to come left as stubs, over the
/// hours they fall in.
fn hours(today: &History, c: &Colors) -> impl IntoElement {
    let most = today
        .buckets
        .iter()
        .map(|b| b.requests)
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    v_flex()
        .px(px(16.))
        .pt(px(16.))
        .pb(px(12.))
        .gap(px(6.))
        .border_t_1()
        .border_color(c.separator)
        .child(
            h_flex()
                .h(px(56.))
                .items_end()
                .gap(px(3.))
                .children((0..24).map(|hour| {
                    let requests = today.buckets.get(hour).map_or(0, |b| b.requests);
                    let column = div().flex_1().rounded(px(2.));
                    if requests > 0 {
                        column
                            .h(relative(requests as f32 / most))
                            .min_h(px(3.))
                            .bg(c.meter)
                    } else {
                        column.h(px(3.)).bg(c.track)
                    }
                })),
        )
        .child(
            // Each label under its own hour's column.
            h_flex()
                .gap(px(3.))
                .text_size(px(11.))
                .text_color(c.faint)
                .font_features(tabular())
                .children((0..24).map(|hour| {
                    div()
                        .flex_1()
                        .whitespace_nowrap()
                        .when(hour % 6 == 0, |cell| cell.child(format!("{hour:02}:00")))
                })),
        )
}
