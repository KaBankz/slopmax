//! What pages are drawn with: a page laid out top to bottom, section
//! headings, bars for usage windows, and the charts, all from text cells.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Widget};
use slopmax_client::api::Tone;
use slopmax_client::api::report::tone_of_use;

use crate::app::Hit;
use crate::theme::Theme;

/// A page laid out from the top down, a line at a time, over a canvas
/// taller than the screen that is scrolled into view.
pub struct Flow<'a> {
    pub buf: &'a mut Buffer,
    pub theme: &'a Theme,
    pub hits: &'a mut Vec<(Rect, Hit)>,
    pub x: u16,
    pub width: u16,
    pub y: u16,
}

impl<'a> Flow<'a> {
    /// The canvas's last row.
    fn bottom(&self) -> u16 {
        self.buf.area.bottom()
    }

    /// One line, cut to the width.
    pub fn line(&mut self, line: Line<'_>) {
        if self.y < self.bottom() {
            self.buf.set_line(self.x, self.y, &line, self.width);
        }
        self.y += 1;
    }

    /// One line with `right` set against the right edge.
    pub fn split_line(&mut self, left: Line<'_>, right: Line<'_>) {
        if self.y < self.bottom() {
            let rw = (right.width() as u16).min(self.width);
            let lw = self.width.saturating_sub(rw + 1);
            self.buf.set_line(self.x, self.y, &left, lw);
            self.buf
                .set_line(self.x + self.width - rw, self.y, &right, rw);
        }
        self.y += 1;
    }

    pub fn gap(&mut self) {
        self.y += 1;
    }

    /// The next `height` rows, for a widget; cut at the canvas's end.
    pub fn take(&mut self, height: u16) -> Rect {
        let height = height.min(self.bottom().saturating_sub(self.y));
        let rect = Rect::new(self.x, self.y.min(self.bottom()), self.width, height);
        self.y += height;
        rect
    }

    pub fn hit(&mut self, rect: Rect, hit: Hit) {
        self.hits.push((rect, hit));
    }

    /// A section's heading: its title, a rule to the edge, and what is said
    /// of it at the end.
    pub fn section(&mut self, title: &str, trailing: Option<Line<'_>>) {
        if self.y >= self.bottom() {
            self.y += 2;
            return;
        }
        let theme = self.theme;
        let title = Span::styled(title.to_owned(), theme.strong());
        let tw = title.width() as u16;
        let trailing = trailing.unwrap_or_default();
        let rw = trailing.width() as u16;
        self.buf.set_span(self.x, self.y, &title, self.width);
        let rule_from = self.x + tw + 1;
        let rule_to = (self.x + self.width).saturating_sub(if rw > 0 { rw + 1 } else { 0 });
        for x in rule_from..rule_to {
            self.buf[(x, self.y)]
                .set_symbol("─")
                .set_style(theme.rule());
        }
        if rw > 0 && rw + tw + 2 <= self.width {
            self.buf
                .set_line(self.x + self.width - rw, self.y, &trailing, rw);
        }
        self.y += 2;
    }

    /// Lays out side by side: each of `widths` (in columns) gets a flow of
    /// its own from the same row, `gap` apart; the page goes on below the
    /// tallest.
    pub fn columns(
        &mut self,
        widths: &[u16],
        gap: u16,
        mut draw: impl FnMut(usize, &mut Flow<'_>),
    ) {
        let top = self.y;
        let mut x = self.x;
        let mut lowest = top;
        for (i, width) in widths.iter().enumerate() {
            let mut column = Flow {
                buf: &mut *self.buf,
                theme: self.theme,
                hits: &mut *self.hits,
                x,
                width: *width,
                y: top,
            };
            draw(i, &mut column);
            lowest = lowest.max(column.y);
            x += width + gap;
        }
        self.y = lowest;
    }

    /// Splits the width into `n` columns `gap` apart, the last taking what
    /// is left over.
    pub fn even(&self, n: u16, gap: u16) -> Vec<u16> {
        let n = n.max(1);
        let each = (self.width.saturating_sub(gap * (n - 1))) / n;
        let mut widths = vec![each; n as usize];
        if let Some(last) = widths.last_mut() {
            *last = self.width.saturating_sub((each + gap) * (n - 1));
        }
        widths
    }

    /// A line of text in a style, wrapped at word boundaries to the width.
    pub fn wrapped(&mut self, text: &str, style: Style, indent: u16) {
        let width = self.width.saturating_sub(indent).max(8) as usize;
        for line in wrap(text, width) {
            self.line(Line::from(vec![
                Span::raw(" ".repeat(indent as usize)),
                Span::styled(line, style),
            ]));
        }
    }
}

/// `text` broken into lines of at most `width` columns, at spaces.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let fits = Line::from(format!("{current} {word}")).width() <= width;
        if current.is_empty() {
            current = word.to_owned();
        } else if fits {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(std::mem::take(&mut current));
            current = word.to_owned();
        }
    }
    if !current.is_empty() || lines.is_empty() {
        lines.push(current);
    }
    lines
}

