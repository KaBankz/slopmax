//! The Usage page: what went through slopmax over a range, charted. Tiles
//! for the totals, tokens by provider as areas, requests as bars, how soon
//! answers began as lines, the models as a ring, the token mix as one bar,
//! and the accounts ranked.

use gpui_kit::component::chart::{AreaChart, BarChart, LineChart, PieChart};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::{self, Bucket, History, Range, Share};
use slopmax_core::human;
use slopmax_core::provider::ProviderId;

use crate::{Colors, bar, caption, dot};

/// macOS's own colors, which tell series apart in light and dark alike:
/// blue, purple, orange, green, cyan, pink.
const PALETTE: [u32; 6] = [0x0a84ff, 0xbf5af2, 0xff9f0a, 0x30d158, 0x64d2ff, 0xff375f];
/// The models the ring names; the rest share a slice.
const MODELS: usize = 5;

pub(crate) fn page(history: &History, c: &Colors) -> Div {
    if history.total.requests == 0 {
        return v_flex()
            .p(px(32.))
            .rounded(px(12.))
            .bg(c.group)
            .items_center()
            .child(div().text_color(c.muted).child(match history.range {
                Range::Today => "Nothing has gone through slopmax today.",
                _ => "Nothing has gone through slopmax in this range.",
            }));
    }
    // Every label for a few hours or a week; fewer for a month.
    let margin = match history.range {
        Range::Today => 3,
        Range::Week => 1,
        Range::Month => 5,
    };
    let legend = history
        .providers
        .iter()
        .map(|p| (provider_color(*p, c), p.spec().title.into()))
        .collect();
    v_flex()
        .gap(px(16.))
        .child(tiles(history, c))
        .child(
            card(c)
                .child(header("Tokens", legend, c))
                .child(div().h(px(210.)).child(tokens(history, margin, c))),
        )
        .child(
            h_flex()
                .items_start()
                .gap(px(16.))
                .child(
                    card(c)
                        .child(header("Requests", Vec::new(), c))
                        .child(div().h(px(150.)).child(requests(history, margin, c))),
                )
                .child(
                    card(c)
                        .child(header("API value", Vec::new(), c))
                        .child(div().h(px(150.)).child(cost(history, margin))),
                ),
        )
        .child(
            h_flex()
                .items_stretch()
                .gap(px(16.))
                .child(models(history, c))
                .child(mix(history, c)),
        )
        .child(
            card(c)
                .child(header(
                    "Time to first byte",
                    vec![(c.accent, "Median".into()), (c.warn, "Slowest 5%".into())],
                    c,
                ))
                .child(div().h(px(150.)).child(first_byte(history, margin, c))),
        )
        .child(accounts(history, c))
}

