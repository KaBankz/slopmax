//! The daemon: the proxy agents talk to, slopmax's API beside it, and the
//! background work that keeps the pool current (picking up account
//! changes, keeping tokens fresh, polling usage, redeeming limit resets,
//! telling notices) and saves its state. It is built on the engine,
//! [`slopmax_core`], and is the only process that writes what it holds while
//! it runs; the CLI and the dashboard reach it through `/slopmax/api`.

pub mod handoff;
pub mod proxy;
pub mod supervisor;

// The engine's modules, under the names the daemon's code uses.
pub(crate) use slopmax_core::{
    account, agent, api, auth, blocking, browse, config, doctor, error, fsx, history, import,
    ledger, limits, notify, paths, pool, provider, quota, report, route, state, summary, tailscale,
    update, usage, waste,
};
pub(crate) use slopmax_core::{ids, log, net, time, wire};

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::net::TcpListener;

use crate::account::Account;
use crate::config::Config;
use crate::error::ListenError;
use crate::net::{Origins, server};
use crate::paths::Home;
use crate::pool::State;
use crate::provider::credits::Outcome;
use crate::proxy::App;
pub use crate::proxy::Tailnet;
use crate::time::{SignedDuration, Timestamp};

/// How often blocked accounts are re-checked, in case quota frees up early.
const RECHECK_BLOCKED: SignedDuration = SignedDuration::from_mins(10);
/// How close to expiry a reset credit is redeemed rather than lost.
pub const CREDIT_EXPIRY_LEAD: SignedDuration =
    SignedDuration::from_hours(slopmax_api::settings::REDEEM_LEAD_HOURS as i64);
/// How often an account's reset credits are listed again. They change only
/// when one is granted, spent, or expires, which the usage count and the
/// expiry dates already tell.
const LIST_CREDITS_EVERY: SignedDuration = SignedDuration::from_hours(6);
/// How often the credits of a provider whose usage does not count them, as
/// Claude's, are listed: a new one shows within the hour. A failed listing
/// waits as long, since it asks the usage endpoint, which rate-limits.
const LIST_UNCOUNTED_EVERY: SignedDuration = SignedDuration::from_hours(1);
/// How soon a new count from the usage has the credits listed again, at the
/// earliest.
const LIST_CREDITS_GAP: SignedDuration = SignedDuration::from_mins(10);
/// How often account conditions are compared for notifications.
const WATCH_EVERY: Duration = Duration::from_secs(30);

/// The runtime every command runs on: one thread unless `SLOPMAX_WORKERS`
/// asks for more. One thread carries one machine's agents with room to spare,
/// and it hands no work between threads and holds the least memory. A
/// proxy shared by many clients sets `SLOPMAX_WORKERS` to a number of
/// threads, or to `auto` for one per CPU; blocking work (the disk, name
/// lookups) runs on threads of its own either way.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    let workers = std::env::var("SLOPMAX_WORKERS").ok();
    let mut builder = match workers.as_deref().map(str::trim) {
        Some("auto") => tokio::runtime::Builder::new_multi_thread(),
        Some(n) => match n.parse::<usize>() {
            Ok(n) if n > 1 => {
                let mut builder = tokio::runtime::Builder::new_multi_thread();
                builder.worker_threads(n);
                builder
            }
            _ => tokio::runtime::Builder::new_current_thread(),
        },
        None => tokio::runtime::Builder::new_current_thread(),
    };
    builder.enable_all().build()
}

/// Serves `home` with `config` until stopped: `slopmax serve`.
pub async fn run(config: Config, home: Home) -> Result<Stopped> {
    serve(config, home, Origins::default()).await
}

/// How the daemon stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stopped {
    /// Asked to stop, or signalled.
    Done,
    /// Asked to stop so it is started again, where the socket can't be
    /// handed over: the service manager restarts it on exit code 75.
    Restart,
    /// Handed the proxy to the process `pid` ([`handoff`]). `adopted`:
    /// systemd took that one as the service's main process. `relaunch`:
    /// launchd keeps the socket, and the process it starts next takes over
    /// from that one. `exited`: its exit code, if it already stopped.
    HandedOff {
        pid: u32,
        adopted: bool,
        relaunch: bool,
        exited: Option<i32>,
    },
}

impl Stopped {
    /// The process's exit code: 75 (`EX_TEMPFAIL`) asks for a restart.
    /// After a handoff under launchd, that starts the service's binary,
    /// which takes over from the new process. After one nothing knows of
    /// (`slopmaxw.exe`, a terminal), this process stands in for the new one
    /// with whatever started it: it waits for it and exits as it does.
    pub async fn finish(self) -> i32 {
        match self {
            Self::Done | Self::HandedOff { adopted: true, .. } => 0,
            Self::Restart => 75,
            Self::HandedOff {
                exited: Some(code), ..
            } => code,
            Self::HandedOff { relaunch: true, .. } => 75,
            Self::HandedOff { pid, .. } => handoff::wait_for(pid).await,
        }
    }
}