/// A dot in a tone: what a condition or a finding leads with.
pub fn dot(theme: &Theme, tone: Tone) -> Span<'static> {
    Span::styled("●", theme.tone(tone))
}

/// A usage bar `width` columns wide: the used part a heavy line in its
/// tone, the rest a light one, in half-column steps.
pub fn bar(
    theme: &Theme,
    fraction: f64,
    width: u16,
    tone: Tone,
    faded: bool,
) -> Vec<Span<'static>> {
    let width = width as usize;
    let halves = (fraction.clamp(0.0, 1.0) * width as f64 * 2.0).round() as usize;
    let (full, half) = (halves / 2, halves % 2);
    let mut style = theme.tone(tone);
    if faded {
        style = style.add_modifier(Modifier::DIM);
    }
    let rest = width.saturating_sub(full + half);
    let mut spans = vec![Span::styled("━".repeat(full), style)];
    if half == 1 {
        spans.push(Span::styled("╸", style));
    }
    spans.push(Span::styled("─".repeat(rest), theme.track()));
    spans
}

/// A usage bar in the tone its use calls for.
pub fn usage_bar(theme: &Theme, used: f64, width: u16, faded: bool) -> Vec<Span<'static>> {
    bar(theme, used / 100.0, width, tone_of_use(used), faded)
}

/// One account's part of a pool's bar.
pub struct Segment {
    /// Its share of the pool.
    pub weight: f64,
    pub used: f64,
    /// Not serving: turned off or signed out.
    pub idle: bool,
}

/// A pool's bar: one segment per account, as wide as its share and filled
/// as far as it is used, a column apart.
pub fn segmented_bar(theme: &Theme, segments: &[Segment], width: u16) -> Vec<Span<'static>> {
    if segments.len() <= 1 {
        let used = segments.first().map_or(0.0, |s| s.used);
        return usage_bar(theme, used, width, false);
    }
    let gaps = segments.len() as u16 - 1;
    let room = width.saturating_sub(gaps) as f64;
    let total: f64 = segments
        .iter()
        .map(|s| s.weight.max(0.0))
        .sum::<f64>()
        .max(f64::EPSILON);
    let mut spans = Vec::new();
    let mut given = 0u16;
    for (i, segment) in segments.iter().enumerate() {
        let last = i + 1 == segments.len();
        let w = if last {
            width.saturating_sub(gaps).saturating_sub(given)
        } else {
            ((segment.weight.max(0.0) / total) * room).round().max(1.0) as u16
        };
        given += w;
        if segment.idle {
            spans.push(Span::styled("┄".repeat(w as usize), theme.track()));
        } else {
            spans.extend(usage_bar(theme, segment.used, w, false));
        }
        if !last {
            spans.push(Span::raw(" "));
        }
    }
    spans
}

const EIGHTHS: [&str; 9] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/// Columns, one per value, scaled to the largest and as tall as `area`,
/// in eighths of a row; `style` picks a style per column.
pub fn column_chart(
    buf: &mut Buffer,
    area: Rect,
    values: &[f64],
    style: impl Fn(usize) -> Style,
    gap: bool,
) {
    let most = values.iter().copied().fold(0.0, f64::max);
    scaled_columns(buf, area, values, most, style, gap);
}

