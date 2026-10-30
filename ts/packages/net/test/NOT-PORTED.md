# Rust tests not ported

None. All 14 tests under `crates/slopmax-net/` are ported with their Rust
names and pass:

| Rust file   | Tests                                                                                                                                | TypeScript            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `body.rs`   | `reads_within_the_limit`, `stalled_bodies_fail`                                                                                      | `test/body.test.ts`   |
| `client.rs` | `plain_clients_refuse_https`, `parses_proxy_urls`, `origins_rewrite_matching_prefixes`, `loopback_and_listed_hosts_bypass_the_proxy` | `test/client.test.ts` |
| `form.rs`   | `encodes_like_the_whatwg_serializer`, `decodes_pairs_and_tolerates_malformed_escapes`                                                | `test/form.test.ts`   |
| `server.rs` | `serves_until_shutdown`, `names_the_program_holding_a_port`                                                                          | `test/server.test.ts` |
| `ws.rs`     | `accept_key_matches_the_rfc`, `reads_the_rfcs_frames`, `round_trips_every_size_masked_or_not`, `rejects_broken_frames`               | `test/ws.test.ts`     |

## Tests that now cover less than in Rust

The four `ws.rs` tests exercise the ported RFC 6455 framing (`ws.Reader`,
`ws.Writer`), which frames slopmax's outbound socket (to ChatGPT). In Rust the
same code also framed the inbound socket (from Codex); in TypeScript that side
is Bun's server WebSocket, so these tests no longer cover it. What they
guarded there is covered by `server.test.ts` "WebSocket upgrades send their
own 101 headers and carry messages both ways": text and binary both ways, a
20 MB message (past Bun's 16 MB default, within the 64 MiB limit), ping
answered with a pong, close codes and reasons in both directions.

`stalled_bodies_fail` runs on the `TestClock` (no real time passes), as the
Rust ran on tokio's real timer.