/// The range's totals, side by side.
fn tiles(history: &History, c: &Colors) -> Div {
    let total = &history.total;
    let input = total.input + total.cache_read + total.cache_write;
    let cached = (input > 0).then(|| total.cache_read as f64 / input as f64 * 100.0);
    let tiles = [
        (
            "Tokens",
            human::compact(history::tokens(total)),
            cached.map_or_else(String::new, |c| format!("{c:.0}% read from cache")),
        ),
        (
            "Requests",
            grouped(total.requests),
            match history.total.failed {
                0 => "none failed".to_owned(),
                n => format!("{} failed", grouped(n)),
            },
        ),
        (
            "API value",
            total.cost_label(),
            match total.unpriced {
                0 => "at API prices".to_owned(),
                n => format!("{} requests to unpriced models", grouped(n)),
            },
        ),
        (
            "First byte",
            history.first_byte.map_or_else(|| "—".to_owned(), seconds),
            "median wait".to_owned(),
        ),
    ];
    h_flex()
        .items_stretch()
        .rounded(px(12.))
        .bg(c.group)
        .children(
            tiles
                .into_iter()
                .enumerate()
                .map(|(i, (title, value, note))| {
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .p(px(16.))
                        .gap(px(4.))
                        .when(i > 0, |tile| tile.border_l_1().border_color(c.separator))
                        .child(caption(title, c))
                        .child(
                            div()
                                .text_size(px(24.))
                                .line_height(px(30.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(value),
                        )
                        .child(caption(&note, c))
                }),
        )
}

/// Tokens over the range, an area per provider.
fn tokens(history: &History, margin: usize, c: &Colors) -> AreaChart<Bucket, SharedString, f64> {
    let chart = AreaChart::new(history.buckets.clone())
        .id("tokens")
        .x(|b: &Bucket| SharedString::from(b.label.clone()));
    let mut chart = if smooth(history) {
        chart.natural()
    } else {
        chart.linear()
    }
    .tick_margin(margin)
    .grid_dashed(true)
    .y_axis(true)
    .y_tick_count(4)
    .y_tick_format(|v| human::compact(v.max(0.) as u64))
    .tooltip_value(|_, _, v| human::compact(v.max(0.) as u64).into());
    for (i, &provider) in history.providers.iter().enumerate() {
        let color = provider_color(provider, c);
        chart = chart
            .y(move |b: &Bucket| b.tokens[i] as f64)
            .stroke(color)
            .fill(linear_gradient(
                180.,
                linear_color_stop(color.opacity(0.35), 0.),
                linear_color_stop(color.opacity(0.), 1.),
            ))
            .name(provider.spec().title);
    }
    chart
}

/// Requests over the range, a bar each hour or day.
fn requests(history: &History, margin: usize, c: &Colors) -> BarChart<Bucket, SharedString, f64> {
    let fill = c.accent;
    BarChart::new(history.buckets.clone())
        .id("requests")
        .band(|b: &Bucket| SharedString::from(b.label.clone()))
        .value(|b: &Bucket| b.requests as f64)
        .fill(move |_, _, _, _| fill)
        .corner_radii(px(3.))
        .max_band_width(px(18.))
        .tick_margin(margin)
        .grid_dashed(true)
        .value_axis(true)
        .value_tick_count(4)
        .value_tick_format(|v| grouped(v.max(0.) as u64))
        .tooltip_value(|_, v| grouped(v.max(0.) as u64).into())
}

/// What the requests would have cost on the API, a point each hour or day.
fn cost(history: &History, margin: usize) -> LineChart<Bucket, SharedString, f64> {
    // Cents, where whole dollars would label every tick the same.
    let most = history.buckets.iter().map(|b| b.cost).fold(0., f64::max);
    let places = if most < 10. { 2 } else { 0 };
    let chart = LineChart::new(history.buckets.clone())
        .id("cost")
        .x(|b: &Bucket| SharedString::from(b.label.clone()))
        .y(|b: &Bucket| b.cost)
        .stroke(rgb(PALETTE[1]))
        .name("API value");
    if smooth(history) {
        chart.natural()
    } else {
        chart.linear()
    }
    .dot()
    .tick_margin(margin)
    .grid_dashed(true)
    .y_axis(true)
    .y_tick_count(4)
    .y_tick_format(move |v| format!("${v:.places$}"))
    .tooltip_value(|_, v| format!("${v:.2}").into())
}

/// Days curve smoothly; hours, which climb from nothing overnight, keep to
/// straight lines, where a smooth curve would dip below zero first.
fn smooth(history: &History) -> bool {
    history.range != Range::Today
}

type Wait = (SharedString, f64, f64);

/// How soon answers began, in seconds, over the hours or days that had
/// any: the median shaded, the slowest twentieth a line above it.
fn first_byte(history: &History, margin: usize, c: &Colors) -> AreaChart<Wait, SharedString, f64> {
    let waits: Vec<Wait> = history
        .buckets
        .iter()
        .filter_map(|b| {
            let (median, slow) = b.first_byte?;
            Some((
                b.label.clone().into(),
                median as f64 / 1e3,
                slow as f64 / 1e3,
            ))
        })
        .collect();
    AreaChart::new(waits)
        .id("first-byte")
        .x(|w: &Wait| w.0.clone())
        .y(|w: &Wait| w.1)
        .stroke(c.accent)
        .fill(linear_gradient(
            180.,
            linear_color_stop(c.accent.opacity(0.3), 0.),
            linear_color_stop(c.accent.opacity(0.), 1.),
        ))
        .name("Median")
        .y(|w: &Wait| w.2)
        .stroke(c.warn)
        .fill(transparent_black())
        .name("Slowest 5%")
        .natural()
        .tick_margin(margin)
        .grid_dashed(true)
        .y_axis(true)
        .y_tick_count(4)
        .y_tick_format(|v| format!("{v:.1}s"))
        .tooltip_value(|_, _, v| format!("{v:.2}s").into())
}

#[derive(Clone)]
struct Slice {
    name: SharedString,
    tokens: u64,
    color: Hsla,
}

/// Tokens by model, as a ring beside its legend.
fn models(history: &History, c: &Colors) -> Div {
    let mut slices: Vec<Slice> = history
        .models
        .iter()
        .take(MODELS)
        .zip(PALETTE)
        .map(|(share, color)| Slice {
            name: share.name.clone().into(),
            tokens: history::tokens(&share.totals),
            color: rgb(color).into(),
        })
        .collect();
    let rest: u64 = history
        .models
        .iter()
        .skip(MODELS)
        .map(|s| history::tokens(&s.totals))
        .sum();
    if rest > 0 {
        slices.push(Slice {
            name: "Other".into(),
            tokens: rest,
            color: c.muted,
        });
    }
    let total = slices.iter().map(|s| s.tokens).sum::<u64>().max(1) as f64;
    let ring = PieChart::new(slices.clone())
        .id("models")
        .value(|s: &Slice| s.tokens as f32)
        .color(|s: &Slice| s.color)
        .inner_radius(46.)
        .outer_radius(70.)
        .pad_angle(0.03)
        .tooltip_name(|s: &Slice| s.name.clone())
        .tooltip_value(|s: &Slice, _, share| {
            format!("{} · {share:.0}%", human::compact(s.tokens)).into()
        });
    card(c).child(header("Models", Vec::new(), c)).child(
        h_flex()
            .gap(px(20.))
            .child(div().flex_shrink_0().size(px(150.)).child(ring))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(8.))
                    .children(slices.iter().map(|s| {
                        h_flex()
                            .gap(px(8.))
                            .child(dot(s.color))
                            .child(div().flex_1().min_w_0().truncate().child(s.name.clone()))
                            .child(
                                div()
                                    .text_color(c.muted)
                                    .child(format!("{:.0}%", s.tokens as f64 / total * 100.0)),
                            )
                    })),
            ),
    )
}

