//! `slopmax proxy`: the background proxy from the terminal. The work
//! itself is in [`slopmax_core::background`].

use std::time::Duration;

use anyhow::{Context, Result};

use crate::ui;
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::Config;
use slopmax_core::service::Manager;

pub(super) async fn start(config: &Config) -> Result<()> {
    if let Some(version) = Daemon::new(config).running().await? {
        let ours = env!("CARGO_PKG_VERSION");
        if version == ours {
            println!("slopmax is already running on {}", config.base_url());
        } else {
            println!(
                "slopmax {version} is already running on {}; this is {ours}. \
                 `slopmax update` moves it to {ours} without dropping a connection.",
                config.base_url()
            );
        }
        return Ok(());
    }
    background::launch(config, super::home(), &background::current_exe()?).await?;
    println!(
        "slopmax running on {} {}",
        config.base_url(),
        ui::dim(format!("(log: {})", super::home().log().display()))
    );
    Ok(())
}

pub(super) async fn stop(config: &Config) -> Result<()> {
    let stopped = background::stop(config).await?;
    // launchd would start it again for the next connection to its socket.
    if let Some(manager) =
        slopmax_core::service::Manager::detect().filter(|m| m.status(super::home()).installed)
    {
        manager.stopped();
    }
    if stopped {
        println!("slopmax stopped");
    } else {
        println!("slopmax is not running");
    }
    Ok(())
}

/// Starts the proxy unless it already runs.
pub(super) async fn ensure_running(config: &Config) -> Result<()> {
    background::ensure_running(config, super::home(), &background::current_exe()?).await?;
    Ok(())
}

/// The service manager here, or why there is none.
fn manager() -> Result<Manager> {
    Manager::detect().context(
        "no supported service manager here (systemd user services, launchd, or Windows); \
         run `slopmax proxy start` from a login script instead",
    )
}

/// `slopmax proxy install`: starts the proxy at login, and now.
pub(super) async fn install(config: &Config) -> Result<()> {
    let manager = manager()?;
    let exe = background::current_exe()?;
    let before = manager
        .status(super::home())
        .elsewhere
        .then(|| manager.served(super::home()))
        .flatten();
    let file = background::install_service(config, super::home(), manager, &exe).await?;
    println!(
        "slopmax now starts at login {}",
        ui::dim(format!("({})", file.display()))
    );
    if let Some(before) = before {
        println!(
            "{}",
            ui::dim(format!(
                "It ran slopmax for {} before; that home's proxy now runs only when \
                 started there.",
                super::home().show(&before)
            ))
        );
    }
    if manager.status(super::home()).lingering == Some(false) {
        println!(
            "{}",
            ui::dim(
                "To keep it running after you log out (on a server), run \
                 `loginctl enable-linger $USER`."
            )
        );
    }
    Ok(())
}

/// `slopmax proxy uninstall`.
pub(super) fn uninstall() -> Result<()> {
    let file = manager()?.uninstall(super::home())?;
    println!(
        "slopmax no longer starts at login {}",
        ui::dim(format!("({})", file.display()))
    );
    Ok(())
}

/// `slopmax proxy restart`.
pub(super) async fn restart(config: &Config) -> Result<()> {
    if background::stop(config).await? {
        println!("slopmax stopped");
    }
    start(config).await
}

/// `slopmax proxy status`: whether the proxy runs, where, and whether it
/// starts at login.
pub(super) async fn status(config: &Config, json: bool) -> Result<()> {
    if let Some(url) = config.hub_url() {
        let url = url.trim_end_matches('/');
        let health = super::daemon(config).await.ok().flatten();
        let reached = health.is_some();
        if json {
            let view = serde_json::json!({ "hub": url, "reachable": reached });
            println!("{}", serde_json::to_string_pretty(&view)?);
        } else if reached {
            println!("This machine uses the hub at {url}, which answers.");
        } else {
            println!("This machine uses the hub at {url}, which doesn't answer.");
        }
        return Ok(());
    }
    let client = slopmax_client::Client::new(config.base_url(), &config.api_key);
    let health = client.health_within(Duration::from_secs(1)).await;
    let service = Manager::detect().map(|m| (m, m.status(super::home())));
    if json {
        let view = serde_json::json!({
            "running": health.is_some(),
            "address": config.base_url(),
            "version": health.as_ref().map(|h| h.version.clone()),
            "pid": health.as_ref().and_then(|h| h.pid),
            "log": super::home().log().display().to_string(),
            "service": service.as_ref().map(|(_, s)| serde_json::json!({
                "installed": s.installed,
                "running": s.running,
            })),
        });
        println!("{}", serde_json::to_string_pretty(&view)?);
        return Ok(());
    }
    match &health {
        Some(health) => println!(
            "proxy    {} on {} {}",
            ui::green("running"),
            config.base_url(),
            ui::dim(format!(
                "(slopmax {}{})",
                health.version,
                health.pid.map(|p| format!(", pid {p}")).unwrap_or_default()
            ))
        ),
        None => println!(
            "proxy    {} {}",
            ui::yellow("stopped"),
            ui::dim("(`slopmax proxy start` starts it)")
        ),
    }
    let state = match &service {
        None => ui::dim("no service manager here"),
        Some((manager, status)) => match (status.installed, status.running) {
            (false, _) if status.elsewhere => format!(
                "not installed for this home {}",
                ui::dim(format!(
                    "(it runs slopmax for {})",
                    manager
                        .served(super::home())
                        .map(|dir| super::home().show(&dir))
                        .unwrap_or_default()
                ))
            ),
            (false, _) => format!(
                "not installed {}",
                ui::dim("(`slopmax proxy install` starts it at login)")
            ),
            (true, true) => ui::green("installed and running"),
            (true, false) => ui::yellow("installed, not running"),
        },
    };
    println!("service  {state}");
    println!(
        "log      {}",
        ui::dim(super::home().log().display().to_string())
    );
    if let Some((_, status)) = &service
        && status.lingering == Some(false)
        && status.installed
    {
        println!(
            "{}",
            ui::dim("It stops when you log out; `loginctl enable-linger $USER` keeps it.")
        );
    }
    Ok(())
}

/// How much of the log's end is read to find the last lines.
const LOG_TAIL: u64 = 1024 * 1024;

/// Prints the last `lines` of the background proxy's log, then, with
/// `follow`, whatever it appends until interrupted.
pub(super) async fn logs(lines: usize, follow: bool) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let path = super::home().log();
    let mut file = loop {
        match std::fs::File::open(&path) {
            Ok(file) => break file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && follow => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                println!(
                    "No log yet: {} is written once the proxy runs in the background.",
                    path.display()
                );
                return Ok(());
            }
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        }
    };
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL)))?;
    // The tail may start inside a character; decode leniently.
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let tail = String::from_utf8_lossy(&bytes);
    let shown: Vec<&str> = tail.lines().collect();
    let mut out = std::io::stdout();
    for line in &shown[shown.len().saturating_sub(lines)..] {
        writeln!(out, "{line}")?;
    }
    if !follow {
        return Ok(());
    }
    let mut position = len;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let len = std::fs::metadata(&path).map_or(0, |m| m.len());
        if len < position {
            // Truncated or replaced: start over from the top.
            file = std::fs::File::open(&path)?;
            position = 0;
        }
        if len > position {
            file.seek(SeekFrom::Start(position))?;
            let mut chunk = Vec::new();
            (&mut file).take(len - position).read_to_end(&mut chunk)?;
            out.write_all(&chunk)?;
            out.flush()?;
            position = len;
        }
    }
}
