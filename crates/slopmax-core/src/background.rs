//! The proxy in the background: talking to a running one, and starting it
//! detached or as a login service. The CLI and the app both manage it
//! through here; `exe` is always the slopmax binary that runs `serve`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::config::Config;
use crate::provider::credits::Outcome;
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

    /// Has the running proxy redeem a reset credit on account `id`: the
    /// soonest to expire. Returns how that went, and the report after.
    pub async fn redeem(&self, id: &str) -> Result<(Outcome, Report)> {
        #[derive(serde::Deserialize)]
        struct Redeemed {
            outcome: Outcome,
            report: Report,
        }
        let response = self
            .http
            .post(format!("{}/slopmax/accounts/{id}/redeem", self.base))
            .bearer_auth(&self.key)
            .send()
            .await
            .context("the proxy is not running")?;
        if !response.status().is_success() {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            let message = body["error"]["message"].as_str().unwrap_or("it failed");
            bail!("{message}");
        }
        let redeemed: Redeemed = response
            .json()
            .await
            .context("unexpected answer from the proxy")?;
        Ok((redeemed.outcome, redeemed.report))
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::config::Strategy;
    use crate::pool::Pins;
    use crate::testkit::{self, Mock};
    use crate::time::Timestamp;

    fn report() -> Report {
        crate::report::build(
            Vec::new(),
            |_| Default::default(),
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            true,
            Timestamp::now(),
        )
    }

    fn daemon_at(mock: &Mock) -> Daemon {
        let config = Config {
            listen: mock.url.trim_start_matches("http://").parse().unwrap(),
            api_key: "sm-key".into(),
            ..Config::default()
        };
        Daemon::new(&config)
    }

    /// A stand-in proxy that answers like slopmax's own endpoints.
    async fn proxy(service: &'static str) -> Mock {
        Mock::start(move |seen| {
            let authorized = seen.header("authorization") == Some("Bearer sm-key");
            match seen.route() {
                "/healthz" => testkit::json(200, json!({ "service": service, "version": "9.9.9" })),
                _ if !authorized => testkit::json(401, json!({})),
                "/slopmax/status" | "/slopmax/refresh" | "/slopmax/sync" => {
                    testkit::json(200, serde_json::to_value(report()).unwrap())
                }
                "/slopmax/accounts/codex-ok/redeem" => testkit::json(
                    200,
                    json!({ "outcome": Outcome::Reset, "report": report() }),
                ),
                "/slopmax/accounts/codex-garbled/redeem" => testkit::reply(200, "not json"),
                "/slopmax/accounts/codex-none/redeem" => testkit::json(
                    409,
                    json!({ "error": { "message": "no reset credits left" } }),
                ),
                "/slopmax/shutdown" => testkit::reply(200, ""),
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
        assert!(daemon.report(false).await.is_none());
        assert!(daemon.shutdown().await.is_err());
        let error = daemon.redeem("codex-ok").await.unwrap_err();
        assert_eq!(error.to_string(), "the proxy is not running");
        // `stop` with nothing running says so instead of failing.
        assert!(!stop(&config).await.unwrap());
    }

    #[tokio::test]
    async fn reports_are_read_with_the_key_and_refreshes_and_syncs_post() {
        let mock = proxy("slopmax").await;
        let daemon = daemon_at(&mock);
        assert!(daemon.report(false).await.unwrap().live);
        assert!(daemon.report(true).await.is_some());
        assert!(daemon.sync().await.is_some());
        let seen: Vec<(String, String)> = mock
            .seen()
            .iter()
            .map(|s| (s.method.to_string(), s.path.clone()))
            .collect();
        assert_eq!(
            seen,
            [
                ("GET".into(), "/slopmax/status".into()),
                ("POST".into(), "/slopmax/refresh".into()),
                ("POST".into(), "/slopmax/sync".into()),
            ]
        );
        assert!(
            mock.seen()
                .iter()
                .all(|s| s.header("authorization") == Some("Bearer sm-key"))
        );
    }

    #[tokio::test]
    async fn a_wrong_key_reads_as_no_report() {
        let mock = proxy("slopmax").await;
        let config = Config {
            listen: mock.url.trim_start_matches("http://").parse().unwrap(),
            api_key: "wrong".into(),
            ..Config::default()
        };
        let daemon = Daemon::new(&config);
        assert!(daemon.report(false).await.is_none());
        assert!(daemon.shutdown().await.is_err());
    }

    #[tokio::test]
    async fn redeeming_returns_the_outcome_or_the_proxys_reason() {
        let mock = proxy("slopmax").await;
        let daemon = daemon_at(&mock);
        let (outcome, report) = daemon.redeem("codex-ok").await.unwrap();
        assert_eq!(outcome, Outcome::Reset);
        assert!(report.accounts.is_empty());

        let error = daemon.redeem("codex-none").await.unwrap_err();
        assert_eq!(error.to_string(), "no reset credits left");
        let error = daemon.redeem("codex-unknown").await.unwrap_err();
        assert_eq!(error.to_string(), "it failed");
        let error = daemon.redeem("codex-garbled").await.unwrap_err();
        assert_eq!(error.to_string(), "unexpected answer from the proxy");
    }

    #[tokio::test]
    async fn stopping_asks_a_running_proxy_to_shut_down() {
        let mock = proxy("slopmax").await;
        let config = Config {
            listen: mock.url.trim_start_matches("http://").parse().unwrap(),
            api_key: "sm-key".into(),
            ..Config::default()
        };
        assert!(stop(&config).await.unwrap());
        assert_eq!(mock.seen_at("/slopmax/shutdown").len(), 1);
    }

    #[test]
    fn the_current_binary_is_found() {
        assert!(current_exe().unwrap().exists());
    }
}
