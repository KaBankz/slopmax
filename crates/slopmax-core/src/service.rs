//! Running the proxy as a background service that starts at login: a
//! systemd user unit on Linux, a launchd agent on macOS, and on Windows
//! `slopmaxw.exe` in the user's Run key, which supervises the proxy as the
//! other two do (crates/slopmax-launcher).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::fsx;
use crate::paths::Home;
use crate::update::install::{self, Install};

const NAME: &str = "slopmax";
const LABEL: &str = "dev.slopmax";
/// Windows: the programs this user starts at login. Writing here takes no
/// administrator, unlike a scheduled task or a service.
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// Windows: the windowed program that runs the proxy, beside slopmax.exe.
const LAUNCHER: &str = "slopmaxw.exe";
/// systemd: load the new unit, start it at login, and run it now. Restart,
/// not `enable --now`: a proxy the unit already runs, even one still
/// finishing its requests, would keep the old binary, and once it exits
/// cleanly `Restart=on-failure` leaves nothing running.
const SYSTEMD_INSTALL: [&[&str]; 3] = [
    &["--user", "daemon-reload"],
    &["--user", "enable", NAME],
    &["--user", "restart", NAME],
];

/// The service manager on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Systemd,
    Launchd,
    /// The user's Run key starting `slopmaxw.exe`.
    Windows,
}

/// What the service manager knows about slopmax, for one home.
///
/// The service is the user's, one per machine, and runs the proxy for one
/// home: the one `SLOPMAX_HOME` named when it was installed. To any other
/// home it is not installed, so `start` there starts that home's proxy
/// itself rather than the service, which would run another home's.
#[derive(Debug, Clone, Copy, Default)]
pub struct Status {
    /// Installed for this home.
    pub installed: bool,
    /// Installed for this home and running.
    pub running: bool,
    /// Installed for another home.
    pub elsewhere: bool,
    /// Linux: whether the user's services keep running after logout.
    pub lingering: Option<bool>,
}

impl Manager {
    /// The manager available here, if slopmax knows how to use it.
    /// `SLOPMAX_NO_SERVICE` set hides it, for a demo or a test whose proxy
    /// must not become the user's login service: launchd and systemd are
    /// the user's own, whatever directories the environment moves.
    pub fn detect() -> Option<Self> {
        if std::env::var_os("SLOPMAX_NO_SERVICE").is_some_and(|v| !v.is_empty()) {
            return None;
        }
        if cfg!(target_os = "macos") {
            Some(Self::Launchd)
        } else if cfg!(windows) {
            Some(Self::Windows)
        } else if cfg!(target_os = "linux") && succeeds("systemctl", &["--user", "--version"]) {
            Some(Self::Systemd)
        } else {
            None
        }
    }

    fn file(self, home: &Home) -> PathBuf {
        match self {
            Self::Systemd => config_home(home)
                .join("systemd/user")
                .join(format!("{NAME}.service")),
            Self::Launchd => home
                .user()
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
            // A registry value rather than a file, named the way regedit
            // shows it.
            Self::Windows => PathBuf::from(format!("{RUN_KEY}\\{NAME}")),
        }
    }