/// How long the daemon waits, when it stops, for background work in
/// flight: a usage poll, a refresh whose new token must be saved.
const SETTLE: Duration = Duration::from_secs(5);

/// Runs the proxy from `home`, sending provider traffic to `origins`
/// (benchmarks point them at a local mock).
///
/// Stopping runs in order: the listener stops taking connections and
/// drains the ones open, background loops end and the work they started
/// finishes, refreshes in flight save their tokens, and state is saved
/// last, by the only writer left.
pub async fn serve(config: Config, home: Home, origins: Origins) -> Result<Stopped> {
    serve_with(config, home, origins, Tailnet::default()).await
}

/// [`serve`], asking Tailscale through `tailnet`: tests give fakes, so no
/// test runs the real `tailscale` command.
///
/// On unix the proxy also listens on the home's tailnet socket, which
/// `tailscale serve` passes the tailnet's requests to with who sent each.
/// Only root (tailscaled) and this user may connect to it. A socket that
/// can't be made is logged, and the proxy runs on TCP alone.
pub async fn serve_with(
    config: Config,
    home: Home,
    origins: Origins,
    tailnet: Tailnet,
) -> Result<Stopped> {
    let mut launchd = false;
    let mut launchd_socket = false;
    let (serving, listener, ready) = match handoff::Inherited::take() {
        Some(inherited) => {
            launchd_socket = inherited.launchd;
            let (listener, lock, ready) = inherited.ready();
            write_pid(&home)?;
            listener.set_nonblocking(true)?;
            (lock, listener, Some(ready))
        }
        None => match supervisor::take() {
            // systemd's store holds the socket of a listen address since
            // changed: a fresh one, stored in its place.
            Some(kept)
                if kept.by == supervisor::Keeper::Systemd
                    && kept.listener.local_addr().ok() != Some(config.listen) =>
            {
                drop(kept);
                supervisor::forget();
                (serve_lock(&home)?, bind(config.listen)?, None)
            }
            Some(kept) => {
                launchd = kept.by == supervisor::Keeper::Launchd;
                launchd_socket = launchd;
                let addr = kept.listener.local_addr()?;
                let lock = take_over(&home, &config, addr).await?;
                kept.listener.set_nonblocking(true)?;
                (lock, kept.listener, None)
            }
            None => (serve_lock(&home)?, bind(config.listen)?, None),
        },
    };
    if listener.local_addr().ok() != Some(config.listen) {
        let next = if launchd {
            "once `slopmax proxy install` writes it into the login service"
        } else {
            "at the next restart"
        };
        log::warn!(
            "serving the socket kept for this proxy, on {}; listen = {} applies {next}",
            listener.local_addr().map_or("?".into(), |a| a.to_string()),
            config.listen
        );
    }
    // systemd keeps the socket from now on (a copy, sent once the unit
    // allows it), and passes it to the process it starts next.
    let kept = listener.try_clone().ok();
    let listener = TcpListener::from_std(listener)?;
    let state = read_state(&home);
    let app = App::new(config, home, state, origins);
    app.set_tailnet(tailnet);
    app.sync()?;
    app.launchd
        .store(launchd, std::sync::atomic::Ordering::SeqCst);
    app.launchd_socket
        .store(launchd_socket, std::sync::atomic::Ordering::SeqCst);
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let _ = app.handles.set(handoff::Handles {
            listener: listener.as_raw_fd(),
            lock: serving.as_raw_fd(),
        });
    }
    #[cfg(not(unix))]
    let _ = app.handles.set(handoff::Handles {});
    *app.serving.lock().unwrap_or_else(|p| p.into_inner()) = Some(serving);

    // Logins, removals and `slopmax account use` from the CLI are told to the
    // daemon at once (`/slopmax/api/sync`); the rescan catches the rest.
    // Each job asks the config as it runs, so a changed config.toml turns it
    // on or off without a restart. Every period is a multiple of 30 s, so the
    // jobs share their wakeups: each costs tokio's timer wheel about three,
    // as it moves a long timer down its levels.
    let watching = Arc::new(tokio::sync::Mutex::new(Watch::open(&app)));
    let jobs: Vec<Job> = vec![
        Job::new("save state", Duration::from_secs(30), |app| async move {
            // Nothing to write: no blocking thread woken for nothing.
            if app.pool.needs_save() {
                blocking::run(move || save_state(&app)).await;
            }
        }),
        Job::new("watch", WATCH_EVERY, move |app| {
            let watching = watching.clone();
            async move { watching.lock().await.step(&app).await }
        }),
        Job::new("rescan", RESCAN, |app| async move {
            if let Err(e) = app.rescan() {
                log::warn!("reloading accounts: {e:#}");
            }
            app.reload_config();
        }),
        Job::new("poll", Duration::from_secs(60), |app| async move {
            if app.config().poll_mins > 0 {
                poll_all(&app, false).await;
            }
        }),
        Job::new("record quota", crate::quota::EVERY, |app| async move {
            blocking::run(move || app.sample_quota()).await;
        }),
        Job::new("list credits", Duration::from_secs(60), |app| async move {
            list_credits(&app, false).await;
        }),
        Job::new("warm windows", Duration::from_secs(60), |app| async move {
            if app.config().warm_windows {
                proxy::warm::idle_accounts(&app).await;
            }
        }),
        Job::new(
            "refresh tokens",
            Duration::from_secs(300),
            |app| async move {
                if app.config().refresh_tokens {
                    refresh_all(&app).await;
                }
            },
        ),
        Job::new(
            "follow installs",
            Duration::from_secs(60),
            |app| async move {
                follow_installs(&app).await;
            },
        ),
        Job::new(
            "look for releases",
            Duration::from_secs(3600),
            |app| async move {
                look_for_releases(&app).await;
            },
        ),
        Job::new(
            "redeem expiring",
            Duration::from_secs(1800),
            |app| async move {
                if app.config().redeem_expiring_credits {
                    redeem_expiring(&app).await;
                }
            },
        ),
    ];
    app.spawn(schedule(app.clone(), jobs));

    log::info!(
        "slopmax {} listening on {}",
        env!("CARGO_PKG_VERSION"),
        app.config().base_url()
    );
    let handler = {
        let app = Arc::clone(&app);
        move |request| proxy::handle(Arc::clone(&app), request)
    };
    // Taking connections now: the daemon this one replaces stops, and a
    // service manager counts it started.
    if let Some(ready) = ready {
        ready.tell();
    }
    supervisor::notify("READY=1");
    if let Some(kept) = kept {
        app.spawn(keep_socket(app.clone(), kept));
    }
    // After a handoff, draining ends early if the new process stops, or
    // this one is told to: what it still holds is cut.
    #[cfg(unix)]
    let socket = tailnet_socket::listen(&app, handler.clone());
    let stopping = {
        let app = app.clone();
        async move {
            let how = shutdown(app.clone()).await;
            // The server accepts nothing more once this returns.
            app.let_go.cancel();
            how
        }
    };
    tokio::select! {
        () = server::serve_until(listener, handler, stopping) => {}
        () = app.cut.cancelled() => log::info!("ending what this proxy still had"),
    }
    // Both listeners stop together; the socket goes once it has drained.
    app.stop.cancel();
    #[cfg(unix)]
    if let Some(socket) = socket {
        socket.close(&app.cut).await;
    }
    let successor = *app.successor.lock().unwrap_or_else(|p| p.into_inner());
    let handed_over = app.handed_over.load(std::sync::atomic::Ordering::SeqCst);
    // What the daemon started finishes too: after a handoff, Codex's
    // sockets end their turns, which takes as long as the streams.
    let settle = if handed_over { handoff::DRAIN } else { SETTLE };
    app.tasks.close();
    let settled = tokio::select! {
        done = tokio::time::timeout(settle, app.tasks.wait()) => done.is_ok(),
        () = app.cut.cancelled() => false,
    };
    if !settled {
        log::warn!("stopping without waiting longer for background work");
    }
    auth::settle(SETTLE).await;
    save_state(&app);
    app.ledger.sync();
    drop(app.serving.lock().unwrap_or_else(|p| p.into_inner()).take());
    if handed_over {
        log::info!("finished what this proxy started; the new one serves");
    } else {
        log::info!("stopped");
    }
    Ok(match successor {
        Some((pid, adopted)) => Stopped::HandedOff {
            pid,
            adopted,
            relaunch: app.launchd.load(std::sync::atomic::Ordering::SeqCst),
            exited: *app.successor_exit.lock().unwrap_or_else(|p| p.into_inner()),
        },
        None if app.restart.load(std::sync::atomic::Ordering::Relaxed) => Stopped::Restart,
        None => Stopped::Done,
    })
}