/// Columns as [`column_chart`] draws them, with `most` filling `area`, so
/// charts side by side can share a scale.
pub fn scaled_columns(
    buf: &mut Buffer,
    area: Rect,
    values: &[f64],
    most: f64,
    style: impl Fn(usize) -> Style,
    gap: bool,
) {
    if values.is_empty() || area.width == 0 || area.height == 0 {
        return;
    }
    let n = values.len() as u16;
    let step = (area.width / n).max(1);
    let bar_w = if gap && step >= 3 { step - 1 } else { step };
    let left = area.x + (area.width.saturating_sub(step * n)) / 2;
    for (i, value) in values.iter().enumerate() {
        let x = left + i as u16 * step;
        if x + bar_w > area.right() {
            break;
        }
        let eighths = if most > 0.0 {
            ((value / most).min(1.0) * f64::from(area.height) * 8.0).round() as u16
        } else {
            0
        };
        // A sliver for any value at all, so a quiet hour shows.
        let eighths = if *value > 0.0 { eighths.max(1) } else { 0 };
        for row in 0..area.height {
            let from_bottom = row * 8;
            let fill = eighths.saturating_sub(from_bottom).min(8);
            let y = area.bottom() - 1 - row;
            let symbol = if fill == 0 && row == 0 {
                "▁"
            } else {
                EIGHTHS[fill as usize]
            };
            let cell_style = if fill == 0 && row == 0 {
                Style::new().add_modifier(Modifier::DIM)
            } else {
                style(i)
            };
            for dx in 0..bar_w {
                buf[(x + dx, y)].set_symbol(symbol).set_style(cell_style);
            }
        }
    }
}

/// Labels under a column chart: as many as fit, spread evenly.
pub fn axis_labels(labels: &[String], width: u16) -> String {
    let n = labels.len();
    if n == 0 || width == 0 {
        return String::new();
    }
    let step = (width as usize / n).max(1);
    let longest = labels.iter().map(|l| l.chars().count()).max().unwrap_or(1) + 1;
    let every = longest.div_ceil(step).max(1);
    let left = (width as usize).saturating_sub(step * n) / 2;
    let mut out = vec![' '; width as usize];
    for (i, label) in labels.iter().enumerate() {
        if i % every != 0 {
            continue;
        }
        let at = left + i * step;
        for (j, c) in label.chars().enumerate() {
            if let Some(slot) = out.get_mut(at + j) {
                *slot = c;
            }
        }
    }
    out.into_iter().collect::<String>().trim_end().to_owned()
}

/// Lines through points (x and y from 0 to 1) in Braille dots, two across
/// and four down a cell, each line in its own style.
pub fn braille_lines(buf: &mut Buffer, area: Rect, series: &[(&[(f64, f64)], Style)]) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let (w, h) = (area.width as usize * 2, area.height as usize * 4);
    for (points, style) in series {
        let mut dots = vec![0u8; area.width as usize * area.height as usize];
        let to_dot = |(x, y): (f64, f64)| -> (i64, i64) {
            let px = (x.clamp(0.0, 1.0) * (w - 1) as f64).round() as i64;
            let py = ((1.0 - y.clamp(0.0, 1.0)) * (h - 1) as f64).round() as i64;
            (px, py)
        };
        let mut plot = |px: i64, py: i64| {
            if px < 0 || py < 0 || px as usize >= w || py as usize >= h {
                return;
            }
            let (cx, cy) = (px as usize / 2, py as usize / 4);
            let bit = match (px % 2, py % 4) {
                (0, 0) => 0x01,
                (0, 1) => 0x02,
                (0, 2) => 0x04,
                (0, _) => 0x40,
                (_, 0) => 0x08,
                (_, 1) => 0x10,
                (_, 2) => 0x20,
                _ => 0x80,
            };
            dots[cy * area.width as usize + cx] |= bit;
        };
        for pair in points.windows(2) {
            let (a, b) = (to_dot(pair[0]), to_dot(pair[1]));
            let steps = (b.0 - a.0).abs().max((b.1 - a.1).abs()).max(1);
            for s in 0..=steps {
                let t = s as f64 / steps as f64;
                plot(
                    (a.0 as f64 + (b.0 - a.0) as f64 * t).round() as i64,
                    (a.1 as f64 + (b.1 - a.1) as f64 * t).round() as i64,
                );
            }
        }
        if let [only] = points {
            let (px, py) = to_dot(*only);
            plot(px, py);
        }
        for (i, bits) in dots.iter().enumerate() {
            if *bits == 0 {
                continue;
            }
            let x = area.x + (i % area.width as usize) as u16;
            let y = area.y + (i / area.width as usize) as u16;
            let cell = &mut buf[(x, y)];
            // Dots already there from another line are kept.
            let had = cell
                .symbol()
                .chars()
                .next()
                .map(|c| c as u32)
                .filter(|c| (0x2800..=0x28FF).contains(c))
                .map_or(0, |c| (c - 0x2800) as u8);
            let symbol = char::from_u32(0x2800 + u32::from(had | bits)).unwrap_or(' ');
            cell.set_char(symbol).set_style(*style);
        }
    }
}