    /// Writes the service definition for `exe`, then enables and starts it.
    ///
    /// On Linux and macOS the service runs `exe` through the home's link
    /// ([`Home::service_exe`]), which an update moves to the new binary:
    /// the definition never names a version that may be removed. launchd
    /// listens on `listen` for it.
    pub fn install(self, exe: &Path, home: &Home, listen: SocketAddr) -> Result<PathBuf> {
        let file = self.file(home);
        if self == Self::Windows {
            let log = home.log();
            let home = std::env::var_os("SLOPMAX_HOME").map(PathBuf::from);
            let line = windows_command(&launcher(exe)?, exe, &log, home.as_deref());
            run(
                "reg",
                &[
                    "add", RUN_KEY, "/v", NAME, "/t", "REG_SZ", "/d", &line, "/f",
                ],
            )?;
            // Replacing a running one, as launchd's bootout does.
            stop_launcher();
            spawn_launcher(exe, &log, home.as_deref())?;
            return Ok(file);
        }
        let resolved = exe.canonicalize().unwrap_or_else(|_| exe.to_path_buf());
        let target = Install::of(&resolved).entry(&resolved);
        install::link(home, &target)
            .with_context(|| format!("linking {}", home.service_exe().display()))?;
        let text = self
            .definition(home, listen)
            .context("Windows keeps no file")?;
        fsx::write_private(&file, text.as_bytes())
            .with_context(|| format!("writing {}", file.display()))?;
        match self {
            Self::Systemd => {
                for args in SYSTEMD_INSTALL {
                    run("systemctl", args)?;
                }
            }
            Self::Launchd => {
                // Replacing a loaded agent: unload it first (fails if absent).
                let _ = launchctl(&["bootout", &launchd_target()]);
                launchctl(&["bootstrap", &launchd_domain(), &file.to_string_lossy()])?;
            }
            Self::Windows => {}
        }
        Ok(file)
    }

