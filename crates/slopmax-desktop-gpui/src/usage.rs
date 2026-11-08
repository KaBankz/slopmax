//! The Usage and Performance pages, over the range the header picks.
//! Usage charts what went through slopmax: tokens by provider, requests and
//! their API value, the models ranked and the token mix, which agents sent
//! the work, when the work happens, and the accounts ranked. Performance
//! charts how well it went: what failover saved and what failed, how much
//! came from cache, how fast each model writes, and how soon answers began.
//!
//! The charts keep to neutrals: providers stack in two shades, and red
//! marks what failed; nothing else is colored. Totals for each hour or day
//! stand as columns, never curves that would invent values between them.

use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::history::Totals;
use slopmax_app::history::{self, Bucket, History, Range};
use slopmax_app::human;
use slopmax_app::view;

use crate::Main;
use crate::theme::{Colors, tabular};
use crate::ui::{self, caption, figure, legend, meter, panel, section, stat, stats, swatch};

/// The width left of a column chart for its counts.
const GUTTER: f32 = 40.;
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
            .enumerate()
            .map(|(i, p)| (c.stack(i), p.title())),
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
                    match (history.billed > 0., total.unpriced) {
                        (true, _) => format!("Billed to API keys {}", dollars(history.billed)),
                        (false, 0) => "at API prices".to_owned(),
                        (false, n) => format!("{} unpriced", count(n, "request")),
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
            section("Tokens", Some(providers.into_any_element()), c)
                .child(chart(tokens(history, margin, c), c)),
        )
        .child(pair(
            section(
                "Requests",
                Some(legend([(c.meter, "Answered"), (c.bad, "Failed")], c).into_any_element()),
                c,
            )
            .child(chart(requests(history, margin, c), c)),
            section("API value", None, c).child(chart(cost(history, margin, c), c)),
        ))
        .child(pair(models(history, c), mix(history, c)))
        .child(agents(history, c))
        .when(history.range != Range::Today, |page| {
            page.child(activity(history, c))
        })
        .child(accounts(history, c))
        .child(left(history, c))
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
                        "answered by another account",
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
                        history
                            .first_byte
                            .map_or_else(|| "—".to_owned(), |ms| format!("{:.2} s", ms / 1e3)),
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
            .child(chart(first_byte(history, margin, c), c)),
        ))
}

/// Tokens each hour or day, a column stacked from each provider's, in
/// shades of neutral.
fn tokens(history: &History, margin: usize, c: &Colors) -> Div {
    let tones: Vec<Hsla> = (0..history.providers.len()).map(|i| c.stack(i)).collect();
    let providers = history.providers.clone();
    columns(
        "tokens",
        history,
        Layout::Stacked,
        |b| {
            b.tokens
                .iter()
                .zip(&tones)
                .map(|(n, tone)| ((*n), *tone))
                .collect()
        },
        move |b| {
            let mut tip = vec![b.label.clone()];
            for (provider, tokens) in providers.iter().zip(&b.tokens) {
                tip.push(format!(
                    "{}: {}",
                    provider.title(),
                    human::compact(*tokens as u64)
                ));
            }
            tip.join("\n")
        },
        Scale::count(),
        |v| human::compact(v.round() as u64).replace(".0", ""),
        180.,
        margin,
        c,
    )
}

/// Requests each hour or day, those that failed capping them in red.
fn requests(history: &History, margin: usize, c: &Colors) -> Div {
    let (fill, failed) = (c.meter, c.bad);
    columns(
        "requests",
        history,
        Layout::Stacked,
        |b| vec![(b.requests as f64, fill), (b.failed as f64, failed)],
        |b| match b.failed {
            0 => format!("{}\n{}", b.label, count(b.requests, "request")),
            n => format!(
                "{}\n{}\n{} failed",
                b.label,
                count(b.requests, "request"),
                grouped(n)
            ),
        },
        Scale::count(),
        |v| grouped(v.round() as u64),
        CHART,
        margin,
        c,
    )
}

