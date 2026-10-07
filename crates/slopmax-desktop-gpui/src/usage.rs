//! The Usage and Performance pages, over the range the header picks.
//! Usage charts what went through slopmax: tokens by provider, requests and
//! their API value, the models ranked and the token mix, which agents sent
//! the work, when the work happens, and the accounts ranked. Performance
//! charts how well it went: what failover saved and what failed, how much
//! came from cache, how fast each model writes, and how soon answers began.
//!
//! The charts keep to neutrals. A provider's own color tells providers
//! apart, and red marks what failed; nothing else is colored.

use gpui_kit::component::chart::AreaChart;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::{self, Bucket, History, Range};
use slopmax_core::human;
use slopmax_core::provider::ProviderId;
use slopmax_core::summary::Totals;

use crate::Main;
use crate::theme::{Colors, tabular};
use crate::ui::{self, caption, dot, figure, legend, meter, panel, section, stat, stats, swatch};

/// The width left of a column chart for its counts.
const GUTTER: f32 = 32.;
/// The models ranked by name; the rest share a row.
const MODELS: usize = 5;
/// The models whose speed is drawn.
const SPEEDS: usize = 6;
/// The width of a ranked row's name.
const NAME: f32 = 160.;
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
            None => v_flex().child(ui::empty(
                "Reading the ledger…",
                "Every request slopmax answers is counted here.",
                c,
            )),
            Some(history) if history.total.requests == 0 && history.total.failed == 0 => v_flex()
                .child(ui::empty(
                    match history.range {
                        Range::Today => "Nothing yet today",
                        _ => "Nothing in this range",
                    },
                    "Requests show here once an agent sends them through slopmax.",
                    c,
                )),
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

/// Two sections side by side, one over the other when the window is
/// narrow.
fn pair(left: Div, right: Div) -> Div {
    h_flex()
        .flex_wrap()
        .items_stretch()
        .gap(px(24.))
        .child(left.flex_1().min_w(px(320.)))
        .child(right.flex_1().min_w(px(320.)))
}

/// A panel holding a chart, filling its section's height beside another.
fn chart(content: impl IntoElement, c: &Colors) -> Div {
    panel(c).flex_1().p(px(16.)).child(content)
}