    pub fn uninstall(self, home: &Home) -> Result<PathBuf> {
        let file = self.file(home);
        if let Some(other) = self.served(home).filter(|dir| !same_dir(dir, home.dir())) {
            bail!(
                "the login service runs slopmax for {}, not this home; remove it from there: \
                 SLOPMAX_HOME=\"{}\" slopmax proxy uninstall",
                home.show(&other),
                other.display()
            );
        }
        if self == Self::Windows {
            if !run_key_set() {
                bail!("no service installed");
            }
            // The proxy with it, as `systemctl disable --now` stops it.
            stop_launcher();
            run("reg", &["delete", RUN_KEY, "/v", NAME, "/f"])?;
            return Ok(file);
        }
        match self {
            Self::Systemd => {
                let _ = run("systemctl", &["--user", "disable", "--now", NAME]);
            }
            Self::Launchd => {
                let _ = launchctl(&["bootout", &launchd_target()]);
            }
            Self::Windows => {}
        }
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => bail!("no service installed"),
            Err(e) => return Err(e).with_context(|| format!("removing {}", file.display())),
        }
        if self == Self::Systemd {
            let _ = run("systemctl", &["--user", "daemon-reload"]);
        }
        Ok(file)
    }

    /// What this version writes for `home`: the unit or the plist, which
    /// runs the home's link. `None` on Windows, which keeps no file.
    fn definition(self, home: &Home, listen: SocketAddr) -> Option<String> {
        let exe = home.service_exe();
        let log = home.log();
        let moved = std::env::var_os("SLOPMAX_HOME").map(PathBuf::from);
        match self {
            Self::Systemd => Some(systemd_unit(&exe, &log, moved.as_deref())),
            Self::Launchd => Some(launchd_plist(&exe, &log, moved.as_deref(), listen)),
            Self::Windows => None,
        }
    }

    /// Whether the installed definition is not what this version writes:
    /// from an older slopmax, or for another listen address.
    pub fn outdated(self, home: &Home, listen: SocketAddr) -> bool {
        let Some(text) = self.definition(home, listen) else {
            return false;
        };
        std::fs::read_to_string(self.file(home)).is_ok_and(|old| old != text)
    }

    /// systemd: writes the unit anew when this home's (it runs the home's
    /// link) is outdated, and has systemd load it. The proxy it runs
    /// carries on: nothing here restarts it. Whether it was rewritten.
    pub fn refresh(self, home: &Home, listen: SocketAddr) -> Result<bool> {
        if self != Self::Systemd || !self.outdated(home, listen) {
            return Ok(false);
        }
        let file = self.file(home);
        let ours = format!("ExecStart=\"{}\" serve\n", home.service_exe().display());
        if !std::fs::read_to_string(&file).is_ok_and(|old| old.contains(&ours)) {
            return Ok(false);
        }
        let text = self.definition(home, listen).unwrap_or_default();
        fsx::write_private(&file, text.as_bytes())
            .with_context(|| format!("writing {}", file.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        Ok(true)
    }

    /// After the proxy was told to stop: launchd, which would start it
    /// again for the next connection to the socket it keeps, unloads the
    /// agent until `start` or the next login.
    pub fn stopped(self) {
        if self == Self::Launchd {
            let _ = launchctl(&["bootout", &launchd_target()]);
        }
    }

    pub fn status(self, home: &Home) -> Status {
        let served = self.served(home);
        let installed = served
            .as_deref()
            .is_some_and(|dir| same_dir(dir, home.dir()));
        let elsewhere = served.is_some() && !installed;
        let (running, lingering) = match self {
            Self::Windows => (installed && launcher_running(), None),
            Self::Systemd => (
                installed && succeeds("systemctl", &["--user", "is-active", "--quiet", NAME]),
                lingering(),
            ),
            Self::Launchd => (
                installed && launchctl(&["print", &launchd_target()]).is_ok(),
                None,
            ),
        };
        Status {
            installed,
            running,
            elsewhere,
            lingering,
        }
    }

    /// The home whose proxy the installed service runs, if one is
    /// installed: the `SLOPMAX_HOME` its definition sets, else the default
    /// one, `~/.slopmax`.
    pub fn served(self, home: &Home) -> Option<PathBuf> {
        let definition = match self {
            Self::Windows => {
                let output = Command::new("reg")
                    .args(["query", RUN_KEY, "/v", NAME])
                    .output()
                    .ok()
                    .filter(|o| o.status.success())?;
                String::from_utf8_lossy(&output.stdout).into_owned()
            }
            _ => std::fs::read_to_string(self.file(home)).ok()?,
        };
        Some(
            self.home_in(&definition)
                .unwrap_or_else(|| home.user().join(".slopmax")),
        )
    }

    /// The `SLOPMAX_HOME` a service definition sets, if it sets one.
    fn home_in(self, definition: &str) -> Option<PathBuf> {
        let value = match self {
            Self::Systemd => definition.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("Environment=\"SLOPMAX_HOME=")?
                    .strip_suffix('"')
                    .map(str::to_owned)
            })?,
            Self::Launchd => {
                let (_, rest) = definition.split_once("<key>SLOPMAX_HOME</key>")?;
                let (_, rest) = rest.split_once("<string>")?;
                let (value, _) = rest.split_once("</string>")?;
                value
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&amp;", "&")
            }
            Self::Windows => {
                let (_, rest) = definition.split_once(" --home \"")?;
                rest.split_once('"')?.0.to_owned()
            }
        };
        Some(PathBuf::from(value))
    }

    /// Starts the installed service, which runs `exe` (the one it was
    /// installed with, on Linux and macOS). An agent `stop` unloaded is
    /// loaded again, its plist written anew for `listen`.
    pub fn start(self, exe: &Path, home: &Home, listen: SocketAddr) -> Result<()> {
        match self {
            Self::Systemd => run("systemctl", &["--user", "start", NAME]),
            Self::Launchd if launchctl(&["print", &launchd_target()]).is_ok() => {
                launchctl(&["kickstart", &launchd_target()])
            }
            Self::Launchd => {
                let file = self.file(home);
                if self.outdated(home, listen) {
                    let text = self.definition(home, listen).unwrap_or_default();
                    fsx::write_private(&file, text.as_bytes())
                        .with_context(|| format!("writing {}", file.display()))?;
                }
                launchctl(&["bootstrap", &launchd_domain(), &file.to_string_lossy()])
            }
            // One already running starts the proxy itself, once its pause
            // after a failure is over.
            Self::Windows if launcher_running() => Ok(()),
            Self::Windows => {
                let home_dir = std::env::var_os("SLOPMAX_HOME").map(PathBuf::from);
                spawn_launcher(exe, &home.log(), home_dir.as_deref())
            }
        }
    }
}

/// Where the user's configuration lives (`$XDG_CONFIG_HOME` or `~/.config`).
fn config_home(home: &Home) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.user().join(".config"))
}

