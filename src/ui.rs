//! Terminal helpers: colors, usage bars, compact durations, and reading
//! secrets.

use std::fmt::Display;
use std::io::{BufRead, IsTerminal, Read};
use std::sync::OnceLock;

use crate::time::{SignedDuration, Timestamp};

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

/// A count in three significant figures: `1234567` → `1.2M`.
pub fn compact(n: u64) -> String {
    match n {
        n if n >= 1_000_000_000 => format!("{:.1}B", n as f64 / 1e9),
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

/// Formats a duration with its two most significant units, e.g. `3d4h`,
/// `2h05m`, `9m30s`.
pub fn duration(d: SignedDuration) -> String {
    let secs = d.as_secs().max(0);
    let (days, hours, mins, s) = (
        secs / 86_400,
        secs % 86_400 / 3_600,
        secs % 3_600 / 60,
        secs % 60,
    );
    match (days, hours, mins) {
        (0, 0, 0) => format!("{s}s"),
        (0, 0, m) => format!("{m}m{s:02}s"),
        (0, h, m) => format!("{h}h{m:02}m"),
        (d, h, _) => format!("{d}d{h}h"),
    }
}

/// Time remaining until `at`, or `now` once it has passed.
pub fn until(at: Timestamp, now: Timestamp) -> String {
    let left = at.duration_since(now);
    if left.is_positive() {
        duration(left)
    } else {
        "now".into()
    }
}

/// Time elapsed since `at`, e.g. `5m00s ago`.
pub fn ago(at: Timestamp, now: Timestamp) -> String {
    format!("{} ago", duration(now.duration_since(at)))
}

/// Pads `text` to `width` columns, ignoring ANSI escapes when measuring.
pub fn pad(text: &str, width: usize) -> String {
    let visible = visible_width(text);
    format!("{text}{}", " ".repeat(width.saturating_sub(visible)))
}

/// Reads a secret such as an API key: typed without echo at a terminal, or
/// read whole from stdin when it is piped in, so it never sits in argv or
/// shell history.
pub fn read_secret(prompt: &str) -> std::io::Result<String> {
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        let mut text = String::new();
        stdin.lock().read_to_string(&mut text)?;
        return Ok(text.trim().to_owned());
    }
    eprint!("{prompt}: ");
    let quiet = EchoOff::new();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    drop(quiet);
    eprintln!();
    Ok(line.trim().to_owned())
}

/// Turns off terminal echo until dropped.
struct EchoOff {
    #[cfg(unix)]
    saved: Option<libc::termios>,
}

impl EchoOff {
    #[cfg(unix)]
    fn new() -> Self {
        // SAFETY: tcgetattr and tcsetattr only read and write the termios
        // they are given, which lives on this stack frame.
        unsafe {
            let mut term: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut term) != 0 {
                return Self { saved: None };
            }
            let saved = term;
            term.c_lflag &= !libc::ECHO;
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &term) != 0 {
                return Self { saved: None };
            }
            Self { saved: Some(saved) }
        }
    }

    #[cfg(not(unix))]
    fn new() -> Self {
        Self {}
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(saved) = &self.saved {
            // SAFETY: as in `new`.
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, saved);
            }
        }
    }
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
    fn durations_use_two_units() {
        let f = |s| duration(SignedDuration::from_secs(s));
        assert_eq!(f(42), "42s");
        assert_eq!(f(9 * 60 + 30), "9m30s");
        assert_eq!(f(2 * 3600 + 5 * 60 + 59), "2h05m");
        assert_eq!(f(3 * 86_400 + 4 * 3600 + 120), "3d4h");
        assert_eq!(f(-5), "0s");
    }

    #[test]
    fn until_reports_now_when_passed() {
        let now = Timestamp::from_second(1_000).unwrap();
        assert_eq!(until(Timestamp::from_second(900).unwrap(), now), "now");
        assert_eq!(until(Timestamp::from_second(1_090).unwrap(), now), "1m30s");
    }

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
