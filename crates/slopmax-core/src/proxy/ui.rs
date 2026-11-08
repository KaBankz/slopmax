//! The web UI at `/slopmax/`: the React app from `web/apps/ui`, built into
//! the binary (see `build.rs`) and speaking the API under `/slopmax/api`.
//!
//! The page carries no data and needs no key to load: it reads the owner
//! key from its address (`#key=…`, which browsers never send) and keeps it
//! in the tab. Files are sent gzip-compressed, with an ETag so a reload
//! costs a 304; those whose names carry a content hash are cached for a
//! year, the rest checked on every load. A strict content security policy
//! lets the page run only its own files and talk only to its own origin.

use http::{HeaderMap, HeaderValue, StatusCode, header};

use crate::net::body;
use crate::net::server::Response;

pub(crate) struct Asset {
    /// Its name below `/slopmax/`.
    pub name: &'static str,
    /// Whether `body` is gzip-compressed.
    pub gzip: bool,
    pub etag: &'static str,
    pub body: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/ui.rs"));

const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; \
                   connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; \
                   base-uri 'none'; form-action 'none'";

/// What a slopmax built without the UI shows at `/slopmax/`.
const NOT_BUILT: &str = "<!doctype html><meta charset=utf-8><title>slopmax</title>\
    <p>This slopmax was built without its web UI. Build it with <code>mise run ui</code>, \
    then build slopmax again.</p>";

/// Whether `name` is one of the UI's files, so `/slopmax/<name>` is the
/// page's and not one of the `/slopmax/*` endpoints.
pub(super) fn serves(name: &str) -> bool {
    name.is_empty() || ASSETS.iter().any(|a| a.name == name)
}

/// Answers `GET /slopmax/<name>`: `""` is the page itself.
pub(super) fn answer(name: &str, headers: &HeaderMap) -> Response {
    let name = if name.is_empty() { "index.html" } else { name };
    let Some(asset) = ASSETS.iter().find(|a| a.name == name) else {
        return page(
            StatusCode::OK,
            "text/html; charset=utf-8",
            NOT_BUILT.as_bytes(),
            "no-cache",
        );
    };
    let cache = match hashed(name) {
        true => "public, max-age=31536000, immutable",
        false => "no-cache",
    };
    let matches = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|tags| {
            tags.split(',')
                .any(|t| matches!(t.trim(), "*") || t.trim().trim_start_matches("W/") == asset.etag)
        });
    let mut response = if matches {
        let mut response = Response::new(body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else if asset.gzip && !accepts_gzip(headers) {
        // Every browser takes gzip; a client that does not is told so.
        return page(
            StatusCode::NOT_ACCEPTABLE,
            "text/plain; charset=utf-8",
            b"this file is sent gzip-compressed\n",
            "no-cache",
        );
    } else {
        let mut response = page(StatusCode::OK, content_type(name), asset.body, cache);
        if asset.gzip {
            response
                .headers_mut()
                .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        }
        response
    };
    let out = response.headers_mut();
    out.insert(header::ETAG, HeaderValue::from_static(asset.etag));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    out.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    secure(out);
    response
}

/// `/slopmax` and the old `/slopmax/dashboard` send the browser to the page,
/// keeping the key in the address's fragment, which browsers carry across.
pub(super) fn to_page() -> Response {
    let mut response = Response::new(body::empty());
    *response.status_mut() = StatusCode::PERMANENT_REDIRECT;
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/slopmax/"));
    response
}

fn page(
    status: StatusCode,
    kind: &'static str,
    bytes: &'static [u8],
    cache: &'static str,
) -> Response {
    let mut response = Response::new(body::full(bytes));
    *response.status_mut() = status;
    let out = response.headers_mut();
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    secure(out);
    response
}

fn secure(headers: &mut HeaderMap) {
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|part| {
            let mut fields = part.split(';').map(str::trim);
            let name = fields.next().unwrap_or_default().to_ascii_lowercase();
            let refused = fields.any(|f| f.replace(' ', "") == "q=0");
            (name == "gzip" || name == "*") && !refused
        })
}

/// Whether the name carries a content hash (`index-46zt46c3.js`): eight or
/// more letters and digits, one at least a digit, after the last dash.
fn hashed(name: &str) -> bool {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.rsplit_once('-').is_some_and(|(_, hash)| {
        hash.len() >= 8
            && hash.bytes().all(|b| b.is_ascii_alphanumeric())
            && hash.bytes().any(|b| b.is_ascii_digit())
    })
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("json" | "map") => "application/json",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_names_are_cached_for_good() {
        assert!(hashed("index-46zt46c3.js"));
        assert!(hashed("logo-3z18dtz7.svg"));
        assert!(!hashed("index.html"));
        assert!(!hashed("font-semibold.css"));
    }

    #[test]
    fn gzip_is_taken_unless_refused() {
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static(value));
            accepts_gzip(&headers)
        };
        assert!(with("gzip, deflate, br"));
        assert!(with("br;q=1.0, gzip;q=0.8"));
        assert!(with("*"));
        assert!(!with("gzip;q=0"));
        assert!(!with("br"));
        assert!(!accepts_gzip(&HeaderMap::new()));
    }
}
