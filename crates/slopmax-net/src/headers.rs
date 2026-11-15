//! Which headers cross the proxy: what an agent sent that may go on to a
//! provider, and what a provider answered that may come back.

use http::HeaderMap;

/// Headers that belong to one connection, never forwarded.
pub const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Whether `name` (lowercase) is one a tailnet proxy sets: tailscaled's
/// `Tailscale-*` identity headers and the forwarding headers. They name the
/// user and the machine, so they never go upstream.
pub fn is_tailnet_header(name: &str) -> bool {
    name.starts_with("tailscale-") || name.starts_with("x-forwarded-") || name == "forwarded"
}

/// Removes every tailnet header ([`is_tailnet_header`]) in place.
pub fn strip_tailnet(headers: &mut HeaderMap) {
    let names: Vec<_> = headers
        .keys()
        .filter(|name| is_tailnet_header(name.as_str()))
        .cloned()
        .collect();
    for name in names {
        headers.remove(name);
    }
}

/// Client headers safe to forward upstream: everything but hop-by-hop
/// headers, tailnet headers, and the agent's local credentials and cookies.
pub fn forwardable(client: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(client.len());
    for (name, value) in client {
        let name_str = name.as_str();
        // slopmax's own headers are for slopmax alone.
        let skip = HOP_BY_HOP.contains(&name_str)
            || name_str.starts_with("x-slopmax-")
            || is_tailnet_header(name_str)
            || matches!(
                name_str,
                "host" | "content-length" | "authorization" | "x-api-key" | "cookie"
            );
        if !skip {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

/// Keeps the upstream response headers safe to return to the agent,
/// removing the rest in place.
pub fn keep_returnable(upstream: &mut HeaderMap) {
    for name in HOP_BY_HOP
        .into_iter()
        .chain(["content-length", "set-cookie"])
    {
        upstream.remove(name);
    }
}

#[cfg(test)]
mod tests {
    use http::HeaderValue;

    use super::*;

    #[test]
    fn forwardable_drops_only_credentials_and_hop_by_hop() {
        let mut client = HeaderMap::new();
        client.insert("authorization", HeaderValue::from_static("Bearer sm-key"));
        client.insert("connection", HeaderValue::from_static("keep-alive"));
        client.insert("accept-encoding", HeaderValue::from_static("gzip, br"));
        client.insert("x-app", HeaderValue::from_static("cli"));
        let out = forwardable(&client);
        assert!(!out.contains_key("authorization"));
        assert!(!out.contains_key("connection"));
        assert_eq!(out["accept-encoding"], "gzip, br");
        assert_eq!(out["x-app"], "cli");
    }

    /// What tailscaled serve adds to a request from the tailnet.
    const TAILNET: [&str; 9] = [
        "tailscale-user-login",
        "tailscale-user-name",
        "tailscale-user-profile-pic",
        "tailscale-headers-info",
        "tailscale-funnel-request",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
    ];

    /// A request as tailscaled serve passes it on, plus an agent's own
    /// headers.
    fn from_tailnet() -> HeaderMap {
        let mut client = HeaderMap::new();
        for name in TAILNET {
            client.append(name, HeaderValue::from_static("someone"));
        }
        client.append("x-forwarded-for", HeaderValue::from_static("100.64.0.9"));
        client.insert("x-app", HeaderValue::from_static("cli"));
        client.insert(
            "anthropic-beta",
            HeaderValue::from_static("oauth-2025-04-20"),
        );
        client
    }

    #[test]
    fn forwardable_drops_tailnet_headers() {
        let out = forwardable(&from_tailnet());
        for name in TAILNET {
            assert!(!out.contains_key(name), "{name} went upstream");
        }
        assert_eq!(out["x-app"], "cli");
        assert_eq!(out["anthropic-beta"], "oauth-2025-04-20");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn strip_tailnet_removes_every_tailnet_header() {
        let mut headers = from_tailnet();
        strip_tailnet(&mut headers);
        let mut names: Vec<&str> = headers.keys().map(|n| n.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["anthropic-beta", "x-app"]);
        assert!(!is_tailnet_header("x-forwarded"));
        assert!(!is_tailnet_header("tailscale"));
        assert!(is_tailnet_header("x-forwarded-port"));
    }

    #[test]
    fn returnable_drops_hop_by_hop_length_and_cookies() {
        let mut upstream = HeaderMap::new();
        upstream.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        upstream.insert("content-length", HeaderValue::from_static("12"));
        upstream.append("set-cookie", HeaderValue::from_static("a=1"));
        upstream.append("set-cookie", HeaderValue::from_static("b=2"));
        upstream.insert(
            "content-type",
            HeaderValue::from_static("text/event-stream"),
        );
        upstream.append("x-request", HeaderValue::from_static("1"));
        upstream.append("x-request", HeaderValue::from_static("2"));
        keep_returnable(&mut upstream);
        let mut names: Vec<&str> = upstream.keys().map(|n| n.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["content-type", "x-request"]);
        assert_eq!(upstream.get_all("x-request").iter().count(), 2);
    }
}
