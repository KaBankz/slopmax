//! The Usage and Performance pages, over the range the toolbar picks.
//! Usage charts what went through slopmax: tokens by provider as areas,
//! requests as columns and their API value as a line, the models as a ring
//! and the token mix as one bar, which agents sent the work, when the work
//! happens, and the accounts ranked. Performance charts how well it went:
//! what failover saved and what failed, how much came from cache and what
//! that saved, how fast each model writes, and how soon answers began.

use std::collections::HashMap;

use gpui_kit::component::chart::{AreaChart, LineChart, PieChart};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::{self, Bucket, History, Range, Share};
use slopmax_core::human;
use slopmax_core::provider::ProviderId;
use slopmax_core::summary::Totals;

use crate::Main;
use crate::theme::Colors;
use crate::ui::{caption, dot, gauge as bar};

/// macOS's own colors, which tell series apart in light and dark alike:
/// blue, purple, pink, cyan, yellow. Orange and green are left out, as
/// Claude's and ChatGPT's everywhere on the page.
const PALETTE: [u32; 5] = [0x0a84ff, 0xbf5af2, 0xff375f, 0x64d2ff, 0xffd60a];
/// The width left of a column chart for its counts.
const GUTTER: f32 = 32.;
/// The models the ring names; the rest share a slice.
const MODELS: usize = 5;
/// The models whose speed is drawn.
const SPEEDS: usize = 6;
const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

impl Main {
    /// The Usage page, or with `performance` the Performance page, once the
    /// ledger is read for the range.
    pub(crate) fn usage(&self, c: &Colors, performance: bool) -> Div {
        match self
            .snapshot
            .history
            .as_ref()
            .filter(|h| h.range == self.range)
        {
            None => v_flex().child(caption("Reading the ledger…", c)),
            Some(history) if history.total.requests == 0 && history.total.failed == 0 => v_flex()
                .p(px(32.))
                .rounded(px(14.))
                .bg(c.surface)
                .border_1()
                .border_color(c.border)
                .items_center()
                .child(div().text_color(c.muted).child(match history.range {
                    Range::Today => "Nothing has gone through slopmax today.",
                    _ => "Nothing has gone through slopmax in this range.",
                })),
            Some(history) if performance => self::performance(history, c),
            Some(history) => page(history, c),
        }
    }
}

/// Every label for a few hours or a week; fewer for a month.
fn margin(history: &History) -> usize {
    match history.range {
        Range::Today => 3,
        Range::Week => 1,
        Range::Month => 5,
    }
}

fn pair(left: Div, right: Div) -> Div {
    h_flex()
        .items_stretch()
        .gap(px(16.))
        .child(left)
        .child(right)
}

fn page(history: &History, c: &Colors) -> Div {
    let margin = margin(history);
    let total = &history.total;
    let legend = history
        .providers
        .iter()
        .map(|p| (c.provider(*p), p.spec().title.into()))
        .collect();
    v_flex()
        .gap(px(16.))
        .child(tiles(
            [
                (
                    "Tokens",
                    human::compact(history::tokens(total)),
                    history
                        .cached
                        .map_or_else(String::new, |r| format!("{:.0}% from cache", r * 100.)),
                ),
                (
                    "Requests",
                    grouped(total.requests),
                    match history.sessions {
                        0 => "answered".to_owned(),
                        n => format!("in {}", count(n, "conversation")),
                    },
                ),
                (
                    "API value",
                    priced(total.cost, total),
                    match total.unpriced {
                        0 => "at API prices".to_owned(),
                        n => format!("{} unpriced", count(n, "request")),
                    },
                ),
                (
                    "A month at this pace",
                    history.monthly.map_or_else(|| "—".to_owned(), dollars),
                    match history.range {
                        Range::Week => "at API prices".to_owned(),
                        _ => "from a week's use".to_owned(),
                    },
                ),
            ],
            c,
        ))
        .child(
            card(c)
                .child(header("Tokens", legend, c))
                .child(div().h(px(210.)).child(tokens(history, margin, c))),
        )
        .child(pair(
            card(c)
                .child(header("Requests", Vec::new(), c))
                .child(requests(history, margin, c)),
            card(c)
                .child(header("API value", Vec::new(), c))
                .child(div().h(px(150.)).child(cost(history, margin))),
        ))
        .child(pair(models(history, c), mix(history, c)))
        .child(agents(history, c))
        .when(history.range != Range::Today, |page| {
            page.child(activity(history, c))
        })
        .child(accounts(history, c))
}

