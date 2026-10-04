//! Inbound HTTP/1.1 on hyper: an accept loop with keep-alive and graceful
//! shutdown. Routing is the handler's business.

use std::convert::Infallible;
use std::future::Future;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::body::Body;
use crate::log;

pub type Request = http::Request<Incoming>;
pub type Response = http::Response<Body>;

/// How long a client may take to send its request headers.
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// How long shutdown waits for in-flight requests (long streams included).
const DRAIN: Duration = Duration::from_secs(10);

/// Serves `handler` on `listener` until `shutdown` completes, then lets
/// in-flight requests finish for a moment.
pub async fn serve<H, F>(listener: TcpListener, handler: H, shutdown: impl Future<Output = ()>)
where
    H: Fn(Request) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response> + Send + 'static,
{
    // Each connection holds a receiver; the sender learns when all are gone.
    let (stop, stopping) = watch::channel(());
    tokio::pin!(shutdown);
    loop {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(e) => {
                    // Usually out of file descriptors: back off instead of spinning.
                    log::warn!("accepting a connection failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            () = &mut shutdown => break,
        };
        // Streamed answers are many small writes. Nagle's algorithm would
        // hold each until the client acknowledges the last, and clients
        // delay acknowledgments by up to 40 ms.
        let _ = stream.set_nodelay(true);
        let handler = handler.clone();
        let mut stopping = stopping.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let response = handler(request);
                async move { Ok::<_, Infallible>(response.await) }
            });
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            tokio::pin!(connection);
            tokio::select! {
                _ = connection.as_mut() => {}
                _ = stopping.changed() => {
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.await;
                }
            }
        });
    }
    drop(stopping);
    stop.send_replace(());
    let _ = tokio::time::timeout(DRAIN, stop.closed()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::body::full;
    use crate::net::client::Client;

    #[tokio::test]
    async fn serves_until_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hi", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(
            listener,
            |request: Request| async move {
                Response::new(full(format!(
                    "{} {}",
                    request.method(),
                    request.uri().path()
                )))
            },
            async {
                let _ = rx.await;
            },
        ));
        let client = Client::builder().build();
        let text = client.get(&url).send().await.unwrap().text().await.unwrap();
        assert_eq!(text, "GET /hi");
        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server stops")
            .unwrap();
    }
}

/// The program listening on TCP `port`, as `name (pid N)`, when the
/// system says. Used to explain a port that is already taken.
pub fn port_holder(port: u16) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        // Listening sockets of that port, by inode…
        let inodes: Vec<String> = ["/proc/net/tcp", "/proc/net/tcp6"]
            .iter()
            .filter_map(|table| std::fs::read_to_string(table).ok())
            .flat_map(|text| {
                text.lines()
                    .skip(1)
                    .filter_map(|line| {
                        let fields: Vec<&str> = line.split_whitespace().collect();
                        let local = u16::from_str_radix(fields.get(1)?.rsplit(':').next()?, 16);
                        let listening = *fields.get(3)? == "0A";
                        (local == Ok(port) && listening)
                            .then(|| fields.get(9).map(|i| i.to_string()))?
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        if inodes.is_empty() {
            return None;
        }
        // …and the process holding one of them.
        for entry in std::fs::read_dir("/proc").ok()?.flatten() {
            let pid = entry.file_name().to_string_lossy().into_owned();
            if !pid.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                let target = target.to_string_lossy();
                if inodes
                    .iter()
                    .any(|inode| target == format!("socket:[{inode}]").as_str())
                {
                    let name =
                        std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
                    return Some(format!("{} (pid {pid})", name.trim()));
                }
            }
        }
        // The socket belongs to a process this user cannot see.
        Some("another user's program".into())
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let pid = text.lines().find_map(|l| l.strip_prefix('p'))?;
        let name = text
            .lines()
            .find_map(|l| l.strip_prefix('c'))
            .unwrap_or("a program");
        Some(format!("{name} (pid {pid})"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = port;
        None
    }
}

#[cfg(test)]
mod port_tests {
    use super::*;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn names_the_program_holding_a_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let holder = port_holder(port).unwrap();
        assert!(
            holder.contains(&format!("pid {}", std::process::id())),
            "{holder}"
        );
        drop(listener);
        assert_eq!(port_holder(port), None);
    }
}
