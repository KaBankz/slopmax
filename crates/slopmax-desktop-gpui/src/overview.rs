//! The Overview page, where the window opens: how the accounts stand, in a
//! line; each subscription's pool, as a card that leads to its accounts;
//! what wants a look, only when something does; and today's work in brief.

use gpui_kit::component::{Sizable, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::History;
use slopmax_app::view::{self, Attention, Group, Overview, Remedy, Status};
use slopmax_core::human;
use slopmax_core::provider::ProviderId;
use slopmax_core::report::Tone;
use slopmax_core::time::Timestamp;

use crate::accounts::{resets, segments};
use crate::usage::{grouped, priced};
use crate::{Colors, Main, Section, caption, group_box, provider_color, push, section, symbols};

impl Main {
    pub(crate) fn overview(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> Div {
        let Some(report) = &self.snapshot.report else {
            return v_flex().child(caption("Looking for the proxy…", c));
        };
        let status = view::status(report, now);
        let groups = view::groups(report, now);
        let attention = view::attention(report, now);
        let pools: Vec<&Group> = groups.iter().filter(|g| !g.overview.is_empty()).collect();
        v_flex()
            .gap(px(26.))
            .child(self.headline(&status, c, cx))
            .when(!pools.is_empty(), |page| {
                page.child(
                    h_flex().items_start().gap(px(16.)).children(
                        pools
                            .into_iter()
                            .map(|group| pool_card(group, c, cx))
                            .collect::<Vec<_>>(),
                    ),
                )
            })
            .when(!attention.is_empty(), |page| {
                page.child(self.needs(&attention, c, cx))
            })
            .child(self.today(c, cx))
    }

    /// How the accounts stand, and the proxy, in a line beside a symbol.
    fn headline(&self, status: &Status, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let (symbol, color) = match status.tone {
            Tone::Good => ("checkmark.circle.fill", c.good),
            Tone::Bad => ("xmark.octagon.fill", c.bad),
            _ => ("exclamationmark.triangle.fill", c.warn),
        };
        let proxy = view::proxy_line(&self.snapshot);
        let detail = match &status.detail {
            Some(detail) => format!("{detail} · {proxy}"),
            None => proxy,
        };
        h_flex()
            .gap(px(14.))
            .children(symbols::symbol(symbol, color, 30., cx))
            .child(
                v_flex()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(17.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(status.headline.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(c.muted)
                            .truncate()
                            .child(detail),
                    ),
            )
    }

    /// What wants a look, each with what to do about it.
    fn needs(&self, items: &[Attention], c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let mut list = group_box(c);
        for (i, item) in items.iter().enumerate() {
            let symbol = match item.tone {
                Tone::Bad => "xmark.octagon.fill",
                _ => "exclamationmark.triangle.fill",
            };
            let (remedy, provider, account) = (item.remedy, item.provider, item.account.clone());
            let title = match remedy {
                Remedy::SignIn => "Sign In…",
                Remedy::Redeem => "Redeem…",
                Remedy::Look => "Show",
            };
            list = list.child(
                h_flex()
                    .py(px(10.))
                    .gap(px(10.))
                    .when(i > 0, |row| row.border_t_1().border_color(c.separator))
                    .children(symbols::symbol(symbol, c.tone(item.tone), 15., cx))
                    .child(div().flex_1().min_w_0().child(item.text.clone()))
                    .child(
                        push(SharedString::from(format!("remedy-{i}")), title)
                            .small()
                            .on_click(cx.listener(move |main, _, _, cx| match remedy {
                                Remedy::SignIn => main.app.sign_in(provider),
                                Remedy::Redeem => {
                                    main.credits_open.insert(account.clone());
                                    main.go(Section::Provider(provider), cx);
                                }
                                Remedy::Look => main.go(Section::Provider(provider), cx),
                            })),
                    ),
            );
        }
        section("Needs attention", c).child(list)
    }

    /// Today's requests, tokens, value, and failover saves, over its hours.
    fn today(&self, c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let link = h_flex()
            .id("to-usage")
            .gap(px(2.))
            .text_size(px(12.))
            .text_color(c.accent)
            .cursor_pointer()
            .child("Usage")
            .children(symbols::symbol("chevron.right", c.accent, 10., cx))
            .on_click(cx.listener(|main, _, _, cx| main.go(Section::Usage, cx)));
        let body = match self.snapshot.today.as_ref() {
            None => caption("Reading the ledger…", c),
            Some(today) if today.total.requests == 0 && today.total.failed == 0 => {
                caption("Nothing has gone through slopmax today.", c)
            }
            Some(today) => v_flex()
                .gap(px(14.))
                .child(totals(today, c))
                .child(hours(today, c)),
        };
        v_flex()
            .gap(px(8.))
            .child(
                h_flex()
                    .px(px(4.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Today"))
                    .child(div().flex_1())
                    .child(link),
            )
            .child(v_flex().p(px(16.)).rounded(px(12.)).bg(c.group).child(body))
    }
}

/// A subscription's pool: each window across its accounts, which accounts
/// are ready, and its reset credits. A click opens its accounts.
fn pool_card(group: &Group, c: &Colors, cx: &mut Context<Main>) -> Stateful<Div> {
    let provider = group.provider;
    let enabled = group.accounts.iter().filter(|r| !r.disabled).count();
    let ready = group
        .accounts
        .iter()
        .filter(|r| !r.disabled && r.status.tone == Tone::Good)
        .count();
    v_flex()
        .id(SharedString::from(format!("pool-{provider}")))
        .flex_1()
        .min_w_0()
        .p(px(16.))
        .gap(px(14.))
        .rounded(px(12.))
        .bg(c.group)
        .role(Role::Button)
        .aria_label(format!("{} accounts", group.title))
        .on_click(cx.listener(move |main, _, _, cx| main.go(Section::Provider(provider), cx)))
        .child(
            h_flex()
                .gap(px(8.))
                .child(
                    div()
                        .size(px(9.))
                        .rounded_full()
                        .bg(provider_color(provider, c)),
                )
                .child(div().font_weight(FontWeight::SEMIBOLD).child(group.title))
                .child(div().flex_1())
                .child(caption(&format!("{ready} of {enabled} ready"), c))
                .children(symbols::symbol("chevron.right", c.muted, 10., cx)),
        )
        .children(group.overview.iter().map(|o| window(o, provider, c)))
        .children(group.credits.as_deref().map(|credits| {
            h_flex()
                .gap(px(6.))
                .text_size(px(11.))
                .text_color(c.muted)
                .children(symbols::symbol("arrow.counterclockwise", c.muted, 11., cx))
                .child(credits.to_owned())
        }))
}

/// One window across a pool: its title and use, a segment per account,
/// and when it resets.
fn window(overview: &Overview, provider: ProviderId, c: &Colors) -> Div {
    v_flex()
        .gap(px(6.))
        .child(
            h_flex()
                .text_size(px(12.))
                .child(overview.title.clone())
                .child(div().flex_1())
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(format!("{} used", overview.gauge.percent)),
                ),
        )
        .child(segments(&overview.shares, provider, c))
        .child(resets(&overview.gauge, c))
}

/// The day's totals, side by side.
fn totals(today: &History, c: &Colors) -> Div {
    let total = &today.total;
    let stat = |title: &str, value: String| {
        v_flex()
            .flex_1()
            .min_w_0()
            .gap(px(2.))
            .child(caption(title, c))
            .child(
                div()
                    .text_size(px(20.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(value),
            )
    };
    h_flex()
        .gap(px(16.))
        .child(stat("Requests", grouped(total.requests)))
        .child(stat(
            "Tokens",
            human::compact(slopmax_app::history::tokens(total)),
        ))
        .child(stat("API value", priced(total.cost, total)))
        .child(stat("Saved by failover", grouped(today.rescued)))
}

/// Requests in each hour of the day: a slim column each, the hours to come
/// left as stubs.
fn hours(today: &History, c: &Colors) -> Div {
    let most = today
        .buckets
        .iter()
        .map(|b| b.requests)
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let columns = h_flex()
        .h(px(44.))
        .items_end()
        .gap(px(3.))
        .children((0..24).map(|hour| {
            let requests = today.buckets.get(hour).map_or(0, |b| b.requests);
            let column = div().flex_1().rounded(px(2.));
            if requests > 0 {
                column
                    .h(relative(requests as f32 / most))
                    .min_h(px(3.))
                    .bg(c.accent.opacity(0.8))
            } else {
                column.h(px(3.)).bg(c.track)
            }
        }));
    v_flex().gap(px(4.)).child(columns).child(
        h_flex()
            .justify_between()
            .child(caption("00:00", c))
            .child(caption("12:00", c))
            .child(caption("23:00", c)),
    )
}
