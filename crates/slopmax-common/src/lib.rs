//! What every slopmax crate needs: wall-clock time without a date crate,
//! random identifiers, a small logger, durations and counts in short forms
//! for people, where slopmax keeps its files, and finding a program on PATH.

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

/// Where `program` is on PATH, as a shell would find it. On Windows a name
/// without an extension is also tried with each of `PATHEXT`'s, so
/// `claude` finds `claude.exe` or `claude.cmd`.
pub fn which(program: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names = names(program, std::env::var("PATHEXT").ok().as_deref());
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// The file names `program` may have: on Windows, without an extension of
/// its own, it with each of `pathext`'s (or the usual ones).
fn names(program: &str, pathext: Option<&str>) -> Vec<String> {
    let bare = std::path::Path::new(program).extension().is_none();
    if !cfg!(windows) || !bare {
        return vec![program.to_owned()];
    }
    pathext
        .filter(|exts| !exts.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| format!("{program}{}", ext.to_ascii_lowercase()))
        .chain([program.to_owned()])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_are_found_on_path() {
        assert!(which("slopmax-no-such-program").is_none());
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(which(shell).is_some_and(|path| path.is_file()), "{shell}");
    }

    #[test]
    fn windows_tries_each_extension_of_a_bare_name() {
        let names = names("claude", Some(".EXE;.CMD"));
        if cfg!(windows) {
            assert_eq!(names, ["claude.exe", "claude.cmd", "claude"]);
            assert_eq!(super::names("claude", None)[0], "claude.com");
            assert_eq!(super::names("slopmax.exe", None), ["slopmax.exe"]);
        } else {
            assert_eq!(names, ["claude"]);
        }
    }
}
