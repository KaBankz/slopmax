//! What every page is built of, kept plain: panels of ruled rows on the
//! page, section titles, figures in even numerals, thin meters, a status
//! as a dot beside its words, the mark, segmented choices, and the strip a
//! window is dragged by. Spacing groups; a hairline separates; color only
//! reports a state.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use slopmax_app::view::{Gauge, Label, Share};
use slopmax_core::report::Tone;

use crate::theme::{Colors, tabular};

/// The type scale, a step of about 1.2: a page's title, a section's, body
/// text, and secondary text.
pub(crate) const TITLE: f32 = 20.;
pub(crate) const HEADING: f32 = 15.;
pub(crate) const BODY: f32 = 13.;
pub(crate) const SMALL: f32 = 12.;
/// A chart's axis labels, the same in every chart.
pub(crate) const AXIS: f32 = 11.;

/// The height of every control: a button, a text field, a segmented
/// choice.
pub(crate) const CONTROL: f32 = 28.;

/// A button, sized as slopmax's controls are rather than by gpui-kit's rem
/// steps, which at a 13-point rem leave a small button 19.5 points tall
/// around 11-point words: as tall as every control, its words at body size
/// in medium weight, 12 points either side. It is quiet by default, a face
/// inside a hairline; `.primary()` inverts it for a page's main act.
pub(crate) fn push(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    Button::new(id)
        .label(label)
        .h(px(CONTROL))
        .px(px(12.))
        .font_weight(FontWeight::MEDIUM)
}

/// A button that is only an icon, its tooltip saying what it does: a
/// square as tall as every control, the icon at 16 points.
pub(crate) fn tool(id: impl Into<ElementId>, icon: IconName, tip: &'static str) -> Button {
    Button::new(id)
        .icon(icon)
        .ghost()
        // gpui-kit draws a button's icon at three quarters of its size.
        .with_size(px(16. / 0.75))
        .size(px(CONTROL))
        .tooltip(tip)
        .accessibility_label(tip)
}

/// A text field as tall as every control, its words at body size.
pub(crate) fn field(state: &Entity<InputState>) -> Input {
    let field = Input::new(state).large().px(px(10.)).py_0();
    // The field's own `h` sizes a field of many lines alone.
    Styled::h(field, px(CONTROL))
}

/// A Lucide icon, `size` points square, in `color`.
pub(crate) fn icon(name: IconName, size: f32, color: Hsla) -> Icon {
    Icon::new(name).size(px(size)).text_color(color)
}

/// A panel: what belongs together, set off from the page by a hairline.
pub(crate) fn panel(c: &Colors) -> Div {
    v_flex()
        .min_w_0()
        .rounded(px(8.))
        .border_1()
        .border_color(c.border)
        .bg(c.bg)
}

/// A row of a panel, ruled from the one above it.
pub(crate) fn row(first: bool, c: &Colors) -> Div {
    h_flex()
        .px(px(16.))
        .py(px(12.))
        .gap(px(16.))
        .when(!first, |row| row.border_t_1().border_color(c.separator))
}

/// A section of a page: its title, and whatever trails it, over its
/// content.
pub(crate) fn section(
    title: impl Into<SharedString>,
    trailing: Option<AnyElement>,
    c: &Colors,
) -> Div {
    v_flex().gap(px(10.)).child(
        h_flex()
            .min_h(px(24.))
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .text_size(px(HEADING))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(c.fg)
                    .child(title.into()),
            )
            .children(trailing),
    )
}

/// A number set in even figures.
pub(crate) fn figure(value: impl Into<SharedString>, size: f32, c: &Colors) -> Div {
    div()
        .font_features(tabular())
        .text_size(px(size))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.fg)
        .child(value.into())
}

/// A total in a summary: what it counts, its value, and a note.
pub(crate) fn stat(
    title: &str,
    value: impl Into<SharedString>,
    note: impl AsRef<str>,
    c: &Colors,
) -> Div {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(4.))
        .child(caption(title, c).truncate())
        .child(figure(value, TITLE, c))
        .child(caption(note, c).text_color(c.faint).truncate())
}

/// Totals side by side across a panel, a rule between each.
pub(crate) fn stats<const N: usize>(cells: [Div; N], c: &Colors) -> Div {
    h_flex()
        .items_stretch()
        .children(cells.into_iter().enumerate().map(|(i, cell)| {
            cell.p(px(16.))
                .when(i > 0, |cell| cell.border_l_1().border_color(c.separator))
        }))
}

/// Secondary text.
pub(crate) fn caption(text: impl AsRef<str>, c: &Colors) -> Div {
    div()
        .text_size(px(SMALL))
        .text_color(c.muted)
        .child(text.as_ref().to_owned())
}

pub(crate) fn dot(color: Hsla) -> Div {
    div().flex_shrink_0().size(px(6.)).rounded_full().bg(color)
}

/// A state in words beside a dot of its tone. A good state reads in the
/// text's own color, a quiet one in secondary text, and the rest in theirs.
pub(crate) fn label(label: &Label, c: &Colors) -> Div {
    let words = div().min_w_0().truncate().child(sentence(&label.text));
    let line = h_flex().min_w_0().gap(px(7.));
    match label.tone {
        Tone::Muted | Tone::Accent => line.text_color(c.muted).child(words),
        Tone::Good => line.text_color(c.fg).child(dot(c.good)).child(words),
        tone => line
            .text_color(c.tone(tone))
            .child(dot(c.tone(tone)))
            .child(words),
    }
}

