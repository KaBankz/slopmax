//! Terminal output: colors, usage bars, and column padding. Durations and
//! counts come from [`crate::human`]; input is read by `cli::term`.

use std::fmt::Display;
use std::io::IsTerminal;
use std::sync::OnceLock;

fn color_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED
        .get_or_init(|| std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal())
}

fn paint(code: &str, text: impl Display) -> String {
    if color_enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn bold(text: impl Display) -> String {
    paint("1", text)
}

pub fn dim(text: impl Display) -> String {
    paint("2", text)
}

pub fn red(text: impl Display) -> String {
    paint("31", text)
}

pub fn green(text: impl Display) -> String {
    paint("32", text)
}

pub fn yellow(text: impl Display) -> String {
    paint("33", text)
}

pub fn cyan(text: impl Display) -> String {
    paint("36", text)
}

/// Colors `text` by how much of a quota is used.
pub fn by_level(percent: f64, text: impl Display) -> String {
    match percent {
        p if p >= 90.0 => red(text),
        p if p >= 70.0 => yellow(text),
        _ => green(text),
    }
}

/// A fixed-width usage bar such as `██████░░░░`.
pub fn bar(percent: f64, width: usize) -> String {
    let filled = ((percent.clamp(0.0, 100.0) / 100.0) * width as f64).round() as usize;
    let body = format!("{}{}", "█".repeat(filled), "░".repeat(width - filled));
    by_level(percent, body)
}

/// Pads `text` to `width` columns, ignoring ANSI escapes when measuring.
pub fn pad(text: &str, width: usize) -> String {
    let visible = visible_width(text);
    format!("{text}{}", " ".repeat(width.saturating_sub(visible)))
}

/// Display width of `text` with ANSI color escapes stripped.
pub fn visible_width(text: &str) -> usize {
    let mut width = 0;
    let mut in_escape = false;
    for c in text.chars() {
        match (in_escape, c) {
            (false, '\x1b') => in_escape = true,
            (true, 'm') => in_escape = false,
            (true, _) => {}
            (false, _) => width += 1,
        }
    }
    width
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_width_ignores_escapes() {
        assert_eq!(visible_width("\x1b[31mabc\x1b[0m"), 3);
        assert_eq!(pad("\x1b[1mab\x1b[0m", 4), "\x1b[1mab\x1b[0m  ");
    }

    #[test]
    fn bar_fills_proportionally() {
        assert_eq!(visible_width(&bar(50.0, 10)), 10);
        assert!(bar(50.0, 10).contains("█████░░░░░"));
        assert!(bar(250.0, 4).contains("████"));
    }
}
