//! What every slopmax crate needs: wall-clock time without a date crate,
//! random identifiers, a small logger, durations and counts in short forms
//! for people, and where slopmax keeps its files.

pub mod human;
pub mod ids;
pub mod log;
pub mod time;

/// slopmax's directory: `$SLOPMAX_HOME`, else `~/.slopmax`.
pub fn home() -> std::path::PathBuf {
    std::env::var_os("SLOPMAX_HOME")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".slopmax")
        })
}