/// What the requests would have cost on the API, each hour or day.
fn cost(history: &History, margin: usize, c: &Colors) -> Div {
    let fill = c.meter;
    columns(
        "cost",
        history,
        Layout::Stacked,
        |b| vec![(b.cost, fill)],
        |b| format!("{}\n{} at API prices", b.label, dollars(b.cost)),
        Scale::money(),
        |v| {
            if v.fract() == 0. {
                format!("${v:.0}")
            } else {
                format!("${v:.2}")
            }
        },
        CHART,
        margin,
        c,
    )
}

/// How a column holds its parts: one on another, or side by side.
#[derive(Clone, Copy, PartialEq)]
enum Layout {
    Stacked,
    Grouped,
}

/// A value axis: from zero to a round value past the most, its ticks no
/// finer than a step; or set.
#[derive(Clone, Copy)]
enum Scale {
    Zero { finest: f64 },
    Fixed { bottom: f64, top: f64, ticks: usize },
}

impl Scale {
    /// Whole counts from zero.
    fn count() -> Self {
        Self::Zero { finest: 1. }
    }

    /// Dollars from zero, to the cent.
    fn money() -> Self {
        Self::Zero { finest: 0.01 }
    }

    /// The axis's bottom, top, and ticks for values up to `most`.
    fn fit(self, most: f64) -> (f64, f64, usize) {
        match self {
            Self::Fixed { bottom, top, ticks } => (bottom, top, ticks),
            Self::Zero { finest } => {
                let (top, ticks) = axis(most, finest);
                (0., top, ticks)
            }
        }
    }
}

/// The height of a chart beside another.
const CHART: f32 = 132.;