/// Moves the proxy to a newer slopmax once its install has one.
async fn follow_installs(app: &Arc<App>) {
    let Some(newer) = handoff::look_for_newer(app).await else {
        return;
    };
    log::info!(
        "a newer slopmax is installed at {}; moving to it",
        newer.display()
    );
    if cfg!(unix) {
        let _ = handoff::hand_off(app, &newer, true).await;
    } else if app.running.as_ref().is_some_and(|r| r.path == newer) {
        // Windows: replaced in place, so a restart runs it.
        app.restart
            .store(true, std::sync::atomic::Ordering::Relaxed);
        app.stop.cancel();
    }
}

/// Looks up the newest release once a day, for `slopmax status` to tell.
async fn look_for_releases(app: &Arc<App>) {
    if !update::checks(&app.config()) {
        return;
    }
    let now = Timestamp::now();
    if update::Checked::read(&app.home).is_some_and(|c| !c.stale(now)) {
        return;
    }
    // Offline, or GitHub away: quietly, and again in an hour.
    let Ok(latest) = update::latest(&app.auth_http).await else {
        return;
    };
    let checked = update::Checked {
        checked_at: now,
        latest: latest.to_string(),
    };
    app.saw_release(&checked);
    if let Some(newer) = checked.newer() {
        log::info!(
            "slopmax {newer} is out (this is {}); `slopmax update` installs it",
            env!("CARGO_PKG_VERSION")
        );
    }
    let home = app.home.clone();
    blocking::run(move || {
        if let Err(e) = checked.write(&home) {
            log::warn!("saving the release lookup: {e}");
        }
    })
    .await;
}

