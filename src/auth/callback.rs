//! The browser half of an OAuth authorization-code flow.
//!
//! slopmax listens on the provider's registered loopback redirect and, at the
//! same time, accepts the final redirect URL pasted into the terminal. The
//! paste path makes logins work on headless machines: authorize in any
//! browser, then copy the address bar of the (failed) localhost page back.

use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use http::{HeaderValue, StatusCode, header};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::net::server::{self, Request, Response};
use crate::net::{body, form};

/// How long to wait for the user to finish authorizing.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

/// Authorization code returned by the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callback {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Debug)]
struct Params {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

impl Params {
    fn into_callback(self) -> Result<Callback> {
        if let Some(error) = self.error {
            let detail = self.error_description.unwrap_or_default();
            bail!("authorization failed: {error} {detail}");
        }
        let code = self
            .code
            .filter(|c| !c.is_empty())
            .ok_or_else(|| anyhow!("no code"))?;
        // Anthropic's manual flow shows `code#state` as a single value.
        match (code.split_once('#'), self.state) {
            (Some((code, state)), None) => Ok(Callback {
                code: code.into(),
                state: Some(state.into()),
            }),
            (_, state) => Ok(Callback { code, state }),
        }
    }
}

/// Parses a pasted redirect URL, query string, or bare `code#state`.
pub fn parse_pasted(input: &str) -> Result<Callback> {
    let input = input.trim();
    let query = match input.split_once('?') {
        Some((_, query)) => query,
        None if input.contains('=') => input,
        None => {
            return Params {
                code: Some(input.into()),
                state: None,
                error: None,
                error_description: None,
            }
            .into_callback();
        }
    };
    let query = query.split('#').next().unwrap_or(query);
    parse_query(query).into_callback()
}

/// Decodes the OAuth parameters from a URL query string.
fn parse_query(query: &str) -> Params {
    let mut params = Params {
        code: None,
        state: None,
        error: None,
        error_description: None,
    };
    for (key, value) in form::decode(query) {
        let slot = match key.as_str() {
            "code" => &mut params.code,
            "state" => &mut params.state,
            "error" => &mut params.error,
            "error_description" => &mut params.error_description,
            _ => continue,
        };
        *slot = Some(value);
    }
    params
}

/// Waits for the authorization code, from either the loopback redirect or a
/// pasted URL, and checks the CSRF `state`.
pub async fn receive(port: u16, path: &'static str, expected_state: &str) -> Result<Callback> {
    let (tx, mut rx) = mpsc::channel::<Result<Callback>>(4);
    let server = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
        Ok(listener) => Some(tokio::spawn(serve(listener, path, tx.clone()))),
        Err(e) => {
            eprintln!("  (port {port} is busy: {e}; paste the redirect URL instead)");
            None
        }
    };
    tokio::spawn(read_pasted(tx));

    let result = tokio::time::timeout(LOGIN_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Some(Ok(callback)) => return Ok(callback),
                Some(Err(e)) => eprintln!("  {e:#}; try again"),
                None => bail!("login input closed"),
            }
        }
    })
    .await
    .map_err(|_| anyhow!("timed out waiting for authorization"))?;
    if let Some(server) = server {
        server.abort();
    }

    let callback = result?;
    match callback.state.as_deref() {
        Some(state) if state != expected_state => bail!("OAuth state mismatch; start over"),
        _ => Ok(callback),
    }
}

async fn serve(listener: TcpListener, path: &'static str, tx: mpsc::Sender<Result<Callback>>) {
    let handler = move |request: Request| {
        let tx = tx.clone();
        async move {
            if request.uri().path() != path {
                let mut response = Response::new(body::empty());
                *response.status_mut() = StatusCode::NOT_FOUND;
                return response;
            }
            let result = parse_query(request.uri().query().unwrap_or_default()).into_callback();
            let page = if result.is_ok() {
                SUCCESS_PAGE
            } else {
                FAILURE_PAGE
            };
            let _ = tx.send(result).await;
            let mut response = Response::new(body::full(page));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            response
        }
    };
    server::serve(listener, handler, std::future::pending()).await;
}

async fn read_pasted(tx: mpsc::Sender<Result<Callback>>) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if tx.send(parse_pasted(&line)).await.is_err() {
            return;
        }
    }
}

/// Opens `url` in the default browser; returns false when none is available.
pub fn open_browser(url: &str) -> bool {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    {
        "xdg-open"
    } else {
        return false;
    };
    Command::new(program)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

const SUCCESS_PAGE: &str = "<!doctype html><title>slopmax</title>\
<body style=\"font-family:system-ui;text-align:center;padding:4em\">\
<h2>Account connected</h2><p>You can close this tab and return to the terminal.</p>";

const FAILURE_PAGE: &str = "<!doctype html><title>slopmax</title>\
<body style=\"font-family:system-ui;text-align:center;padding:4em\">\
<h2>Authorization failed</h2><p>Check the terminal for details.</p>";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_redirect_url() {
        let cb = parse_pasted("http://localhost:1455/auth/callback?code=abc&state=xyz").unwrap();
        assert_eq!(cb.code, "abc");
        assert_eq!(cb.state.as_deref(), Some("xyz"));
    }

    #[test]
    fn parses_code_hash_state() {
        let cb = parse_pasted("  abc#xyz \n").unwrap();
        assert_eq!(cb.code, "abc");
        assert_eq!(cb.state.as_deref(), Some("xyz"));
    }

    #[test]
    fn parses_bare_query_and_decodes() {
        let cb = parse_pasted("code=a%2Bb&state=s").unwrap();
        assert_eq!(cb.code, "a+b");
    }

    #[test]
    fn surfaces_provider_errors() {
        let err =
            parse_pasted("http://x/cb?error=access_denied&error_description=nope").unwrap_err();
        assert!(err.to_string().contains("access_denied"));
    }
}