/// A chart's frame, as every chart draws it: a value axis at the left on a
/// grid of round values, the plot over the hours or days, and every
/// `margin`th of them named beneath, each under its own slot.
fn frame(
    history: &History,
    (bottom, top, ticks): (f64, f64, usize),
    format: impl Fn(f64) -> String,
    height: f32,
    margin: usize,
    plot: Div,
    c: &Colors,
) -> Div {
    let rows: Vec<f64> = (0..ticks)
        .map(|i| bottom + (top - bottom) * i as f64 / (ticks - 1) as f64)
        .collect();
    let y = |value: f64| px(height * (1. - ((value - bottom) / (top - bottom)) as f32));
    let grid = rows.iter().map(|&value| {
        div()
            .absolute()
            .left_0()
            .right_0()
            .top(y(value))
            .border_t_1()
            .border_color(c.separator)
    });
    let values = div()
        .relative()
        .w(px(GUTTER))
        .flex_shrink_0()
        .h(px(height))
        .text_size(px(ui::AXIS))
        .text_color(c.muted)
        .font_features(tabular())
        .children(rows.iter().map(|&value| {
            div()
                .absolute()
                .right(px(8.))
                .top(y(value) - px(7.))
                .whitespace_nowrap()
                .child(format(value))
        }));
    let names = h_flex()
        .h(px(18.))
        .pt(px(4.))
        .pl(px(GUTTER))
        .text_size(px(ui::AXIS))
        .text_color(c.muted)
        .children(history.buckets.iter().enumerate().map(|(i, b)| {
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
        .child(
            h_flex().items_start().child(values).child(
                div()
                    .relative()
                    .flex_1()
                    .h(px(height))
                    .children(grid)
                    .child(plot),
            ),
        )
        .child(names)
}

/// A strip over each hour or day that shows its `tip` while hovered.
fn hovers(id: &'static str, history: &History, tip: impl Fn(&Bucket) -> String, c: &Colors) -> Div {
    let hover = c.hover;
    h_flex()
        .absolute()
        .inset_0()
        .children(history.buckets.iter().enumerate().map(|(i, bucket)| {
            let tip = SharedString::from(tip(bucket));
            div()
                .id((id, i))
                .flex_1()
                .h_full()
                .rounded(px(3.))
                .hover(move |strip| strip.bg(hover))
                .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
        }))
}

/// Values over the range as columns `height` tall, one an hour or a day,
/// holding their `parts` as `layout` has it. Hovering a column shows its
/// `tip`.
#[allow(clippy::too_many_arguments)]
fn columns(
    id: &'static str,
    history: &History,
    layout: Layout,
    parts: impl Fn(&Bucket) -> Vec<(f64, Hsla)>,
    tip: impl Fn(&Bucket) -> String,
    scale: Scale,
    format: impl Fn(f64) -> String,
    height: f32,
    margin: usize,
    c: &Colors,
) -> Div {
    let stacks: Vec<Vec<(f64, Hsla)>> = history.buckets.iter().map(parts).collect();
    let most = stacks
        .iter()
        .map(|stack| match layout {
            Layout::Stacked => stack.iter().map(|(n, _)| n).sum::<f64>(),
            Layout::Grouped => stack.iter().map(|(n, _)| *n).fold(0., f64::max),
        })
        .fold(0., f64::max);
    let fitted = scale.fit(most);
    let (_, top, _) = fitted;
    let tall = |n: f64| px(height * (n / top) as f32);
    let bars =
        h_flex()
            .absolute()
            .inset_0()
            .items_end()
            .children(stacks.into_iter().map(|stack| {
                let shown = stack.into_iter().filter(|(n, _)| *n > 0.);
                // A slim column, centered in its hour or day and clear of its
                // neighbors; grouped, a slimmer one for each part.
                let column =
                    match layout {
                        Layout::Stacked => v_flex()
                            .w(relative(0.6))
                            .max_w(px(18.))
                            .gap(px(1.))
                            .children(shown.collect::<Vec<_>>().into_iter().rev().map(
                                |(n, tone)| div().h(tall(n)).min_h(px(2.)).rounded(px(2.)).bg(tone),
                            )),
                        Layout::Grouped => h_flex()
                            .w(relative(0.7))
                            .max_w(px(22.))
                            .items_end()
                            .gap(px(2.))
                            .children(shown.map(|(n, tone)| {
                                div()
                                    .flex_1()
                                    .h(tall(n))
                                    .min_h(px(2.))
                                    .rounded(px(2.))
                                    .bg(tone)
                            })),
                    };
                h_flex()
                    .flex_1()
                    .h_full()
                    .items_end()
                    .justify_center()
                    .child(column)
            }));
    let plot = div()
        .absolute()
        .inset_0()
        .child(bars)
        .child(hovers(id, history, tip, c));
    frame(history, fitted, format, height, margin, plot, c)
}

/// Lines over the range, one per series, through each hour or day that has
/// a value, in straight segments; a lone point shows as a dot.
#[allow(clippy::too_many_arguments)]
fn lines(
    id: &'static str,
    history: &History,
    series: Vec<(Vec<Option<f64>>, Hsla)>,
    tip: impl Fn(&Bucket) -> String,
    scale: Scale,
    format: impl Fn(f64) -> String,
    height: f32,
    margin: usize,
    c: &Colors,
) -> Div {
    let most = series
        .iter()
        .flat_map(|(values, _)| values.iter().flatten().copied())
        .fold(0., f64::max);
    let fitted = scale.fit(most);
    let (bottom, top, _) = fitted;
    let slots = history.buckets.len().max(1);
    let drawing = canvas(
        |_, _, _| {},
        move |bounds, (), window, _| {
            let at = |i: usize, value: f64| {
                let along = (i as f32 + 0.5) / slots as f32;
                let up = ((value - bottom) / (top - bottom)).clamp(0., 1.) as f32;
                point(
                    bounds.left() + bounds.size.width * along,
                    bounds.top() + bounds.size.height * (1. - up),
                )
            };
            for (values, color) in &series {
                let mut path = PathBuilder::stroke(px(1.5));
                let mut drawn = false;
                for (i, value) in values.iter().enumerate() {
                    let Some(value) = *value else { continue };
                    let joined = i > 0 && values[i - 1].is_some();
                    if joined {
                        path.line_to(at(i, value));
                        drawn = true;
                    } else {
                        path.move_to(at(i, value));
                        let alone = values.get(i + 1).is_none_or(Option::is_none);
                        if alone {
                            let p = at(i, value);
                            window.paint_quad(
                                fill(
                                    Bounds::new(p - point(px(2.), px(2.)), size(px(4.), px(4.))),
                                    *color,
                                )
                                .corner_radii(px(2.)),
                            );
                        }
                    }
                }
                if drawn && let Ok(path) = path.build() {
                    window.paint_path(path, *color);
                }
            }
        },
    )
    .absolute()
    .inset_0();
    let plot = div()
        .absolute()
        .inset_0()
        .child(drawing)
        .child(hovers(id, history, tip, c));
    frame(history, fitted, format, height, margin, plot, c)
}

/// What failover saved and what failed, each hour or day, side by side.
/// The totals above give their sums.
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
            Layout::Grouped,
            |b| vec![(b.rescued as f64, saved), (b.failed as f64, failed)],
            |b| {
                format!(
                    "{}\n{} saved by failover\n{} failed",
                    b.label,
                    grouped(b.rescued),
                    grouped(b.failed)
                )
            },
            Scale::count(),
            |v| grouped(v.round() as u64),
            CHART,
            margin,
            c,
        ),
        c,
    ))
}