/// Listens on `listen`, saying what holds the port when it is taken.
fn bind(listen: std::net::SocketAddr) -> Result<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind(listen).map_err(|source| {
        // Windows refuses a port another process holds as access denied;
        // elsewhere that means a port below 1024, whoever holds it.
        let taken = source.kind() == std::io::ErrorKind::AddrInUse
            || cfg!(windows) && source.kind() == std::io::ErrorKind::PermissionDenied;
        match server::port_holder(listen.port()).filter(|_| taken) {
            Some(holder) => ListenError::Held {
                addr: listen,
                holder,
            },
            None => ListenError::Unavailable {
                addr: listen,
                cause: source,
            },
        }
    })?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// How often the account files are checked for changes the daemon was not
/// told about.
const RESCAN: Duration = Duration::from_secs(30);

/// The socket `tailscale serve` passes the tailnet's requests to.
#[cfg(unix)]
mod tailnet_socket {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::Arc;

    use tokio_util::sync::CancellationToken;

    use crate::log;
    use crate::net::server::{self, Request, Response};
    use crate::proxy::App;

    /// The longest socket path taken: macOS holds 104 bytes, Linux 108.
    const LONGEST: usize = 100;

    /// The socket being served.
    pub(crate) struct Socket {
        path: PathBuf,
        /// The socket file this process made, as (device, inode): after a
        /// handoff the path holds the new process's, which stays.
        made: (u64, u64),
        serving: tokio::task::JoinHandle<()>,
    }

    impl Socket {
        /// Waits for its connections to drain, once the daemon stops, or
        /// until `cut`, and removes it if the path is still this one's.
        pub async fn close(self, cut: &CancellationToken) {
            tokio::select! {
                _ = self.serving => {}
                () = cut.cancelled() => {}
            }
            match std::fs::symlink_metadata(&self.path) {
                Ok(meta) if (meta.dev(), meta.ino()) == self.made => {}
                _ => return,
            }
            if let Err(e) = std::fs::remove_file(&self.path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                log::warn!("removing {}: {e}", self.path.display());
            }
        }
    }

    /// Serves `handler` on the home's tailnet socket until the daemon
    /// stops: open to this user and root (tailscaled) only. Anything in
    /// the way but an old socket is left alone, and the proxy runs without
    /// it. The serve lock says no other daemon owns an old one, but for
    /// one this process took over from: it keeps what it has, and new
    /// connections come here.
    pub(crate) fn listen<H, F>(app: &Arc<App>, handler: H) -> Option<Socket>
    where
        H: Fn(Request) -> F + Clone + Send + Sync + 'static,
        F: Future<Output = Response> + Send + 'static,
    {
        let path = app.home.tailnet_socket();
        let not_listening = |why: &dyn std::fmt::Display| {
            log::warn!(
                "not listening on {}: {why}; Tailscale can't reach slopmax there",
                path.display()
            );
        };
        if path.as_os_str().len() > LONGEST {
            not_listening(
                &"the path is too long for a socket (move SLOPMAX_HOME somewhere shorter)",
            );
            return None;
        }
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_socket() => {
                if let Err(e) = std::fs::remove_file(&path) {
                    not_listening(&format_args!("removing the old socket: {e}"));
                    return None;
                }
            }
            Ok(_) => {
                not_listening(&"something else is there");
                return None;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                not_listening(&e);
                return None;
            }
        }
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(e) => {
                not_listening(&e);
                return None;
            }
        };
        let made = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .and_then(|()| std::fs::symlink_metadata(&path));
        let (owner, made) = match made {
            Ok(meta) => (meta.uid(), (meta.dev(), meta.ino())),
            Err(e) => {
                not_listening(&format_args!("making it private: {e}"));
                drop(listener);
                let _ = std::fs::remove_file(&path);
                return None;
            }
        };
        let serving = tokio::spawn(server::serve_until(
            server::tailnet(listener, owner),
            handler,
            crate::shutdown(Arc::clone(app)),
        ));
        Some(Socket {
            path,
            made,
            serving,
        })
    }
}

