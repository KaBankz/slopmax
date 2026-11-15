//! Moving the proxy to another slopmax binary, such as an update, without
//! refusing or cutting off a connection.
//!
//! The running daemon starts the new binary with its listening socket and
//! its home's lock, and waits for it to say it is ready. Then it stops
//! taking connections and finishes the requests it has, streams and
//! Codex's turns included, while the new one takes every connection from
//! then on: the socket never closes, so agents never see the move.
//!
//! What supervises the proxy has to keep seeing it run. systemd is told
//! the new process is the service's main one (`MAINPID=`). Anything else
//! (launchd, `slopmaxw.exe`, a terminal) watches the process it started, so
//! that one stays: once drained it waits for the new process, passes on
//! the signals it gets, and exits as the new one does.
//!
//! Windows has no way to hand a socket to a child that slopmax uses, so a
//! move there is a restart: `slopmaxw.exe` starts the binary again at once.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::log;
use crate::proxy::App;
use crate::update::install::{self, FileId, Install};
use crate::update::{self, Version};

/// What a handing-off daemon sets for the new one:
/// `<its pid>:<listener fd>:<lock fd>:<ready fd>`.
#[cfg(unix)]
const ENV: &str = "SLOPMAX_HANDOFF";
/// How long the new binary has to start and say it is ready.
#[cfg(unix)]
const READY_WAIT: Duration = Duration::from_secs(30);
/// How long the old daemon lets its requests run once the new one serves:
/// long enough for any answer an agent waits for.
pub const DRAIN: Duration = Duration::from_secs(30 * 60);

/// What a handing-off daemon passed this one.
pub struct Inherited {
    pub listener: std::net::TcpListener,
    pub lock: std::fs::File,
    ready: std::fs::File,
}

impl Inherited {
    /// What the parent handed this process, if it is a daemon handing off.
    /// The variable names the parent's pid, so a process that only
    /// inherited the environment further down takes nothing.
    #[cfg(unix)]
    #[allow(unsafe_code)]
    pub fn take() -> Option<Self> {
        use std::os::fd::FromRawFd;
        let value = std::env::var(ENV).ok()?;
        let fields: Vec<i32> = value.split(':').filter_map(|f| f.parse().ok()).collect();
        let &[parent, listener, lock, ready] = fields.as_slice() else {
            return None;
        };
        // SAFETY: getppid has no preconditions.
        if parent != unsafe { libc::getppid() } {
            return None;
        }
        for fd in [listener, lock, ready] {
            // SAFETY: fcntl on any number is safe; an fd that is not open
            // fails with EBADF. Marked close-on-exec again, so they do not
            // leak into what this process starts.
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                log::warn!("{ENV} names fd {fd}, which is not open; starting afresh");
                return None;
            }
        }
        // SAFETY: each fd is open, was handed to this process alone, and is
        // owned from here on by exactly one value.
        let (listener, lock, ready) = unsafe {
            (
                std::net::TcpListener::from_raw_fd(listener),
                std::fs::File::from_raw_fd(lock),
                std::fs::File::from_raw_fd(ready),
            )
        };
        Some(Self {
            listener,
            lock,
            ready,
        })
    }

    #[cfg(not(unix))]
    pub fn take() -> Option<Self> {
        None
    }

    /// Tells the old daemon this one serves: it stops taking connections.
    pub fn ready(self) -> (std::net::TcpListener, std::fs::File, Ready) {
        (self.listener, self.lock, Ready(self.ready))
    }
}

/// The old daemon's line, written once this one takes connections.
pub struct Ready(std::fs::File);

impl Ready {
    pub fn tell(mut self) {
        if let Err(e) = std::io::Write::write_all(&mut self.0, b"r") {
            log::warn!("telling the old proxy this one is ready: {e}");
        }
    }
}

/// Tells systemd `state` (`READY=1`, `MAINPID=…`) when it supervises this
/// process with `Type=notify`. Whether it was told.
#[cfg(unix)]
pub fn notify(state: &str) -> bool {
    use std::os::unix::net::UnixDatagram;
    let Some(path) = std::env::var_os("NOTIFY_SOCKET") else {
        return false;
    };
    let Ok(socket) = UnixDatagram::unbound() else {
        return false;
    };
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
    let sent = match bytes.strip_prefix(b"@") {
        #[cfg(target_os = "linux")]
        Some(name) => {
            use std::os::linux::net::SocketAddrExt;
            std::os::unix::net::SocketAddr::from_abstract_name(name)
                .and_then(|addr| socket.send_to_addr(state.as_bytes(), &addr))
        }
        #[cfg(not(target_os = "linux"))]
        Some(_) => return false,
        None => socket.send_to(state.as_bytes(), &path),
    };
    sent.inspect_err(|e| log::warn!("telling systemd {state}: {e}"))
        .is_ok()
}

