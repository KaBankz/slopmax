//! What the service manager does for the proxy beyond starting it: hearing
//! that it is ready, and keeping its listening socket, so that between one
//! process and the next (a crash, a restart, launchd starting the binary an
//! update installed) connections wait in the socket's queue instead of
//! being refused.
//!
//! systemd keeps the socket in the service's file-descriptor store: the
//! proxy puts it there once it listens (`FDSTORE=1`), and systemd passes it
//! to each process it starts after that (`LISTEN_FDS`), until the service
//! stops. launchd owns it outright: the agent's plist names it, launchd
//! binds it when the agent loads, and each process it starts takes it with
//! `launch_activate_socket`.

#[cfg(unix)]
use crate::log;

/// What the socket is called: its `FDNAME` in systemd's store.
#[cfg(target_os = "linux")]
const NAME: &str = "listener";

/// Which service manager kept the socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keeper {
    Systemd,
    Launchd,
}

/// The listening socket the service manager kept for this process.
pub struct Kept {
    pub listener: std::net::TcpListener,
    pub by: Keeper,
}

/// The socket the service manager kept for this process, if it keeps one.
pub fn take() -> Option<Kept> {
    #[cfg(target_os = "linux")]
    if let Some(listener) = from_systemd() {
        return Some(Kept {
            listener,
            by: Keeper::Systemd,
        });
    }
    #[cfg(target_os = "macos")]
    if let Some(listener) = from_launchd() {
        return Some(Kept {
            listener,
            by: Keeper::Launchd,
        });
    }
    None
}

/// The socket systemd passed this process from the service's store
/// (`LISTEN_FDS`, from fd 3 on, named in `LISTEN_FDNAMES`). The variables
/// name the process they are for, so one that only inherited them takes
/// nothing.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn from_systemd() -> Option<std::net::TcpListener> {
    use std::os::fd::FromRawFd;
    const FIRST: i32 = 3;
    let pid: u32 = std::env::var("LISTEN_PID").ok()?.parse().ok()?;
    if pid != std::process::id() {
        return None;
    }
    let count: i32 = std::env::var("LISTEN_FDS").ok()?.parse().ok()?;
    let names = std::env::var("LISTEN_FDNAMES").unwrap_or_default();
    let names: Vec<&str> = names.split(':').collect();
    let mut found = None;
    for index in 0..count {
        let fd = FIRST + index;
        // SAFETY: fcntl on any number is safe. systemd passes its fds
        // inheritable; they must not leak into what this process starts.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        if names.get(index as usize) == Some(&NAME) && found.is_none() {
            found = Some(fd);
        }
    }
    let fd = found?;
    // SAFETY: systemd passed `fd` to this process (`LISTEN_PID`) under the
    // name this proxy stored its listener with, and from here it is owned
    // by exactly one value.
    let listener = unsafe { std::net::TcpListener::from_raw_fd(fd) };
    match listener.local_addr() {
        Ok(_) => Some(listener),
        Err(e) => {
            log::warn!("the socket systemd kept is not a TCP listener ({e}); listening afresh");
            None
        }
    }
}

/// The socket launchd binds for the agent (its plist's `Listener`). Fails
/// in a process launchd did not start, or whose plist names no socket.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn from_launchd() -> Option<std::net::TcpListener> {
    use std::os::fd::FromRawFd;
    unsafe extern "C" {
        fn launch_activate_socket(
            name: *const libc::c_char,
            fds: *mut *mut libc::c_int,
            count: *mut libc::size_t,
        ) -> libc::c_int;
    }
    let mut fds: *mut libc::c_int = std::ptr::null_mut();
    let mut count: libc::size_t = 0;
    // SAFETY: the name is NUL-terminated, and launchd writes a malloc'd
    // array and its length into the two out-parameters.
    let error = unsafe { launch_activate_socket(c"Listener".as_ptr(), &mut fds, &mut count) };
    if error != 0 || fds.is_null() {
        return None;
    }
    // SAFETY: on success `fds` holds `count` descriptors, which this
    // process now owns; the array is freed once they are copied out.
    let owned: Vec<libc::c_int> = unsafe {
        let copied = std::slice::from_raw_parts(fds, count).to_vec();
        libc::free(fds.cast());
        copied
    };
    let mut listeners = owned.into_iter().map(|fd| {
        // SAFETY: fcntl on a descriptor this process owns; each is then
        // owned by exactly one value, and those not served are closed.
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            std::net::TcpListener::from_raw_fd(fd)
        }
    });
    listeners.next()
}