/// How much input came from cache each hour or day, on an axis that ends
/// at 100% and starts as low as it must, so a steady rate still shows its
/// changes.
fn cache(history: &History, margin: usize, c: &Colors) -> Div {
    let rates: Vec<Option<f64>> = history
        .buckets
        .iter()
        .map(|b| b.cached.map(|r| r * 100.))
        .collect();
    let least = rates.iter().flatten().copied().fold(100., f64::min);
    let span = [10., 20., 50., 100.]
        .into_iter()
        .find(|span| 100. - span <= least - 1.)
        .unwrap_or(100.);
    let line = lines(
        "cache",
        history,
        vec![(rates, c.meter)],
        |b| match b.cached {
            Some(r) => format!("{}\n{:.0}% from cache", b.label, r * 100.),
            None => format!("{}\nNo input", b.label),
        },
        Scale::Fixed {
            bottom: 100. - span,
            top: 100.,
            ticks: 3,
        },
        |v| format!("{v:.0}%"),
        CHART,
        margin,
        c,
    );
    section("Input from cache", None, c).child(chart(line, c))
}

/// How soon answers began, in seconds, over the hours or days that had
/// any: the median, and the slowest twentieth in a fainter line.
fn first_byte(history: &History, margin: usize, c: &Colors) -> Div {
    let seconds = |pick: fn((f64, f64)) -> f64| -> Vec<Option<f64>> {
        history
            .buckets
            .iter()
            .map(|b| b.first_byte.map(|w| pick(w) / 1e3))
            .collect()
    };
    let (median, slow) = (seconds(|w| w.0), seconds(|w| w.1));
    let slowest = slow.iter().flatten().copied().fold(0., f64::max);
    let (top, ticks) = axis(slowest, 0.1);
    let places = places(top / (ticks - 1) as f64);
    lines(
        "first-byte",
        history,
        vec![(slow, c.series(2)), (median, c.meter)],
        |b| match b.first_byte {
            Some((median, slow)) => format!(
                "{}\nMedian {:.2} s\nSlowest 5% {:.2} s",
                b.label,
                median / 1e3,
                slow / 1e3
            ),
            None => format!("{}\nNo answers", b.label),
        },
        Scale::Fixed {
            bottom: 0.,
            top,
            ticks,
        },
        move |v| format!("{v:.places$} s"),
        CHART,
        margin,
        c,
    )
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

/// A ranked row's name.
fn name(text: impl Into<SharedString>) -> Div {
    h_flex()
        .w(px(NAME))
        .flex_shrink_0()
        .child(div().min_w_0().truncate().child(text.into()))
}

/// A model's name, ranked, in the face for names a program reads.
fn model(text: impl Into<SharedString>) -> Div {
    name(text)
        .font_family(crate::theme::MONO)
        .text_size(px(ui::SMALL))
}

/// Tokens by model, ranked, the rest as one, and what each would cost
/// on the API.
fn models(history: &History, c: &Colors) -> Div {
    let mut ranked: Vec<(String, Totals)> = history
        .models
        .iter()
        .take(MODELS)
        .map(|share| (share.name.clone(), share.totals))
        .collect();
    let rest = history
        .models
        .iter()
        .skip(MODELS)
        .fold(Totals::default(), |rest, share| {
            combined(rest, &share.totals)
        });
    if history::tokens(&rest) > 0 {
        ranked.push(("Other".to_owned(), rest));
    }
    let most = ranked
        .iter()
        .map(|(_, totals)| history::tokens(totals))
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    section("Models", None, c).child(panel(c).flex_1().p(px(16.)).gap(px(12.)).children(
        ranked.into_iter().map(|(model, totals)| {
            let tokens = history::tokens(&totals);
            h_flex()
                .gap(px(12.))
                .child(self::model(model))
                .child(
                    div()
                        .flex_1()
                        .child(meter(tokens as f32 / most, c.meter, c)),
                )
                .child(cell(human::compact(tokens), 52.))
                .child(cell(priced(totals.cost, &totals), 64.).text_color(c.muted))
        }),
    ))
}

/// Two sets of totals as one.
fn combined(mut sum: Totals, more: &Totals) -> Totals {
    sum.requests += more.requests;
    sum.input += more.input;
    sum.output += more.output;
    sum.cache_read += more.cache_read;
    sum.cache_write += more.cache_write;
    sum.cost += more.cost;
    sum.unpriced += more.unpriced;
    sum.failed += more.failed;
    sum
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

/// How fast each model writes once it has begun, fastest first: the
/// figures alone, as they differ too little for bars to tell apart.
fn speed(history: &History, c: &Colors) -> Div {
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
                    .child(model(s.model.clone()))
                    .child(div().flex_1().text_color(c.muted).child(s.provider.title()))
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
                .child(name(part.name.clone()))
                .child(
                    div()
                        .flex_1()
                        .child(meter(tokens as f32 / most, c.meter, c)),
                )
                .child(cell(human::compact(tokens), 56.))
                .child(cell(count(part.totals.requests, "request"), 112.).text_color(c.muted))
                .child(cell(priced(part.totals.cost, &part.totals), 72.).text_color(c.muted))
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
                    .text_size(px(ui::AXIS))
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

/// The accounts ranked by tokens, each with its provider, its share drawn,
/// and its API value; the failures no account took; and the totals, which
/// the columns add up to.
fn accounts(history: &History, c: &Colors) -> Div {
    let sum = history
        .accounts
        .iter()
        .map(|s| history::tokens(&s.totals))
        .sum::<u64>()
        .max(1) as f32;
    let most = history
        .accounts
        .iter()
        .map(|s| history::tokens(&s.totals))
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    const ACCOUNT: f32 = 260.;
    const WIDTHS: [f32; 4] = [64., 72., 56., 76.];
    let numbers = |cells: [String; 4]| {
        h_flex().flex_shrink_0().gap(px(16.)).children(
            cells
                .into_iter()
                .zip(WIDTHS)
                .map(|(text, width)| cell(text, width)),
        )
    };
    let line = || {
        h_flex()
            .px(px(16.))
            .py(px(10.))
            .gap(px(16.))
            .border_t_1()
            .border_color(c.separator)
    };
    let failed = |n: u64| match n {
        0 => "—".to_owned(),
        n => grouped(n),
    };
    let mut table = panel(c).child(
        h_flex()
            .px(px(16.))
            .py(px(8.))
            .gap(px(16.))
            .text_size(px(ui::SMALL))
            .text_color(c.muted)
            .child(div().w(px(ACCOUNT)).flex_shrink_0().child("Account"))
            .child(div().flex_1().child("Share of tokens"))
            .child(numbers(
                ["Tokens", "Requests", "Failed", "API value"].map(str::to_owned),
            )),
    );
    for share in &history.accounts {
        let tokens = history::tokens(&share.totals);
        table = table.child(
            line()
                .child(
                    h_flex()
                        .w(px(ACCOUNT))
                        .flex_shrink_0()
                        .gap(px(8.))
                        .child(div().min_w_0().truncate().child(share.name.clone()))
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_color(c.muted)
                                .child(share.provider.title()),
                        ),
                )
                .child(
                    h_flex()
                        .flex_1()
                        .gap(px(12.))
                        .child(
                            div()
                                .flex_1()
                                .child(meter(tokens as f32 / most, c.meter, c)),
                        )
                        .child(
                            cell(format!("{:.0}%", tokens as f32 / sum * 100.), 36.)
                                .text_color(c.muted),
                        ),
                )
                .child(numbers([
                    human::compact(tokens),
                    grouped(share.totals.requests),
                    failed(share.totals.failed),
                    priced(share.totals.cost, &share.totals),
                ])),
        );
    }
    if history.unplaced > 0 {
        table = table.child(
            line()
                .text_color(c.muted)
                .child(
                    div()
                        .w(px(ACCOUNT))
                        .flex_shrink_0()
                        .child("No account could take it"),
                )
                .child(
                    caption("Every account was limited or out of rotation", c)
                        .flex_1()
                        .min_w_0()
                        .truncate(),
                )
                .child(numbers([
                    "—".to_owned(),
                    "—".to_owned(),
                    grouped(history.unplaced),
                    "—".to_owned(),
                ])),
        );
    }
    let total = &history.total;
    table = table.child(
        line()
            .font_weight(FontWeight::MEDIUM)
            .child(div().w(px(ACCOUNT)).flex_shrink_0().child("Total"))
            .child(div().flex_1())
            .child(numbers([
                human::compact(history::tokens(total)),
                grouped(total.requests),
                failed(total.failed),
                priced(total.cost, total),
            ])),
    );
    section("Accounts", None, c).child(table)
}

/// What weekly resets threw away over the range: the share of each plan's
/// fee its unused quota stood for, in all and by account. A measure, so it
/// keeps to neutrals.
fn left(history: &History, c: &Colors) -> Div {
    let left = &history.left;
    let explain = caption(
        "The share of each plan's weekly fee that resets threw away, at plan list prices or \
         [plan_prices] in config.toml.",
        c,
    );
    let section = section("Left on the table", None, c);
    if left.windows == 0 {
        return section
            .child(
                panel(c)
                    .p(px(16.))
                    .child(caption(view::left_line(0, 0.), c)),
            )
            .child(explain);
    }
    const WIDTHS: [f32; 3] = [104., 72., 76.];
    let numbers = |cells: [String; 3]| {
        h_flex().flex_shrink_0().gap(px(16.)).children(
            cells
                .into_iter()
                .zip(WIDTHS)
                .map(|(text, width)| cell(text, width)),
        )
    };
    let summary = h_flex()
        .p(px(16.))
        .gap(px(16.))
        .items_end()
        .child(figure(dollars(left.dollars), ui::TITLE, c))
        .child(caption(view::left_line(left.windows, left.unused), c).pb(px(3.)))
        .when(left.unpriced > 0, |line| {
            line.child(div().flex_1()).child(
                caption(
                    format!(
                        "{} on plans without a known price left out",
                        count(left.unpriced, "weekly window")
                    ),
                    c,
                )
                .pb(px(3.)),
            )
        });
    let head = h_flex()
        .px(px(16.))
        .py(px(8.))
        .gap(px(16.))
        .border_t_1()
        .border_color(c.separator)
        .text_size(px(ui::SMALL))
        .text_color(c.muted)
        .child(div().w(px(260.)).flex_shrink_0().child("Account"))
        .child(div().flex_1().child("Unused at reset"))
        .child(numbers(
            ["Weekly windows", "Unused", "Left"].map(str::to_owned),
        ));
    let rows = left.accounts.iter().map(|account| {
        h_flex()
            .px(px(16.))
            .py(px(10.))
            .gap(px(16.))
            .border_t_1()
            .border_color(c.separator)
            .child(
                h_flex()
                    .w(px(260.))
                    .flex_shrink_0()
                    .gap(px(8.))
                    .child(div().min_w_0().truncate().child(account.name.clone()))
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_color(c.muted)
                            .child(account.provider.title()),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .child(meter((account.unused / 100.) as f32, c.meter, c)),
            )
            .child(numbers([
                grouped(account.windows),
                format!("{:.0}%", account.unused),
                dollars(account.dollars),
            ]))
    });
    section
        .child(panel(c).child(summary).child(head).children(rows))
        .child(explain)
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