#[cfg(not(unix))]
pub fn notify(_state: &str) -> bool {
    false
}

/// The descriptors a handoff passes on: the listener and the lock, while
/// this daemon holds them.
#[derive(Debug, Clone, Copy)]
pub struct Handles {
    #[cfg(unix)]
    pub listener: std::os::fd::RawFd,
    #[cfg(unix)]
    pub lock: std::os::fd::RawFd,
}

/// The binary this daemon runs, to notice when its install has a newer one.
#[derive(Debug)]
pub struct Running {
    pub path: PathBuf,
    id: Option<FileId>,
    install: Install,
}

impl Running {
    pub fn now() -> Option<Self> {
        let path = std::env::current_exe().ok()?.canonicalize().ok()?;
        Some(Self {
            id: FileId::of(&path),
            install: Install::of(&path),
            path,
        })
    }
}

/// Hands the proxy to the slopmax at `exe`, which must answer `--version`;
/// with `newer`, only to a version newer than this one. Returns once the
/// new process serves; this one then drains and stops. On failure this one
/// carries on as before.
pub async fn hand_off(app: &Arc<App>, exe: &Path, newer: bool) -> Result<()> {
    if app.handing_off.swap(true, Ordering::SeqCst) {
        bail!("the proxy is already moving to another binary");
    }
    let result = attempt(app, exe, newer).await;
    if let Err(e) = &result {
        log::warn!("not moving to {}: {e:#}", exe.display());
        app.frozen.store(false, Ordering::SeqCst);
        app.handing_off.store(false, Ordering::SeqCst);
    }
    result
}

async fn attempt(app: &Arc<App>, exe: &Path, newer: bool) -> Result<()> {
    let target = exe.to_path_buf();
    let version = crate::blocking::run(move || update::binary_version(&target))
        .await
        .with_context(|| format!("{} is not a slopmax that runs here", exe.display()))?;
    if newer && version <= Version::current() {
        bail!(
            "{} is slopmax {version}, not newer than this one",
            exe.display()
        );
    }
    let handles = app
        .handles
        .get()
        .copied()
        .context("the proxy is not serving yet")?;
    // From here until the new process takes over, nothing this one learns
    // is saved: the new one reads the state as it is written now, and two
    // writers would undo each other. Refreshes in flight finish first, so
    // a rotated token is on disk before the new process reads it.
    app.frozen.store(true, Ordering::SeqCst);
    crate::auth::settle(Duration::from_secs(5)).await;
    let saver = Arc::clone(app);
    crate::blocking::run(move || crate::save_state_now(&saver)).await;
    let pid = start(exe, handles).await?;
    log::info!(
        "slopmax {version} (pid {pid}) serves from {}; finishing what this one started",
        exe.display()
    );
    let adopted = notify(&format!("MAINPID={pid}"));
    *app.successor.lock().unwrap_or_else(|p| p.into_inner()) = Some((pid, adopted));
    // While this one drains, a stop it is sent goes to the new process,
    // and once that ends nothing here is worth keeping.
    let watcher = Arc::clone(app);
    tokio::spawn(async move {
        let code = wait_for(pid).await;
        *watcher
            .successor_exit
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(code);
        watcher.cut.cancel();
    });
    // The service runs the new binary from now on; `exe` may be the link
    // itself, so what it resolves to.
    if install::linked(&app.home).is_some()
        && let Ok(real) = exe.canonicalize()
        && let Err(e) = install::link(&app.home, &Install::of(&real).entry(&real))
    {
        log::warn!("pointing the service at {}: {e}", exe.display());
    }
    app.stop.cancel();
    Ok(())
}

