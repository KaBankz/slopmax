//! The Overview page, where the window opens: how the accounts stand, as a
//! ring beside today's work by the hour; today's totals; each
//! subscription's pool, as a card that leads to its accounts; and what
//! wants a look, only when something does.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::Button;
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
use crate::theme::Colors;
use crate::ui::{self, caption, card, card_header, figure, icon, icon_tile, pill, ring, stat};
use crate::usage::{grouped, priced};
use crate::{Main, Section};

impl Main {
    pub(crate) fn overview(&self, c: &Colors, now: Timestamp, cx: &mut Context<Self>) -> Div {
        let Some(report) = &self.snapshot.report else {
            return v_flex().child(ui::empty(
                IconName::Server,
                "Looking for the proxy…",
                "slopmax shows your accounts as soon as it answers.",
                c,
            ));
        };
        let status = view::status(report, now);
        let groups = view::groups(report, now);
        let attention = view::attention(report, now);
        let pools: Vec<&Group> = groups.iter().filter(|g| !g.overview.is_empty()).collect();
        v_flex()
            .gap(px(20.))
            .child(self.hero(&status, &groups, c))
            .child(self.totals(c))
            .when(!pools.is_empty(), |page| {
                page.child(
                    ui::section("Pools", c).child(
                        h_flex().flex_wrap().items_start().gap(px(16.)).children(
                            pools
                                .into_iter()
                                .map(|group| pool_card(group, c, cx))
                                .collect::<Vec<_>>(),
                        ),
                    ),
                )
            })
            .when(!attention.is_empty(), |page| {
                page.child(self.needs(&attention, c, cx))
            })
    }

    /// How the accounts stand: the share ready as a ring, the headline and
    /// what keeps the rest, and today's requests by the hour.
    fn hero(&self, status: &Status, groups: &[Group], c: &Colors) -> impl IntoElement {
        let working: Vec<_> = groups
            .iter()
            .flat_map(|group| &group.accounts)
            .filter(|row| !row.disabled)
            .collect();
        let count = |tone: Tone| working.iter().filter(|row| row.status.tone == tone).count();
        let (ready, limited, failing) = (count(Tone::Good), count(Tone::Warn), count(Tone::Bad));
        let off = groups
            .iter()
            .flat_map(|group| &group.accounts)
            .filter(|row| row.disabled)
            .count();
        let color = match status.tone {
            Tone::Good => c.good,
            Tone::Bad => c.bad,
            _ => c.warn,
        };
        let fraction = ready as f32 / working.len().max(1) as f32;
        let proxy = view::proxy_line(&self.snapshot);
        let chips = h_flex()
            .flex_wrap()
            .gap(px(6.))
            .when(ready > 0, |chips| {
                chips.child(pill(format!("{ready} ready"), c.good, c))
            })
            .when(limited > 0, |chips| {
                chips.child(pill(format!("{limited} limited"), c.warn, c))
            })
            .when(failing > 0, |chips| {
                chips.child(pill(format!("{failing} need you"), c.bad, c))
            })
            .when(off > 0, |chips| {
                chips.child(pill(format!("{off} off"), c.muted, c))
            });
        card(c)
            .flex_row()
            .flex_wrap()
            .items_center()
            .p(px(24.))
            .gap(px(28.))
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .size(px(112.))
                    .child(ring(fraction, color, 11., c))
                    .child(
                        v_flex()
                            .absolute()
                            .inset_0()
                            .items_center()
                            .justify_center()
                            .child(figure(format!("{ready}/{}", working.len()), 26., c))
                            .child(caption("ready", c)),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(240.))
                    .gap(px(8.))
                    .child(
                        div()
                            .font_family(crate::theme::DISPLAY)
                            .text_size(px(22.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.fg)
                            .child(status.headline.clone()),
                    )
                    .child(caption(
                        match &status.detail {
                            Some(detail) => format!("{detail} · {proxy}"),
                            None => proxy,
                        },
                        c,
                    ))
                    .child(chips),
            )
            .children(self.snapshot.today.as_ref().map(|today| hours(today, c)))
    }

    /// Today's requests, tokens, value, and failover saves.
    fn totals(&self, c: &Colors) -> impl IntoElement {
        let tile = |content: Div| card(c).flex_1().min_w(px(190.)).p(px(18.)).child(content);
        let row = h_flex().flex_wrap().gap(px(16.));
        let Some(today) = self.snapshot.today.as_ref() else {
            return row.child(tile(caption("Reading today's ledger…", c)));
        };
        let total = &today.total;
        row.child(tile(stat(
            IconName::Hash,
            c.accent,
            "Requests today",
            grouped(total.requests),
            match total.failed {
                0 => "none failed".to_owned(),
                n => format!("{} failed", grouped(n)),
            },
            c,
        )))
        .child(tile(stat(
            IconName::Layers,
            c.violet,
            "Tokens",
            human::compact(slopmax_app::history::tokens(total)),
            today.cached.map_or_else(
                || "no cache reads".to_owned(),
                |r| format!("{:.0}% from cache", r * 100.),
            ),
            c,
        )))
        .child(tile(stat(
            IconName::Coins,
            c.info,
            "API value",
            priced(total.cost, total),
            "what the API would charge",
            c,
        )))
        .child(tile(stat(
            IconName::Zap,
            c.warn,
            "Saved by failover",
            grouped(today.rescued),
            "taken by another account",
            c,
        )))
    }

