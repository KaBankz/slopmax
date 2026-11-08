//! Running the proxy as a background service that starts at login: a
//! systemd user unit on Linux, a launchd agent on macOS.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::fsx;
use crate::paths::Home;

const NAME: &str = "slopmax";
const LABEL: &str = "dev.slopmax";

/// The service manager on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Systemd,
    Launchd,
}

/// What the service manager knows about slopmax.
#[derive(Debug, Clone, Copy, Default)]
pub struct Status {
    pub installed: bool,
    pub running: bool,
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
        }
    }

    /// Writes the service definition for `exe`, then enables and starts it.
    pub fn install(self, exe: &Path, home: &Home) -> Result<PathBuf> {
        let file = self.file(home);
        let log = home.log();
        let home = std::env::var_os("SLOPMAX_HOME").map(PathBuf::from);
        let text = match self {
            Self::Systemd => systemd_unit(exe, &log, home.as_deref()),
            Self::Launchd => launchd_plist(exe, &log, home.as_deref()),
        };
        fsx::write_private(&file, text.as_bytes())
            .with_context(|| format!("writing {}", file.display()))?;
        match self {
            Self::Systemd => {
                run("systemctl", &["--user", "daemon-reload"])?;
                run("systemctl", &["--user", "enable", "--now", NAME])?;
            }
            Self::Launchd => {
                // Replacing a loaded agent: unload it first (fails if absent).
                let _ = launchctl(&["bootout", &launchd_target()]);
                launchctl(&["bootstrap", &launchd_domain(), &file.to_string_lossy()])?;
            }
        }
        Ok(file)
    }

    pub fn uninstall(self, home: &Home) -> Result<PathBuf> {
        let file = self.file(home);
        match self {
            Self::Systemd => {
                let _ = run("systemctl", &["--user", "disable", "--now", NAME]);
            }
            Self::Launchd => {
                let _ = launchctl(&["bootout", &launchd_target()]);
            }
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

    pub fn status(self, home: &Home) -> Status {
        let installed = self.file(home).exists();
        match self {
            Self::Systemd => Status {
                installed,
                running: installed
                    && succeeds("systemctl", &["--user", "is-active", "--quiet", NAME]),
                lingering: lingering(),
            },
            Self::Launchd => Status {
                installed,
                running: installed && launchctl(&["print", &launchd_target()]).is_ok(),
                lingering: None,
            },
        }
    }

    pub fn start(self) -> Result<()> {
        match self {
            Self::Systemd => run("systemctl", &["--user", "start", NAME]),
            Self::Launchd => launchctl(&["kickstart", &launchd_target()]),
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

fn systemd_unit(exe: &Path, log: &Path, home: Option<&Path>) -> String {
    let environment = home
        .map(|h| format!("Environment=\"SLOPMAX_HOME={}\"\n", h.display()))
        .unwrap_or_default();
    format!(
        "[Unit]\n\
         Description=slopmax account pool for Claude Code and Codex\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         ExecStart=\"{exe}\" serve\n\
         {environment}\
         Restart=on-failure\n\
         RestartSec=5\n\
         StandardOutput=append:{log}\n\
         StandardError=append:{log}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = exe.display(),
        log = log.display(),
    )
}

fn launchd_plist(exe: &Path, log: &Path, home: Option<&Path>) -> String {
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
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
{environment}</dict>
</plist>
"#,
        exe = xml(exe),
        log = xml(log),
    )
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
    fn launchd_plist_escapes_paths() {
        let plist = launchd_plist(
            Path::new("/Users/a&b/slopmax"),
            Path::new("/Users/a&b/.slopmax/slopmax.log"),
            None,
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
        );
        assert!(plist.contains(
            "<key>EnvironmentVariables</key>\n  <dict>\n    <key>SLOPMAX_HOME</key>\n    <string>/srv/&lt;home&gt;</string>"
        ));
        assert!(plist.contains("<string>dev.slopmax</string>"));
        assert!(plist.ends_with("</dict>\n</plist>\n"));
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
