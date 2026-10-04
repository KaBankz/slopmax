//! The proxy in the background: talking to it, starting and stopping it,
//! and the login service.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::config::Config;
use crate::report::Report;
use crate::service::Manager;
use crate::{fsx, net, paths, ui};

/// Talks to a running proxy.
pub(super) struct Daemon {
    base: String,
    key: String,
    http: net::Client,
}

impl Daemon {
    pub(super) fn new(config: &Config) -> Self {
        let http = net::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(1))
            .build();
        Self {
            base: config.base_url(),
            key: config.api_key.clone(),
            http,
        }
    }

    pub(super) async fn is_running(&self) -> bool {
        self.version().await.is_some()
    }

    /// The running proxy's version, if one answers on the configured port.
    pub(super) async fn version(&self) -> Option<String> {
        let url = format!("{}/healthz", self.base);
        let body: serde_json::Value = self.http.get(url).send().await.ok()?.json().await.ok()?;
        if body["service"] != "slopmax" {
            return None;
        }
        body["version"].as_str().map(str::to_owned)
    }

    pub(super) async fn report(&self, refresh: bool) -> Option<Report> {
        let url = format!(
            "{}/slopmax/{}",
            self.base,
            if refresh { "refresh" } else { "status" }
        );
        let request = if refresh {
            self.http.post(url)
        } else {
            self.http.get(url)
        };
        let response = request.bearer_auth(&self.key).send().await.ok()?;
        response.error_for_status().ok()?.json().await.ok()
    }

    pub(super) async fn shutdown(&self) -> Result<()> {
        self.http
            .post(format!("{}/slopmax/shutdown", self.base))
            .bearer_auth(&self.key)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

pub(super) async fn start(config: &Config) -> Result<()> {
    let daemon = Daemon::new(config);
    if daemon.is_running().await {
        println!("slopmax is already running on {}", config.base_url());
        return Ok(());
    }
    launch(config).await?;
    println!(
        "slopmax running on {} {}",
        config.base_url(),
        ui::dim(format!("(log: {})", paths::log_file().display()))
    );
    Ok(())
}

pub(super) async fn stop(config: &Config) -> Result<()> {
    let daemon = Daemon::new(config);
    if !daemon.is_running().await {
        println!("slopmax is not running");
        return Ok(());
    }
    daemon.shutdown().await?;
    println!("slopmax stopped");
    Ok(())
}

pub(super) async fn ensure_running(config: &Config) -> Result<()> {
    if !Daemon::new(config).is_running().await {
        launch(config).await?;
    }
    Ok(())
}

/// Starts the proxy: through the service when one is installed, so it stays
/// supervised, else as a detached process.
pub(super) async fn launch(config: &Config) -> Result<()> {
    match Manager::detect().filter(|m| m.status().installed) {
        Some(manager) => {
            manager.start()?;
            wait_until_running(config).await
        }
        None => spawn_background(config).await,
    }
}

pub(super) async fn service(config: &Config, action: &str) -> Result<()> {
    let manager = Manager::detect().context(
        "no supported service manager here (systemd user services or launchd); \
         run `slopmax start` from a login script instead",
    )?;
    match action {
        "install" => {
            let daemon = Daemon::new(config);
            if daemon.is_running().await {
                // The service takes over the port.
                daemon.shutdown().await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let exe = std::env::current_exe().context("locating the slopmax binary")?;
            let file = manager.install(&exe)?;
            wait_until_running(config).await?;
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

/// Starts `slopmax serve` detached from the terminal, logging to a file.
async fn spawn_background(config: &Config) -> Result<()> {
    let exe = std::env::current_exe().context("locating the slopmax binary")?;
    fsx::private_dir(&paths::home())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_file())?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().context("starting the proxy")?;
    wait_until_running(config).await
}

async fn wait_until_running(config: &Config) -> Result<()> {
    let daemon = Daemon::new(config);
    for _ in 0..50 {
        if daemon.is_running().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!(
        "the proxy did not start; see {}",
        paths::log_file().display()
    )
}
