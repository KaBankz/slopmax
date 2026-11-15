//! `slopmaxw.exe`: what Windows runs at login to keep the proxy running.
//!
//! slopmax.exe is a console program, so Windows opens a console window for
//! it when it starts at login. This one is a windowed program with no
//! window: it runs `slopmax.exe serve` without a console, its output going
//! to the log, and supervises it as systemd and launchd do elsewhere. A
//! clean exit (`slopmax stop`) ends it; exit code 75, an update's restart,
//! starts the proxy again at once; any other failure, after 5 seconds.
//!
//! `slopmaxw.exe <slopmax.exe> --log <file> [--home <dir>]`

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

/// What `/shutdown {"restart": true}` exits with: start again.
const RESTART: i32 = 75;
/// How long a failed proxy waits before it is started again.
const BACKOFF: Duration = Duration::from_secs(5);

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
struct Args {
    exe: PathBuf,
    log: PathBuf,
    home: Option<PathBuf>,
}

fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Args, String> {
    let mut args = args.into_iter();
    let (mut exe, mut log, mut home) = (None, None, None);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--log") => log = args.next().map(PathBuf::from),
            Some("--home") => home = args.next().map(PathBuf::from),
            _ if exe.is_none() => exe = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected argument {}", arg.to_string_lossy())),
        }
    }
    Ok(Args {
        exe: exe.ok_or("no slopmax.exe given")?,
        log: log.ok_or("no --log given")?,
        home,
    })
}

/// What to do once the proxy has exited with `code` (`None`: killed, or it
/// could not start at all).
#[derive(Debug, PartialEq, Eq)]
enum Next {
    Stop,
    Restart(Duration),
}

fn after(code: Option<i32>) -> Next {
    match code {
        Some(0) => Next::Stop,
        Some(RESTART) => Next::Restart(Duration::ZERO),
        _ => Next::Restart(BACKOFF),
    }
}

/// Runs the proxy until it exits cleanly, starting it again otherwise.
fn supervise(mut run: impl FnMut() -> Option<i32>, mut wait: impl FnMut(Duration)) {
    loop {
        match after(run()) {
            Next::Stop => return,
            Next::Restart(delay) => wait(delay),
        }
    }
}

fn main() -> ExitCode {
    let args = match parse(std::env::args_os().skip(1)) {
        Ok(args) => args,
        // A windowed program has nowhere to print; the caller checks the
        // arguments it writes.
        Err(_) => return ExitCode::from(2),
    };
    supervise(|| serve(&args), std::thread::sleep);
    ExitCode::SUCCESS
}

/// Runs `slopmax.exe serve` once, with no console, appending its output to
/// the log; returns its exit code.
fn serve(args: &Args) -> Option<i32> {
    let open = || {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&args.log)
    };
    let (Ok(out), Ok(err)) = (open(), open()) else {
        return None;
    };
    let mut command = std::process::Command::new(&args.exe);
    command
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err);
    if let Some(home) = &args.home {
        command.env("SLOPMAX_HOME", home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// CREATE_NO_WINDOW: the proxy gets no console of its own.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.status().ok()?.code()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse(list.iter().map(OsString::from))
    }

    #[test]
    fn reads_the_command_line_the_service_writes() {
        assert_eq!(
            args(&[r"C:\s\slopmax.exe", "--log", r"C:\h\slopmax.log"]).unwrap(),
            Args {
                exe: r"C:\s\slopmax.exe".into(),
                log: r"C:\h\slopmax.log".into(),
                home: None,
            }
        );
        let with_home = args(&["slopmax.exe", "--home", "h", "--log", "l"]).unwrap();
        assert_eq!(with_home.home, Some("h".into()));
        assert!(args(&["slopmax.exe"]).is_err());
        assert!(args(&["--log", "l"]).is_err());
        assert!(args(&["a.exe", "b.exe", "--log", "l"]).is_err());
    }

    #[test]
    fn restarts_until_a_clean_exit() {
        let mut codes = vec![Some(1), None, Some(RESTART), Some(0)].into_iter();
        let mut runs = 0;
        let mut waits = Vec::new();
        supervise(
            || {
                runs += 1;
                codes.next().unwrap()
            },
            |delay| waits.push(delay),
        );
        assert_eq!(runs, 4);
        assert_eq!(waits, [BACKOFF, BACKOFF, Duration::ZERO]);
    }
}
