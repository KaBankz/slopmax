//! Opening TCP connections.
//!
//! Windows does not give up on a local port nobody listens on when the port
//! refuses: it sends the SYN again twice and fails only after about two
//! seconds, where Linux and macOS fail at once. Asking whether the local proxy
//! runs then takes two seconds whenever it does not. So connections to this
//! machine turn those resends off (`SIO_TCP_INITIAL_RTO`), as curl and Chrome
//! do; connections elsewhere keep the system's behaviour.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tower_service::Service;

use crate::body::BoxError;

pub(crate) type Connecting =
    Pin<Box<dyn Future<Output = Result<TokioIo<TcpStream>, BoxError>> + Send>>;

/// How long a connection may sit idle before TCP checks the peer is there.
const KEEPALIVE: Duration = Duration::from_secs(60);

/// Opens TCP connections: hyper's connector, but connections to this machine
/// fail at once on Windows when nothing listens.
#[derive(Clone)]
pub(crate) struct Dial {
    http: HttpConnector,
    #[cfg_attr(not(windows), allow(dead_code))]
    timeout: Duration,
}

impl Dial {
    pub(crate) fn new(timeout: Duration) -> Self {
        let mut http = HttpConnector::new();
        http.enforce_http(false);
        http.set_nodelay(true);
        http.set_keepalive(Some(KEEPALIVE));
        http.set_connect_timeout(Some(timeout));
        Self { http, timeout }
    }
}

impl Service<Uri> for Dial {
    type Response = TokioIo<TcpStream>;
    type Error = BoxError;
    type Future = Connecting;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        self.http.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, dst: Uri) -> Connecting {
        #[cfg(windows)]
        if let Some(host) = dst
            .host()
            .map(|h| h.trim_start_matches('[').trim_end_matches(']'))
            && local(host)
        {
            let port = dst.port_u16().unwrap_or(match dst.scheme_str() {
                Some("https") => 443,
                _ => 80,
            });
            return Box::pin(windows::connect(host.to_owned(), port, self.timeout));
        }
        let connecting = self.http.call(dst);
        Box::pin(async move { connecting.await.map_err(Into::into) })
    }
}

/// Whether `host` (an IP without brackets, or a name) is this machine.
#[cfg_attr(not(windows), allow(dead_code))]
fn local(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Whether something accepts TCP connections at `addr` within `timeout`.
pub fn reachable(addr: SocketAddr, timeout: Duration) -> bool {
    #[cfg(windows)]
    {
        windows::reachable(addr, timeout)
    }
    #[cfg(not(windows))]
    {
        std::net::TcpStream::connect_timeout(&addr, timeout).is_ok()
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::net::SocketAddr;
    use std::os::windows::io::AsRawSocket;
    use std::time::Duration;

    use hyper_util::rt::TokioIo;
    use socket2::{Domain, Protocol, SockRef, Socket, TcpKeepalive, Type};
    use tokio::net::{TcpSocket, TcpStream};

    use super::KEEPALIVE;
    use crate::body::BoxError;

    /// Connects to `host` (this machine) the way hyper would: each of its
    /// addresses in turn, within `timeout` in all.
    pub(super) async fn connect(
        host: String,
        port: u16,
        timeout: Duration,
    ) -> Result<TokioIo<TcpStream>, BoxError> {
        let attempt = async {
            let mut last = None;
            for addr in tokio::net::lookup_host((host.as_str(), port)).await? {
                // A name that resolves elsewhere gets no special treatment.
                match open(addr, addr.ip().is_loopback()).await {
                    Ok(stream) => return Ok(stream),
                    Err(e) => last = Some(e),
                }
            }
            Err(last.unwrap_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, format!("{host} has no address"))
            }))
        };
        match tokio::time::timeout(timeout, attempt).await {
            Ok(Ok(stream)) => Ok(TokioIo::new(stream)),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "connect timed out").into()),
        }
    }

    async fn open(addr: SocketAddr, nearby: bool) -> io::Result<TcpStream> {
        let socket = if addr.is_ipv4() {
            TcpSocket::new_v4()?
        } else {
            TcpSocket::new_v6()?
        };
        if nearby {
            no_syn_resends(&socket);
        }
        socket.set_nodelay(true)?;
        SockRef::from(&socket).set_tcp_keepalive(&TcpKeepalive::new().with_time(KEEPALIVE))?;
        socket.connect(addr).await
    }

    pub(super) fn reachable(addr: SocketAddr, timeout: Duration) -> bool {
        let Ok(socket) = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))
        else {
            return false;
        };
        if addr.ip().is_loopback() {
            no_syn_resends(&socket);
        }
        socket.connect_timeout(&addr.into(), timeout).is_ok()
    }

    /// Makes a refused connect fail at once rather than after the resends.
    /// Windows 10 1709 and later; on older systems the call fails and the
    /// socket keeps the default.
    #[allow(unsafe_code)]
    fn no_syn_resends(socket: &impl AsRawSocket) {
        use windows_sys::Win32::Networking::WinSock::{
            SIO_TCP_INITIAL_RTO, SOCKET, TCP_INITIAL_RTO_DEFAULT_RTT,
            TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS, TCP_INITIAL_RTO_PARAMETERS, WSAIoctl,
        };
        let params = TCP_INITIAL_RTO_PARAMETERS {
            Rtt: TCP_INITIAL_RTO_DEFAULT_RTT as u16,
            // The constant is (USHORT)-2; the field is a UCHAR, so 0xFE.
            MaxSynRetransmissions: TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS as u8,
        };
        let mut returned = 0u32;
        // SAFETY: the socket is open for the duration of the call, the input
        // buffer is a live TCP_INITIAL_RTO_PARAMETERS of the size passed, there
        // is no output buffer, and the call is synchronous (no OVERLAPPED).
        unsafe {
            WSAIoctl(
                socket.as_raw_socket() as SOCKET,
                SIO_TCP_INITIAL_RTO,
                (&raw const params).cast(),
                size_of::<TCP_INITIAL_RTO_PARAMETERS>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
                None,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::time::Instant;

    use super::*;

    #[test]
    fn local_hosts() {
        for host in ["127.0.0.1", "127.8.0.1", "::1", "localhost", "LocalHost"] {
            assert!(local(host), "{host}");
        }
        for host in ["10.0.0.1", "example.com", "::2", "localhost.example.com"] {
            assert!(!local(host), "{host}");
        }
    }

    /// The port of a listener that has just closed, so nothing listens there.
    fn closed_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn a_closed_local_port_is_refused_at_once() {
        let addr = SocketAddr::from(([127, 0, 0, 1], closed_port()));
        let start = Instant::now();
        assert!(!reachable(addr, Duration::from_secs(5)));
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "{:?}",
            start.elapsed()
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(reachable(
            listener.local_addr().unwrap(),
            Duration::from_secs(5)
        ));
    }

    #[tokio::test]
    async fn the_client_is_refused_at_once() {
        let port = closed_port();
        for host in ["127.0.0.1", "localhost"] {
            let mut dial = Dial::new(Duration::from_secs(5));
            let start = Instant::now();
            let refused = dial
                .call(format!("http://{host}:{port}").parse().unwrap())
                .await;
            assert!(refused.is_err(), "{host}");
            assert!(
                start.elapsed() < Duration::from_millis(500),
                "{host}: {:?}",
                start.elapsed()
            );
        }
    }
}