/// The user unit. `Type=notify`: systemd counts the proxy started once it
/// listens, and `NotifyAccess=all` lets a proxy that hands its socket to a
/// newer binary name that one the main process (`MAINPID=`), so an update
/// keeps the service running without a restart. The proxy keeps its socket
/// in the unit's store (`FileDescriptorStoreMax=`), which passes it to the
/// next process: through a crash, restarted within a second as often as it
/// takes, or a restart, connections wait rather than being refused. Room
/// for two, as systemd counts before it sees that a process offering the
/// socket again offers the one it holds.
fn systemd_unit(exe: &Path, log: &Path, home: Option<&Path>) -> String {
    let environment = home
        .map(|h| format!("Environment=\"SLOPMAX_HOME={}\"\n", h.display()))
        .unwrap_or_default();
    format!(
        "[Unit]\n\
         Description=slopmax account pool for Claude Code, Codex, and Grok Build\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         StartLimitIntervalSec=0\n\
         \n\
         [Service]\n\
         Type=notify\n\
         NotifyAccess=all\n\
         FileDescriptorStoreMax=2\n\
         ExecStart=\"{exe}\" serve\n\
         {environment}\
         Restart=on-failure\n\
         RestartSec=1\n\
         StandardOutput=append:{log}\n\
         StandardError=append:{log}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = exe.display(),
        log = log.display(),
    )
}

/// The agent. launchd binds the proxy's socket (`Listener`) when it loads
/// and keeps it: each process it starts takes it, so through a crash or a
/// restart connections wait rather than being refused, and once a proxy
/// that handed itself to a new binary exits, the process launchd starts
/// next takes over from that one. Processes it started that outlive the
/// proxy's are left be (`AbandonProcessGroup`).
fn launchd_plist(exe: &Path, log: &Path, home: Option<&Path>, listen: SocketAddr) -> String {
    let xml = |p: &Path| {
        p.display()
            .to_string()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let environment = home
        .map(|h| {
            format!(
                "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>SLOPMAX_HOME</key>\n    <string>{}</string>\n  </dict>\n",
                xml(h)
            )
        })
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>Sockets</key>
  <dict>
    <key>Listener</key>
    <dict>
      <key>SockNodeName</key>
      <string>{node}</string>
      <key>SockServiceName</key>
      <string>{port}</string>
      <key>SockFamily</key>
      <string>{family}</string>
      <key>SockType</key>
      <string>stream</string>
    </dict>
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
{environment}</dict>
</plist>
"#,
        exe = xml(exe),
        log = xml(log),
        node = listen.ip(),
        port = listen.port(),
        family = if listen.is_ipv4() { "IPv4" } else { "IPv6" },
    )
}

/// Windows: `slopmaxw.exe` beside `exe`, which the release archive ships.
fn launcher(exe: &Path) -> Result<PathBuf> {
    let launcher = exe.with_file_name(LAUNCHER);
    if !launcher.is_file() {
        bail!(
            "{LAUNCHER}, which runs slopmax at login, is not beside {}; it comes in slopmax's Windows release archive",
            exe.display()
        );
    }
    Ok(launcher)
}

/// Windows: the Run key's command line. Windows paths cannot hold `"`, so
/// quoting each is enough.
fn windows_command(launcher: &Path, exe: &Path, log: &Path, home: Option<&Path>) -> String {
    let mut line = format!(
        "\"{}\" \"{}\" --log \"{}\"",
        launcher.display(),
        exe.display(),
        log.display()
    );
    if let Some(home) = home {
        line.push_str(&format!(" --home \"{}\"", home.display()));
    }
    line
}

