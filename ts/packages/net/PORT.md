# @slopmax/net: port notes

The TypeScript port of `crates/slopmax-net`: outbound HTTP, the inbound
server, WebSocket frames, and form encoding, on Bun's `fetch` and
`Bun.serve` with Effect 4.1. No dependencies beyond `effect` and
`@slopmax/common`.

## Files

| Rust            | TypeScript      | Notes                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib.rs`    | `src/index.ts`  | Modules as namespaces (`body`, `client`, `form`, `server`, `ws`); `Client`, `HttpError`, `Origins` at the top level. Each module is also a subpath export.                                                                                                                                                |
| `src/body.rs`   | `src/body.ts`   | A body is a `Stream<Uint8Array, E>`. `full`, `empty`, `read` (fails `LengthLimitError`, "length limit exceeded"), `readAll` (`TooLarge`, `body exceeds {limit} bytes`), `prefixed`, `idleTimeout` (`Stalled`, `no data for {duration:?}`, timed on the `Clock`). `boxed` is gone: streams need no boxing. |
| `src/client.rs` | `src/client.ts` | `Proxy`, `Bypass`, `Origins`, `Builder`, `Client`, `RequestBuilder`, `Response`, `HttpError`; plus `statusText` (http's `StatusCode` display) and `layerHttpClient` (an `effect/http` `HttpClient` over the same pool, proxy, and origins). A client's state and a request's parts are private.           |
| (hyper-util)    | `src/conn.ts`   | New: a pull-based byte stream over a `node:net`/`node:tls` socket (`Conn`: interrupt-safe reads, linear buffering), TCP and TLS dialing as effects (the connect timeout on the `Clock`), the CONNECT tunnel (hyper-util's `Tunnel`, same request and error texts), and the system's trusted roots.        |
| (hyper-util)    | `src/socks.ts`  | New: the SOCKS5 handshake (hyper-util's `SocksV5`, same error texts) as an effect, and a loopback HTTP proxy that dials out through it, since Bun's `fetch` takes HTTP proxies only.                                                                                                                      |
| (http)          | `src/uri.ts`    | New: the `http` crate's `Uri` checks (scheme, authority, path, query), so request URLs and proxy addresses pass and fail where Rust's did, with its texts (`invalid uri character`, `invalid authority`, …).                                                                                              |
| `src/form.rs`   | `src/form.ts`   | One to one.                                                                                                                                                                                                                                                                                               |
| `src/server.rs` | `src/server.ts` | `bind` + `serve(listener, app, shutdown)` keep the Rust's shape; `make`/`layer` give an `effect/http` `HttpServer` (so `HttpRouter` serves on it); `upgrade(headers)` and `ServerSocket` for WebSockets; `portHolder`.                                                                                    |
| `src/ws.rs`     | `src/ws.ts`     | `acceptKey`, `newKey`, `Message`, `Reader`, `Writer` one to one, over any `ByteSource`/`ByteSink`; `MessageReader`/`MessageWriter` are what both sides of a relay offer.                                                                                                                                  |

`@slopmax/common` gained `fmt.debugDuration` (Rust's `{:?}` of a `Duration`,
for `no data for 100ms`) and `text.debug` (Rust's `{:?}` of a `str`, for
`proxy "x" needs a scheme…`), each with a test there.

## Tests

|                                                         | Count    |
| ------------------------------------------------------- | -------- |
| Rust tests in `crates/slopmax-net`                      | 14       |
| Ported with the Rust name                               | 14       |
| Added for contract clauses and the new modules          | 48       |
| Passing (`bun test packages/net`, Bun 1.4.4 and canary) | 62 of 62 |

`test/NOT-PORTED.md` lists none left out, and what the WebSocket tests no
longer cover. The added tests run against local stand-ins (`test/support.ts`):
an upstream on `Bun.serve`, an HTTP proxy, and a SOCKS5 proxy with
user/password auth, all on loopback ports. The connect-timeout test dials
TEST-NET-1 (`192.0.2.1`), which is never routed.

## Contract items

| ID      | Where                                                                                                                                                               | Tests                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NET-001 | `Builder.build` (a `Bun.FetchSession`, keep-alive idle 60 s), `send` (`decompress: false`, `redirect: "manual"`, HTTP/1.1, the connect guard), `conn.openTcpWithin` | "compressed bodies pass through untouched", "connections are kept alive and reused", "redirects are answers, not followed", "the connect timeout bounds a connect that never completes, with or without an upgrade"                                                                                                  |
| NET-002 | `HttpError`, `statusText`, `conn.errorText`, `uri.parse`                                                                                                            | "errors say what failed and why", "statuses print as http prints them", "an invalid header or JSON value fails at send", "a SOCKS5 proxy that cannot reach the target fails the request with its reason"                                                                                                             |
| NET-003 | `Proxy.parse` (through `uri.parse`), `Proxy.toString`                                                                                                               | `parses_proxy_urls`, "proxy URLs: errors, default ports, case, …", "proxy URLs are checked as http's Uri checks them"                                                                                                                                                                                                |
| NET-004 | `Builder.build`, `Proxy.fromEnv` (through `Config`), `Proxy.setDefault`                                                                                             | "which proxy: HTTPS_PROXY, https_proxy, ALL_PROXY, all_proxy; HTTP_PROXY is not read"                                                                                                                                                                                                                                |
| NET-005 | `Bypass`                                                                                                                                                            | `loopback_and_listed_hosts_bypass_the_proxy`, "which proxy: …" (NO_PROXY, no_proxy, an empty NO_PROXY), "an HTTP proxy gets Basic credentials; loopback goes direct"                                                                                                                                                 |
| NET-006 | `Builder.build` (Basic token), `conn.tunnel`, `socks.dial`                                                                                                          | "an HTTP proxy gets Basic credentials…", "a SOCKS5 proxy, with user and password, …", "a 101 hands over its connection, directly or through either proxy", `socks.test.ts`                                                                                                                                           |
| NET-007 | `conn.systemRoots`, `Builder.build`, `send`                                                                                                                         | `plain_clients_refuse_https`                                                                                                                                                                                                                                                                                         |
| NET-008 | `Origins.apply`, `Client.request`                                                                                                                                   | `origins_rewrite_matching_prefixes`, "layerHttpClient sends effect/http requests through the client"                                                                                                                                                                                                                 |
| NET-009 | `RequestBuilder`                                                                                                                                                    | "headers: header replaces, headers keeps every value, …", "forms set their content type…", "an invalid header or JSON value fails at send"                                                                                                                                                                           |
| NET-010 | `send`, `Response.bytes`, `Response.intoBody`, `body.idleTimeout`                                                                                                   | "timeouts: the total covers headers and body, …", "bytes reads at most 64 MiB", `stalled_bodies_fail`                                                                                                                                                                                                                |
| NET-011 | `send` (a request with `upgrade` goes over its own connection), `Response.upgrade` (scoped)                                                                         | "a 101 hands over its connection, directly or through either proxy", "an interrupted read takes nothing"                                                                                                                                                                                                             |
| NET-012 | `body.ts`                                                                                                                                                           | `reads_within_the_limit`, `stalled_bodies_fail`, "read_all fails past its limit…", "a prefixed body yields its held chunks first"                                                                                                                                                                                    |
| NET-020 | `form.ts`                                                                                                                                                           | `encodes_like_the_whatwg_serializer`, `decodes_pairs_and_tolerates_malformed_escapes`, "percent_decode leaves + alone…"                                                                                                                                                                                              |
| NET-030 | `server.bind`, `serve`, `make`                                                                                                                                      | `serves_until_shutdown`, "shutdown stops accepting and lets in-flight requests finish", "shutdown does not wait for open WebSockets", "a client that stalls in its headers is cut off; …" (a kept-alive connection's next request too), "request heads up to hyper's limit and bodies of any size reach the handler" |
| NET-031 | `server.portHolder`                                                                                                                                                 | `names_the_program_holding_a_port`                                                                                                                                                                                                                                                                                   |
| NET-040 | `ws.acceptKey`, `ws.newKey`                                                                                                                                         | `accept_key_matches_the_rfc`                                                                                                                                                                                                                                                                                         |
| NET-041 | `ws.Reader` (outbound); Bun with `maxPayloadLength` 64 MiB (inbound)                                                                                                | `reads_the_rfcs_frames`, `rejects_broken_frames`, "every broken frame gets its own error", "an end of stream inside a frame's first two bytes …", "frames split anywhere read the same…", "fragments past 64 MiB…", "closes carry their code…", "messages that wait to be read keep their bytes"                     |
| NET-042 | `ws.Writer`, `ws.frame` (outbound); `ServerSocket.send` (inbound)                                                                                                   | `round_trips_every_size_masked_or_not`, "writes one final frame per message, …", "WebSocket upgrades send their own 101 headers…"                                                                                                                                                                                    |

## Deviations from the Rust, and why

- **Outbound HTTP is Bun's `fetch`**, one `Bun.FetchSession` per client (its
  own keep-alive pool, idle connections closed after 60 s; Bun's timer is
  coarse, so up to two steps later). Bun gives its sockets `TCP_NODELAY`
  and a 60 s TCP keepalive itself (checked with `strace`), as hyper's
  connector was set to.
- **The connect timeout on the fetch path is a guard.** Bun's fetch has no
  connect timeout. When fetch may have to connect (no answer from that
  host, or that HTTP proxy, within the pool's 60 s idle time), `send`
  resolves the name and opens a TCP connection of its own beside the
  fetch, timed on the `Clock`. If that connect outlasts the timeout (10 s
  unless set), the request fails `request failed: deadline has elapsed`, as
  hyper's connector did, and the fetch is aborted; a connect that succeeds
  is closed at once and the fetch goes on. Name resolution is not timed, as
  in Rust. It costs one extra TCP handshake per cold host (never for
  loopback, which cannot stall), and none while connections are pooled. A
  pooled connection the server dropped is re-dialed by Bun without the
  guard. Through SOCKS5, the bridge times its own dial to the proxy.
  `Client.fetch` (and `layerHttpClient`) has no guard. The upgrade path
  dials itself and times the connect directly.
- **On the wire, requests are Bun's.** Bun adds `Connection: keep-alive`,
  and `Accept: */*` and `User-Agent: Bun/<version>` when a request has none
  (hyper sent neither; slopmax's clients set their own user agent), and
  `Content-Length: 0` on an empty POST. Several values of one header go out
  as one line (`x-m: 1, 2`), which HTTP reads as the same; names are
  re-cased and reordered. `accept-encoding` is not added
  (`decompress: false`). The upgrade path writes its request as given.
- **Proxies.** Bun reads `http_proxy` and `NO_PROXY` itself; every request
  passes its own `proxy` (or `false`) so only slopmax's rules apply
  (`HTTP_PROXY` stays unread). For a plain-`http://` target through an HTTP
  proxy, Bun sends the request in absolute form to the proxy rather than
  opening a CONNECT tunnel as hyper-util does; HTTPS targets are tunnelled
  either way.
- **SOCKS5 goes through a loopback bridge** (`socks.bridge`), started on
  first use, shared by every client with the same proxy and connect
  timeout, and `unref`'d so it never keeps the process alive. It serves only
  requests carrying its random credentials (a 407 otherwise), so other
  local programs cannot relay through it. Each request names itself to the
  bridge; when the bridge cannot dial, the request fails with the SOCKS
  error (`request failed: SOCKS error: connection refused`), as in Rust,
  not with the bridge's 502.
- **Empty variables.** `std::env::var` reads an empty `NO_PROXY` as set (it
  then wins over `no_proxy`). Effect's environment provider treats an empty
  value as missing unless built with `preserveEmptyStrings: true`; the
  front ends should provide
  `ConfigProvider.fromEnv({ preserveEmptyStrings: true })` so every
  variable reads as in Rust. `HTTPS_PROXY`/`ALL_PROXY` skip blank values
  either way.
- **Upgrades.** `fetch` cannot hand over a connection, so a request carrying
  an `upgrade` header is sent over a connection of its own (`conn.ts`):
  direct, CONNECT, or SOCKS5, then TLS, then one HTTP/1.1 exchange, all as
  effects; interrupted or failed at any step, the connection is destroyed.
  A `101` hands the connection over: `Response.upgrade` needs a `Scope` and
  closes the connection when it ends, as Rust closed it on drop. Any other
  answer is read whole (content length, chunked, or to the end) and the
  connection closed. `Response.close` lets go of a response whose body
  will not be read. Through an HTTP proxy, a URL without a port is
  tunnelled to port 80 (443 for https); hyper-util's `Tunnel` asked for 443
  whatever the scheme.
- **TLS roots** are the system's (`tls.getCACertificates("system")`, loaded
  once), given to each session as its `ca`, so Bun's bundled roots are not
  used, as rustls used only the system's.
- **Error texts** keep slopmax's wording (`request failed: …`). OS errors
  read as std prints them (`Connection refused (os error 111)`, the number
  from the platform's errno table), name failures as getaddrinfo's text,
  URL errors as http's `Uri` (`uri.ts`), unsupported schemes as
  hyper-rustls's (`unsupported scheme ftp`), tunnel and SOCKS errors as
  hyper-util's. TLS failures are worded as Bun words them
  (`self signed certificate` where rustls said
  `invalid peer certificate: UnknownIssuer`), with Bun's `verbose: true`
  advice cut off.
- **`build()` is an `Effect`**, so `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`
  are read through `Config` and tests set them with a `ConfigProvider`.
  `Proxy.setDefault` stays a once-set module value, as Rust's `OnceLock`.
- **Server.** `bind` runs `Bun.serve` directly rather than through
  `@effect/platform-bun`'s `BunHttpServer`, whose WebSocket upgrade cannot
  set headers on the `101` (the relay copies `openai-model`,
  `x-reasoning-included`, `x-models-etag`, WS-010) and whose WebSocket
  defaults (16 MB messages, 120 s idle) differ from slopmax's. Requests and
  responses are still `effect/http`'s. Bun sets `TCP_NODELAY` on accepted
  connections and runs its own accept loop, so the Rust's "accepting a
  connection failed" warning and 100 ms back-off have no counterpart. Bun
  only upgrades to WebSocket.
  - The 30 s header timeout is Bun's idle timeout: turned off per request
    once its headers are in (`server.timeout(request, 0)`), and turned back
    on when the request's scope ends (its answer sent, a streamed one
    included), so every request on a kept-alive connection gets it, as with
    hyper. Bun's timer ticks coarsely, so a stalled client is cut off some
    seconds after 30 s.
  - Limits: no request body limit (Bun's 128 MiB default is lifted; the
    proxy's own 256 MiB limit and 413 apply, PRX-030). Request heads up to
    hyper's 417,792 bytes, where Bun's default is 16 KiB: `bind` raises
    Bun's process-wide `http.maxHeaderSize` to that, never lowers it. hyper
    also refused more than 100 header lines (431); Bun has no such cap, and
    it is not imposed.
  - Shutdown stops accepting, closes idle connections, waits up to 10 s for
    in-flight requests (`server.pendingRequests`, polled every 20 ms), then
    closes what is left. Upgraded WebSockets are not waited for: in Rust
    they had left hyper's connection tasks and ended with the process; here
    they are closed with the server (Bun sends a close frame).
- **Inbound WebSocket framing is Bun's.** `ServerSocket` offers the same
  `message`/`send` as `ws.Reader`/`ws.Writer`. Bun answers pings itself, so
  pings never reach `message` (the relay's own pong would be a second one);
  Bun answers a close with the same close at once; a close with code 1005
  reads as a bare close and 1006 as the end of the stream. Messages up to
  64 MiB, handed over without a copy; no extensions, no idle timeout; a
  send that Bun queues waits for the queue to drain, as Rust's writer
  flushed every frame.
- **`ws.Reader` parses synchronously.** Frames are parsed from the bytes
  already read, in a buffer that grows only to the frame being read, and
  the source is read only when a frame is incomplete: about 0.6 µs a frame
  for 52-byte frames on Bun 1.4.4 (it was 3 to 5 µs). An end of stream
  inside a 16- or 64-bit length fails `unexpected end of file` (tokio's
  `read_u16`/`read_u64`), inside a key or payload `early eof`
  (`read_exact`), as in Rust.
- **`portHolder`** returns an `Effect` (it reads `/proc` or runs `lsof`).
  It blocks while it does: it runs once, on the error path of a bind that
  failed, so it stays synchronous rather than asking for a `ChildProcess`
  service.

## Left for later

- A test of HTTPS through a CONNECT proxy end to end: it needs a TLS
  upstream whose CA the client trusts, and the client trusts only the
  system's roots. The tunnel itself is tested (the upgrade path through the
  HTTP proxy), and Bun's `fetch` CONNECT support was checked in
  `RUNTIME.md` (probe c).
- The core's WebSocket relay (WS-009..017) is the core's to build on
  `client` (upstream: `send` → `upgrade` → `ws.Reader`/`ws.Writer.client`)
  and `server.upgrade` (client side).
