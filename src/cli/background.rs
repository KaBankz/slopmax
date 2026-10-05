//! `start`, `stop`, `service`, and `logs`: the background proxy from the
//! terminal. The work itself is in [`crate::background`].

use std::time::Duration;

use anyhow::{Context, Result};

use crate::background::{self, Daemon};
use crate::config::Config;
use crate::service::Manager;
use crate::{paths, ui};

pub(super) async fn start(config: &Config) -> Result<()> {
    if Daemon::new(config).is_running().await {
        println!("slopmax is already running on {}", config.base_url());
        return Ok(());
    }
    background::launch(config, &background::current_exe()?).await?;
    println!(
        "slopmax running on {} {}",
        config.base_url(),
        ui::dim(format!("(log: {})", paths::log_file().display()))
    );
    Ok(())
}

pub(super) async fn stop(config: &Config) -> Result<()> {
    if background::stop(config).await? {
        println!("slopmax stopped");
    } else {
        println!("slopmax is not running");
    }
    Ok(())
}

/// Starts the proxy unless it already runs.
pub(super) async fn ensure_running(config: &Config) -> Result<()> {
    background::ensure_running(config, &background::current_exe()?).await?;
    Ok(())
}

pub(super) async fn service(config: &Config, action: &str) -> Result<()> {
    let manager = Manager::detect().context(
        "no supported service manager here (systemd user services or launchd); \
         run `slopmax start` from a login script instead",
    )?;
    match action {
        "install" => {
            let exe = background::current_exe()?;
            let file = background::install_service(config, manager, &exe).await?;
            println!(
                "slopmax now starts at login {}",
                ui::dim(format!("({})", file.display()))
            );
            if manager.status().lingering == Some(false) {
                println!(
                    "{}",
                    ui::dim(
                        "To keep it running after you log out (on a server), run \
                         `loginctl enable-linger $USER`."
                    )
                );
            }
        }
        "uninstall" => {
            let file = manager.uninstall()?;
            println!(
                "Removed the service {}",
                ui::dim(format!("({})", file.display()))
            );
        }
        _ => {
            let status = manager.status();
            let state = match (status.installed, status.running) {
                (false, _) => "not installed".to_owned(),
                (true, true) => ui::green("installed and running"),
                (true, false) => ui::yellow("installed, not running"),
            };
            println!("service: {state}");
            if status.lingering == Some(false) && status.installed {
                println!(
                    "{}",
                    ui::dim("It stops when you log out; `loginctl enable-linger $USER` keeps it.")
                );
            }
        }
    }
    Ok(())
}

/// How much of the log's end is read to find the last lines.
const LOG_TAIL: u64 = 1024 * 1024;

/// Prints the last `lines` of the background proxy's log, then, with
/// `follow`, whatever it appends until interrupted.
pub(super) async fn logs(lines: usize, follow: bool) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let path = paths::log_file();
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