    /// What wants a look, each with what to do about it.
    fn needs(&self, items: &[Attention], c: &Colors, cx: &mut Context<Self>) -> impl IntoElement {
        let mut list = v_flex();
        for (i, item) in items.iter().enumerate() {
            let name = match item.tone {
                Tone::Bad => IconName::OctagonX,
                _ => IconName::TriangleAlert,
            };
            let (remedy, provider, account) = (item.remedy, item.provider, item.account.clone());
            let (title, action_icon) = match remedy {
                Remedy::SignIn => ("Sign in…", IconName::LogIn),
                Remedy::Redeem => ("Redeem…", IconName::RotateCcw),
                Remedy::Look => ("Show", IconName::ArrowUpRight),
            };
            list = list.child(
                h_flex()
                    .py(px(12.))
                    .gap(px(12.))
                    .when(i > 0, |row| row.border_t_1().border_color(c.separator))
                    .child(icon_tile(name, c.tone(item.tone), 30., c))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(13.))
                            .text_color(c.fg)
                            .child(item.text.clone()),
                    )
                    .child(
                        Button::new(SharedString::from(format!("remedy-{i}")))
                            .label(title)
                            .icon(action_icon)
                            .outline()
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
        card(c)
            .gap(px(6.))
            .child(card_header("Needs attention", c).child(pill(
                items.len().to_string(),
                c.warn,
                c,
            )))
            .child(list)
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
    let color = c.provider(provider);
    let hover = color.opacity(0.5);
    card(c)
        .id(SharedString::from(format!("pool-{provider}")))
        .flex_1()
        .min_w(px(320.))
        .gap(px(18.))
        .cursor_pointer()
        .hover(move |card| card.border_color(hover))
        .role(Role::Button)
        .aria_label(format!("{} accounts", group.title))
        .on_click(cx.listener(move |main, _, _, cx| main.go(Section::Provider(provider), cx)))
        .child(
            h_flex()
                .gap(px(10.))
                .child(provider_mark(provider, c))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(ui::HEADING + 1.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(group.title),
                )
                .child(pill(
                    format!("{ready} of {enabled} ready"),
                    if ready == enabled { c.good } else { c.warn },
                    c,
                ))
                .child(icon(IconName::ChevronRight, 16., c.faint)),
        )
        .children(group.overview.iter().map(|o| window(o, provider, c)))
        .children(group.credits.as_deref().map(|credits| {
            h_flex()
                .gap(px(8.))
                .pt(px(14.))
                .border_t_1()
                .border_color(c.separator)
                .text_size(px(ui::SMALL))
                .text_color(c.muted)
                .child(icon(IconName::RotateCcw, 14., c.accent))
                .child(credits.to_owned())
        }))
}

/// A provider's color as a tile with its initial, as its pages lead with.
pub(crate) fn provider_mark(provider: ProviderId, c: &Colors) -> Div {
    let color = c.provider(provider);
    div()
        .flex_shrink_0()
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .bg(linear_gradient(
            135.,
            linear_color_stop(color, 0.),
            linear_color_stop(color.opacity(0.7), 1.),
        ))
        .text_size(px(13.))
        .font_weight(FontWeight::BOLD)
        .text_color(white())
        .child(
            provider
                .spec()
                .title
                .chars()
                .next()
                .map(String::from)
                .unwrap_or_default(),
        )
}

/// One window across a pool: its title and use, a segment per account,
/// and when it resets.
fn window(overview: &Overview, provider: ProviderId, c: &Colors) -> Div {
    v_flex()
        .gap(px(8.))
        .child(
            h_flex()
                .items_end()
                .gap(px(6.))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(12.5))
                        .text_color(c.muted)
                        .child(overview.title.clone()),
                )
                .child(figure(overview.gauge.percent.clone(), 17., c))
                .child(caption("used", c).pb(px(1.))),
        )
        .child(segments(&overview.shares, provider, c))
        .child(resets(&overview.gauge, c))
}

/// Today's requests by the hour, the hours to come left as stubs, beside
/// their total.
fn hours(today: &History, c: &Colors) -> impl IntoElement {
    let most = today
        .buckets
        .iter()
        .map(|b| b.requests)
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let brand = c.brand(180.);
    let columns = h_flex()
        .h(px(64.))
        .items_end()
        .gap(px(3.))
        .children((0..24).map(|hour| {
            let requests = today.buckets.get(hour).map_or(0, |b| b.requests);
            let column = div().flex_1().rounded(px(3.));
            if requests > 0 {
                column
                    .h(relative(requests as f32 / most))
                    .min_h(px(4.))
                    .bg(brand)
            } else {
                column.h(px(4.)).bg(c.track)
            }
        }));
    v_flex()
        .flex_1()
        .min_w(px(260.))
        .max_w(px(420.))
        .gap(px(10.))
        .child(
            h_flex()
                .items_end()
                .gap(px(8.))
                .child(caption("Today by the hour", c).flex_1())
                .child(figure(grouped(today.total.requests), 17., c))
                .child(caption("requests", c).pb(px(1.))),
        )
        .child(columns)
        .child(
            h_flex()
                .justify_between()
                .child(caption("00:00", c).text_size(px(ui::TINY)))
                .child(caption("12:00", c).text_size(px(ui::TINY)))
                .child(caption("23:00", c).text_size(px(ui::TINY))),
        )
}
