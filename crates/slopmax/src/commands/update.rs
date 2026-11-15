//! `slopmax update`: installs the newest release the way slopmax was
//! installed, then moves the running proxy to it without dropping a
//! connection.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use crate::ui;
use slopmax_core::auth;
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::Config;
use slopmax_core::net::Origins;
use slopmax_core::paths::Home;
use slopmax_core::service::Manager;
use slopmax_core::time::Timestamp;
use slopmax_core::update::install::{self, Install};
use slopmax_core::update::{self, Checked, Version};

pub(super) async fn run(config: &Config, check: bool) -> Result<i32> {
    let home = super::home();
    let ours = Version::current();
    let http = auth::http_client(Origins::default());
    let latest = update::latest(&http).await?;
    let checked = Checked {
        checked_at: Timestamp::now(),
        latest: latest.to_string(),
    };
    let _ = checked.write(home);
    let exe = background::current_exe()?
        .canonicalize()
        .context("locating the slopmax binary")?;
    let install = Install::of(&exe);
    if check {
        if latest > ours {
            println!("slopmax {latest} is out; this is {ours}. {}", how(&install));
        } else {
            println!("slopmax {ours} is the newest release.");
        }
        if let Some(running) = Daemon::new(config).running().await?
            && running != ours.to_string()
        {
            println!("The proxy runs {running}; `slopmax update` moves it to {ours}.");
        }
        return Ok(0);
    }
    let installed = if latest > ours {
        match &install {
            Install::Mise { tool, .. } => with_mise(home, &install, tool, &exe, ours, latest)?,
            Install::File => {
                println!("Downloading slopmax {latest}…");
                let files = update::download(&http, latest).await?;
                let dir = exe
                    .parent()
                    .context("the slopmax binary is in no directory")?;
                update::put_in_place(dir, &files, latest)?;
                exe.clone()
            }
            other => {
                let command = other.update_command().unwrap_or_default();
                println!(
                    "slopmax {latest} is out; this is {ours}. It was installed by a package manager, so update it there:\n\n  {command}\n\nThe proxy moves to it by itself once it is installed."
                );
                return Ok(0);
            }
        }
    } else {
        println!("slopmax {ours} is the newest release.");
        exe.clone()
    };
    move_proxy(config, home, &installed).await?;
    Ok(0)
}

/// What gets this install to a new release.
fn how(install: &Install) -> String {
    match install.update_command() {
        Some(command) => format!("Update it with `{command}`."),
        None => "`slopmax update` installs it.".to_owned(),
    }
}

/// Has mise install `latest` as its config asks: `mise upgrade` when it
/// asks for the latest, the pin moved when the global config pins a
/// version. A project's pin is that project's to change. The binary mise
/// runs now.
fn with_mise(
    home: &Home,
    install: &Install,
    tool: &str,
    exe: &Path,
    ours: Version,
    latest: Version,
) -> Result<PathBuf> {
    let request = install::mise_request(tool)
        .context("mise installed slopmax, but `mise ls` doesn't say how its config asks for it")?;
    let bump = match request.version.as_str() {
        "latest" => false,
        pinned => match &request.source {
            Some(source) if install::is_global_mise_config(source) => {
                println!(
                    "Moving slopmax's version in {} from {pinned} to {latest}…",
                    home.show(source)
                );
                true
            }
            Some(source) => bail!(
                "slopmax is pinned to {pinned} in {}; change it there and run `mise install`, \
                 and the proxy moves to it by itself",
                source.display()
            ),
            None => bail!(
                "something outside a mise config asks for slopmax {pinned} (MISE_* in the \
                 environment?); change that and run `mise install`"
            ),
        },
    };
    install::mise_upgrade(tool, bump)?;
    let now = install
        .current(exe)
        .context("mise doesn't say where it installed slopmax")?;
    match update::binary_version(&now) {
        Some(version) if version > ours => Ok(now),
        Some(version) => bail!(
            "mise still runs slopmax {version}; a minimum release age in mise's settings may hold {latest} back"
        ),
        None => bail!(
            "the slopmax mise installed at {} doesn't run",
            now.display()
        ),
    }
}

