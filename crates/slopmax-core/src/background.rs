//! The proxy in the background: talking to a running one, and starting it
//! detached or as a login service. The CLI and the app both manage it
//! through here; `exe` is always the slopmax binary that runs `serve`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::config::Config;
use crate::service::Manager;
use crate::{fsx, paths};

/// A running proxy, reached through its API.
#[derive(Clone)]
pub struct Daemon {
    client: slopmax_client::Client,
}

impl Daemon {
    pub fn new(config: &Config) -> Self {
        Self {
            client: slopmax_client::Client::new(config.base_url(), &config.api_key),
        }
    }

    pub async fn is_running(&self) -> bool {
        self.version().await.is_some()
    }

    /// The running proxy's version, if one answers on the configured port.
    pub async fn version(&self) -> Option<String> {
        self.client.health().await.map(|h| h.version)
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.client.shutdown(false).await?;
        Ok(())
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testkit::{self, Mock};

    fn daemon_at(mock: &Mock) -> Daemon {
        Daemon::new(&config_at(mock))
    }

    fn config_at(mock: &Mock) -> Config {
        Config {
            listen: mock.url.trim_start_matches("http://").parse().unwrap(),
            api_key: "sm-key".into(),
            ..Config::default()
        }
    }

    /// A stand-in proxy that answers like slopmax's own endpoints.
    async fn proxy(service: &'static str) -> Mock {
        Mock::start(move |seen| {
            let authorized = seen.header("authorization") == Some("Bearer sm-key");
            match seen.route() {
                "/healthz" => testkit::json(200, json!({ "service": service, "version": "9.9.9" })),
                _ if !authorized => testkit::json(
                    401,
                    json!({ "_tag": "Unauthorized", "message": "missing or invalid slopmax key" }),
                ),
                "/slopmax/api/shutdown" => testkit::json(200, json!({ "status": "stopping" })),
                _ => testkit::reply(500, ""),
            }
        })
        .await
    }

    #[tokio::test]
    async fn the_running_proxy_reports_its_version() {
        let mock = proxy("slopmax").await;
        let daemon = daemon_at(&mock);
        assert_eq!(daemon.version().await.as_deref(), Some("9.9.9"));
        assert!(daemon.is_running().await);
    }

    #[tokio::test]
    async fn another_program_on_the_port_is_not_the_proxy() {
        let mock = proxy("something-else").await;
        let daemon = daemon_at(&mock);
        assert_eq!(daemon.version().await, None);
        assert!(!daemon.is_running().await);
    }

    #[tokio::test]
    async fn nothing_listening_is_not_running() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let listen = listener.local_addr().unwrap();
        drop(listener);
        let config = Config {
            listen,
            ..Config::default()
        };
        let daemon = Daemon::new(&config);
        assert!(!daemon.is_running().await);
        assert!(daemon.shutdown().await.is_err());
        // `stop` with nothing running says so instead of failing.
        assert!(!stop(&config).await.unwrap());
    }

    #[tokio::test]
    async fn stopping_asks_a_running_proxy_to_shut_down_with_the_key() {
        let mock = proxy("slopmax").await;
        assert!(stop(&config_at(&mock)).await.unwrap());
        assert_eq!(mock.seen_at("/slopmax/api/shutdown").len(), 1);
        let wrong = Config {
            api_key: "wrong".into(),
            ..config_at(&mock)
        };
        assert!(Daemon::new(&wrong).shutdown().await.is_err());
    }

    #[test]
    fn the_current_binary_is_found() {
        assert!(current_exe().unwrap().exists());
    }
}
