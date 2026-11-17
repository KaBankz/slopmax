//! The proxy in the background: talking to a running one, and starting it
//! detached or as a login service. The CLI manages it through here; `exe`
//! is always the slopmax binary that runs `serve`.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};

use crate::config::Config;
use crate::fsx;
use crate::paths::Home;
use crate::service::Manager;

/// A running proxy, reached through its API.
#[derive(Clone)]
pub struct Daemon {
    client: slopmax_client::Client,
    listen: SocketAddr,
}

/// What answers at the configured address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// Nothing, or a program that is not slopmax.
    Absent,
    /// slopmax, taking this home's key.
    Ours { version: String },
    /// slopmax, refusing this home's key: started from another home, or
    /// before `api_key` changed.
    Foreign { version: String, pid: Option<u32> },
}

/// How long `start` waits for the proxy to answer, in all.
const START_WAIT: Duration = Duration::from_secs(10);
/// How long each look at a starting proxy waits for its answer: a program
/// that holds the port and never answers costs no more than this.
const START_PROBE: Duration = Duration::from_millis(500);

impl Daemon {
    pub fn new(config: &Config) -> Self {
        Self {
            client: slopmax_client::Client::new(config.base_url(), &config.api_key),
            listen: config.listen,
        }
    }

    /// Whether this home's proxy answers on the configured port.
    pub async fn is_running(&self) -> bool {
        matches!(self.probe().await, Probe::Ours { .. })
    }

    /// The running proxy's version, if this home's proxy answers on the
    /// configured port.
    pub async fn version(&self) -> Option<String> {
        match self.probe().await {
            Probe::Ours { version } => Some(version),
            _ => None,
        }
    }

    /// What answers on the configured port. A proxy on this machine
    /// answers at once; a second's wait spares a program that holds the
    /// port and never answers.
    pub async fn probe(&self) -> Probe {
        self.probe_within(Duration::from_secs(1)).await
    }

    async fn probe_within(&self, timeout: Duration) -> Probe {
        match self.client.health_within(timeout).await {
            None => Probe::Absent,
            Some(health) if health.owner == Some(false) => Probe::Foreign {
                version: health.version,
                pid: health.pid,
            },
            Some(health) => Probe::Ours {
                version: health.version,
            },
        }
    }

    /// The version of this home's proxy if it runs; an error saying what to
    /// do when the port has a proxy that refuses this home's key.
    pub async fn running(&self) -> Result<Option<String>> {
        match self.probe().await {
            Probe::Absent => Ok(None),
            Probe::Ours { version } => Ok(Some(version)),
            Probe::Foreign { pid, .. } => bail!(foreign(self.listen, pid)),
        }
    }

    /// The running proxy's status report.
    pub async fn report(&self) -> Result<slopmax_client::api::report::Report> {
        Ok(self.client.status().await?)
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.client.shutdown(false).await?;
        Ok(())
    }
}

/// What to say of a slopmax on `listen` that refuses this home's key, and
/// how to get past it. `pid` is the process, when it said; else the port's
/// holder is looked up.
pub fn foreign(listen: SocketAddr, pid: Option<u32>) -> String {
    let pid = pid.or_else(|| {
        let holder = crate::net::server::port_holder(listen.port())?;
        holder
            .rsplit_once("(pid ")?
            .1
            .trim_end_matches(')')
            .parse()
            .ok()
    });
    let end = pid
        .map(|pid| format!(" (or end pid {pid})"))
        .unwrap_or_default();
    format!(
        "a slopmax proxy on {listen} doesn't accept this home's key: it was started from another \
         SLOPMAX_HOME, or before api_key changed. Stop it from there{end}, then run `slopmax proxy start`."
    )
}

/// The binary this process runs as, which the proxy it starts runs too.
pub fn current_exe() -> Result<PathBuf> {
    std::env::current_exe().context("locating the slopmax binary")
}

