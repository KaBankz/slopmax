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

/// Client headers safe to forward upstream: everything but hop-by-hop
/// headers and the agent's local credentials and cookies.
pub fn forwardable(client: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(client.len());
    for (name, value) in client {
        let name_str = name.as_str();
        // slopmax's own headers are for slopmax alone.
        let skip = HOP_BY_HOP.contains(&name_str)
            || name_str.starts_with("x-slopmax-")
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
