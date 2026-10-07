//! What every page is built of, in slopmax's own design: cards on the page,
//! stat tiles, status pills, gauges and rings, icons, the brand's mark,
//! avatars, segmented choices, and the strip a window is dragged by.

use std::f32::consts::TAU;

use gpui_kit::assets::IconName;
use gpui_kit::component::plot::shape::{Arc, ArcData};
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::view::Label;
use slopmax_core::report::Tone;

use crate::theme::{Colors, DISPLAY, tabular};

/// A page's title.
pub(crate) const TITLE: f32 = 20.;
/// A section of a page, and a card's title.
pub(crate) const HEADING: f32 = 14.;
pub(crate) const SMALL: f32 = 12.;
pub(crate) const TINY: f32 = 11.;

/// A Lucide icon, `size` points square, in `color`.
pub(crate) fn icon(name: IconName, size: f32, color: Hsla) -> Icon {
    Icon::new(name).size(px(size)).text_color(color)
}

/// An icon on a rounded tile of its color, as a stat or a list leads with.
pub(crate) fn icon_tile(name: IconName, color: Hsla, size: f32, c: &Colors) -> Div {
    div()
        .flex_shrink_0()
        .size(px(size))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(size * 0.3))
        .bg(c.tint(color))
        .child(icon(name, size * 0.55, color))
}

/// A card: the page's unit of content, on a surface with a hairline edge,
/// lifted by a soft shadow in light.
pub(crate) fn card(c: &Colors) -> Div {
    v_flex()
        .min_w_0()
        .p(px(20.))
        .gap(px(16.))
        .rounded(px(14.))
        .bg(c.surface)
        .border_1()
        .border_color(c.border)
        .when(!c.dark, |card| {
            card.shadow(vec![
                BoxShadow::new(px(0.), px(1.), black().opacity(0.04)).blur_radius(px(2.)),
                BoxShadow::new(px(0.), px(4.), black().opacity(0.03)).blur_radius(px(12.)),
            ])
        })
}

/// A card's title, with whatever trails it on the right.
pub(crate) fn card_header(title: impl Into<SharedString>, c: &Colors) -> Div {
    h_flex().gap(px(10.)).min_h(px(22.)).child(
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_size(px(HEADING))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(c.fg)
            .child(title.into()),
    )
}

/// A section of a page: its title over its content.
pub(crate) fn section(title: impl Into<SharedString>, c: &Colors) -> Div {
    v_flex().gap(px(12.)).child(
        div()
            .text_size(px(HEADING + 1.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(c.fg)
            .child(title.into()),
    )
}

/// A number set large, in Inter's display cut, its figures even.
pub(crate) fn figure(value: impl Into<SharedString>, size: f32, c: &Colors) -> Div {
    div()
        .font_family(DISPLAY)
        .font_features(tabular())
        .text_size(px(size))
        .line_height(px(size * 1.15))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.fg)
        .child(value.into())
}

/// A total at a glance: what it counts beside its icon, the value large,
/// and a note.
pub(crate) fn stat(
    name: IconName,
    color: Hsla,
    title: &str,
    value: impl Into<SharedString>,
    note: impl AsRef<str>,
    c: &Colors,
) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(10.))
        .child(
            h_flex()
                .gap(px(8.))
                .child(icon_tile(name, color, 24., c))
                .child(caption(title, c).text_size(px(12.5))),
        )
        .child(
            v_flex()
                .gap(px(3.))
                .child(figure(value, 26., c))
                .child(caption(note, c).truncate()),
        )
}

/// Secondary text.
pub(crate) fn caption(text: impl AsRef<str>, c: &Colors) -> Div {
    div()
        .text_size(px(SMALL))
        .text_color(c.muted)
        .child(text.as_ref().to_owned())
}

pub(crate) fn dot(color: Hsla) -> Div {
    div().flex_shrink_0().size(px(7.)).rounded_full().bg(color)
}