/// Takes the home's serve lock, held while the daemon runs, so a second
/// daemon on the same home fails to start instead of racing the first for
/// its files. The CLI holds it a moment to change the state of a home no
/// daemon serves ([`crate::state::change`]), which is waited out.
///
/// The holder's pid goes in a file beside it, `.serve.pid`, for the error
/// a second daemon gives: Windows locks a file against reading too.
fn serve_lock(home: &Home) -> Result<std::fs::File> {
    match lock_within(home, Duration::from_secs(1))? {
        Some(file) => Ok(file),
        None => held(home),
    }
}

/// The error for a home another daemon serves.
fn held<T>(home: &Home) -> Result<T> {
    let pid = std::fs::read_to_string(home.dir().join(".serve.pid")).unwrap_or_default();
    let holder = match pid.trim() {
        "" => String::new(),
        pid => format!(" (pid {pid})"),
    };
    bail!(
        "another slopmax{holder} is already serving {}",
        home.dir().display()
    )
}

/// The serve lock, once it is free within `wait`; `None` if it isn't.
fn lock_within(home: &Home, wait: Duration) -> Result<Option<std::fs::File>> {
    let path = home.dir().join(".serve.lock");
    fsx::private_dir(home.dir())?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    let deadline = std::time::Instant::now() + wait;
    let taken = loop {
        match file.try_lock() {
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            taken => break taken,
        }
    };
    match taken {
        Ok(()) => {
            write_pid(home)?;
            Ok(Some(file))
        }
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => {
            Err(e).with_context(|| format!("locking {}", path.display()))
        }
    }
}

/// The serve lock for a process the service manager gave the socket to.
/// One that still serves the home (under launchd, the process the proxy
/// was handed to before this one started) is asked through the socket to
/// make way ([`handoff::make_way`]): it lets go of the home once its state
/// is saved, and finishes its requests while this one takes the new ones.
async fn take_over(
    home: &Home,
    config: &Config,
    addr: std::net::SocketAddr,
) -> Result<std::fs::File> {
    let lookup = home.clone();
    if let Some(file) = blocking::run(move || lock_within(&lookup, Duration::from_secs(1))).await? {
        return Ok(file);
    }
    log::info!("another slopmax still serves this home; asking it to make way");
    let key = config.api_key.clone();
    if let Err(e) = blocking::run(move || ask_to_make_way(addr, &key)).await {
        log::warn!("asking the other slopmax to make way: {e:#}");
    }
    let lookup = home.clone();
    match blocking::run(move || lock_within(&lookup, MAKE_WAY)).await? {
        Some(file) => Ok(file),
        None => held(home),
    }
}

/// How long a daemon making way has to save the state and let go.
const MAKE_WAY: Duration = Duration::from_secs(30);

/// Asks the daemon taking connections on `addr` to make way for this one.
fn ask_to_make_way(addr: std::net::SocketAddr, key: &str) -> Result<()> {
    use std::io::{BufRead, Write};
    let mut addr = addr;
    if addr.ip().is_unspecified() {
        addr.set_ip(match addr {
            std::net::SocketAddr::V4(_) => std::net::Ipv4Addr::LOCALHOST.into(),
            std::net::SocketAddr::V6(_) => std::net::Ipv6Addr::LOCALHOST.into(),
        });
    }
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(MAKE_WAY))?;
    let body = serde_json::to_string(&slopmax_api::requests::Shutdown {
        make_way: true,
        ..Default::default()
    })?;
    write!(
        stream,
        "POST /slopmax/api/shutdown HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {key}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    let mut status = String::new();
    std::io::BufReader::new(stream).read_line(&mut status)?;
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(()),
        _ => bail!("it answered {}", status.trim()),
    }
}

/// Has the service manager keep the listening socket: systemd stores it
/// once its unit allows that, which this rewrites when it predates it.
async fn keep_socket(app: Arc<App>, listener: std::net::TcpListener) {
    if !cfg!(target_os = "linux") || std::env::var_os("NOTIFY_SOCKET").is_none() {
        return;
    }
    let home = app.home.clone();
    let listen = app.config().listen;
    blocking::run(move || {
        if let Some(manager) = slopmax_core::service::Manager::detect()
            && let Err(e) = manager.refresh(&home, listen)
        {
            log::warn!("updating the login service: {e:#}");
        }
        supervisor::keep(&listener);
    })
    .await;
}

/// Names this process the lock's holder, in `.serve.pid`.
fn write_pid(home: &Home) -> Result<()> {
    let pid = home.dir().join(".serve.pid");
    std::fs::write(&pid, std::process::id().to_string())
        .with_context(|| format!("writing {}", pid.display()))
}