/// Starts the proxy unless one already answers. Returns whether it started
/// one. A machine that uses a hub runs none, and says so.
pub async fn ensure_running(config: &Config, home: &Home, exe: &Path) -> Result<bool> {
    if let Some(refusal) = config.hub_refusal() {
        return Err(anyhow!(refusal));
    }
    if Daemon::new(config).running().await?.is_some() {
        return Ok(false);
    }
    launch(config, home, exe).await?;
    Ok(true)
}

/// Starts the proxy: through the service when one is installed, so it stays
/// supervised, else as a detached process logging to the home's log.
pub async fn launch(config: &Config, home: &Home, exe: &Path) -> Result<()> {
    // What the proxy logs from here on says why, if it does not start.
    let logged = std::fs::metadata(home.log()).map_or(0, |m| m.len());
    let child = match Manager::detect().filter(|m| m.status(home).installed) {
        Some(manager) => {
            manager.start(exe, home, config.listen)?;
            None
        }
        None => Some(spawn(exe, home)?),
    };
    wait_until_running(config, home, child, logged).await
}

/// Stops a running proxy. Returns whether one was running.
pub async fn stop(config: &Config) -> Result<bool> {
    let daemon = Daemon::new(config);
    if daemon.running().await?.is_none() {
        return Ok(false);
    }
    daemon.shutdown().await?;
    Ok(true)
}

/// Installs the login service that runs `exe`, taking over from a proxy
/// started another way, and waits until it answers. Returns the service
/// definition's file.
pub async fn install_service(
    config: &Config,
    home: &Home,
    manager: Manager,
    exe: &Path,
) -> Result<PathBuf> {
    if stop(config).await? {
        // Give the port back before the service takes it.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let logged = std::fs::metadata(home.log()).map_or(0, |m| m.len());
    let file = manager.install(exe, home, config.listen)?;
    wait_until_running(config, home, None, logged).await?;
    Ok(file)
}

/// Starts `exe serve` detached from this process, logging to a file.
fn spawn(exe: &Path, home: &Home) -> Result<Child> {
    fsx::private_dir(home.dir())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.log())?;
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
    command.spawn().context("starting the proxy")
}