/// A word or two on a chip of its color, as a status shows.
pub(crate) fn pill(text: impl Into<SharedString>, color: Hsla, c: &Colors) -> Div {
    chip(color, c).child(text.into())
}

/// An empty chip of `color`, for what it holds.
fn chip(color: Hsla, c: &Colors) -> Div {
    h_flex()
        .flex_shrink_0()
        .h(px(20.))
        .px(px(8.))
        .gap(px(5.))
        .rounded_full()
        .bg(c.tint(color))
        .text_size(px(TINY))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink(color, c))
}

/// A status as a chip: good, warning and bad ones lead with a dot of their
/// color; the rest are quiet words.
pub(crate) fn status(label: &Label, c: &Colors) -> Div {
    match label.tone {
        Tone::Muted => pill(label.text.clone(), c.muted, c),
        Tone::Accent => pill(label.text.clone(), c.accent, c),
        tone => {
            let color = c.tone(tone);
            chip(color, c)
                .pl(px(7.))
                .child(dot(color).size(px(6.)))
                .child(label.text.clone())
        }
    }
}

/// A worded state in a line of text: good, warning and bad ones lead with a
/// dot of their color, and keep their words readable.
pub(crate) fn label(label: &Label, c: &Colors) -> Div {
    let text = div().min_w_0().truncate().child(label.text.clone());
    let line = h_flex().min_w_0().gap(px(6.));
    match label.tone {
        Tone::Muted => line.text_color(c.muted).child(text),
        Tone::Accent => line.text_color(c.accent).child(text),
        tone => line.child(dot(c.tone(tone))).child(text),
    }
}

/// `color` dark enough to read on its own tint in light; as it is in dark.
pub(crate) fn ink(color: Hsla, c: &Colors) -> Hsla {
    if c.dark {
        color
    } else {
        Hsla {
            l: (color.l - 0.12).max(0.),
            ..color
        }
    }
}

/// A gauge's bar, filled to `fraction`, its fill brightening to its end.
pub(crate) fn gauge(fraction: f32, color: Hsla, c: &Colors) -> Div {
    let fraction = fraction.clamp(0., 1.);
    div()
        .h(px(8.))
        .rounded_full()
        .bg(c.track)
        .when(fraction > 0., |bar| {
            bar.child(
                div()
                    .h_full()
                    .w(relative(fraction))
                    .min_w(px(8.))
                    .rounded_full()
                    .bg(linear_gradient(
                        90.,
                        linear_color_stop(color.opacity(0.7), 0.),
                        linear_color_stop(color, 1.),
                    )),
            )
        })
}

/// A ring filled clockwise from the top to `fraction`, its ends round: a
/// gauge with a number at its center.
pub(crate) fn ring(fraction: f32, color: Hsla, stroke: f32, c: &Colors) -> impl IntoElement {
    let track = c.track;
    let fraction = fraction.clamp(0., 1.);
    canvas(
        move |bounds, _, _| bounds,
        move |_, bounds, window, _| {
            let outer = bounds.size.width.min(bounds.size.height).as_f32() / 2.;
            let inner = outer - stroke;
            let arc = Arc::new().inner_radius(inner).outer_radius(outer);
            arc.paint(&ArcData::new(&(), 0, 1., 0., TAU), track, &bounds, window);
            if fraction <= 0. {
                return;
            }
            let end = fraction * TAU;
            arc.paint(
                &ArcData::new(&(), 1, fraction, 0., end),
                color,
                &bounds,
                window,
            );
            let center = bounds.center();
            let middle = (inner + outer) / 2.;
            for angle in [0., end] {
                let at = point(
                    center.x + px(middle * angle.sin()),
                    center.y - px(middle * angle.cos()),
                );
                let cap = Bounds::centered_at(at, size(px(stroke), px(stroke)));
                window.paint_quad(fill(cap, color).corner_radii(px(stroke / 2.)));
            }
        },
    )
    .size_full()
}