/// Counts as shades, darkest for the most: for a week by hour.
pub fn shade(value: u64, most: u64) -> &'static str {
    if value == 0 || most == 0 {
        return "·";
    }
    match value as f64 / most as f64 {
        f if f > 0.75 => "█",
        f if f > 0.5 => "▓",
        f if f > 0.25 => "▒",
        _ => "░",
    }
}

/// A panel: a rounded, dim border with a title, around `area`; gives back
/// what is inside.
pub fn panel(buf: &mut Buffer, theme: &Theme, area: Rect, title: Option<Line<'_>>) -> Rect {
    let mut block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(theme.rule());
    if let Some(title) = title {
        block = block.title(title);
    }
    let inner = block.inner(area);
    block.render(area, buf);
    inner
}

/// A figure: its title, the figure in bold, and a note under it, in a panel.
pub struct Stat {
    pub title: String,
    pub value: String,
    pub note: String,
    /// A change against the span before: `▲ 12%`, in its tone.
    pub change: Option<(String, Tone)>,
}

/// The narrowest a figure's panel is drawn; narrower, they go two across.
const CARD: u16 = 22;

/// Figures side by side in panels, four rows tall with their borders: all
/// in a row where each gets `CARD` columns, else two across. What doesn't
/// fit a panel is cut with an ellipsis, never past its border.
pub fn stats(flow: &mut Flow<'_>, stats: &[Stat]) {
    if stats.is_empty() {
        return;
    }
    let n = stats.len() as u16;
    let across = if flow.width + 1 >= n * (CARD + 1) {
        n
    } else {
        n.min(2)
    };
    for chunk in stats.chunks(across as usize) {
        let widths = flow.even(across, 1);
        let theme = flow.theme;
        flow.columns(&widths, 1, |i, column| {
            let Some(stat) = chunk.get(i) else {
                return;
            };
            let area = column.take(5);
            let inner = panel(column.buf, theme, area, None);
            let inner = Rect {
                x: inner.x + 1,
                width: inner.width.saturating_sub(2),
                ..inner
            };
            let room = inner.width as usize;
            let fit = |text: &str| crate::format::fit(text, room);
            let value = {
                let mut spans = vec![Span::styled(fit(&stat.value), theme.strong())];
                // The change goes where it fits beside the figure.
                if let Some((change, tone)) = &stat.change
                    && Line::from(format!("{}  {change}", stat.value)).width() <= room
                {
                    spans.push(Span::raw("  "));
                    spans.push(Span::styled(change.clone(), theme.tone(*tone)));
                }
                Line::from(spans)
            };
            let rows = [
                Line::from(Span::styled(fit(&stat.title), theme.muted())),
                value,
                Line::from(Span::styled(fit(&stat.note), theme.muted())),
            ];
            for (dy, line) in rows.iter().enumerate() {
                if (dy as u16) < inner.height {
                    column
                        .buf
                        .set_line(inner.x, inner.y + dy as u16, line, inner.width);
                }
            }
        });
    }
}

/// `▲ 12%` or `▼ 4%` against the span before; nothing without one.
pub fn change(now: f64, then: f64, up_is_good: bool) -> Option<(String, Tone)> {
    if then <= 0.0 || !now.is_finite() {
        return None;
    }
    let by = (now - then) / then * 100.0;
    if by.abs() < 0.5 {
        return Some(("±0%".into(), Tone::Muted));
    }
    let tone = match (by > 0.0, up_is_good) {
        (true, true) | (false, false) => Tone::Good,
        _ => Tone::Muted,
    };
    let arrow = if by > 0.0 { "▲" } else { "▼" };
    Some((format!("{arrow} {:.0}%", by.abs()), tone))
}