/// Starts `exe serve` with this daemon's socket and lock, and waits until
/// it says it is ready. Its pid.
#[cfg(unix)]
#[allow(unsafe_code)]
async fn start(exe: &Path, handles: Handles) -> Result<u32> {
    use std::io::Read;
    use std::os::fd::FromRawFd;
    use std::os::unix::process::CommandExt;

    let mut pipe = [0; 2];
    // SAFETY: `pipe` has room for the two fds pipe(2) writes.
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } == -1 {
        return Err(std::io::Error::last_os_error()).context("making the ready pipe");
    }
    let [read_fd, write_fd] = pipe;
    // SAFETY: both fds were just made by pipe(2) and are owned here.
    let (mut ready, writer) = unsafe {
        (
            std::fs::File::from_raw_fd(read_fd),
            std::fs::File::from_raw_fd(write_fd),
        )
    };
    for fd in [read_fd, write_fd] {
        // SAFETY: fcntl on an fd this process owns.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    let passed = [handles.listener, handles.lock, write_fd];
    let mut command = std::process::Command::new(exe);
    command
        .arg("serve")
        .env(
            ENV,
            format!(
                "{}:{}:{}:{}",
                std::process::id(),
                handles.listener,
                handles.lock,
                write_fd
            ),
        )
        .stdin(std::process::Stdio::null());
    // SAFETY: the closure runs in the forked child before exec and only
    // calls fcntl, which is async-signal-safe.
    unsafe {
        command.pre_exec(move || {
            for fd in passed {
                if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("starting {}", exe.display()))?;
    drop(writer);
    let pid = child.id();
    let said = tokio::task::spawn_blocking(move || {
        let mut byte = [0u8; 1];
        ready.read(&mut byte).map(|n| n == 1)
    });
    match tokio::time::timeout(READY_WAIT, said).await {
        Ok(Ok(Ok(true))) => Ok(pid),
        outcome => {
            // It never took over: end it, which also ends the wait.
            let _ = child.kill();
            let _ = child.wait();
            match outcome {
                Err(_) => bail!(
                    "{} did not say it was ready within {} s",
                    exe.display(),
                    READY_WAIT.as_secs()
                ),
                _ => bail!("{} stopped before it was ready", exe.display()),
            }
        }
    }
}

#[cfg(not(unix))]
async fn start(_exe: &Path, _handles: Handles) -> Result<u32> {
    bail!("handing the socket to another process isn't supported on this system")
}

/// Waits for the process the proxy moved to, as the one its supervisor
/// started, passing on the signals that stop it. Its exit code.
#[cfg(unix)]
#[allow(unsafe_code)]
pub async fn wait_for(pid: u32) -> i32 {
    use tokio::signal::unix::{SignalKind, signal};
    let pid = pid as libc::pid_t;
    let mut terminate = signal(SignalKind::terminate()).ok();
    let mut interrupt = signal(SignalKind::interrupt()).ok();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    loop {
        let mut status = 0;
        // SAFETY: waitpid with WNOHANG on this process's own child.
        match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
            0 => {}
            -1 => return 0,
            _ if libc::WIFEXITED(status) => return libc::WEXITSTATUS(status),
            _ => return 128 + libc::WTERMSIG(status),
        }
        let forward = tokio::select! {
            _ = tick.tick() => None,
            Some(()) = async { terminate.as_mut()?.recv().await } => Some(libc::SIGTERM),
            Some(()) = async { interrupt.as_mut()?.recv().await } => Some(libc::SIGINT),
        };
        if let Some(sig) = forward {
            // SAFETY: kill(2) to this process's own child.
            unsafe { libc::kill(pid, sig) };
        }
    }
}

#[cfg(not(unix))]
pub async fn wait_for(_pid: u32) -> i32 {
    0
}

/// The newest slopmax its install holds, when that is not the one running
/// and is newer: an upgrade made by mise, the install script, Homebrew, or
/// `slopmax update`, which the proxy then moves to. mise is asked only
/// when its files changed.
pub async fn look_for_newer(app: &Arc<App>) -> Option<PathBuf> {
    let running = app.running.as_ref()?;
    let mut seen = app.install_seen.lock().await;
    if let Install::Mise { root, .. } = &running.install {
        let stamp = mise_stamp(root);
        if seen.stamp == Some(stamp) {
            return None;
        }
        seen.stamp = Some(stamp);
    }
    let install = running.install.clone();
    let path = running.path.clone();
    let candidate = crate::blocking::run(move || install.current(&path)).await?;
    let id = FileId::of(&candidate);
    if id.is_none() || (candidate == running.path && id == running.id) || seen.tried == id {
        return None;
    }
    seen.tried = id;
    let probe = candidate.clone();
    let version = crate::blocking::run(move || update::binary_version(&probe)).await?;
    (version > Version::current()).then_some(candidate)
}

/// When a mise install was last changed: its tool directory (a version
/// added or removed) and the global config (a pin moved).
fn mise_stamp(root: &Path) -> (Option<std::time::SystemTime>, Option<std::time::SystemTime>) {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let global = std::env::home_dir().map(|h| h.join(".config/mise/config.toml"));
    (modified(root), global.as_deref().and_then(modified))
}

/// What the follow job has looked at.
#[derive(Debug, Default)]
pub struct Seen {
    stamp: Option<(Option<std::time::SystemTime>, Option<std::time::SystemTime>)>,
    /// The last binary tried, so one that cannot take over is not tried
    /// every minute.
    tried: Option<FileId>,
}