/// The state saved at the last stop. One that cannot be read is moved
/// aside, and the daemon starts without it: health and readings come back
/// with the next requests and polls, while a daemon that refused to start
/// would stop every agent.
fn read_state(home: &Home) -> State {
    let path = home.state();
    match fsx::read_toml(&path) {
        Ok(state) => crate::state::upgrade(home, state.unwrap_or_default()),
        Err(e) => {
            // The file that failed: the TOML, or the JSON an earlier
            // version left, which was being read in its place.
            let bad = match path.exists() {
                true => path,
                false => path.with_extension("json"),
            };
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let name = bad
                .file_name()
                .map_or("state".into(), |n| n.to_string_lossy());
            let aside = bad.with_file_name(format!("{name}.bad-{at}"));
            match std::fs::rename(&bad, &aside) {
                Ok(()) => log::warn!(
                    "{name} could not be read ({e}); moved it to {} and started afresh",
                    aside.display()
                ),
                Err(moving) => log::warn!(
                    "{name} could not be read ({e}) or moved aside ({moving}); started afresh"
                ),
            }
            crate::state::upgrade(home, State::default())
        }
    }
}

/// One background job: what it is called, how often it runs, and what it
/// does.
struct Job {
    name: &'static str,
    every: Duration,
    run: Box<dyn Fn(Arc<App>) -> proxy::BoxedTask + Send + Sync>,
}

impl Job {
    fn new<F, Fut>(name: &'static str, every: Duration, run: F) -> Self
    where
        F: Fn(Arc<App>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Self {
            name,
            every,
            run: Box::new(move |app| Box::pin(run(app))),
        }
    }
}

/// Runs every job on one timer, until the daemon stops: it sleeps until the
/// soonest is due, then starts each one due as a task of its own. A job runs
/// once at a time and never catches up on runs it missed; one that panics is
/// logged and runs again on schedule. Jobs due at once start together, so
/// the daemon wakes once for them.
async fn schedule(app: Arc<App>, jobs: Vec<Job>) {
    let start = tokio::time::Instant::now();
    let mut next = vec![start; jobs.len()];
    let mut running: Vec<Option<tokio::task::JoinHandle<()>>> = jobs.iter().map(|_| None).collect();
    loop {
        let soonest = next.iter().copied().min().unwrap_or(start);
        tokio::select! {
            () = tokio::time::sleep_until(soonest) => {}
            () = app.stop.cancelled() => return,
        }
        let now = tokio::time::Instant::now();
        for (i, job) in jobs.iter().enumerate() {
            if next[i] > now {
                continue;
            }
            // From the slot it was due in, so jobs of the same period stay
            // in step however long a run takes.
            while next[i] <= now {
                next[i] += job.every;
            }
            if running[i].as_ref().is_some_and(|run| !run.is_finished()) {
                continue;
            }
            // Moving to another binary: that one runs the jobs from now,
            // and a refresh here would rotate a token under it.
            if app.handing_off.load(std::sync::atomic::Ordering::SeqCst) {
                continue;
            }
            if let Some(run) = running[i].take()
                && let Err(e) = run.await
                && e.is_panic()
            {
                log::error!("{} failed; it runs again on schedule: {e}", job.name);
            }
            running[i] = Some(app.tasks.spawn((job.run)(app.clone())));
        }
    }
}

/// Waits for the daemon to be stopped. How it stops: after a handoff, its
/// connections end as their clients finish with them; else at once, with a
/// few seconds for requests under way.
async fn shutdown(app: Arc<App>) -> server::Stop {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
        () = app.stop.cancelled() => {},
    }
    app.stop.cancel();
    if app.handed_over.load(std::sync::atomic::Ordering::SeqCst) {
        server::Stop::HandedOver(handoff::DRAIN)
    } else {
        server::Stop::Now(server::DRAIN)
    }
}

/// Watches the accounts' conditions, telling each change: in the log, on
/// the API's event stream (which the dashboard posts as notifications),
/// and to the configured webhook or command. The nudges told are kept with
/// the state, so a restart does not tell them again.
struct Watch {
    watcher: notify::Watcher,
}

impl Watch {
    fn open(app: &App) -> Self {
        Self {
            watcher: notify::Watcher::remembering(app.pool.told()),
        }
    }

    async fn step(&mut self, app: &App) {
        let now = Timestamp::now();
        let accounts = app.pool.accounts();
        let mut events = self
            .watcher
            .changes(&accounts, |id| app.pool.state(id), now);
        let config = app.config();
        let report = app.report();
        let subjects: Vec<notify::Subject> =
            report.accounts.iter().map(notify::Subject::of).collect();
        let nudges = notify::nudges(
            &subjects,
            config.redeem_expiring_credits,
            &config.plan_prices,
            now,
        );
        let fresh = self.watcher.new_nudges(nudges);
        if !fresh.is_empty() {
            app.pool.set_told(self.watcher.told());
        }
        events.extend(fresh);
        for event in events {
            log::info!("{}", event.message);
            if app.api_events.receiver_count() > 0 {
                let key = format!(
                    "{}:{}:{}",
                    event.event.as_str(),
                    event.account.as_deref().unwrap_or("-"),
                    event.until.map_or(0, |at| at.as_second())
                );
                let notice = slopmax_api::events::Event::Notice {
                    notice: crate::api::notice(&key, &event),
                };
                let _ = app.api_events.send(notice.frame().into());
            }
            if !config.notify.is_enabled() {
                continue;
            }
            if let Err(e) = config.notify.send(&app.auth_http, &event).await {
                log::warn!("sending a notification: {e:#}");
            }
        }
    }
}