/// The core's words, set as `slopmax status` sets them, as a window's:
/// without the dot that leads an active account, as the window draws its
/// own; capitalized; and with commas where the terminal sets parts apart
/// with dots.
pub(crate) fn sentence(text: &str) -> String {
    let text = text
        .trim_start_matches('●')
        .trim_start()
        .replace(" · ", ", ");
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// A word or a count on a quiet chip, as a plan or a total shows.
pub(crate) fn badge(text: impl Into<SharedString>, c: &Colors) -> Div {
    h_flex()
        .flex_shrink_0()
        .h(px(20.))
        .px(px(7.))
        .rounded(px(5.))
        .border_1()
        .border_color(c.border)
        .text_size(px(11.5))
        .text_color(c.muted)
        .child(text.into())
}

/// A meter filled to `fraction`.
pub(crate) fn meter(fraction: f32, color: Hsla, c: &Colors) -> Div {
    let fraction = fraction.clamp(0., 1.);
    div()
        .h(px(4.))
        .rounded(px(2.))
        .bg(c.track)
        .when(fraction > 0., |track| {
            track.child(
                div()
                    .h_full()
                    .w(relative(fraction))
                    .min_w(px(2.))
                    .rounded(px(2.))
                    .bg(color),
            )
        })
}

/// A usage window across a pool: a segment for each account, filled to its
/// use, neutral until it runs short. An account out of service fades.
pub(crate) fn segments(shares: &[Share], c: &Colors) -> Div {
    h_flex().gap(px(3.)).children(shares.iter().map(|share| {
        meter(share.fraction, c.fill(share.tone), c)
            .flex_1()
            .when(share.idle, |bar| bar.opacity(0.4))
    }))
}

/// When a usage window resets: `Resets in 1h07m (22:59)`.
pub(crate) fn resets(gauge: &Gauge) -> String {
    match (&gauge.resets_in, &gauge.resets_at) {
        (Some(left), Some(at)) => format!("Resets in {left} ({at})"),
        (Some(left), None) => format!("Resets in {left}"),
        _ => "Nothing to reset".to_owned(),
    }
}

/// A chart's series, each named beside a swatch of its color.
pub(crate) fn legend<'a>(series: impl IntoIterator<Item = (Hsla, &'a str)>, c: &Colors) -> Div {
    h_flex()
        .gap(px(14.))
        .text_size(px(SMALL))
        .text_color(c.muted)
        .children(series.into_iter().map(|(color, name)| {
            h_flex()
                .gap(px(6.))
                .child(swatch(color))
                .child(name.to_owned())
        }))
}

/// A series' color, as a legend shows it.
pub(crate) fn swatch(color: Hsla) -> Div {
    div().flex_shrink_0().size(px(8.)).rounded(px(2.)).bg(color)
}

/// slopmax's mark: three rising bars on a tile of its pink, as the app's
/// icon draws them on a 64-point grid.
pub(crate) fn logo(size: f32, c: &Colors) -> Div {
    let unit = size / 64.;
    div()
        .relative()
        .flex_shrink_0()
        .size(px(size))
        .rounded(px(14. * unit))
        .bg(c.accent)
        .children(
            [(14., 34., 16.), (27.5, 24., 26.), (41., 14., 36.)].map(|(x, y, h)| {
                div()
                    .absolute()
                    .left(px(x * unit))
                    .top(px(y * unit))
                    .w(px(9. * unit))
                    .h(px(h * unit))
                    .rounded(px(2. * unit))
                    .bg(white())
            }),
        )
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
        rgb(0x333338).into()
    } else {
        white()
    };
    let mut track = h_flex()
        .flex_shrink_0()
        .h(px(CONTROL))
        .p(px(2.))
        .gap(px(2.))
        .rounded(px(7.))
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
                .px(px(10.))
                .flex()
                .items_center()
                .rounded(px(5.))
                .text_size(px(SMALL))
                .font_weight(FontWeight::MEDIUM)
                .role(Role::RadioButton)
                .aria_label(title)
                .aria_selected(selected)
                .map(|segment| {
                    if selected {
                        segment
                            .bg(raised)
                            .text_color(c.fg)
                            .border_1()
                            .border_color(c.border)
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

/// What a page says while it has nothing to show: what is missing, and
/// what will fill it.
pub(crate) fn empty(title: &str, detail: &str, c: &Colors) -> Div {
    panel(c)
        .items_center()
        .py(px(40.))
        .gap(px(4.))
        .child(
            div()
                .font_weight(FontWeight::MEDIUM)
                .text_color(c.fg)
                .child(title.to_owned()),
        )
        .child(caption(detail, c))
}

#[cfg(test)]
mod tests {
    // Not the glob, which brings GPUI's own `test` attribute.
    use super::sentence;

    #[test]
    fn the_cores_words_read_as_a_sentence() {
        assert_eq!(sentence("ready"), "Ready");
        assert_eq!(sentence("● active · 2 sessions"), "Active, 2 sessions");
        assert_eq!(sentence("limited · back in 1h"), "Limited, back in 1h");
        assert_eq!(sentence("120 req · 5.2M tok"), "120 req, 5.2M tok");
        assert_eq!(sentence(""), "");
    }
}