fn performance(history: &History, c: &Colors) -> Div {
    let margin = margin(history);
    let total = &history.total;
    let answered = total.requests as f64 / (total.requests + total.failed).max(1) as f64 * 100.;
    v_flex()
        .gap(px(16.))
        .child(tiles(
            [
                (
                    "Answered",
                    format!("{answered:.1}%"),
                    match total.failed {
                        0 => "none failed".to_owned(),
                        n => format!("{} failed", grouped(n)),
                    },
                ),
                (
                    "Saved by failover",
                    grouped(history.rescued),
                    "requests another account took".to_owned(),
                ),
                (
                    "From cache",
                    history
                        .cached
                        .map_or_else(|| "—".to_owned(), |r| format!("{:.0}%", r * 100.)),
                    format!("saving {}", priced(history.cache_saved, total)),
                ),
                (
                    "First byte",
                    history
                        .first_byte
                        .map_or_else(|| "—".to_owned(), |ms| format!("{:.1}s", ms as f64 / 1e3)),
                    "the median wait".to_owned(),
                ),
            ],
            c,
        ))
        .child(pair(
            reliability(history, margin, c),
            cache(history, margin, c),
        ))
        .child(pair(
            speed(history, c),
            card(c)
                .child(header(
                    "Time to first byte",
                    vec![(c.accent, "Median".into()), (c.warn, "Slowest 5%".into())],
                    c,
                ))
                .child(div().h(px(150.)).child(first_byte(history, margin, c))),
        ))
}

/// Totals side by side: each a title, a value, and a note.
fn tiles<const N: usize>(tiles: [(&str, String, String); N], c: &Colors) -> Div {
    h_flex()
        .items_stretch()
        .rounded(px(14.))
        .bg(c.surface)
        .border_1()
        .border_color(c.border)
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
                        .child(caption(&note, c).truncate())
                }),
        )
}

/// Tokens over the range, an area per provider.
fn tokens(history: &History, margin: usize, c: &Colors) -> AreaChart<Bucket, SharedString, f64> {
    let chart = AreaChart::new(history.buckets.clone())
        .id("tokens")
        .x(|b: &Bucket| SharedString::from(b.label.clone()));
    let most = history
        .buckets
        .iter()
        .flat_map(|b| b.tokens.iter().copied())
        .max()
        .unwrap_or(0);
    let (top, ticks) = axis(most as f64, 1.);
    let mut chart = if smooth(history) {
        chart.natural()
    } else {
        chart.linear()
    }
    .y_domain(0., top)
    .y_padding(0., 0.)
    .tick_margin(margin)
    .grid_dashed(true)
    .y_axis(true)
    .y_tick_count(ticks)
    .y_tick_format(|v| human::compact(v.round() as u64).replace(".0", ""))
    .tooltip_value(|_, _, v| human::compact(v.max(0.) as u64).into());
    for (i, &provider) in history.providers.iter().enumerate() {
        let color = c.provider(provider);
        chart = chart
            .y(move |b: &Bucket| b.tokens[i] as f64)
            .stroke(color)
            .fill(fade(color))
            .name(provider.spec().title);
    }
    chart
}

/// Requests over the range, a column each hour or day.
fn requests(history: &History, margin: usize, c: &Colors) -> Div {
    let fill = c.accent;
    columns(
        "requests",
        history,
        |b| vec![(b.requests, fill)],
        |b| format!("{} · {}", b.label, count(b.requests, "request")),
        132.,
        margin,
        c,
    )
}

/// What the requests would have cost on the API, a point each hour or day.
fn cost(history: &History, margin: usize) -> LineChart<Bucket, SharedString, f64> {
    let most = history.buckets.iter().map(|b| b.cost).fold(0., f64::max);
    let (top, ticks) = axis(most, 0.01);
    // Cents only where the steps need them.
    let cents = if places(top / (ticks - 1) as f64) == 0 {
        0
    } else {
        2
    };
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
    .y_domain(0., top)
    .y_padding(0., 0.)
    .tick_margin(margin)
    .grid_dashed(true)
    .y_axis(true)
    .y_tick_count(ticks)
    .y_tick_format(move |v| format!("${v:.cents$}"))
    .tooltip_value(|_, v| format!("${v:.2}").into())
}