fn page(history: &History, c: &Colors) -> Div {
    let margin = margin(history);
    let total = &history.total;
    let providers = legend(
        history
            .providers
            .iter()
            .map(|p| (c.provider(*p), p.spec().title)),
        c,
    );
    v_flex()
        .gap(px(32.))
        .child(panel(c).child(stats(
            [
                stat(
                    "Tokens",
                    human::compact(history::tokens(total)),
                    history.cached.map_or_else(
                        || "no cache reads".to_owned(),
                        |r| format!("{:.0}% from cache", r * 100.),
                    ),
                    c,
                ),
                stat(
                    "Requests",
                    grouped(total.requests),
                    match history.sessions {
                        0 => "answered".to_owned(),
                        n => format!("in {}", count(n, "conversation")),
                    },
                    c,
                ),
                stat(
                    "API value",
                    priced(total.cost, total),
                    match total.unpriced {
                        0 => "at API prices".to_owned(),
                        n => format!("{} unpriced", count(n, "request")),
                    },
                    c,
                ),
                stat(
                    "A month at this pace",
                    history.monthly.map_or_else(|| "—".to_owned(), dollars),
                    match history.range {
                        Range::Week => "at API prices".to_owned(),
                        _ => "from a week's use".to_owned(),
                    },
                    c,
                ),
            ],
            c,
        )))
        .child(
            section("Tokens", Some(providers.into_any_element()), c).child(chart(
                div().h(px(220.)).child(tokens(history, margin, c)),
                c,
            )),
        )
        .child(pair(
            section("Requests", None, c).child(chart(requests(history, margin, c), c)),
            section("API value", None, c)
                .child(chart(div().h(px(150.)).child(cost(history, margin, c)), c)),
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
        .gap(px(32.))
        .child(
            panel(c).child(stats(
                [
                    stat(
                        "Answered",
                        format!("{answered:.1}%"),
                        match total.failed {
                            0 => "none failed".to_owned(),
                            n => format!("{} failed", grouped(n)),
                        },
                        c,
                    ),
                    stat(
                        "Saved by failover",
                        grouped(history.rescued),
                        "taken by another account",
                        c,
                    ),
                    stat(
                        "From cache",
                        history
                            .cached
                            .map_or_else(|| "—".to_owned(), |r| format!("{:.0}%", r * 100.)),
                        format!("saving {}", priced(history.cache_saved, total)),
                        c,
                    ),
                    stat(
                        "First byte",
                        history.first_byte.map_or_else(
                            || "—".to_owned(),
                            |ms| format!("{:.1}s", ms as f64 / 1e3),
                        ),
                        "the median wait",
                        c,
                    ),
                ],
                c,
            )),
        )
        .child(pair(
            reliability(history, margin, c),
            cache(history, margin, c),
        ))
        .child(pair(
            speed(history, c),
            section(
                "Time to first byte",
                Some(
                    legend([(c.meter, "Median"), (c.series(2), "Slowest 5%")], c)
                        .into_any_element(),
                ),
                c,
            )
            .child(chart(
                div().h(px(150.)).child(first_byte(history, margin, c)),
                c,
            )),
        ))
}

/// Tokens over the range, an area per provider in its color.
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
    .grid_dashed(false)
    .y_axis(true)
    .y_tick_count(ticks)
    .y_tick_format(|v| human::compact(v.round() as u64).replace(".0", ""))
    .tooltip_value(|_, _, v| human::compact(v.max(0.) as u64).into());
    for (i, &provider) in history.providers.iter().enumerate() {
        let color = c.provider(provider);
        chart = chart
            .y(move |b: &Bucket| b.tokens[i] as f64)
            .stroke(color)
            .fill(color.opacity(0.05))
            .name(provider.spec().title);
    }
    chart
}

/// Requests over the range, a column each hour or day.
fn requests(history: &History, margin: usize, c: &Colors) -> Div {
    let fill = c.meter;
    columns(
        "requests",
        history,
        |b| vec![(b.requests, fill.into())],
        |b| format!("{}\n{}", b.label, count(b.requests, "request")),
        132.,
        margin,
        c,
    )
}

/// What the requests would have cost on the API, each hour or day.
fn cost(history: &History, margin: usize, c: &Colors) -> AreaChart<Bucket, SharedString, f64> {
    let most = history.buckets.iter().map(|b| b.cost).fold(0., f64::max);
    let (top, ticks) = axis(most, 0.01);
    // Cents only where the steps need them.
    let cents = if places(top / (ticks - 1) as f64) == 0 {
        0
    } else {
        2
    };
    let chart = AreaChart::new(history.buckets.clone())
        .id("cost")
        .x(|b: &Bucket| SharedString::from(b.label.clone()))
        .y(|b: &Bucket| b.cost)
        .stroke(c.meter)
        .fill(c.meter.opacity(0.06))
        .name("API value");
    if smooth(history) {
        chart.natural()
    } else {
        chart.linear()
    }
    .y_domain(0., top)
    .y_padding(0., 0.)
    .tick_margin(margin)
    .grid_dashed(false)
    .y_axis(true)
    .y_tick_count(ticks)
    .y_tick_format(move |v| format!("${v:.cents$}"))
    .tooltip_value(|_, _, v| format!("${v:.2}").into())
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
    parts: impl Fn(&Bucket) -> Vec<(u64, Background)>,
    tip: impl Fn(&Bucket) -> String,
    height: f32,
    margin: usize,
    c: &Colors,
) -> Div {
    let stacks: Vec<Vec<(u64, Background)>> = history.buckets.iter().map(parts).collect();
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
    let hover = c.hover;
    let plot = div()
        .relative()
        .flex_1()
        .h(px(height))
        .children(rows.iter().map(|&value| {
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(y(value))
                .border_t_1()
                .border_color(c.separator)
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
        .text_size(px(11.))
        .text_color(c.muted)
        .font_features(tabular())
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
        .text_size(px(11.))
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
/// the failed above. The totals above give their sums.
fn reliability(history: &History, margin: usize, c: &Colors) -> Div {
    let (saved, failed) = (c.meter, c.bad);
    section(
        "Reliability",
        Some(legend([(saved, "Saved by failover"), (failed, "Failed")], c).into_any_element()),
        c,
    )
    .child(chart(
        columns(
            "reliability",
            history,
            |b| vec![(b.rescued, saved.into()), (b.failed, failed.into())],
            |b| {
                format!(
                    "{}\n{} saved by failover\n{} failed",
                    b.label,
                    grouped(b.rescued),
                    grouped(b.failed)
                )
            },
            132.,
            margin,
            c,
        ),
        c,
    ))
}

type Share100 = (SharedString, f64);

/// How much input came from cache each hour or day.
fn cache(history: &History, margin: usize, c: &Colors) -> Div {
    let rates: Vec<Share100> = history
        .buckets
        .iter()
        .filter_map(|b| Some((b.label.clone().into(), f64::from(b.cached?) * 100.)))
        .collect();
    let line = AreaChart::new(rates)
        .id("cache")
        .x(|r: &Share100| r.0.clone())
        .y(|r: &Share100| r.1)
        .stroke(c.meter)
        .fill(c.meter.opacity(0.06))
        .name("From cache");
    let line = if smooth(history) {
        line.natural()
    } else {
        line.linear()
    }
    .y_domain(0., 100.)
    .y_padding(0., 0.)
    .tick_margin(margin)
    .grid_dashed(false)
    .y_axis(true)
    .y_tick_count(3)
    .y_tick_format(|v| format!("{v:.0}%"))
    .tooltip_value(|_, _, v| format!("{v:.0}%").into());
    section("Input from cache", None, c).child(chart(div().h(px(150.)).child(line), c))
}

type Wait = (SharedString, f64, f64);

/// How soon answers began, in seconds, over the hours or days that had
/// any: the median shaded, the slowest twentieth a fainter line.
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
        .stroke(c.meter)
        .fill(c.meter.opacity(0.06))
        .name("Median")
        .y(|w: &Wait| w.2)
        .stroke(c.series(2))
        .fill(transparent_black())
        .name("Slowest 5%")
        .natural()
        .y_domain(0., top)
        .y_padding(0., 0.)
        .tick_margin(margin)
        .grid_dashed(false)
        .y_axis(true)
        .y_tick_count(ticks)
        .y_tick_format(move |v| format!("{v:.places$}s"))
        .tooltip_value(|_, _, v| format!("{v:.2}s").into())
}

/// A number at the right of a fixed column, in even figures.
fn cell(text: impl Into<SharedString>, width: f32) -> Div {
    div()
        .w(px(width))
        .flex_shrink_0()
        .flex()
        .justify_end()
        .font_features(tabular())
        .child(text.into())
}

/// A ranked row's name, after a dot of its maker's color if it has one.
fn name(text: impl Into<SharedString>, color: Option<Hsla>) -> Div {
    h_flex()
        .w(px(NAME))
        .flex_shrink_0()
        .gap(px(8.))
        .children(color.map(dot))
        .child(div().min_w_0().truncate().child(text.into()))
}

/// Tokens by model, ranked, the rest as one.
fn models(history: &History, c: &Colors) -> Div {
    let mut ranked: Vec<(String, u64)> = history
        .models
        .iter()
        .take(MODELS)
        .map(|share| (share.name.clone(), history::tokens(&share.totals)))
        .collect();
    let rest: u64 = history
        .models
        .iter()
        .skip(MODELS)
        .map(|s| history::tokens(&s.totals))
        .sum();
    if rest > 0 {
        ranked.push(("Other".to_owned(), rest));
    }
    let total = ranked.iter().map(|(_, n)| n).sum::<u64>().max(1) as f32;
    let most = ranked.iter().map(|(_, n)| *n).max().unwrap_or(0).max(1) as f32;
    section("Models", None, c).child(panel(c).flex_1().p(px(16.)).gap(px(12.)).children(
        ranked.into_iter().map(|(model, tokens)| {
            h_flex()
                .gap(px(12.))
                .child(name(model, None))
                .child(
                    div()
                        .flex_1()
                        .child(meter(tokens as f32 / most, c.meter, c)),
                )
                .child(
                    cell(format!("{:.0}%", tokens as f32 / total * 100.), 40.).text_color(c.muted),
                )
                .child(cell(human::compact(tokens), 56.))
        }),
    ))
}

/// What the tokens were: input, cache read, cache write, and output, as one
/// bar in shades of the text's color, and what one request carries.
fn mix(history: &History, c: &Colors) -> Div {
    let total = &history.total;
    let parts = [
        ("Input", total.input),
        ("Cache read", total.cache_read),
        ("Cache write", total.cache_write),
        ("Output", total.output),
    ];
    let sum = history::tokens(total).max(1) as f32;
    let key = |i: usize| {
        let (title, tokens) = parts[i];
        h_flex()
            .flex_1()
            .min_w_0()
            .gap(px(8.))
            .child(swatch(c.series(i)))
            .child(div().flex_1().text_color(c.muted).child(title))
            .child(div().font_features(tabular()).child(human::compact(tokens)))
    };
    // What one request carries, on average: its context, cached or not,
    // and what the model wrote back.
    let requests = total.requests.max(1);
    let context = (total.input + total.cache_read + total.cache_write) / requests;
    let per = |title: &str, value: u64| {
        v_flex()
            .flex_1()
            .gap(px(4.))
            .child(caption(title, c))
            .child(figure(human::compact(value), ui::HEADING, c))
    };
    section("Token mix", None, c).child(
        panel(c)
            .flex_1()
            .p(px(16.))
            .gap(px(16.))
            .child(
                // Each part takes its share; the smallest still shows.
                h_flex().h(px(8.)).gap(px(2.)).children(
                    parts
                        .iter()
                        .enumerate()
                        .filter(|(_, (_, tokens))| *tokens > 0)
                        .map(|(i, (_, tokens))| {
                            div()
                                .h_full()
                                .flex_basis(relative(*tokens as f32 / sum))
                                .flex_shrink(1.)
                                .min_w(px(3.))
                                .rounded(px(2.))
                                .bg(c.series(i))
                        }),
                ),
            )
            .child(
                v_flex()
                    .gap(px(10.))
                    .child(h_flex().gap(px(24.)).child(key(0)).child(key(1)))
                    .child(h_flex().gap(px(24.)).child(key(2)).child(key(3))),
            )
            .child(div().h(px(1.)).bg(c.separator))
            .child(
                h_flex()
                    .gap(px(24.))
                    .child(per("Context per request", context))
                    .child(per("Output per request", total.output / requests)),
            ),
    )
}

/// How fast each model writes once it has begun, fastest first.
fn speed(history: &History, c: &Colors) -> Div {
    let fastest = history
        .speeds
        .first()
        .map_or(1., |s| s.tokens_per_second)
        .max(1.);
    section("Output speed", None, c).child(
        panel(c)
            .flex_1()
            .p(px(16.))
            .gap(px(12.))
            .when(history.speeds.is_empty(), |list| {
                list.child(caption("No answers long enough to time yet.", c))
            })
            .children(history.speeds.iter().take(SPEEDS).map(|s| {
                h_flex()
                    .gap(px(12.))
                    .child(name(s.model.clone(), Some(c.provider(s.provider))))
                    .child(div().flex_1().child(meter(
                        (s.tokens_per_second / fastest) as f32,
                        c.meter,
                        c,
                    )))
                    .child(cell(format!("{:.0} tok/s", s.tokens_per_second), 80.))
            })),
    )
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
    section("Agents", None, c).child(panel(c).p(px(16.)).gap(px(12.)).children(
        history.agents.iter().map(|part| {
            let tokens = history::tokens(&part.totals);
            h_flex()
                .gap(px(12.))
                .child(name(part.name, Some(agent_color(part.name, c))))
                .child(
                    div()
                        .flex_1()
                        .child(meter(tokens as f32 / most, c.meter, c)),
                )
                .child(cell(human::compact(tokens), 56.))
                .child(cell(count(part.totals.requests, "request"), 112.).text_color(c.muted))
        }),
    ))
}

/// When the work happens: answers by weekday and hour, the busier the
/// darker.
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
    let ink = c.fg;
    let shade = |n: u64| {
        if n == 0 {
            c.track
        } else {
            ink.opacity(0.12 + 0.68 * n as f32 / most.max(1) as f32)
        }
    };
    let scale = h_flex()
        .gap(px(4.))
        .text_size(px(ui::SMALL))
        .text_color(c.muted)
        .child("Less")
        .children([0.12, 0.35, 0.58, 0.8].map(|strength| {
            div()
                .size(px(10.))
                .rounded(px(2.))
                .bg(ink.opacity(strength))
        }))
        .child("More");
    let trailing =
        h_flex()
            .gap(px(20.))
            .children(busiest.map(|(day, hour)| {
                caption(format!("Busiest at {hour:02}:00 on {}", WEEKDAYS[day]), c)
            }))
            .child(scale);
    section("When you work", Some(trailing.into_any_element()), c).child(
        panel(c)
            .p(px(16.))
            .gap(px(3.))
            .children(WEEKDAYS.iter().zip(&history.activity).map(|(day, hours)| {
                h_flex()
                    .gap(px(3.))
                    .child(caption(day, c).w(px(36.)).flex_shrink_0())
                    .children(
                        hours
                            .iter()
                            .map(|&n| div().flex_1().h(px(16.)).rounded(px(2.)).bg(shade(n))),
                    )
            }))
            .child(
                h_flex()
                    .pt(px(4.))
                    .gap(px(3.))
                    .text_size(px(11.))
                    .text_color(c.faint)
                    .font_features(tabular())
                    .child(div().w(px(36.)).flex_shrink_0())
                    .children((0..24).map(|hour| {
                        div()
                            .flex_1()
                            .whitespace_nowrap()
                            .when(hour % 6 == 0, |cell| cell.child(format!("{hour:02}:00")))
                    })),
            ),
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
    const WIDTHS: [f32; 4] = [64., 72., 56., 76.];
    let numbers = |cells: [String; 4]| {
        h_flex().flex_shrink_0().gap(px(16.)).children(
            cells
                .into_iter()
                .zip(WIDTHS)
                .map(|(text, width)| cell(text, width)),
        )
    };
    let mut table = panel(c).child(
        h_flex()
            .px(px(16.))
            .py(px(8.))
            .gap(px(16.))
            .text_size(px(ui::SMALL))
            .text_color(c.muted)
            .child(div().w(px(220.)).flex_shrink_0().child("Account"))
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
        table = table.child(
            h_flex()
                .px(px(16.))
                .py(px(10.))
                .gap(px(16.))
                .border_t_1()
                .border_color(c.separator)
                .child(
                    h_flex()
                        .w(px(220.))
                        .flex_shrink_0()
                        .gap(px(8.))
                        .child(dot(c.provider(share.provider)))
                        .child(div().min_w_0().truncate().child(share.name.clone())),
                )
                .child(
                    div()
                        .flex_1()
                        .child(meter(tokens as f32 / most, c.meter, c)),
                )
                .child(numbers([
                    human::compact(tokens),
                    grouped(share.totals.requests),
                    failed,
                    priced(share.totals.cost, &share.totals),
                ])),
        );
    }
    section("Accounts", None, c).child(table)
}

/// An agent's color: its maker's, as for providers.
fn agent_color(agent: &str, c: &Colors) -> Hsla {
    match agent {
        "Claude Code" => c.provider(ProviderId::Claude),
        "Codex" => c.provider(ProviderId::Codex),
        "Warmups" => c.faint,
        _ => c.muted,
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
    use super::{axis, places};

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
    fn ticks_keep_the_places_their_steps_need() {
        assert_eq!(places(5.), 0);
        assert_eq!(places(0.5), 1);
        assert_eq!(places(0.25), 2);
    }
}
