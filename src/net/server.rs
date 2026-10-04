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