/// Saves the state now, off the runtime's thread, for a change that should
/// outlast a crash at once, such as a pin, rather than wait for the save
/// job's next turn.
pub(crate) fn save_soon(app: &Arc<App>) {
    let app = Arc::clone(app);
    let worker = Arc::clone(&app);
    app.spawn(async move { blocking::run(move || save_state(&worker)).await });
}

fn save_state(app: &App) {
    // Handing off: the new process has read the state and writes it now.
    if app.frozen.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    save_state_now(app);
}

/// Saves the state whatever else is going on.
pub(crate) fn save_state_now(app: &App) {
    let now = Timestamp::now();
    record_lapses(app, now);
    let (state, dirty) = app.pool.snapshot(now);
    if dirty && let Err(e) = fsx::write_toml(&app.home.state(), &state) {
        log::warn!("saving state: {e}");
    }
}

/// Writes down the windows that reset, with how much of each was used, for
/// what was left on the table.
fn record_lapses(app: &App, now: Timestamp) {
    let lapses = app.pool.take_lapses(now);
    if lapses.is_empty() {
        return;
    }
    let accounts = app.pool.accounts();
    let records: Vec<crate::waste::Record> = lapses
        .into_iter()
        .filter_map(|(id, lapse)| {
            let account = accounts.iter().find(|a| a.id == id)?;
            Some(crate::waste::Record {
                ended_at: lapse.ended_at,
                account: id,
                provider: account.provider,
                plan: account.plan.clone(),
                span: lapse.span,
                model: lapse.model,
                used: lapse.used,
            })
        })
        .collect();
    app.hours.lapsed(&records);
    app.ledger.record_windows(&records);
}

/// Refreshes tokens that are close to expiring, so a request never waits
/// on a refresh. Disabled accounts are kept fresh too.
async fn refresh_all(app: &App) {
    for account in app.pool.accounts().iter() {
        if account.auth_error.is_some() {
            continue;
        }
        match auth::ensure_fresh(&app.auth_http, &app.store, account, false).await {
            Ok(fresh) => app.adopt(account, &fresh),
            Err(e) => {
                log::warn!("{}: {e}", account.id);
                app.refresh_failed(account, &e);
            }
        }
    }
}

/// Polls usage for accounts whose reading is due (or all, with `force`).
pub async fn poll_all(app: &Arc<App>, force: bool) {
    let now = Timestamp::now();
    let interval = SignedDuration::from_mins(app.config().poll_mins.max(1) as i64);
    let due: Vec<Arc<Account>> = app
        .pool
        .accounts()
        .iter()
        .filter(|&a| a.auth_error.is_none() && a.provider.spec().is_subscription())
        .filter(|&a| force || is_due(app, a, now, interval))
        .cloned()
        .collect();
    let mut polls = tokio::task::JoinSet::new();
    for account in due {
        let app = Arc::clone(app);
        polls.spawn(async move { poll_one(&app, &account).await });
    }
    while polls.join_next().await.is_some() {}
}

/// Polls one account's usage and records the reading, or the failure.
pub async fn poll_one(app: &App, account: &Account) {
    let result = usage::poll(
        &app.auth_http,
        &app.store,
        account,
        app.config().refresh_tokens,
    )
    .await;
    match result {
        Ok((fresh, reading)) => {
            app.adopt(account, &fresh);
            app.pool
                .record_reading(&account.id, reading.limits, Timestamp::now());
            if reading.plan.is_some() && reading.plan != fresh.plan {
                let (store, id, plan) = (app.store.clone(), fresh.id.clone(), reading.plan);
                match blocking::run(move || store.update(&id, |a| a.plan = plan)).await {
                    // Status and the dashboard read the pool's copy.
                    Ok(saved) => app.pool.put(&saved),
                    Err(e) => log::warn!("{}: saving plan: {e:#}", fresh.id),
                }
            }
        }
        Err(e) => {
            log::warn!("{}: usage poll failed: {e:#}", account.id);
            // A refresh during the poll may have found the sign-in revoked,
            // and marked the stored copy.
            if let Ok(Some(stored)) = app.store.get(&account.id)
                && stored.auth_error.is_some()
            {
                app.pool.put(&stored);
            }
            app.pool
                .record_error(&account.id, &format!("usage poll: {e:#}"));
        }
    }
}