/// Tells systemd `state` (`READY=1`, `MAINPID=…`) when it supervises this
/// process with `Type=notify`. Whether it was told.
#[cfg(unix)]
pub fn notify(state: &str) -> bool {
    let Some(socket) = notify_socket() else {
        return false;
    };
    socket
        .send(state.as_bytes())
        .inspect_err(|e| log::warn!("telling systemd {state}: {e}"))
        .is_ok()
}

#[cfg(not(unix))]
pub fn notify(_state: &str) -> bool {
    false
}

/// A datagram socket connected to systemd's `NOTIFY_SOCKET`, a path or (on
/// Linux) an abstract name.
#[cfg(unix)]
fn notify_socket() -> Option<std::os::unix::net::UnixDatagram> {
    use std::os::unix::net::UnixDatagram;
    let path = std::env::var_os("NOTIFY_SOCKET")?;
    let socket = UnixDatagram::unbound().ok()?;
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
    let connected = match bytes.strip_prefix(b"@") {
        #[cfg(target_os = "linux")]
        Some(name) => {
            use std::os::linux::net::SocketAddrExt;
            std::os::unix::net::SocketAddr::from_abstract_name(name)
                .and_then(|addr| socket.connect_addr(&addr))
        }
        #[cfg(not(target_os = "linux"))]
        Some(_) => return None,
        None => socket.connect(&path),
    };
    connected
        .inspect_err(|e| log::warn!("reaching systemd at {}: {e}", path.display()))
        .ok()?;
    Some(socket)
}

/// Puts `listener` in the systemd service's file-descriptor store, which
/// passes it to the next process the service starts. A socket already
/// there is not stored twice. Whether systemd was told.
#[cfg(target_os = "linux")]
pub fn keep(listener: &std::net::TcpListener) -> bool {
    use std::os::fd::AsRawFd;
    let state = format!("FDSTORE=1\nFDNAME={NAME}");
    let Some(socket) = notify_socket() else {
        return false;
    };
    send_with_fd(&socket, &state, listener.as_raw_fd())
        .inspect_err(|e| log::warn!("giving systemd the listening socket to keep: {e}"))
        .is_ok()
}

#[cfg(not(target_os = "linux"))]
pub fn keep(_listener: &std::net::TcpListener) -> bool {
    false
}

/// Takes the listening socket out of systemd's store: the proxy listens
/// somewhere else now.
#[cfg(target_os = "linux")]
pub fn forget() -> bool {
    notify(&format!("FDSTOREREMOVE=1\nFDNAME={NAME}"))
}

#[cfg(not(target_os = "linux"))]
pub fn forget() -> bool {
    false
}

/// Sends `state` with `fd` attached (`SCM_RIGHTS`).
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn send_with_fd(
    socket: &std::os::unix::net::UnixDatagram,
    state: &str,
    fd: std::os::fd::RawFd,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let fd_size = std::mem::size_of::<libc::c_int>() as libc::c_uint;
    let mut iov = libc::iovec {
        iov_base: state.as_ptr().cast_mut().cast(),
        iov_len: state.len(),
    };
    // Room for one control message carrying one fd, aligned for its header.
    let mut control = [0u64; 4];
    // SAFETY: an all-zero msghdr is a valid empty one.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    // SAFETY: CMSG_SPACE only computes a size.
    message.msg_controllen = unsafe { libc::CMSG_SPACE(fd_size) } as _;
    // SAFETY: `control` is larger than CMSG_SPACE(one int) and aligned for
    // cmsghdr, so the first header and its data lie inside it; `iov`
    // points at `state`, which outlives the call.
    let sent = unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(fd_size) as _;
        std::ptr::write_unaligned(libc::CMSG_DATA(header).cast::<libc::c_int>(), fd);
        libc::sendmsg(socket.as_raw_fd(), &message, libc::MSG_NOSIGNAL)
    };
    if sent < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