/// Days curve smoothly; hours, which climb from nothing overnight, keep to
/// straight lines, where a smooth curve would dip below zero first.
fn smooth(history: &History) -> bool {
    history.range != Range::Today
}

/// Counts over the range as columns `height` tall, one an hour or a day,
/// each stacked from the bottom with its `parts`, on a grid of round counts
/// as the charts draw theirs. Hovering a column shows its `tip`.
fn columns(
    id: &'static str,
    history: &History,
    parts: impl Fn(&Bucket) -> Vec<(u64, Hsla)>,
    tip: impl Fn(&Bucket) -> String,
    height: f32,
    margin: usize,
    c: &Colors,
) -> Div {
    let stacks: Vec<Vec<(u64, Hsla)>> = history.buckets.iter().map(parts).collect();
    let most = stacks
        .iter()
        .map(|stack| stack.iter().map(|(n, _)| n).sum::<u64>())
        .max()
        .unwrap_or(0);
    let (top, ticks) = axis(most as f64, 1.);
    let rows: Vec<f64> = (0..ticks)
        .map(|i| top * i as f64 / (ticks - 1) as f64)
        .collect();
    let y = |value: f64| px(height * (1. - (value / top) as f32));
    let hover = c.track.opacity(0.5);
    let plot = div()
        .relative()
        .flex_1()
        .h(px(height))
        .children(rows.iter().map(|&value| {
            let line = div()
                .absolute()
                .left_0()
                .right_0()
                .top(y(value))
                .border_t_1()
                .border_color(c.separator);
            // The baseline solid, the rest dashed.
            if value > 0. {
                line.border_dashed()
            } else {
                line
            }
        }))
        .child(
            h_flex().absolute().inset_0().items_end().children(
                history
                    .buckets
                    .iter()
                    .zip(stacks)
                    .enumerate()
                    .map(|(i, (bucket, stack))| {
                        let tip = SharedString::from(tip(bucket));
                        v_flex()
                            .id((id, i))
                            .flex_1()
                            .h_full()
                            .items_center()
                            .justify_end()
                            .rounded(px(3.))
                            .hover(move |column| column.bg(hover))
                            .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                            .child(
                                // A slim column, centered in its hour or day
                                // and clear of its neighbors.
                                v_flex()
                                    .w(relative(0.6))
                                    .max_w(px(16.))
                                    .gap(px(1.))
                                    .children(stack.into_iter().rev().filter(|(n, _)| *n > 0).map(
                                        |(n, color)| {
                                            div()
                                                .h(px(height * (n as f64 / top) as f32))
                                                .min_h(px(2.))
                                                .rounded(px(2.))
                                                .bg(color)
                                        },
                                    )),
                            )
                    }),
            ),
        );
    let counts = div()
        .relative()
        .w(px(GUTTER))
        .flex_shrink_0()
        .h(px(height))
        .text_size(px(10.))
        .text_color(c.muted)
        .children(rows.iter().map(|&value| {
            div()
                .absolute()
                .right(px(6.))
                .top(y(value) - px(7.))
                .child(grouped(value.round() as u64))
        }));
    let names = h_flex()
        .h(px(18.))
        .pl(px(GUTTER))
        .text_size(px(10.))
        .text_color(c.muted)
        .children(history.buckets.iter().enumerate().map(|(i, b)| {
            // The hours or days the charts label too.
            h_flex()
                .flex_1()
                .justify_center()
                .when((i + 1) % margin == 0, |cell| {
                    cell.child(
                        div()
                            .flex_shrink_0()
                            .whitespace_nowrap()
                            .child(b.label.clone()),
                    )
                })
        }));
    v_flex()
        .child(h_flex().items_start().child(counts).child(plot))
        .child(names)
}