/// Moves the running proxy to `exe`: handed its socket, the new binary
/// takes every connection from then on while the old one finishes its own.
/// A proxy older than handoffs is restarted this once.
async fn move_proxy(config: &Config, home: &Home, exe: &Path) -> Result<()> {
    let version = update::binary_version(exe)
        .with_context(|| format!("the installed slopmax at {} doesn't run", exe.display()))?;
    let point_service = || -> Result<()> {
        if install::linked(home).is_some() {
            install::link(home, exe).with_context(|| {
                format!(
                    "pointing {} at the new binary",
                    home.service_exe().display()
                )
            })?;
        }
        Ok(())
    };
    let daemon = Daemon::new(config);
    let Some(running) = daemon.running().await? else {
        point_service()?;
        println!(
            "slopmax {version} is installed. The proxy isn't running; it starts on {version}."
        );
        return Ok(());
    };
    // A plist from before launchd kept the proxy's socket: loading the new
    // one restarts the proxy, once.
    if let Some(manager) = Manager::detect().filter(|m| {
        *m == Manager::Launchd && m.status(home).installed && m.outdated(home, config.listen)
    }) {
        println!(
            "The login service predates launchd keeping the proxy's socket; writing it anew \
             restarts the proxy this once, and agents retry what it cuts off."
        );
        background::install_service(config, home, manager, exe).await?;
        println!("The proxy now runs slopmax {version}.");
        return Ok(());
    }
    if Version::parse(&running) == Some(version) {
        point_service()?;
        println!("slopmax {version} is installed, and the proxy runs it.");
        return Ok(());
    }
    let client = slopmax_client::Client::new(config.base_url(), &config.api_key);
    // Windows can't hand the socket over: `slopmaxw.exe` starts the proxy
    // again at once, on the binary replaced in place.
    let moved = if cfg!(windows) {
        client.shutdown(true).await
    } else {
        client.hand_off(&exe.to_string_lossy()).await
    };
    match moved {
        Ok(_) => {}
        // A daemon older than handoffs refuses the field.
        Err(e @ slopmax_client::Error::Api(_)) if e.message().contains("unknown field `exe`") => {
            return restart_once(config, home, exe, &running, version).await;
        }
        // Perhaps already moving: it follows a new install by itself.
        Err(e) => {
            if !answers_as(&daemon, version, Duration::from_secs(30)).await {
                return Err(anyhow::anyhow!(e.message().to_owned()))
                    .context("moving the proxy to the new binary");
            }
        }
    }
    point_service()?;
    if !answers_as(&daemon, version, Duration::from_secs(30)).await {
        bail!("the proxy was handed to {version} but doesn't answer as it");
    }
    println!(
        "slopmax {version} is installed, and the proxy moved to it without dropping a connection. {}",
        ui::dim(format!("(Requests already under way finish on {running}.)"))
    );
    Ok(())
}

/// Whether the proxy answers as `version` within `wait`.
async fn answers_as(daemon: &Daemon, version: Version, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if daemon.version().await.as_deref() == Some(version.to_string().as_str()) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A proxy from before handoffs (0.10 and older) can only be restarted. The
/// new binary does it, writing the login service anew so it runs through
/// the link from now on.
async fn restart_once(
    config: &Config,
    home: &Home,
    exe: &Path,
    running: &str,
    version: Version,
) -> Result<()> {
    println!(
        "The running proxy ({running}) can't hand over its connections, so it restarts this once; \
         agents retry what it cuts off."
    );
    let service = Manager::detect().is_some_and(|m| m.status(home).installed);
    let args: &[&str] = if service {
        &["service", "install"]
    } else {
        background::stop(config).await?;
        // Give the port back before the new proxy takes it.
        tokio::time::sleep(Duration::from_millis(300)).await;
        &["start"]
    };
    let status = std::process::Command::new(exe)
        .args(args)
        .status()
        .with_context(|| format!("running {}", exe.display()))?;
    if !status.success() {
        bail!("`slopmax {}` failed with the new binary", args.join(" "));
    }
    println!("The proxy now runs slopmax {version}.");
    Ok(())
}