/// A row of a bar list: its name, a bar as long as its share of the most,
/// and its figures to the right.
pub fn bar_row(
    flow: &mut Flow<'_>,
    name: &str,
    fraction: f64,
    figures: &[String],
    name_width: u16,
) {
    let theme = flow.theme;
    let figure_widths: u16 = figures.iter().map(|f| f.chars().count() as u16 + 2).sum();
    let bar_width = flow
        .width
        .saturating_sub(name_width + 1 + figure_widths)
        .max(4);
    let mut spans = vec![Span::raw(crate::format::fit(name, name_width as usize))];
    let pad = name_width as usize
        - Line::from(spans[0].content.to_string())
            .width()
            .min(name_width as usize);
    spans.push(Span::raw(" ".repeat(pad + 1)));
    spans.extend(
        bar(theme, fraction, bar_width, Tone::Muted, false)
            .into_iter()
            .map(|s| {
                if s.content.starts_with('━') || s.content.starts_with('╸') {
                    s.style(theme.ink())
                } else {
                    s
                }
            }),
    );
    for (i, figure) in figures.iter().enumerate() {
        let style = if i == 0 {
            theme.strong()
        } else {
            theme.muted()
        };
        spans.push(Span::raw("  "));
        spans.push(Span::styled(figure.clone(), style));
    }
    flow.line(Line::from(spans));
}

/// Tabs to pick from, the current one bold and marked; each clickable.
pub fn tabs<T: Copy + PartialEq>(
    flow: &mut Flow<'_>,
    x: u16,
    y: u16,
    items: &[(T, &str)],
    current: T,
    hit: impl Fn(T) -> Hit,
) -> u16 {
    let theme = flow.theme;
    let mut at = x;
    for (i, (item, title)) in items.iter().enumerate() {
        if i > 0 {
            flow.buf.set_string(at, y, " · ", theme.muted());
            at += 3;
        }
        let style = if *item == current {
            theme
                .accent()
                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        } else {
            theme.muted()
        };
        let w = title.chars().count() as u16;
        if at + w > flow.x + flow.width {
            break;
        }
        flow.buf.set_string(at, y, *title, style);
        flow.hits.push((Rect::new(at, y, w, 1), hit(*item)));
        at += w;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(spans: &[Span<'_>]) -> String {
        spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn bars_fill_in_half_columns() {
        let theme = Theme::plain();
        assert_eq!(text(&bar(&theme, 0.5, 10, Tone::Good, false)), "━━━━━─────");
        assert_eq!(
            text(&bar(&theme, 0.55, 10, Tone::Good, false)),
            "━━━━━╸────"
        );
        assert_eq!(text(&bar(&theme, 1.2, 4, Tone::Good, false)), "━━━━");
        assert_eq!(text(&bar(&theme, 0.0, 4, Tone::Good, false)), "────");
    }

    #[test]
    fn a_pool_bar_gives_each_account_its_share() {
        let theme = Theme::plain();
        let segments = [
            Segment {
                weight: 3.0,
                used: 100.0,
                idle: false,
            },
            Segment {
                weight: 1.0,
                used: 0.0,
                idle: false,
            },
        ];
        assert_eq!(text(&segmented_bar(&theme, &segments, 13)), "━━━━━━━━━ ───");
        let off = [
            Segment {
                weight: 1.0,
                used: 50.0,
                idle: false,
            },
            Segment {
                weight: 1.0,
                used: 0.0,
                idle: true,
            },
        ];
        assert_eq!(text(&segmented_bar(&theme, &off, 9)), "━━── ┄┄┄┄");
    }

    #[test]
    fn text_wraps_at_spaces() {
        assert_eq!(
            wrap("the quick brown fox jumps", 10),
            ["the quick", "brown fox", "jumps"]
        );
        assert_eq!(wrap("", 10), [""]);
    }

    #[test]
    fn labels_space_out_to_fit() {
        let labels: Vec<String> = (0..24).map(|h| format!("{h:02}")).collect();
        assert_eq!(
            axis_labels(&labels, 48),
            "00  02  04  06  08  10  12  14  16  18  20  22"
        );
    }
}