/// What the tokens were: input, cache read, cache write, and output, as one
/// bar and a legend.
fn mix(history: &History, c: &Colors) -> Div {
    let total = &history.total;
    let parts = [
        ("Input", total.input, PALETTE[0]),
        ("Cache read", total.cache_read, PALETTE[4]),
        ("Cache write", total.cache_write, PALETTE[1]),
        ("Output", total.output, PALETTE[2]),
    ];
    let sum = history::tokens(total).max(1) as f32;
    let legend = |part: &(&'static str, u64, u32)| {
        let (title, tokens, color) = *part;
        h_flex()
            .flex_1()
            .min_w_0()
            .gap(px(8.))
            .child(dot(rgb(color).into()))
            .child(div().flex_1().child(title))
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .child(human::compact(tokens)),
            )
    };
    card(c)
        .child(header("Token mix", Vec::new(), c))
        .child(
            // Each part takes its share; the smallest still shows.
            h_flex().h(px(12.)).gap(px(2.)).children(
                parts
                    .iter()
                    .filter(|(_, tokens, _)| *tokens > 0)
                    .map(|(_, tokens, color)| {
                        div()
                            .h_full()
                            .flex_basis(relative(*tokens as f32 / sum))
                            .flex_shrink(1.)
                            .min_w(px(3.))
                            .rounded(px(3.))
                            .bg(rgb(*color))
                    }),
            ),
        )
        .child(
            v_flex()
                .gap(px(10.))
                .child(
                    h_flex()
                        .gap(px(24.))
                        .child(legend(&parts[0]))
                        .child(legend(&parts[1])),
                )
                .child(
                    h_flex()
                        .gap(px(24.))
                        .child(legend(&parts[2]))
                        .child(legend(&parts[3])),
                ),
        )
        .child(div().h(px(1.)).bg(c.separator))
        .child({
            // What one request carries, on average: its context, cached or
            // not, and what the model wrote back.
            let requests = total.requests.max(1);
            let context = (total.input + total.cache_read + total.cache_write) / requests;
            h_flex()
                .gap(px(24.))
                .child(stat("Context per request", human::compact(context), c))
                .child(stat(
                    "Output per request",
                    human::compact(total.output / requests),
                    c,
                ))
        })
}