/// Waits for the proxy just started to answer. `child` is its process when
/// this one started it, to notice at once when it gives up; `logged` is
/// where the log ended before, so a failure shows what the proxy said.
async fn wait_until_running(
    config: &Config,
    home: &Home,
    mut child: Option<Child>,
    logged: u64,
) -> Result<()> {
    let daemon = Daemon::new(config);
    let deadline = Instant::now() + START_WAIT;
    loop {
        match daemon.probe_within(START_PROBE).await {
            Probe::Ours { .. } => return Ok(()),
            Probe::Foreign { pid, .. } => bail!(foreign(config.listen, pid)),
            Probe::Absent => {}
        }
        let exited = child
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten())
            .is_some();
        if exited {
            return Err(did_not_start(home, logged, "it stopped"));
        }
        if Instant::now() >= deadline {
            let waited = format!("it did not answer within {} s", START_WAIT.as_secs());
            return Err(did_not_start(home, logged, &waited));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Why the proxy did not start: the last thing it logged since `logged`,
/// or else `otherwise` and where the log is.
fn did_not_start(home: &Home, logged: u64, otherwise: &str) -> anyhow::Error {
    match last_line(&home.log(), logged) {
        Some(line) => anyhow!("the proxy did not start: {line}"),
        None => anyhow!(
            "the proxy did not start: {otherwise}; see {}",
            home.log().display()
        ),
    }
}

/// The last line written to `log` past byte `from`, without the level or
/// `error:` it starts with.
fn last_line(log: &Path, from: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(log).ok()?;
    let len = file.metadata().ok()?.len();
    // The end is enough: the reason is the last line.
    file.seek(SeekFrom::Start(from.max(len.saturating_sub(64 * 1024))))
        .ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().map(str::trim).rfind(|l| !l.is_empty())?;
    let line = strip_ansi(line);
    let line = line.trim_start_matches("error:").trim();
    Some(line.to_owned())
}

/// `text` without terminal color codes.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Up to the letter that ends the sequence.
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testkit::{self, Mock, temp_dir};

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
                "/healthz" => testkit::json(
                    200,
                    json!({ "service": service, "version": "9.9.9", "pid": 4242, "owner": authorized }),
                ),
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
    async fn a_machine_that_uses_a_hub_starts_no_proxy() {
        // A proxy answers here, and the hub's refusal still comes first:
        // nothing is asked of it, and nothing is started.
        let mock = proxy("slopmax").await;
        let config = Config {
            hub: Some(crate::config::HubLink {
                url: "https://hub.example.ts.net:7567".into(),
                key: None,
            }),
            ..config_at(&mock)
        };
        let dir = temp_dir("hub-refusal");
        let home = Home::at(dir.to_path_buf());
        let error = ensure_running(&config, &home, Path::new("/nonexistent/slopmax"))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), config.hub_refusal().unwrap());
        assert!(mock.seen_at("/healthz").is_empty());
        // The daemon it would talk to stays this machine's own.
        assert_eq!(Daemon::new(&config).client.base(), config.base_url());
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

    #[tokio::test]
    async fn a_proxy_refusing_this_homes_key_is_named_with_its_pid() {
        let mock = proxy("slopmax").await;
        let other = Config {
            api_key: "another-home".into(),
            ..config_at(&mock)
        };
        let daemon = Daemon::new(&other);
        assert_eq!(
            daemon.probe().await,
            Probe::Foreign {
                version: "9.9.9".into(),
                pid: Some(4242)
            }
        );
        assert!(!daemon.is_running().await);
        let refused = stop(&other).await.unwrap_err().to_string();
        assert_eq!(
            refused,
            format!(
                "a slopmax proxy on {} doesn't accept this home's key: it was started from \
                 another SLOPMAX_HOME, or before api_key changed. Stop it from there (or end \
                 pid 4242), then run `slopmax proxy start`.",
                other.listen
            )
        );
        assert!(mock.seen_at("/slopmax/api/shutdown").is_empty());
        // Starting would only fail to listen: it says the same.
        let dir = temp_dir("foreign");
        let home = Home::at(dir.to_path_buf());
        let exe = Path::new("/nonexistent/slopmax");
        let started = ensure_running(&other, &home, exe).await.unwrap_err();
        assert!(started.to_string().contains("pid 4242"), "{started}");
    }

    #[test]
    fn a_proxy_that_does_not_start_shows_what_it_logged() {
        let dir = temp_dir("not-started");
        let home = Home::at(dir.to_path_buf());
        std::fs::create_dir_all(home.dir()).unwrap();
        std::fs::write(home.log(), "an old line from yesterday\n").unwrap();
        let logged = std::fs::metadata(home.log()).unwrap().len();
        assert_eq!(
            did_not_start(&home, logged, "it stopped").to_string(),
            format!(
                "the proxy did not start: it stopped; see {}",
                home.log().display()
            )
        );
        let mut log = std::fs::OpenOptions::new()
            .append(true)
            .open(home.log())
            .unwrap();
        std::io::Write::write_all(
            &mut log,
            b"\x1b[31merror:\x1b[0m python3 (pid 7) is using 127.0.0.1:7595. Set `listen` in config.toml to a free port.\n\n",
        )
        .unwrap();
        assert_eq!(
            did_not_start(&home, logged, "it stopped").to_string(),
            "the proxy did not start: python3 (pid 7) is using 127.0.0.1:7595. \
             Set `listen` in config.toml to a free port."
        );
    }

    #[test]
    fn the_current_binary_is_found() {
        assert!(current_exe().unwrap().exists());
    }
}
