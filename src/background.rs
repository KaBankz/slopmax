//! The proxy in the background: talking to a running one, and starting it
//! detached or as a login service. The CLI and the app both manage it
//! through here; `exe` is always the slopmax binary that runs `serve`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::config::Config;
use crate::report::Report;
use crate::service::Manager;
use crate::{fsx, net, paths};

/// Talks to a running proxy.
#[derive(Clone)]
pub struct Daemon {
    base: String,
    key: String,
    http: net::Client,
}

impl Daemon {
    pub fn new(config: &Config) -> Self {
        let http = net::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(1))
            .plain_http()
            .build();
        Self {
            base: config.base_url(),
            key: config.api_key.clone(),
            http,
        }
    }

    pub async fn is_running(&self) -> bool {
        self.version().await.is_some()
    }

    /// The running proxy's version, if one answers on the configured port.
    pub async fn version(&self) -> Option<String> {
        let url = format!("{}/healthz", self.base);
        let body: serde_json::Value = self.http.get(url).send().await.ok()?.json().await.ok()?;
        if body["service"] != "slopmax" {
            return None;
        }
        body["version"].as_str().map(str::to_owned)
    }

    /// The running proxy's report, after polling every account's usage
    /// first with `refresh`.
    pub async fn report(&self, refresh: bool) -> Option<Report> {
        self.call(if refresh { "refresh" } else { "status" }, refresh)
            .await
    }

    /// Has the running proxy pick up changes on disk now, rather than at its
    /// next check, and returns its report.
    pub async fn sync(&self) -> Option<Report> {
        self.call("sync", true).await
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.http
            .post(format!("{}/slopmax/shutdown", self.base))
            .bearer_auth(&self.key)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn call(&self, path: &str, post: bool) -> Option<Report> {
        let url = format!("{}/slopmax/{path}", self.base);
        let request = if post {
            self.http.post(url)
        } else {
            self.http.get(url)
        };
        let response = request.bearer_auth(&self.key).send().await.ok()?;
        response.error_for_status().ok()?.json().await.ok()
    }
}

/// The binary this process runs as, for front ends that are slopmax itself.
pub fn current_exe() -> Result<PathBuf> {
    std::env::current_exe().context("locating the slopmax binary")
}

/// Starts the proxy unless one already answers. Returns whether it started
/// one.
pub async fn ensure_running(config: &Config, exe: &Path) -> Result<bool> {
    if Daemon::new(config).is_running().await {
        return Ok(false);
    }
    launch(config, exe).await?;
    Ok(true)
}

/// Starts the proxy: through the service when one is installed, so it stays
/// supervised, else as a detached process logging to [`paths::log_file`].
pub async fn launch(config: &Config, exe: &Path) -> Result<()> {
    match Manager::detect().filter(|m| m.status().installed) {
        Some(manager) => manager.start()?,
        None => spawn(exe)?,
    }
    wait_until_running(config).await
}

/// Stops a running proxy. Returns whether one was running.
pub async fn stop(config: &Config) -> Result<bool> {
    let daemon = Daemon::new(config);
    if !daemon.is_running().await {
        return Ok(false);
    }
    daemon.shutdown().await?;
    Ok(true)
}

/// Installs the login service that runs `exe`, taking over from a proxy
/// started another way, and waits until it answers. Returns the service
/// definition's file.
pub async fn install_service(config: &Config, manager: Manager, exe: &Path) -> Result<PathBuf> {
    if stop(config).await? {
        // Give the port back before the service takes it.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let file = manager.install(exe)?;
    wait_until_running(config).await?;
    Ok(file)
}

/// Starts `exe serve` detached from this process, logging to a file.
fn spawn(exe: &Path) -> Result<()> {
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
    Ok(())
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
