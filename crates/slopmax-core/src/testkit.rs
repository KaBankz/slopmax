//! Test helpers: throwaway directories and a local stand-in for a provider's
//! servers, reached through a [`Client`] whose origins point at it.

#![allow(dead_code)]

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::{HeaderMap, Method, StatusCode};
use serde_json::Value;
use tokio::net::TcpListener;

use crate::ids;
use crate::net::server::{self, Request, Response};
use crate::net::{Client, Origins, body};

/// A fresh, empty directory under the system's temp dir, deleted with all
/// it holds when the returned guard drops (a failing test's too: unwinding
/// drops it). Keep the guard as long as the directory is used.
pub fn temp_dir(name: &str) -> TempDir {
    let dir = std::env::temp_dir().join(format!("slopmax-{name}-{}", ids::token()));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// A directory from [`temp_dir`]; reads as its path.
#[derive(Debug)]
pub struct TempDir(PathBuf);

impl Deref for TempDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A value kept beside the temp directory it lives in, which goes when it
/// does; reads as the value.
#[derive(Debug)]
pub struct InTemp<T> {
    value: T,
    _dir: TempDir,
}

impl<T> Deref for InTemp<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.value
    }
}

/// An account store in a fresh temp directory.
pub fn store(name: &str) -> InTemp<crate::account::Store> {
    let dir = temp_dir(name);
    InTemp {
        value: crate::account::Store::at(dir.join("accounts")),
        _dir: dir,
    }
}

/// One request the mock received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: Method,
    /// Path and query.
    pub path: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Seen {
    pub fn text(&self) -> &str {
        std::str::from_utf8(&self.body).unwrap()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// The path without its query.
    pub fn route(&self) -> &str {
        self.path.split('?').next().unwrap_or_default()
    }
}

/// An answer with a status and a body.
pub fn reply(status: u16, body: impl Into<Bytes>) -> Response {
    let mut response = Response::new(body::full(body));
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
}

/// A JSON answer.
pub fn json(status: u16, value: Value) -> Response {
    let mut response = reply(status, value.to_string());
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

type Handler = dyn Fn(&Seen) -> Response + Send + Sync;

/// A local HTTP server that records each request and answers with
/// `handler`. Probes of `/` from other programs on the machine are answered
/// 404 and not recorded.
pub struct Mock {
    pub url: String,
    log: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    pub async fn start(handler: impl Fn(&Seen) -> Response + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let log: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let handler: Arc<Handler> = Arc::new(handler);
        let recorded = log.clone();
        let serve = move |request: Request| {
            let log = recorded.clone();
            let handler = handler.clone();
            async move {
                if request.uri().path() == "/" {
                    return reply(404, "");
                }
                let (parts, incoming) = request.into_parts();
                let body = body::read(incoming, usize::MAX).await.unwrap_or_default();
                let seen = Seen {
                    method: parts.method,
                    path: parts
                        .uri
                        .path_and_query()
                        .map(|p| p.to_string())
                        .unwrap_or_default(),
                    headers: parts.headers,
                    body,
                };
                let response = handler(&seen);
                log.lock().unwrap().push(seen);
                response
            }
        };
        tokio::spawn(server::serve(listener, serve, std::future::pending()));
        Self { url, log }
    }

    /// Every request so far, oldest first.
    pub fn seen(&self) -> Vec<Seen> {
        self.log.lock().unwrap().clone()
    }

    /// Requests to `route` (a path without query).
    pub fn seen_at(&self, route: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|s| s.route() == route)
            .collect()
    }

    /// A client that sends each of `prefixes` (such as
    /// `https://api.anthropic.com`) to this server instead.
    pub fn client(&self, prefixes: &[&str]) -> Client {
        let origins = Origins::new(prefixes.iter().map(|p| (*p, self.url.as_str())));
        Client::builder().plain_http().origins(origins).build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_mock_records_requests_sent_to_redirected_origins() {
        let mock = Mock::start(|seen| json(201, serde_json::json!({ "got": seen.text() }))).await;
        let http = mock.client(&["https://api.example.com"]);
        let response = http
            .post("https://api.example.com/v1/thing?x=1")
            .body("hello")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        let answer: Value = response.json().await.unwrap();
        assert_eq!(answer["got"], "hello");
        let seen = mock.seen_at("/v1/thing");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/v1/thing?x=1");
        assert_eq!(seen[0].method, Method::POST);
        let dir = temp_dir("kit");
        assert!(dir.is_dir());
        let path = dir.to_path_buf();
        drop(dir);
        assert!(!path.exists());
    }
}
