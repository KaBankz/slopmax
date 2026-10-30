//! The browser half of an OAuth authorization-code flow.
//!
//! slopmax listens on the provider's registered loopback redirect and, at the
//! same time, accepts the final redirect address pasted into the CLI or app.
//! The paste path makes logins work on headless machines: authorize in any
//! browser, then copy the address bar of the (failed) localhost page back.

use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use http::{HeaderValue, StatusCode, header};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::{LoginEvent, Prompt};
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

/// Waits for the authorization code, from either the loopback redirect or an
/// address pasted into `prompt`, and checks the CSRF `state`.
pub async fn receive(
    port: u16,
    path: &'static str,
    expected_state: &str,
    prompt: &mut Prompt,
) -> Result<Callback> {
    let (tx, mut redirects) = mpsc::channel::<Result<Callback>>(4);
    let server = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
        Ok(listener) => Some(tokio::spawn(serve(listener, path, tx))),
        Err(e) => {
            // No redirect can arrive, so waiting ends once pastes do too.
            drop(tx);
            prompt.tell(LoginEvent::Notice(format!(
                "port {port} is busy ({e}); paste the redirect address instead"
            )));
            None
        }
    };

    let result = tokio::time::timeout(LOGIN_TIMEOUT, async {
        loop {
            let attempt = tokio::select! {
                Some(redirect) = redirects.recv() => redirect,
                Some(line) = prompt.pasted() => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    parse_pasted(&line)
                }
                else => bail!("port {port} is busy and no redirect address can be pasted"),
            };
            match attempt {
                Ok(callback) => return Ok(callback),
                Err(e) => prompt.tell(LoginEvent::Notice(format!("{e:#}; try again"))),
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

/// Whether this machine can show a browser (it has a desktop session).
pub fn has_browser() -> bool {
    cfg!(any(target_os = "macos", windows))
        || std::env::var_os("DISPLAY").is_some()
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Opens `url` in the default browser; returns false when none is available.
pub fn open_browser(url: &str) -> bool {
    if !has_browser() {
        return false;
    }
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
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
<h2>Account connected</h2><p>You can close this tab and return to slopmax.</p>";

const FAILURE_PAGE: &str = "<!doctype html><title>slopmax</title>\
<body style=\"font-family:system-ui;text-align:center;padding:4em\">\
<h2>Authorization failed</h2><p>slopmax shows what went wrong.</p>";

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

    #[test]
    fn empty_codes_and_fragments_are_handled() {
        let err = parse_pasted("http://x/cb?code=&state=s").unwrap_err();
        assert_eq!(err.to_string(), "no code");
        let cb = parse_pasted("http://x/cb?code=a&state=s#fragment").unwrap();
        assert_eq!((cb.code.as_str(), cb.state.as_deref()), ("a", Some("s")));
        // A `#` inside the code stays when the state comes separately.
        let cb = parse_pasted("code=a%23b&state=s&other=1").unwrap();
        assert_eq!((cb.code.as_str(), cb.state.as_deref()), ("a#b", Some("s")));
        let cb = parse_pasted("bare-code").unwrap();
        assert_eq!((cb.code.as_str(), cb.state), ("bare-code", None));
    }

    #[test]
    fn desktops_have_a_browser() {
        if cfg!(target_os = "macos") {
            assert!(has_browser());
        }
    }

    use std::sync::{Arc, Mutex};

    use crate::net::Client;

    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    type Events = Arc<Mutex<Vec<LoginEvent>>>;

    fn recording() -> (Prompt, Events) {
        let events: Events = Arc::default();
        let log = events.clone();
        (Prompt::new(move |e| log.lock().unwrap().push(e)), events)
    }

    fn notices(events: &Events) -> Vec<String> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                LoginEvent::Notice(text) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// GETs `url`, retrying while the callback server starts.
    async fn get(url: &str) -> (u16, String) {
        let http = Client::builder().plain_http().build();
        for _ in 0..100 {
            if let Ok(response) = http.get(url).send().await {
                let status = response.status().as_u16();
                return (status, response.text().await.unwrap());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{url} never answered");
    }

    #[tokio::test]
    async fn the_redirect_delivers_the_code_and_a_page() {
        let port = free_port();
        let (mut prompt, events) = recording();
        let waiting = tokio::spawn(async move { receive(port, "/cb", "st", &mut prompt).await });
        let base = format!("http://127.0.0.1:{port}");

        let (status, _) = get(&format!("{base}/elsewhere")).await;
        assert_eq!(status, 404);
        let (status, page) = get(&format!("{base}/cb?error=access_denied")).await;
        assert_eq!(status, 200);
        assert!(page.contains("Authorization failed"));
        let (_, page) = get(&format!("{base}/cb?code=abc&state=st")).await;
        assert!(page.contains("Account connected"));

        let callback = waiting.await.unwrap().unwrap();
        assert_eq!(callback.code, "abc");
        assert_eq!(callback.state.as_deref(), Some("st"));
        let notices = notices(&events);
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("access_denied"), "{notices:?}");
        assert!(notices[0].ends_with("; try again"));
    }

    #[tokio::test]
    async fn busy_ports_fall_back_to_pasted_addresses() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        let (tx, rx) = mpsc::unbounded_channel();
        let (prompt, events) = recording();
        let mut prompt = prompt.with_pasted(rx);
        for line in [
            "   ",
            "http://localhost/cb?state=st",
            "http://localhost/cb?code=pasted",
        ] {
            tx.send(line.to_owned()).unwrap();
        }
        let callback = receive(port, "/cb", "st", &mut prompt).await.unwrap();
        // No state came back with the paste, which is accepted.
        assert_eq!(callback.code, "pasted");
        assert_eq!(callback.state, None);
        let notices = notices(&events);
        assert!(notices[0].starts_with(&format!("port {port} is busy")));
        assert_eq!(notices[1], "no code; try again");
        assert_eq!(notices.len(), 2);
    }

    #[tokio::test]
    async fn a_foreign_state_is_refused() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        let (tx, rx) = mpsc::unbounded_channel();
        let mut prompt = Prompt::new(|_| {}).with_pasted(rx);
        tx.send("code=abc&state=evil".into()).unwrap();
        let err = receive(port, "/cb", "st", &mut prompt).await.unwrap_err();
        assert_eq!(err.to_string(), "OAuth state mismatch; start over");
    }

    #[tokio::test]
    async fn nothing_to_wait_for_is_an_error() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        let (mut prompt, _) = recording();
        let err = receive(port, "/cb", "st", &mut prompt).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("port {port} is busy and no redirect address can be pasted")
        );
    }
}