fn stat(title: &str, value: String, c: &Colors) -> Div {
    v_flex()
        .flex_1()
        .gap(px(2.))
        .child(caption(title, c))
        .child(
            div()
                .text_size(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(value),
        )
}

/// The accounts ranked by tokens, each with its share drawn.
fn accounts(history: &History, c: &Colors) -> Div {
    let most = history
        .accounts
        .iter()
        .map(|s| history::tokens(&s.totals))
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let numbers = |tokens: String, requests: String, value: String, c: &Colors| {
        h_flex()
            .flex_shrink_0()
            .gap(px(16.))
            .child(div().w(px(64.)).flex().justify_end().child(tokens))
            .child(div().w(px(72.)).flex().justify_end().child(requests))
            .child(
                div()
                    .w(px(76.))
                    .flex()
                    .justify_end()
                    .text_color(c.fg)
                    .child(value),
            )
    };
    let mut list = card(c).child(header("Accounts", Vec::new(), c)).child(
        h_flex()
            .gap(px(16.))
            .text_size(px(11.))
            .text_color(c.muted)
            .child(div().w(px(240.)).flex_shrink_0().child("Account"))
            .child(div().flex_1().child("Share"))
            .child(numbers(
                "Tokens".into(),
                "Requests".into(),
                "API value".into(),
                c,
            )),
    );
    for share in &history.accounts {
        let tokens = history::tokens(&share.totals);
        list = list.child(account(share, tokens as f32 / most, c).child(numbers(
            human::compact(tokens),
            grouped(share.totals.requests),
            share.totals.cost_label(),
            c,
        )));
    }
    list
}

fn account(share: &Share, fraction: f32, c: &Colors) -> Div {
    let color = provider_color(share.provider, c);
    h_flex()
        .gap(px(16.))
        .py(px(6.))
        .border_t_1()
        .border_color(c.separator)
        .child(
            h_flex()
                .w(px(240.))
                .flex_shrink_0()
                .gap(px(8.))
                .child(dot(color))
                .child(div().min_w_0().truncate().child(share.name.clone())),
        )
        .child(div().flex_1().child(bar(fraction, color, c)))
}

/// A rounded panel on the group fill.
fn card(c: &Colors) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .p(px(16.))
        .gap(px(12.))
        .rounded(px(12.))
        .bg(c.group)
}

/// A chart's title, with its series named on the right.
fn header(title: &str, legend: Vec<(Hsla, SharedString)>, c: &Colors) -> Div {
    h_flex()
        .gap(px(12.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(title.to_owned()),
        )
        .child(div().flex_1())
        .children(legend.into_iter().map(|(color, name)| {
            h_flex()
                .gap(px(5.))
                .text_size(px(11.))
                .text_color(c.muted)
                .child(dot(color))
                .child(name)
        }))
}

/// A provider's color in charts: its brand's.
fn provider_color(provider: ProviderId, c: &Colors) -> Hsla {
    match provider {
        ProviderId::Claude | ProviderId::Anthropic => rgb(0xd97757).into(),
        ProviderId::Codex | ProviderId::OpenAI => rgb(0x10a37f).into(),
        ProviderId::Xai => c.muted,
        _ => c.accent,
    }
}

/// `12,345`.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `1.2s`.
fn seconds(ms: u64) -> String {
    format!("{:.1}s", ms as f64 / 1e3)
}