/// Lists the reset credits of each account that may have some, when its
/// list is due: never listed, listed [`LIST_CREDITS_EVERY`] ago, or no
/// longer matching the count its usage reports; or, for a provider whose
/// usage keeps no count, listed [`LIST_UNCOUNTED_EVERY`] ago. `force` lists
/// them all now.
pub async fn list_credits(app: &App, force: bool) {
    let now = Timestamp::now();
    for account in app.pool.accounts().iter() {
        let Some(credits) = account.provider.get().credits() else {
            continue;
        };
        let agent = app.pool.agent(account.provider);
        let state = app.pool.state(&account.id);
        let counted = state.limits.reset_credits;
        let none = credits.counted() && counted.unwrap_or(0) == 0 && state.credits_left(now) == 0;
        if account.disabled
            || account.auth_error.is_some()
            || none
            || (credits.needs_agent() && agent.is_none())
        {
            continue;
        }
        let every = if credits.counted() {
            LIST_CREDITS_EVERY
        } else {
            LIST_UNCOUNTED_EVERY
        };
        let due = match &state.credits {
            None => true,
            Some(list) => {
                let age = now.duration_since(list.listed_at);
                age >= every || (age >= LIST_CREDITS_GAP && list.counted != counted)
            }
        };
        if !force && !due {
            continue;
        }
        let Some(account) = app.ready(account).await else {
            continue;
        };
        match credits
            .list(&app.auth_http, &account, agent.as_deref())
            .await
        {
            Ok(listed) => app.pool.record_credits(&account.id, listed, now),
            Err(e) => {
                log::warn!("{}: listing limit resets: {e:#}", account.id);
                if !credits.counted() {
                    let kept = state.unexpired_credits(now).cloned().collect();
                    app.pool.record_credits(&account.id, kept, now);
                }
            }
        }
    }
}

/// Redeems reset credits about to expire on accounts with usage to reset.
/// A lapsed credit is simply lost, so spending it first is free quota.
pub async fn redeem_expiring(app: &App) {
    let now = Timestamp::now();
    for account in app.pool.accounts().iter() {
        let Some(credits) = account.provider.get().credits() else {
            continue;
        };
        let state = app.pool.state(&account.id);
        let used = state.limits.windows.iter().any(|w| w.used_at(now) > 0.0);
        if (credits.needs_agent() && app.pool.agent(account.provider).is_none())
            || account.disabled
            || account.auth_error.is_some()
            || state.credits_left(now) == 0
            || !used
        {
            continue;
        }
        let _redeeming = app.redeeming.lock().await;
        let Some(account) = app.ready(account).await else {
            continue;
        };
        match redeem_if_expiring(app, &account, now).await {
            Ok(Some((Outcome::Reset, credit))) => {
                log::info!("{}: redeemed a limit reset before it expired", account.id);
                app.pool
                    .record_reset(&account.id, Timestamp::now(), Some(&credit));
            }
            Ok(Some((outcome, _))) => {
                log::info!(
                    "{}: expiring limit reset not used ({outcome:?})",
                    account.id
                );
            }
            Ok(None) => {}
            Err(e) => log::warn!("{}: checking limit resets: {e:#}", account.id),
        }
    }
}

/// Redeems the account's soonest-expiring credit if it lapses within
/// [`CREDIT_EXPIRY_LEAD`], returning how that went and the credit's id. The
/// list it reads is kept for the account.
async fn redeem_if_expiring(
    app: &App,
    account: &Account,
    now: Timestamp,
) -> Result<Option<(Outcome, String)>> {
    let Some(credits) = account.provider.get().credits() else {
        return Ok(None);
    };
    let agent = app.pool.agent(account.provider);
    let available = credits
        .list(&app.auth_http, account, agent.as_deref())
        .await?;
    app.pool.record_credits(&account.id, available.clone(), now);
    let expiring = available.first().filter(|c| {
        c.expires_at
            .is_some_and(|at| at.duration_since(now) <= CREDIT_EXPIRY_LEAD)
    });
    let Some(credit) = expiring else {
        return Ok(None);
    };
    let outcome = credits
        .redeem(
            &app.auth_http,
            account,
            agent.as_deref(),
            Some(&credit.id),
            None,
        )
        .await?;
    Ok(Some((outcome, credit.id.clone())))
}

/// A reading is due when it is stale, when a window has reset since it was
/// taken (so the fresh window is picked up promptly), or periodically while
/// the account is blocked (quota often frees up before the stated reset).
fn is_due(app: &App, account: &Account, now: Timestamp, interval: SignedDuration) -> bool {
    let state = app.pool.state(&account.id);
    let Some(observed) = state.limits.observed_at else {
        return true;
    };
    let age = now.duration_since(observed);
    let window_reset = state
        .limits
        .windows
        .iter()
        .filter_map(|w| w.resets_at)
        .any(|at| at > observed && at <= now);
    age >= interval || window_reset || (state.is_blocked(now) && age >= RECHECK_BLOCKED)
}