/// A round top for a value axis from zero to `most` or past it, and how many
/// ticks reach it: three to five even steps of 1, 2, 2.5, or 5 times a
/// power of ten, whichever ends lowest, and none finer than `finest`. Steps
/// of whole counts stay whole.
fn axis(most: f64, finest: f64) -> (f64, usize) {
    [3, 4, 5]
        .into_iter()
        .map(|steps| {
            let least = (most / steps as f64).max(finest);
            let power = 10f64.powi(least.log10().floor() as i32);
            let step = [1., 2., 2.5, 5.]
                .into_iter()
                .map(|m| m * power)
                .find(|&step| step >= least * (1. - 1e-9) && (finest < 1. || step.fract() == 0.))
                .unwrap_or(10. * power);
            (step * steps as f64, steps + 1)
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .unwrap_or((1., 2))
}

/// The decimal places that tell ticks `step` apart: none for whole steps.
fn places(step: f64) -> usize {
    (0..2)
        .find(|&p| {
            let scaled = step * 10f64.powi(p as i32);
            (scaled - scaled.round()).abs() < 1e-6
        })
        .unwrap_or(2)
}

/// What failover saved and what failed, each hour or day: the saved below,
/// the failed above. The tiles above give their totals.
fn reliability(history: &History, margin: usize, c: &Colors) -> Div {
    let (good, bad) = (c.good, c.bad);
    card(c)
        .child(header(
            "Reliability",
            vec![(good, "Saved by failover".into()), (bad, "Failed".into())],
            c,
        ))
        .child(columns(
            "reliability",
            history,
            |b| vec![(b.rescued, good), (b.failed, bad)],
            |b| {
                format!(
                    "{} · {} saved by failover · {} failed",
                    b.label,
                    grouped(b.rescued),
                    grouped(b.failed)
                )
            },
            132.,
            margin,
            c,
        ))
}

type Share100 = (SharedString, f64);

/// How much input came from cache each hour or day, and what that saved.
fn cache(history: &History, margin: usize, c: &Colors) -> Div {
    let color: Hsla = rgb(PALETTE[3]).into();
    let rates: Vec<Share100> = history
        .buckets
        .iter()
        .filter_map(|b| Some((b.label.clone().into(), f64::from(b.cached?) * 100.)))
        .collect();
    let chart = AreaChart::new(rates)
        .id("cache")
        .x(|r: &Share100| r.0.clone())
        .y(|r: &Share100| r.1)
        .stroke(color)
        .fill(fade(color))
        .name("From cache");
    let chart = if smooth(history) {
        chart.natural()
    } else {
        chart.linear()
    }
    .y_domain(0., 100.)
    .y_padding(0., 0.)
    .tick_margin(margin)
    .grid_dashed(true)
    .y_axis(true)
    .y_tick_count(3)
    .y_tick_format(|v| format!("{v:.0}%"))
    .tooltip_value(|_, _, v| format!("{v:.0}%").into());
    card(c)
        .child(header("Input from cache", Vec::new(), c))
        .child(div().h(px(150.)).child(chart))
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
    let slowest = waits.iter().map(|w| w.2).fold(0., f64::max);
    let (top, ticks) = axis(slowest, 0.1);
    let places = places(top / (ticks - 1) as f64);
    AreaChart::new(waits)
        .id("first-byte")
        .x(|w: &Wait| w.0.clone())
        .y(|w: &Wait| w.1)
        .stroke(c.accent)
        .fill(fade(c.accent))
        .name("Median")
        .y(|w: &Wait| w.2)
        .stroke(c.warn)
        .fill(transparent_black())
        .name("Slowest 5%")
        .natural()
        .y_domain(0., top)
        .y_padding(0., 0.)
        .tick_margin(margin)
        .grid_dashed(true)
        .y_axis(true)
        .y_tick_count(ticks)
        .y_tick_format(move |v| format!("{v:.places$}s"))
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
    let named = &history.models[..history.models.len().min(MODELS)];
    let colors = model_colors(named.iter().map(|share| share.name.as_str()));
    let mut slices: Vec<Slice> = named
        .iter()
        .map(|share| Slice {
            name: share.name.clone().into(),
            tokens: history::tokens(&share.totals),
            color: rgb(colors[share.name.as_str()]).into(),
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

/// Each model's color: the one its name picks, so that it keeps it from
/// range to range, or the next free when another model picked it too.
fn model_colors<'a>(names: impl Iterator<Item = &'a str>) -> HashMap<&'a str, u32> {
    // Picked in the names' order, which no range changes.
    let mut names: Vec<&str> = names.collect();
    names.sort_unstable();
    let mut taken = [false; PALETTE.len()];
    let mut colors = HashMap::new();
    for name in names {
        // FNV-1a.
        let hash = name.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        let first = (hash % PALETTE.len() as u64) as usize;
        let i = (first..first + PALETTE.len())
            .map(|i| i % PALETTE.len())
            .find(|&i| !taken[i])
            .unwrap_or(first);
        taken[i] = true;
        colors.insert(name, PALETTE[i]);
    }
    colors
}

/// What the tokens were: input, cache read, cache write, and output, as one
/// bar and a legend.
fn mix(history: &History, c: &Colors) -> Div {
    let total = &history.total;
    let parts = [
        ("Input", total.input, PALETTE[0]),
        ("Cache read", total.cache_read, PALETTE[3]),
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

/// How fast each model writes once it has begun, fastest first.
fn speed(history: &History, c: &Colors) -> Div {
    let fastest = history
        .speeds
        .first()
        .map_or(1., |s| s.tokens_per_second)
        .max(1.);
    card(c)
        .child(header("Output speed", Vec::new(), c))
        .when(history.speeds.is_empty(), |card| {
            card.child(caption("No answers long enough to time yet.", c))
        })
        .children(history.speeds.iter().take(SPEEDS).map(|s| {
            let color = c.provider(s.provider);
            h_flex()
                .gap(px(12.))
                .child(
                    div()
                        .w(px(150.))
                        .flex_shrink_0()
                        .truncate()
                        .child(s.model.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .child(bar((s.tokens_per_second / fastest) as f32, color, c)),
                )
                .child(
                    div()
                        .w(px(72.))
                        .flex()
                        .justify_end()
                        .child(format!("{:.0} tok/s", s.tokens_per_second)),
                )
        }))
}

/// Which agents sent the work, by tokens.
fn agents(history: &History, c: &Colors) -> Div {
    let most = history
        .agents
        .iter()
        .map(|a| history::tokens(&a.totals))
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    card(c)
        .child(header("Agents", Vec::new(), c))
        .children(history.agents.iter().map(|part| {
            let color = agent_color(part.name, c);
            let tokens = history::tokens(&part.totals);
            h_flex()
                .gap(px(12.))
                .child(
                    h_flex()
                        .w(px(110.))
                        .flex_shrink_0()
                        .gap(px(8.))
                        .child(dot(color))
                        .child(part.name),
                )
                .child(div().flex_1().child(bar(tokens as f32 / most, color, c)))
                .child(
                    div()
                        .w(px(56.))
                        .flex()
                        .justify_end()
                        .child(human::compact(tokens)),
                )
                .child(
                    div()
                        .w(px(84.))
                        .flex()
                        .justify_end()
                        .text_color(c.muted)
                        .child(format!("{} req", grouped(part.totals.requests))),
                )
        }))
}

/// When the work happens: answers by weekday and hour, the busier the
/// stronger.
fn activity(history: &History, c: &Colors) -> Div {
    let most = history
        .activity
        .iter()
        .flatten()
        .copied()
        .max()
        .unwrap_or(0);
    let busiest = (0..7)
        .flat_map(|day| (0..24).map(move |hour| (day, hour)))
        .max_by_key(|&(day, hour)| history.activity[day][hour])
        .filter(|_| most > 0);
    let shade = |n: u64| {
        if n == 0 {
            c.track
        } else {
            c.accent
                .opacity(0.18 + 0.82 * n as f32 / most.max(1) as f32)
        }
    };
    let legend = h_flex()
        .gap(px(4.))
        .text_size(px(11.))
        .text_color(c.muted)
        .child("Less")
        .children([0.18, 0.45, 0.72, 1.].map(|strength| {
            div()
                .size(px(10.))
                .rounded(px(2.))
                .bg(c.accent.opacity(strength))
        }))
        .child("More");
    card(c)
        .child(
            header("When you work", Vec::new(), c)
                .children(busiest.map(|(day, hour)| {
                    caption(format!("Busiest: {} {hour:02}:00", WEEKDAYS[day]), c)
                }))
                .child(legend),
        )
        .child(
            v_flex()
                .gap(px(3.))
                .children(WEEKDAYS.iter().zip(&history.activity).map(|(day, hours)| {
                    h_flex()
                        .gap(px(3.))
                        .child(caption(day, c).w(px(32.)).flex_shrink_0())
                        .children(
                            hours
                                .iter()
                                .map(|&n| div().flex_1().h(px(16.)).rounded(px(3.)).bg(shade(n))),
                        )
                })),
        )
        .child(
            h_flex()
                .gap(px(3.))
                .child(div().w(px(32.)).flex_shrink_0())
                .children((0..24).map(|hour| {
                    caption(
                        &if hour % 6 == 0 {
                            format!("{hour:02}")
                        } else {
                            String::new()
                        },
                        c,
                    )
                    .flex_1()
                })),
        )
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
    let numbers = |cells: [String; 4]| {
        h_flex().flex_shrink_0().gap(px(16.)).children(
            cells
                .into_iter()
                .zip([64., 72., 56., 76.])
                .map(|(cell, width)| div().w(px(width)).flex().justify_end().child(cell)),
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
                ["Tokens", "Requests", "Failed", "API value"].map(str::to_owned),
            )),
    );
    for share in &history.accounts {
        let tokens = history::tokens(&share.totals);
        let failed = match share.totals.failed {
            0 => "—".to_owned(),
            n => grouped(n),
        };
        list = list.child(account(share, tokens as f32 / most, c).child(numbers([
            human::compact(tokens),
            grouped(share.totals.requests),
            failed,
            priced(share.totals.cost, &share.totals),
        ])));
    }
    list
}

fn account(share: &Share, fraction: f32, c: &Colors) -> Div {
    let color = c.provider(share.provider);
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

/// A card of the page, sharing its row with another.
fn card(c: &Colors) -> Div {
    crate::ui::card(c).flex_1()
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

/// An area's fill: its color, fading to nothing at the bottom.
fn fade(color: Hsla) -> Background {
    linear_gradient(
        180.,
        linear_color_stop(color.opacity(0.35), 0.),
        linear_color_stop(color.opacity(0.), 1.),
    )
}

/// An agent's color: its maker's, as for providers.
fn agent_color(agent: &str, c: &Colors) -> Hsla {
    match agent {
        "Claude Code" => c.provider(ProviderId::Claude),
        "Codex" => c.provider(ProviderId::Codex),
        "Warmups" => c.muted,
        _ => c.accent,
    }
}

/// `12,345`.
pub(crate) fn grouped(n: u64) -> String {
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

/// `1 request`, `1,317 requests`.
fn count(n: u64, noun: &str) -> String {
    match n {
        1 => format!("1 {noun}"),
        n => format!("{} {noun}s", grouped(n)),
    }
}

/// `$412.30`, or `$1,204` from a thousand on.
fn dollars(amount: f64) -> String {
    if amount >= 1_000. {
        format!("${}", grouped(amount.round() as u64))
    } else {
        format!("${amount:.2}")
    }
}

/// An amount at API prices for `totals`' requests: `—` when none had a
/// price, and a trailing `+` when some lacked one.
pub(crate) fn priced(amount: f64, totals: &Totals) -> String {
    match totals.unpriced {
        0 => dollars(amount),
        n if n == totals.requests => "—".to_owned(),
        _ => format!("{}+", dollars(amount)),
    }
}

#[cfg(test)]
mod tests {
    // Not the glob, which brings GPUI's own `test` attribute.
    use super::{PALETTE, axis, model_colors, places};

    #[test]
    fn axes_end_on_round_values() {
        assert_eq!(axis(261., 1.), (300., 4));
        assert_eq!(axis(19_300_000., 1.), (20_000_000., 5));
        assert_eq!(axis(14.2, 0.01), (15., 4));
        assert_eq!(axis(2.4, 0.1), (2.5, 6));
        assert_eq!(axis(300., 1.), (300., 4));
        assert_eq!(axis(9., 1.), (10., 6));
        // Counts step by whole numbers, however few.
        assert_eq!(axis(2., 1.), (3., 4));
        assert_eq!(axis(0., 1.), (3., 4));
    }

    #[test]
    fn a_model_keeps_its_color_whatever_its_rank() {
        let week = model_colors(["opus", "gpt", "sonnet", "fable"].into_iter());
        let today = model_colors(["fable", "sonnet", "opus", "gpt"].into_iter());
        assert_eq!(week, today);
        // No two share one.
        let mut colors: Vec<u32> = week.values().copied().collect();
        colors.sort_unstable();
        colors.dedup();
        assert_eq!(colors.len(), 4);
        assert!(colors.iter().all(|c| PALETTE.contains(c)));
    }

    #[test]
    fn ticks_keep_the_places_their_steps_need() {
        assert_eq!(places(5.), 0);
        assert_eq!(places(0.5), 1);
        assert_eq!(places(0.25), 2);
    }
}