/// slopmax's mark: three rising bars on a tile of its gradient, as the
/// app's icon draws them on a 64-point grid.
pub(crate) fn logo(size: f32, c: &Colors) -> Div {
    let unit = size / 64.;
    div()
        .relative()
        .flex_shrink_0()
        .size(px(size))
        .rounded(px(15. * unit))
        .bg(c.brand(135.))
        .children(
            [(14., 34., 16.), (27.5, 24., 26.), (41., 14., 36.)].map(|(x, y, h)| {
                div()
                    .absolute()
                    .left(px(x * unit))
                    .top(px(y * unit))
                    .w(px(9. * unit))
                    .h(px(h * unit))
                    .rounded(px(2.5 * unit))
                    .bg(white())
            }),
        )
}

/// An account's initials on a disc of its provider's color: of the name
/// before an address's `@`, a letter for each of its first two words.
pub(crate) fn avatar(name: &str, color: Hsla, c: &Colors) -> Div {
    let local = name.split('@').next().unwrap_or(name);
    let initials: String = local
        .split(['.', '-', '_', ' '])
        .filter_map(|part| part.chars().find(|ch| ch.is_alphanumeric()))
        .take(2)
        .flat_map(char::to_uppercase)
        .collect();
    div()
        .flex_shrink_0()
        .size(px(32.))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(c.tint(color))
        .text_size(px(SMALL))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ink(color, c))
        .child(initials)
}

/// A choice of a few, as a row of segments, the chosen one raised; `choose`
/// takes a press.
pub(crate) fn segmented<V: 'static, T: Copy + PartialEq + 'static>(
    id: &str,
    options: impl IntoIterator<Item = (T, &'static str)>,
    chosen: T,
    choose: fn(&mut V, T, &mut Context<V>),
    c: &Colors,
    cx: &mut Context<V>,
) -> Div {
    let raised = if c.dark {
        rgb(0x2a2a34).into()
    } else {
        white()
    };
    let mut track = h_flex()
        .flex_shrink_0()
        .h(px(32.))
        .p(px(3.))
        .gap(px(2.))
        .rounded(px(9.))
        .bg(c.well)
        .border_1()
        .border_color(c.border);
    for (i, (value, title)) in options.into_iter().enumerate() {
        let selected = value == chosen;
        let (fg, hover) = (c.fg, c.hover);
        track = track.child(
            div()
                .id(SharedString::from(format!("{id}-{i}")))
                .h_full()
                .px(px(12.))
                .flex()
                .items_center()
                .rounded(px(6.))
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .role(Role::RadioButton)
                .aria_label(title)
                .aria_selected(selected)
                .map(|segment| {
                    if selected {
                        segment.bg(raised).text_color(c.fg).shadow(vec![
                            BoxShadow::new(px(0.), px(1.), black().opacity(0.12))
                                .blur_radius(px(2.)),
                        ])
                    } else {
                        segment
                            .text_color(c.muted)
                            .cursor_pointer()
                            .hover(move |segment| segment.bg(hover).text_color(fg))
                    }
                })
                .child(title)
                .on_click(cx.listener(move |view, _, _, cx| choose(view, value, cx))),
        );
    }
    track
}

/// A strip the window is dragged by, as by its title bar, and zoomed by a
/// double click. Windows answers both itself, from the strip's area.
pub(crate) fn drag_region(id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .window_control_area(WindowControlArea::Drag)
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count == 2 {
                if cfg!(target_os = "macos") {
                    window.titlebar_double_click();
                } else if cfg!(target_os = "linux") {
                    window.zoom_window();
                }
            }
        })
        .on_mouse_move(|event, window, _| {
            if event.dragging() {
                window.start_window_move();
            }
        })
}

/// An empty card's message: an icon, what is missing, and what to do.
pub(crate) fn empty(name: IconName, title: &str, detail: &str, c: &Colors) -> Div {
    card(c)
        .items_center()
        .py(px(36.))
        .gap(px(10.))
        .child(icon_tile(name, c.accent, 40., c))
        .child(
            v_flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(c.fg)
                        .child(title.to_owned()),
                )
                .child(caption(detail, c)),
        )
}
