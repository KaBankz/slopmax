//! A small leveled logger writing to stderr, which the background proxy
//! redirects to its log file.
//!
//! `SLOPMAX_LOG` sets the level: `error`, `warn`, `info`, `debug`, or `off`.
//! Filters in the `slopmax=debug` form that earlier versions documented are
//! read too.

use std::fmt;
use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

impl Level {
    fn parse(text: &str) -> Option<Option<Self>> {
        Some(match text.trim().to_ascii_lowercase().as_str() {
            "off" | "none" => None,
            "error" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" | "trace" => Some(Self::Debug),
            _ => return None,
        })
    }

    fn label(self) -> &'static str {
        match self {
            Self::Error => "ERROR",
            Self::Warn => "WARN ",
            Self::Info => "INFO ",
            Self::Debug => "DEBUG",
        }
    }

    fn color(self) -> &'static str {
        match self {
            Self::Error => "31",
            Self::Warn => "33",
            Self::Info => "32",
            Self::Debug => "2",
        }
    }
}

/// The most verbose level written; 0 means logging is off.
static MAX_LEVEL: AtomicU8 = AtomicU8::new(Level::Warn as u8);
static COLOR: AtomicBool = AtomicBool::new(false);

/// Sets the level from `SLOPMAX_LOG`, or `default` when it is unset or
/// unreadable.
pub fn init(default: Level) {
    let level = std::env::var("SLOPMAX_LOG")
        .ok()
        .and_then(|filter| parse_filter(&filter))
        .unwrap_or(Some(default));
    MAX_LEVEL.store(level.map_or(0, |l| l as u8), Ordering::Relaxed);
    let color = std::env::var_os("NO_COLOR").is_none() && std::io::stderr().is_terminal();
    COLOR.store(color, Ordering::Relaxed);
}

/// Reads `info` or `slopmax=info,other=warn`; the last directive for
/// slopmax (or without a target) wins.
fn parse_filter(filter: &str) -> Option<Option<Level>> {
    filter
        .rsplit(',')
        .find_map(|directive| match directive.split_once('=') {
            Some((target, level)) if target.trim() == "slopmax" => Level::parse(level),
            Some(_) => None,
            None => Level::parse(directive),
        })
}

pub fn enabled(level: Level) -> bool {
    level as u8 <= MAX_LEVEL.load(Ordering::Relaxed)
}

#[doc(hidden)]
pub fn write(level: Level, args: fmt::Arguments<'_>) {
    let time = Timestamp::now().display_millis();
    let label = if COLOR.load(Ordering::Relaxed) {
        format!("\x1b[{}m{}\x1b[0m", level.color(), level.label())
    } else {
        level.label().to_owned()
    };
    let _ = writeln!(std::io::stderr().lock(), "{time} {label} {args}");
}

#[doc(hidden)]
#[macro_export]
macro_rules! __log_at {
    ($level:ident, $($arg:tt)+) => {
        if $crate::log::enabled($crate::log::Level::$level) {
            $crate::log::write($crate::log::Level::$level, format_args!($($arg)+));
        }
    };
}

// Exported under prefixed names and used as `log::warn!`: a bare `warn`
// would clash with the built-in `#[warn]` attribute.
#[doc(hidden)]
#[macro_export]
macro_rules! __log_error {
    ($($arg:tt)+) => { $crate::__log_at!(Error, $($arg)+) };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __log_warn {
    ($($arg:tt)+) => { $crate::__log_at!(Warn, $($arg)+) };
}

#[doc(hidden)]
#[macro_export]
macro_rules! __log_info {
    ($($arg:tt)+) => { $crate::__log_at!(Info, $($arg)+) };
}

pub use crate::{__log_error as error, __log_info as info, __log_warn as warn};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_levels_and_target_filters() {
        assert_eq!(parse_filter("debug"), Some(Some(Level::Debug)));
        assert_eq!(parse_filter("off"), Some(None));
        assert_eq!(parse_filter("slopmax=info"), Some(Some(Level::Info)));
        assert_eq!(
            parse_filter("hyper=debug,slopmax=error"),
            Some(Some(Level::Error))
        );
        assert_eq!(parse_filter("hyper=debug"), None);
        assert_eq!(parse_filter("loud"), None);
    }

    #[test]
    fn levels_order_by_verbosity() {
        assert!(Level::Error < Level::Warn && Level::Info < Level::Debug);
    }

    #[test]
    fn labels_line_up_and_colors_tell_levels_apart() {
        let levels = [Level::Error, Level::Warn, Level::Info, Level::Debug];
        let labels: Vec<&str> = levels.iter().map(|l| l.label()).collect();
        assert_eq!(labels, ["ERROR", "WARN ", "INFO ", "DEBUG"]);
        let mut colors: Vec<&str> = levels.iter().map(|l| l.color()).collect();
        colors.dedup();
        assert_eq!(colors.len(), 4);
    }

    #[test]
    fn the_default_level_writes_warnings_and_errors_only() {
        // Nothing in these tests calls `init`, so the default stands.
        assert!(enabled(Level::Error));
        assert!(enabled(Level::Warn));
        assert!(!enabled(Level::Info));
        assert!(!enabled(Level::Debug));
        // Writing, plain and colored, never fails or panics.
        write(Level::Warn, format_args!("a test warning"));
        COLOR.store(true, Ordering::Relaxed);
        write(Level::Error, format_args!("a colored test error"));
        COLOR.store(false, Ordering::Relaxed);
        crate::__log_warn!("through the macro: {}", 1);
        crate::__log_info!("filtered out: {}", 2);
    }

    #[test]
    fn levels_read_case_and_space_insensitively() {
        assert_eq!(Level::parse(" WARNING "), Some(Some(Level::Warn)));
        assert_eq!(Level::parse("Trace"), Some(Some(Level::Debug)));
        assert_eq!(Level::parse("none"), Some(None));
        assert_eq!(Level::parse("error"), Some(Some(Level::Error)));
    }
}