/// Windows: starts `slopmaxw.exe` now, as logging in would. It has no
/// window, and outlives this process.
fn spawn_launcher(exe: &Path, log: &Path, home: Option<&Path>) -> Result<()> {
    let mut command = Command::new(launcher(exe)?);
    command.arg(exe).arg("--log").arg(log);
    if let Some(home) = home {
        command.arg("--home").arg(home);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .with_context(|| format!("starting {LAUNCHER}"))?;
    Ok(())
}

/// Windows: ends this user's `slopmaxw.exe` and the proxy it runs (`/T`,
/// its child), if one runs.
fn stop_launcher() {
    let _ = run("taskkill", &["/IM", LAUNCHER, "/T", "/F"]);
}

fn run_key_set() -> bool {
    succeeds("reg", &["query", RUN_KEY, "/v", NAME])
}

/// Whether `a` and `b` are one directory, written alike or not.
fn same_dir(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (a.canonicalize(), b.canonicalize()),
            (Ok(a), Ok(b)) if a == b
        )
}

fn launcher_running() -> bool {
    let filter = format!("IMAGENAME eq {LAUNCHER}");
    Command::new("tasklist")
        .args(["/FI", &filter, "/NH"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(LAUNCHER))
}

/// Linux: whether user services outlive the login session.
fn lingering() -> Option<bool> {
    let user = std::env::var("USER").ok()?;
    let output = Command::new("loginctl")
        .args(["show-user", &user, "--property=Linger"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    Some(text.trim() == "Linger=yes")
}

fn launchd_domain() -> String {
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    format!("gui/{uid}")
}

fn launchd_target() -> String {
    format!("{}/{LABEL}", launchd_domain())
}

fn launchctl(args: &[&str]) -> Result<()> {
    run("launchctl", args)
}

fn succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("running {program}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("{program} {} failed: {}", args.join(" "), stderr.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_over_a_running_unit_restarts_it() {
        let last = SYSTEMD_INSTALL.last().unwrap();
        assert_eq!(*last, ["--user", "restart", NAME]);
        assert!(!SYSTEMD_INSTALL.iter().any(|args| args.contains(&"--now")));
    }

    #[test]
    fn systemd_unit_runs_serve_and_appends_to_the_log() {
        let unit = systemd_unit(
            Path::new("/opt/slopmax/bin/slopmax"),
            Path::new("/home/u/.slopmax/slopmax.log"),
            None,
        );
        assert!(unit.contains("ExecStart=\"/opt/slopmax/bin/slopmax\" serve\n"));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("StandardOutput=append:/home/u/.slopmax/slopmax.log\n"));
        assert!(unit.contains("WantedBy=default.target\n"));
        assert!(!unit.contains("Environment="));
        let custom = systemd_unit(
            Path::new("/x"),
            Path::new("/y"),
            Some(Path::new("/srv/slopmax")),
        );
        assert!(custom.contains("Environment=\"SLOPMAX_HOME=/srv/slopmax\"\n"));
    }

    #[test]
    fn windows_runs_the_launcher_with_the_proxy_and_its_log() {
        let line = windows_command(
            Path::new(r"C:\Program Files\slopmax\slopmaxw.exe"),
            Path::new(r"C:\Program Files\slopmax\slopmax.exe"),
            Path::new(r"C:\Users\me\.slopmax\slopmax.log"),
            None,
        );
        assert_eq!(
            line,
            r#""C:\Program Files\slopmax\slopmaxw.exe" "C:\Program Files\slopmax\slopmax.exe" --log "C:\Users\me\.slopmax\slopmax.log""#
        );
        let moved = windows_command(
            Path::new("w.exe"),
            Path::new("s.exe"),
            Path::new("l"),
            Some(Path::new(r"D:\pool")),
        );
        assert!(moved.ends_with(r#" --home "D:\pool""#), "{moved}");
        assert_eq!(
            Manager::Windows.file(&Home::sandbox("/home/someone")),
            PathBuf::from(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\slopmax")
        );
    }

    #[test]
    fn windows_needs_the_launcher_beside_the_cli() {
        let dir = std::env::temp_dir().join(format!("slopmax-launcher-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("slopmax.exe");
        let error = launcher(&exe).unwrap_err().to_string();
        assert!(error.starts_with("slopmaxw.exe, which runs slopmax at login, is not beside"));
        std::fs::write(dir.join(LAUNCHER), b"").unwrap();
        assert_eq!(launcher(&exe).unwrap(), dir.join(LAUNCHER));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn launchd_plist_escapes_paths() {
        let plist = launchd_plist(
            Path::new("/Users/a&b/slopmax"),
            Path::new("/Users/a&b/.slopmax/slopmax.log"),
            None,
            "127.0.0.1:7567".parse().unwrap(),
        );
        assert!(plist.contains("<string>/Users/a&amp;b/slopmax</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(!plist.contains("EnvironmentVariables"));
    }

    #[test]
    fn launchd_plist_sets_slopmax_home_when_moved() {
        let plist = launchd_plist(
            Path::new("/bin/slopmax"),
            Path::new("/l.log"),
            Some(Path::new("/srv/<home>")),
            "127.0.0.1:7567".parse().unwrap(),
        );
        assert!(plist.contains(
            "<key>EnvironmentVariables</key>\n  <dict>\n    <key>SLOPMAX_HOME</key>\n    <string>/srv/&lt;home&gt;</string>"
        ));
        assert!(plist.contains("<string>dev.slopmax</string>"));
        assert!(plist.ends_with("</dict>\n</plist>\n"));
    }

    #[test]
    fn launchd_keeps_the_proxys_socket() {
        let plist = launchd_plist(
            Path::new("/bin/slopmax"),
            Path::new("/l.log"),
            None,
            "127.0.0.1:7567".parse().unwrap(),
        );
        assert!(plist.contains(
            "<key>Sockets</key>\n  <dict>\n    <key>Listener</key>\n    <dict>\n      \
             <key>SockNodeName</key>\n      <string>127.0.0.1</string>\n      \
             <key>SockServiceName</key>\n      <string>7567</string>\n      \
             <key>SockFamily</key>\n      <string>IPv4</string>"
        ));
        assert!(plist.contains("<key>AbandonProcessGroup</key>\n  <true/>"));
        assert!(plist.contains("<key>ThrottleInterval</key>\n  <integer>1</integer>"));
        let v6 = launchd_plist(
            Path::new("/bin/slopmax"),
            Path::new("/l.log"),
            None,
            "[::1]:9000".parse().unwrap(),
        );
        assert!(v6.contains("<string>::1</string>"));
        assert!(v6.contains("<string>9000</string>"));
        assert!(v6.contains("<string>IPv6</string>"));
    }

    #[test]
    fn an_outdated_unit_is_written_anew_only_when_it_is_this_homes() {
        let root = std::env::temp_dir().join(format!("slopmax-refresh-{}", std::process::id()));
        let home = Home::sandbox(&root);
        let listen: SocketAddr = "127.0.0.1:7567".parse().unwrap();
        let file = Manager::Systemd.file(&home);
        if !file.starts_with(&root) {
            // XDG_CONFIG_HOME puts units elsewhere: the user's own.
            return;
        }
        assert!(
            !Manager::Systemd.outdated(&home, listen),
            "nothing installed"
        );
        let current = Manager::Systemd.definition(&home, listen).unwrap();
        assert!(current.contains("FileDescriptorStoreMax=2\n"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, &current).unwrap();
        assert!(!Manager::Systemd.outdated(&home, listen));
        assert!(!Manager::Systemd.refresh(&home, listen).unwrap());
        // Another binary's unit is left alone, outdated or not.
        std::fs::write(&file, "[Service]\nExecStart=/usr/bin/other serve\n").unwrap();
        assert!(Manager::Systemd.outdated(&home, listen));
        assert!(!Manager::Systemd.refresh(&home, listen).unwrap());
        assert!(!Manager::Windows.outdated(&home, listen));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn each_definition_names_the_home_it_serves() {
        let exe = Path::new("/u/.slopmax/bin/slopmax");
        let log = Path::new("/u/.slopmax/slopmax.log");
        let listen: SocketAddr = "127.0.0.1:7567".parse().unwrap();
        let moved = Path::new("/srv/a <b> & c");
        for manager in [Manager::Systemd, Manager::Launchd, Manager::Windows] {
            let written = |home: Option<&Path>| match manager {
                Manager::Systemd => systemd_unit(exe, log, home),
                Manager::Launchd => launchd_plist(exe, log, home, listen),
                Manager::Windows => format!(
                    "\r\n{RUN_KEY}\r\n    {NAME}    REG_SZ    {}\r\n",
                    windows_command(Path::new("C:\\s\\slopmaxw.exe"), exe, log, home)
                ),
            };
            assert_eq!(manager.home_in(&written(None)), None, "{manager:?}");
            assert_eq!(
                manager.home_in(&written(Some(moved))).as_deref(),
                Some(moved),
                "{manager:?}"
            );
        }
    }

    #[test]
    fn the_service_is_installed_only_for_the_home_it_serves() {
        let root = std::env::temp_dir().join(format!("slopmax-served-{}", std::process::id()));
        let home = Home::sandbox(&root);
        let file = Manager::Systemd.file(&home);
        if !file.starts_with(&root) {
            // XDG_CONFIG_HOME puts units elsewhere: the user's own.
            return;
        }
        let unit = |moved: Option<&Path>| {
            std::fs::write(&file, systemd_unit(&home.service_exe(), &home.log(), moved)).unwrap();
        };
        assert_eq!(Manager::Systemd.served(&home), None);
        assert!(!Manager::Systemd.status(&home).elsewhere);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // Written with no SLOPMAX_HOME: the default home's, which this is.
        unit(None);
        assert_eq!(Manager::Systemd.served(&home), Some(root.join(".slopmax")));
        let status = Manager::Systemd.status(&home);
        assert!(status.installed && !status.elsewhere);
        // Written for another home.
        let other = root.join("other");
        unit(Some(&other));
        assert_eq!(Manager::Systemd.served(&home), Some(other.clone()));
        let status = Manager::Systemd.status(&home);
        assert!(!status.installed && !status.running && status.elsewhere);
        let error = Manager::Systemd.uninstall(&home).unwrap_err().to_string();
        assert!(error.contains("runs slopmax for"), "{error}");
        assert!(file.exists(), "another home's service is left be");
        // This home, named outright.
        unit(Some(home.dir()));
        assert!(Manager::Systemd.status(&home).installed);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn commands_report_their_stderr_when_they_fail() {
        assert!(run("sh", &["-c", "exit 0"]).is_ok());
        let error = run("sh", &["-c", "echo nope >&2; exit 3"]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "sh -c echo nope >&2; exit 3 failed: nope"
        );
        let error = run("slopmax-no-such-program", &[]).unwrap_err();
        assert_eq!(error.to_string(), "running slopmax-no-such-program");
        assert!(succeeds("sh", &["-c", "exit 0"]));
        assert!(!succeeds("sh", &["-c", "exit 1"]));
        assert!(!succeeds("slopmax-no-such-program", &[]));
    }

    #[test]
    fn launchd_targets_the_users_gui_domain() {
        let domain = launchd_domain();
        let uid = domain.strip_prefix("gui/").unwrap();
        assert!(uid.parse::<u32>().is_ok(), "{domain}");
        assert_eq!(launchd_target(), format!("{domain}/dev.slopmax"));
    }

    #[test]
    fn service_files_live_where_each_manager_looks() {
        let home = Home::sandbox("/home/someone");
        let unit = Manager::Systemd.file(&home);
        assert!(unit.ends_with("systemd/user/slopmax.service"));
        let plist = Manager::Launchd.file(&home);
        assert_eq!(
            plist,
            std::path::Path::new("/home/someone/Library/LaunchAgents/dev.slopmax.plist")
        );
        assert!(plist.ends_with("Library/LaunchAgents/dev.slopmax.plist"));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn lingering_is_a_linux_question() {
        // Without loginctl there is nothing to ask.
        assert_eq!(lingering(), None);
    }
}
