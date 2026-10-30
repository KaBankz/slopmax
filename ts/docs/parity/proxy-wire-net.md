# Parity: the proxy, the daemon, the ledger, notifications, wire, net, common

The contract the TypeScript port is checked against for this area. Every line
item has a stable ID, says what the Rust does precisely enough to check, and
points at the Rust source (`path:line`, relative to the repository root). IDs
never change meaning; new items get new numbers.

Scope: `crates/slopmax-core/src/proxy/` (`mod.rs`, `forward.rs`, `sse.rs`,
`start.rs`, `transcode.rs`, `socket.rs`, `models.rs`, `admin.rs`,
`dashboard.html`, `hub.rs`, `warm.rs`, `rawjson.rs`), `daemon.rs`, `ledger.rs`,
`summary.rs`, `history.rs`, `pricing.rs`, `notify.rs`, `waste.rs`,
`crates/slopmax-core/tests/proxy.rs` and `tests/failover.rs`, all of
`crates/slopmax-wire`, `crates/slopmax-net`, and `crates/slopmax-common`.

Prefixes: `PRX` proxy handler, routing, failover, streams, models, warmups,
rawjson · `WS` Codex WebSockets (relay; framing is under `NET`) · `ADM` the
`/slopmax/*` API and the dashboard page · `HUB` the CLIProxyAPI-compatible
management API · `DMN` the daemon and its background tasks · `LED` the
ledger, summaries, history, pricing, and quota left on the table · `NOTE`
notifications and nudges · `WIRE` formats and translation · `NET` HTTP client,
proxies, server, WebSocket frames, forms · `COM` time, ids, logging, human
formats · `HAR` the end-to-end test harness (`tests/proxy.rs`, `tests/failover.rs`;
added by the completeness pass).

Things other inventories own and this one only references: the pool and its
strategies (`pool.rs`), routing plans (`route.rs`), providers' `headers`,
`verdict`, `limits`, `show_pool`, `rebind`, `shape`, credits (`provider/`),
agents' detection and sessions (`agent/`), `report.rs`, `doctor.rs`,
`config.rs` (except the live-setting rules the admin API exposes), `auth/`.

"Message" below means the exact text, which tests and agents read; keep it
byte-for-byte. JSON key order is insertion order in the Rust (`serde_json`
with `preserve_order`, workspace `Cargo.toml:45`), so the order given for a
shape is the order to emit.

---

## 1. Entry point, authentication, and paths (`proxy/mod.rs`)

- [ ] **PRX-001** `GET /healthz` answers 200 `application/json` `{"status":"ok","service":"slopmax","version":"<package version>"}` with no key. — `crates/slopmax-core/src/proxy/mod.rs:263`
- [ ] **PRX-002** Any method on `/api/hello`, and `HEAD` on any path at all, answers 200 with an empty body and no key. This is checked before `/slopmax/*`, so `HEAD /slopmax/status` is also 200 empty (deliberate: Claude Code's connectivity probe and HEAD probes). — `crates/slopmax-core/src/proxy/mod.rs:268`
- [ ] **PRX-003** Dispatch order: `GET /healthz`, then `/api/hello`/`HEAD`, then paths starting `/slopmax/` (admin), then `/v0/management/` (hub), then `GET /v1/models` when it wants the OpenAI list, else the proxy. — `crates/slopmax-core/src/proxy/mod.rs:261-285`
- [ ] **PRX-004** `GET /v1/models` (exact path) is the OpenAI-style list when the user agent does not start `claude-cli/`, there is no `anthropic-version` header, and the query does not contain `client_version=`. The owner key gets the full list, a client key the list narrowed to its models, no or a wrong key gets 401 in Chat's error shape. Otherwise the request is proxied like any other. — `crates/slopmax-core/src/proxy/mod.rs:271-282`, `crates/slopmax-core/src/proxy/models.rs:29-35`
- [ ] **PRX-005** A path the router does not know gets 404 Messages-shaped `unknown path; slopmax serves /v1/*, /claude/*, and /codex/*`, before the key is checked. — `crates/slopmax-core/src/proxy/mod.rs:293-299`
- [ ] **PRX-006** The key is read from `authorization` with the prefix `Bearer ` or `bearer ` (only those two spellings), else from `x-api-key`; it is trimmed. When `authorization` has a bearer token, `x-api-key` is not consulted. It is compared in constant time with `api_key` (owner), then with each `[[keys]]` entry's `key` (client key). — `crates/slopmax-core/src/proxy/mod.rs:423-453`
- [ ] **PRX-007** A proxied request without a valid key gets 401 in the client's format (the route's dialect) with message ``missing or invalid slopmax key; see `slopmax env` ``; nothing reaches a provider. — `crates/slopmax-core/src/proxy/mod.rs:301-305`, `:455-461` (test `rejects_requests_without_the_slopmax_key`)
- [ ] **PRX-008** Every authenticated proxied request whose user agent is `codex…/X.Y.Z…` (product starting `codex`, version = leading digits and dots with exactly three parts) records X.Y.Z as the Codex version models are listed for (last seen wins). — `crates/slopmax-core/src/proxy/mod.rs:306-308`, `crates/slopmax-core/src/provider/codex/wire.rs:44-55`
- [ ] **PRX-009** Every authenticated proxied request whose user agent starts `claude-cli/` and is at most 200 bytes is remembered as Claude Code's user agent (`pool.saw_agent`), which Claude's limit-reset calls reuse. — `crates/slopmax-core/src/proxy/mod.rs:309-311`, `crates/slopmax-core/src/provider/claude/wire.rs:42-45`
- [ ] **PRX-010** A request with `upgrade: websocket` (case-insensitive value) goes to the WebSocket relay after authentication; everything else to the failover loop. — `crates/slopmax-core/src/proxy/mod.rs:314-317`, `:334-339`
- [ ] **PRX-011** Route `/claude` + (end, `/`, or `?`) → provider Claude, dialect Messages, forwarded path = the rest; routed by model only when the rest's path is `/v1/messages` or under it. — `crates/slopmax-core/src/proxy/mod.rs:373-387`
- [ ] **PRX-012** Route `/codex` + (end, `/`, `?`) → provider Codex, dialect Responses, path = the rest; by model only for `/responses` or under it. `/codexx/…` is unknown. — `crates/slopmax-core/src/proxy/mod.rs:379-390`
- [ ] **PRX-013** Unprefixed `/v1`: `/v1/chat/completions…` → no provider, dialect Chat, by model, path `/chat/completions…`; `/v1/responses…` → Codex with path `/responses…`; `/v1/models` whose rest contains `client_version=` and without `anthropic-version` → Codex `/models?…`; anything else → Claude with path `/v1…` (e.g. `/v1/models?limit=1000`, by model false; `/v1/messagesx` by model false). — `crates/slopmax-core/src/proxy/mod.rs:391-411` (test `routes_prefixed_and_v1_paths`)
- [ ] **PRX-014** Error replies: status → kind 401 `authentication_error`, 403 `permission_error`, 404 `not_found_error`, 413 `request_too_large`, 429 `rate_limit_error`, 529 `overloaded_error`, other ≥500 `api_error`, else `invalid_request_error`; body in the given dialect's error shape (Messages when none); `content-type: application/json`. — `crates/slopmax-core/src/proxy/mod.rs:464-477`, `:341-350`
- [ ] **PRX-015** Headers forwarded upstream: all client headers (repeated values kept) except hop-by-hop (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`), any `x-slopmax-*`, `host`, `content-length`, `authorization`, `x-api-key`, `cookie`. `accept-encoding` is kept. — `crates/slopmax-core/src/proxy/mod.rs:479-509` (test `forwardable_drops_only_credentials_and_hop_by_hop`)
- [ ] **PRX-016** Headers returned from upstream: all except hop-by-hop, `content-length`, `set-cookie`. — `crates/slopmax-core/src/proxy/mod.rs:524-533`
- [ ] **PRX-017** `x-slopmax-affinity`: trimmed, case-insensitive `on|true|1|yes` → keep the session's account even if the config turns affinity off; `off|false|0|no` → place by strategy alone; anything else → follow the config. — `crates/slopmax-core/src/proxy/mod.rs:514-521` (tests `affinity_can_be_turned_off_for_the_proxy_or_one_request`, `moving_without_affinity_still_drops_another_accounts_state`)
- [ ] **PRX-018** `reload_config`: reads `config.toml`; a missing file or text identical to the last read does nothing; a parse failure logs warn `config.toml is invalid, keeping the last good one: {e}` and remembers that text (no repeat until it changes); a good file keeps the bound `listen`, keeps the running `api_key` when the new one is empty, logs info `config.toml changed; applying it`, and swaps the config and the pool's routing at once. — `crates/slopmax-core/src/proxy/mod.rs:143-165` (test `a_changed_config_file_applies_without_a_restart`)
- [ ] **PRX-019** `sync` reloads the accounts directory and `pins.json` into the pool. — `crates/slopmax-core/src/proxy/mod.rs:169-174`
- [ ] **PRX-020** `ready(account)`: re-reads the account from disk (falls back to the pool's copy); an `auth_error` on it records that error and makes it unusable; with `refresh_tokens = false` an unlinked account is used as is; otherwise `ensure_fresh`; a transient refresh failure with an unexpired token warns `{id}: refresh failed, using current token: …` and uses it; any other failure warns, records the error, and makes it unusable. — `crates/slopmax-core/src/proxy/mod.rs:177-207`
- [ ] **PRX-021** For subscription providers, response headers carry the pool's windows instead of the serving account's (`Provider::show_pool`), when the pool has any. — `crates/slopmax-core/src/proxy/mod.rs:211-219` (test `agents_see_the_pool_not_the_serving_account`)
- [ ] **PRX-022** The model Codex used last starts as the newest Codex ledger entry with a model within the last 30 days, and is updated by every Codex entry recorded. — `crates/slopmax-core/src/proxy/mod.rs:85-91`, `:231-236`
- [ ] **PRX-023** Every recorded ledger entry is also published to the live feed as its ledger JSON, only when someone is subscribed; the feed buffers 256 entries per subscriber. — `crates/slopmax-core/src/proxy/mod.rs:237-241`, `:118`
- [ ] **PRX-024** The status report is built live (`live: true`), with the next placement per pool and the nudges. — `crates/slopmax-core/src/proxy/mod.rs:244-257`
- [ ] **PRX-025** Inference traffic uses a client with a 10 s connect timeout and a 600 s stall (read) timeout and no total timeout; OAuth/usage calls use the separate bounded `auth_http` client. — `crates/slopmax-core/src/proxy/mod.rs:94-98`, `:111`

- [ ] **PRX-102** The upstream `proxy` setting (and `HTTPS_PROXY`/`ALL_PROXY`) is installed process-wide once, by the CLI or the app before the server starts (`Config::apply`, CFG-027); `reload_config` (PRX-018) swaps the config but never re-applies it, so a changed `proxy` takes effect only after a restart. Together with the kept `listen` this is the README's "only `listen` and `proxy` need a restart". — `crates/slopmax/src/commands.rs:468`, `crates/slopmax-app/src/lib.rs:260`, `crates/slopmax-core/src/proxy/mod.rs:141-165`

## 2. The failover loop (`proxy/forward.rs`)

- [ ] **PRX-030** Request bodies are buffered up to 256 MiB; larger → 413 `request body is too large`; a read failure → 400 `could not read the request body: {e}`. — `crates/slopmax-core/src/proxy/forward.rs:47`, `:353-366`
- [ ] **PRX-031** A body is inspectable ("JSON") only when `content-encoding` is absent or `identity` and the bytes are valid JSON. Non-JSON bodies are forwarded untouched and yield no model or body-derived session. — `crates/slopmax-core/src/proxy/forward.rs:81-93`
- [ ] **PRX-032** Per request: the agent from headers, the session (agent's own; else `session-id`, `session_id`, `x-session-id` headers; else body `prompt_cache_key`), the affinity header, and the model = the first top-level `"model"` string. — `crates/slopmax-core/src/proxy/forward.rs:88-93`, `crates/slopmax-core/src/agent/mod.rs:50-59`
- [ ] **PRX-033** Housekeeping (affects placement) = method is not POST, or path contains `/count_tokens`. Listing models = GET and the path without query ends `/models`. — `crates/slopmax-core/src/proxy/forward.rs:116-125`
- [ ] **PRX-034** A client key with a model list: a model it does not allow → 403 `the key "{name}" may not use {model}`; a body naming `model` more than once at the top level → 403 `the key "{name}" may not send a request that names two models`; no readable model → allowed only when listing models, else 403 `the key "{name}" may use only some models, and this request names none slopmax can read`. (`{name}` is quoted, Rust `{:?}`.) — `crates/slopmax-core/src/proxy/forward.rs:368-393`, `:186-206` (test `client_keys_are_held_to_their_models`)
- [ ] **PRX-035** Planning: a model with a by-model path → `route::plan` (model, dialect, agent id, the path's provider as default); otherwise the path's provider as one step; no provider and no model → no route. — `crates/slopmax-core/src/proxy/forward.rs:157-182`
- [ ] **PRX-036** A path-routed step refuses a provider whose `agent_only` is not the detected agent, before any upstream call; the step holds every account of the provider and the body's model (or empty). — `crates/slopmax-core/src/proxy/forward.rs:209-232` (test `claude_paths_refuse_other_clients_before_routing`)
- [ ] **PRX-037** No-route replies: refused → 403 `slopmax serves {provider title} accounts to {agent title} only; this request came from {user-agent or "an unidentified client"}`; no model → 400 `the request names no model`; unserved → 404 `no connected account serves "{model}" in the {dialect} format (`slopmax status` lists accounts)`. — `crates/slopmax-core/src/proxy/forward.rs:235-261` (tests `claude_accounts_serve_claude_code_only`, `requests_without_a_model_are_turned_away`)
- [ ] **PRX-038** After planning, a client key with models drops steps whose (non-empty) model it does not allow; none left → 403 `the key "{name}" may not use the models this request is routed to` (aliases cannot route past a key). — `crates/slopmax-core/src/proxy/forward.rs:400-409`
- [ ] **PRX-039** `/v1/messages/count_tokens` whose first step has no account speaking Messages is answered locally: 200 `{"input_tokens": ceil(body bytes / 4)}`. — `crates/slopmax-core/src/proxy/forward.rs:411-415`, `:798-804` (test `translated_failures_reach_the_client_in_its_format`)
- [ ] **PRX-040** Steps are tried in order; within a step the pool picks (provider, session, affinity, housekeeping, the step's model when non-empty, the step's accounts, excluding every account already tried this request). Each account gets at most one attempt per request. — `crates/slopmax-core/src/proxy/forward.rs:416-467`
- [ ] **PRX-041** When a step's pick fails because accounts are spent (`until` known), `redeem_when_exhausted` is on, and this step has not rescued yet, a reset credit is redeemed (PRX-072); the freed account is removed from "tried" and picked again. — `crates/slopmax-core/src/proxy/forward.rs:433-444` (tests `spent_codex_pool_redeems_a_credit_when_allowed`, `spent_codex_pool_keeps_its_credits_by_default`)
- [ ] **PRX-042** Why steps could not serve combines as: earliest `until` wins, the first reason is kept. — `crates/slopmax-core/src/proxy/forward.rs:512-524` (test `the_earliest_return_wins_across_steps`)
- [ ] **PRX-043** A final response that is not 2xx is recorded in the ledger as a failure (status, account last tried, attempts = accounts tried). — `crates/slopmax-core/src/proxy/forward.rs:448-462`, `:483-509`
- [ ] **PRX-044** Giving up: last failure was exhaustion and an `until` is known → limit-reached reply; any other last failure → that failure passed back; no failure but `until` → limit-reached; neither → 503 with the pool's reason or `no account could take the request`. It is recorded as a failure with provider = last failure's or the first step's, account = last tried or `""`, attempts = tried count. — `crates/slopmax-core/src/proxy/forward.rs:468-478`, `:1032-1056` (test `every_account_spent_returns_the_agents_own_limit_error`)
- [ ] **PRX-045** Limit reached: 429, message `slopmax: every {provider title} account is rate limited; the next one frees up in {human duration} (`slopmax status` for details)`, body and extra headers from `Dialect::limit_reached`, `retry-after` = whole seconds until, at least 1. — `crates/slopmax-core/src/proxy/forward.rs:1058-1076` (tests `every_account_spent_returns_the_agents_own_limit_error`, `codex_exhaustion_uses_usage_limit_shape`)
- [ ] **PRX-046** A failure entry has zero tokens, no `first_byte_ms`, the agent and session of the request, `ms` since arrival. — `crates/slopmax-core/src/proxy/forward.rs:491-506`
- [ ] **PRX-047** An attempt on a session that moved logs info `{id}: takes over a session from {from}`; an account that is not ready (PRX-020) is skipped without a recorded failure. — `crates/slopmax-core/src/proxy/forward.rs:535-540`
- [ ] **PRX-048** Lane: the account's dialects contain the client's, or are empty → forward as is; else the first dialect the client's can be translated into (none → as is). — `crates/slopmax-core/src/proxy/forward.rs:700-708`
- [ ] **PRX-049** An account is refreshable when it has a refresh token or is linked; keys are not. — `crates/slopmax-core/src/proxy/forward.rs:547`
- [ ] **PRX-050** Native request: URL = `Provider::api(account)` without trailing `/` + the routed path with its query; headers = `Provider::headers(client headers, account, moved)`; body per PRX-051. — `crates/slopmax-core/src/proxy/forward.rs:729-736`
- [ ] **PRX-051** The native body is byte-for-byte the client's, except: when routing renamed the model, the model value is spliced in place (JSON-encoded string); when state must be stripped (session moved, or a stale-state retry), `Provider::rebind` edits it. — `crates/slopmax-core/src/proxy/forward.rs:136-154` (test `claude_fails_over_and_forwards_the_request_unchanged`)
- [ ] **PRX-052** Translated request: the request is decoded once (lazily) into the common form; model = the step's; `cache_key` = the session when the client gave none; for a Responses upstream not stripping state, reasoning state is restored (PRX-053); encoded, then `Provider::shape`; headers are only `content-type: application/json`, `accept: text/event-stream`, `user-agent: slopmax/<version>`, passed through `Provider::headers`; URL = base + `translate::path(upstream)`. A decode error → 400 with its message. — `crates/slopmax-core/src/proxy/forward.rs:737-762`, `:552-557` (test `chat_clients_reach_keys_and_endpoints_by_model`)
- [ ] **PRX-053** Restoring reasoning: in each message, before its first tool call, a reasoning part with empty text and the remembered opaque state is inserted when the replay store has state for that call id and this account. — `crates/slopmax-core/src/proxy/forward.rs:766-784` (test `claude_code_runs_gpt_models_on_chatgpt_accounts`)
- [ ] **PRX-054** A network error warns `{id}: upstream unreachable: {e}`, records `network error: {e}` on the account, and moves on (account not blocked). — `crates/slopmax-core/src/proxy/forward.rs:558-564` (test `an_unreachable_endpoint_fails_over_and_records_why`)
- [ ] **PRX-055** Every upstream response's rate-limit headers update the account's windows (`Provider::limits` → `pool.observe`), success or not. — `crates/slopmax-core/src/proxy/forward.rs:566-569`
- [ ] **PRX-056** A 2xx in a dialect that holds its start (Responses) is held (PRX-085): refused as exhausted → block 5 min (`DEFAULT_BLOCK`) with reason `usage limit reached`, log `{id}: limited inside the stream; switching accounts`; refused otherwise → throttle 30 s (`DEFAULT_THROTTLE`); either way the next account is tried and the held bytes become the failure. — `crates/slopmax-core/src/proxy/forward.rs:576-597`, `crates/slopmax-core/src/pool.rs:34-36` (tests `codex_streams_that_open_spent_move_to_the_next_account`, `codex_streams_that_open_overloaded_move_on_without_benching`)
- [ ] **PRX-057** A served 2xx records success on the account and logs info `{id} {METHOD} {path without query} {model or -} → {status}` plus ` (as {lane})` when translated. — `crates/slopmax-core/src/proxy/forward.rs:599-608`
- [ ] **PRX-058** A non-2xx is read whole, logged `{id}: upstream returned {status}`, and classified by `Provider::verdict(status, headers, body, model, now)`. — `crates/slopmax-core/src/proxy/forward.rs:628-631`
- [ ] **PRX-059** Unauthorized, first time, refreshable, `refresh_tokens` on → forced refresh and the same account retried; a refresh failure records its message on the account and moves on. — `crates/slopmax-core/src/proxy/forward.rs:633-645` (tests `a_rejected_token_is_refreshed_and_the_request_retried`, `a_refused_refresh_moves_on_to_the_next_account`)
- [ ] **PRX-060** StaleState, first time → retried on the same account with account-bound state stripped. — `crates/slopmax-core/src/proxy/forward.rs:646-649`
- [ ] **PRX-061** Unauthorized (otherwise) or Forbidden → account blocked 30 min with reason `unauthorized` / `forbidden`, next account. — `crates/slopmax-core/src/proxy/forward.rs:49`, `:650-658` (tests `revoked_tokens_move_to_the_next_account`, `without_refreshing_a_rejected_token_benches_the_account`)
- [ ] **PRX-062** Exhausted{until, model} → blocked until `until` (else now + 5 min), scoped to the model when given, reason `usage limit reached`, log `{id}: limited until {until}; switching accounts`, next account. — `crates/slopmax-core/src/proxy/forward.rs:659-666`
- [ ] **PRX-063** Throttled{until} → throttled until `until` (else now + 30 s), next account; not blocked. — `crates/slopmax-core/src/proxy/forward.rs:667-671` (tests `a_throttled_account_is_set_aside_briefly_not_blocked`, `only_throttled_accounts_pass_the_refusal_back`)
- [ ] **PRX-064** Final with status 500, 502, 503, 504, or 529: first time sleep 400 ms and retry the same account (log `{id}: retrying after a passing server error`); second time log `{id}: answered {status} twice; trying another account`, record `server error {status}`, next account; never blocked. — `crates/slopmax-core/src/proxy/forward.rs:52-59`, `:676-690` (test `passing_server_errors_are_retried_once_on_the_same_account`)
- [ ] **PRX-065** StaleState after stripping, or any other Final, is passed to the client as the answer. — `crates/slopmax-core/src/proxy/forward.rs:691-693` (test `fast_mode_refusals_reach_claude_code_without_benching_accounts`)
- [ ] **PRX-066** A failure passed back natively keeps the upstream status and body, returnable headers, pooled windows; a translated one is retold in the client's format (PRX-067). — `crates/slopmax-core/src/proxy/forward.rs:291-301`
- [ ] **PRX-067** Retelling: the message is the first string found at `/error/message`, `/response/error/message`, `/error`, `/detail`, `/message` in the body as JSON, or in any `data:` line of it; else the first 500 bytes as lossy UTF-8. A Messages client hears any 5xx as 529; others keep the status. — `crates/slopmax-core/src/proxy/forward.rs:307-334` (tests `upstream_errors_are_retold_with_their_message`, `a_failure_event_inside_a_stream_is_found`, `unreadable_errors_pass_their_first_500_bytes`, `claude_code_hears_server_errors_as_overloaded`)
- [ ] **PRX-068** A native success streams back with the upstream status, returnable headers plus pooled windows, the body tapped (PRX-071). — `crates/slopmax-core/src/proxy/forward.rs:891-905`
- [ ] **PRX-069** A translated success answers under the model name the client asked for; an upstream whose content type contains `json` is read as one document; `stream: true` → `content-type: text/event-stream`, `cache-control: no-cache`, re-encoded as it streams (upstream headers not returned); otherwise the body is read (≤256 MiB; failure → 502 `reading the upstream answer failed: {e}`) and answered as one 200 JSON reply, unless the answer is only an error, which becomes an error reply with its status (invalid → 502). — `crates/slopmax-core/src/proxy/forward.rs:909-965`
- [ ] **PRX-070** For a Responses upstream, a reasoning-state event followed by a tool call remembers that state for that call id and account. — `crates/slopmax-core/src/proxy/forward.rs:969-985`
- [ ] **PRX-071** When a served body ends (or the client drops it): usage added to the account; an in-stream exhaustion blocks it 5 min with reason `usage limit reached mid-stream`; a ledger entry is recorded with the step's model (else the request's), the upstream status, tokens, `ms` since arrival, `first_byte_ms` (first body chunk), attempts, agent, session. Translated answers are tapped in the upstream's format. — `crates/slopmax-core/src/proxy/forward.rs:989-1029`
- [ ] **PRX-072** Rescue: only for providers with credits; skipped when the provider needs Claude Code's user agent and none was seen; serialized by one lock; after taking it, any enabled signed-in unblocked account of the provider is returned at once (another request already redeemed); else spent accounts with credits left, the one blocked longest first, are made ready and redeemed with the soonest-expiring known credit (or none, letting the provider choose); `reset` records the reset and returns the account; other outcomes are logged and the next is tried. — `crates/slopmax-core/src/proxy/forward.rs:808-867` (test `spent_codex_pool_redeems_a_credit_when_allowed`)
- [ ] **PRX-073** Failover happens only before the first response byte reaches the client; once a stream is handed over, failures reach the client in the stream. — `crates/slopmax-core/src/proxy/forward.rs:1-8`, `:619-625`

## 3. Stream taps, held starts, transcoding (`sse.rs`, `start.rs`, `transcode.rs`)

- [ ] **PRX-080** The tap's shape from response headers: `content-encoding` present and not `identity` → opaque (nothing read; only the request counts); `content-type` containing `json` → one document, buffered up to 16 MiB and parsed at the end; else server-sent events. — `crates/slopmax-core/src/proxy/sse.rs:19`, `:55-68`
- [ ] **PRX-081** Event taps split on `\n` (lines may span chunks); a line longer than 16 MiB is skipped; only `data:` lines containing `usage`, `error`, or `failed` are parsed (trimmed JSON) and folded into the outcome by `Dialect::observe`. — `crates/slopmax-core/src/proxy/sse.rs:70-137` (tests `claude_usage_merges_start_and_delta`, `codex_usage_separates_cached_input`, `whole_json_responses_report_usage`, `codex_in_stream_usage_limit_is_exhaustion`)
- [ ] **PRX-082** At the end the last unterminated line is read too, and the outcome always counts one request. — `crates/slopmax-core/src/proxy/sse.rs:108-121`
- [ ] **PRX-083** A tapped body reports exactly once: at its end, on a body error, or when dropped early (client disconnect), with the instant its first data chunk passed. — `crates/slopmax-core/src/proxy/sse.rs:140-212` (test `tapped_stream_reports_once_even_when_dropped`)
- [ ] **PRX-085** Held start: chunks are held for at most 3 s total and 256 KiB; each complete `data:` line's JSON is judged by `Dialect::opening`: `Wait` keeps holding, `Content` streams (held chunks replayed first, then the rest), `Refused{exhausted}` returns the held bytes as the failure; time out, end, error, or the size limit stream what was held. — `crates/slopmax-core/src/proxy/start.rs:19-79` (tests `content_streams_with_the_held_start_replayed`, `a_spent_quota_is_caught_before_the_agent_sees_it`, `request_failures_go_to_the_agent`)
- [ ] **PRX-087** Transcoding stream: buffers at most 64 MiB (a chunk past that is dropped, and the end reports the cut); JSON mode collects the body and decodes it whole at the end; event mode splits on `\n`, strips one trailing `\r`, and hands each `data:` payload to the decoder; upstream end or error → the decoder's finish (a cut stream becomes an error in the client's format); every event is shown to the watcher before encoding; empty outputs emit nothing. — `crates/slopmax-core/src/proxy/transcode.rs:21-136` (test `chat_chunks_split_anywhere_become_messages_events`)
- [ ] **PRX-088** Whole-body decoding (non-streamed answers, warmups): same line rules, then finish; JSON mode decodes the document. — `crates/slopmax-core/src/proxy/transcode.rs:139-156`
- [ ] **PRX-089** Reasoning replay store: keyed by call id; at most 4096 entries, the oldest inserted evicted first (re-remembering a call keeps its place); entries live 2 h; recalled only for the account that issued them. — `crates/slopmax-core/src/proxy/transcode.rs:158-189` (test `replay_is_per_account_and_bounded`)

## 4. `/v1/models` for OpenAI-style clients (`models.rs`)

- [ ] **PRX-090** Lists models of every account that is enabled, signed in, and whose provider has no `agent_only` (Claude subscriptions never appear), read concurrently; ids are deduplicated and sorted; `owned_by` is the provider id of whichever listing finished first; each config alias is added with `owned_by: "slopmax"`; a client key keeps only models it allows. Shape `{"object":"list","data":[{"id","object":"model","created":0,"owned_by"}]}`. — `crates/slopmax-core/src/proxy/models.rs:38-74` (tests `claude_code_and_codex_keep_their_own_lists`, `openai_clients_list_every_model_they_can_use`)
- [ ] **PRX-091** Each account's list is cached 600 s; an account that is not ready lists nothing; a failed listing warns `{id}: listing its models: {e}` and is not cached. ChatGPT's catalog is asked for with the last Codex version seen, else `0.159.3`. — `crates/slopmax-core/src/proxy/models.rs:21-25`, `:77-101`

## 5. Window warmups (`warm.rs`)

- [ ] **PRX-095** Warm only when a last Codex model is known; candidates are Codex accounts that are enabled, signed in, not blocked, and have a shared `5h` window whose use now is exactly 0 (an account with no 5h reading is not warmed); each account at most once per 5 h (in memory; the mark is set before the attempt, so a failure also waits). Logs `{id}: started its 5-hour window early` / warn `{id}: warmup failed: {e}`. — `crates/slopmax-core/src/proxy/warm.rs:24-64` (test `idle_chatgpt_windows_are_warmed_once`)
- [ ] **PRX-096** The warmup request: `POST {api}/responses`, headers `content-type: application/json`, `accept: text/event-stream`, `user-agent: slopmax/<version>` through `Provider::headers` (not moved); body `{"model":<last Codex model>,"instructions":"Reply with OK.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"store":false,"stream":true}`; its rate-limit headers are observed; non-2xx → error `answered {status}`; not ready → error `its sign-in could not be refreshed`; usage added and a ledger entry recorded with agent `slopmax`, attempts 1, no session, no first byte. — `crates/slopmax-core/src/proxy/warm.rs:67-127`

## 6. In-place JSON (`rawjson.rs`)

- [ ] **PRX-098** `is_valid` validates the whole body as JSON. — `crates/slopmax-core/src/proxy/rawjson.rs:17-19`
- [ ] **PRX-099** `find(path)` returns the byte range of the value at a path of object keys and array indexes, scanning only what precedes it; the first member with the key wins; keys compare by raw bytes (an escaped key does not match); empty path = the whole value; anything malformed → none. — `crates/slopmax-core/src/proxy/rawjson.rs:21-112`, `:128-161` (test `finds_nested_values`)
- [ ] **PRX-100** Strings end only at an unescaped quote (a backslash skips the next byte). — `crates/slopmax-core/src/proxy/rawjson.rs:114-126` (test `strings_end_only_at_unescaped_quotes`)
- [ ] **PRX-101** `find_str` decodes the JSON string at the path; `splice` replaces a range, leaving every other byte as it was. — `crates/slopmax-core/src/proxy/rawjson.rs:38-50` (test `splice_replaces_in_place`)

## 7. Codex WebSockets (`proxy/socket.rs`)

- [ ] **WS-001** Every refusal answers 426 in Responses' error shape (`{"error":{"type":"invalid_request_error","message":"slopmax relays this over HTTP streaming"}}`) and logs info `websocket refused ({why}); Codex will stream over HTTP`, so Codex falls back to HTTP at once. — `crates/slopmax-core/src/proxy/socket.rs:55-58`, `:171-177`
- [ ] **WS-002** Refused when `websockets = false` in the config (read per handshake). — `crates/slopmax-core/src/proxy/socket.rs:59-61` (test `websockets_off_or_for_other_models_send_codex_to_http`)
- [ ] **WS-003** Refused unless the route is Codex and by model (`/codex/responses`, `/v1/responses`). — `crates/slopmax-core/src/proxy/socket.rs:62-64`
- [ ] **WS-004** Refused for a client key held to some models (each request is checked over HTTP instead). — `crates/slopmax-core/src/proxy/socket.rs:65-69` (test `client_keys_are_held_to_their_models`)
- [ ] **WS-005** No `sec-websocket-key` → 400 Messages-shaped `missing Sec-WebSocket-Key`; `sec-websocket-version` other than `13` (trimmed) → 426 refusal plus header `sec-websocket-version: 13`. — `crates/slopmax-core/src/proxy/socket.rs:70-79`
- [ ] **WS-006** The model is read from `x-codex-routing-hint: model=<m>;…` (parts split on `;`, trimmed; empty → none). — `crates/slopmax-core/src/proxy/socket.rs:183-190` (test `the_routing_hint_names_the_model`)
- [ ] **WS-007** With a model, the plan's first step must be Codex with exactly that model name (no alias, no translation), else refused `the model is not served by a ChatGPT account`; its accounts are the candidates. Without a model, all Codex accounts are. — `crates/slopmax-core/src/proxy/socket.rs:81-116`
- [ ] **WS-008** Placement: session from the agent's headers (no body), the affinity header, not housekeeping, no exclusions; no account → refused `no ChatGPT account can serve now`; not ready → refused `the account's sign-in could not be refreshed`. — `crates/slopmax-core/src/proxy/socket.rs:117-132`
- [ ] **WS-009** Upstream handshake: `GET {api}/responses`; client headers minus `sec-websocket-key`, `-version`, `-extensions`, `-protocol`, through `Provider::headers(moved)`; then `upgrade: websocket`, `connection: Upgrade`, `sec-websocket-version: 13`, a fresh `sec-websocket-key`; `accept-encoding` removed; `openai-beta: responses_websockets=2026-02-06` added unless the client sent one; 15 s timeout; must answer 101 with the right `sec-websocket-accept`. Failure warns `{id}: websocket handshake failed: {why}` and refuses `the upstream handshake failed`. — `crates/slopmax-core/src/proxy/socket.rs:39-42`, `:194-248` (test `codex_websockets_are_relayed_to_chatgpt`)
- [ ] **WS-010** The client gets 101 with `upgrade: websocket`, `connection: Upgrade`, `sec-websocket-accept` for its key, and `openai-model`, `x-reasoning-included`, `x-models-etag` copied from upstream's 101; logs `websocket opened on {id}`. — `crates/slopmax-core/src/proxy/socket.rs:141-168`
- [ ] **WS-011** The relay runs one writer per side behind 64-message queues (client side unmasked, upstream side masked); either reader ending stops the other; writers get up to 5 s to flush what is queued, closes included. — `crates/slopmax-core/src/proxy/socket.rs:264-323`
- [ ] **WS-012** Client → upstream: text passes through WS-013; a ping is answered with a pong to the client (not forwarded); pongs are dropped; a close is forwarded and ends the relay; binary is forwarded; the client's socket ending or failing sends a bare close upstream. — `crates/slopmax-core/src/proxy/socket.rs:325-357`
- [ ] **WS-013** A client text that is JSON `{"type":"response.create",…}` starts a turn (clock, its `model`, first byte cleared). On a socket whose session moved accounts, it also drops `client_metadata["x-codex-turn-state"]`, top-level `previous_response_id`, and `encrypted_content` of `reasoning` input items; the text is re-serialized only when something was dropped. — `crates/slopmax-core/src/proxy/socket.rs:359-393`, `crates/slopmax-core/src/provider/codex/wire.rs:66-81` (test `moved_sockets_drop_old_account_state`)
- [ ] **WS-014** Upstream → client: ping → pong upstream; pongs dropped; close forwarded and ends; binary forwarded; the upstream ending or failing sends the client close 1011 `upstream closed`. — `crates/slopmax-core/src/proxy/socket.rs:405-430`
- [ ] **WS-015** The first JSON text of a turn marks its first byte. `codex.rate_limits` events update the account's windows; when the pool has windows the client gets the event rewritten with the pooled windows instead. — `crates/slopmax-core/src/proxy/socket.rs:431-460` (test `codex_sockets_report_the_pool_too`)
- [ ] **WS-016** `response.completed`, `response.incomplete`, `response.done` record success and one ledger entry: Codex, the turn's model, status 200, usage from `/response/usage` (else one request, no tokens), attempts 1, `ms` and `first_byte_ms` from the turn's start, the handshake's agent and session. — `crates/slopmax-core/src/proxy/socket.rs:461-464`, `:521-552`
- [ ] **WS-017** `response.failed` / `error` whose code (or type) is `usage_limit_reached`, `usage_limit_exceeded`, `usage_not_included`, `insufficient_quota` → blocked as a 429 refusal (until or 5 min, per model), log `{id}: limited inside a websocket; closing it`; `server_is_overloaded`, `slow_down`, `rate_limit_exceeded` → throttled 30 s. Then a bare close upstream and close 1012 `the account is limited; reconnect` to the client, without forwarding the event. Other failures pass through. — `crates/slopmax-core/src/proxy/socket.rs:465-519` (tests `spent_accounts_close_the_socket_and_request_errors_pass`, `spent_accounts_close_the_socket_so_codex_reconnects_elsewhere`)

## 8. slopmax's own API (`proxy/admin.rs`)

Every error here is Messages-shaped: `{"type":"error","error":{"type":<kind>,"message":<text>}}` (PRX-014); the dashboard reads `error.message`.

- [ ] **ADM-001** `GET /slopmax/dashboard` (GET only) needs no key and serves the embedded page with `content-type: text/html; charset=utf-8`, `content-security-policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'`, `referrer-policy: no-referrer`. — `crates/slopmax-core/src/proxy/admin.rs:33`, `:42-44`, `:114-134` (test `the_dashboard_api_reports_acts_and_streams`)
- [ ] **ADM-002** Everything else under `/slopmax/` needs the owner key (client keys get 401) → 401 ``missing or invalid slopmax key; see `slopmax env` ``. — `crates/slopmax-core/src/proxy/admin.rs:45-51`
- [ ] **ADM-003** The path after `/slopmax/` is split on `/`; an unmatched method/path → 404 `no such slopmax endpoint`. — `crates/slopmax-core/src/proxy/admin.rs:52-53`, `:110`
- [ ] **ADM-004** `GET status` → the live report JSON (`version`, `strategy`, `live`, `generated_at`, `accounts`, `pools`, `nudges`; shapes in the report inventory). — `crates/slopmax-core/src/proxy/admin.rs:54`, `crates/slopmax-core/src/report.rs:20-47`
- [ ] **ADM-005** `POST refresh` polls every eligible account's usage now and lists every eligible account's limit resets now, then answers the report. — `crates/slopmax-core/src/proxy/admin.rs:55-61`
- [ ] **ADM-006** `POST sync` re-reads config.toml (PRX-018), accounts, and pins, then answers the report; a failure → 500 with the error chain. — `crates/slopmax-core/src/proxy/admin.rs:62-66`, `:482-487`
- [ ] **ADM-007** `POST shutdown` signals the daemon to stop and answers `{"status":"stopping"}`. — `crates/slopmax-core/src/proxy/admin.rs:67-70`
- [ ] **ADM-008** `GET usage?range=&by=`: range `today|7d|30d|all` (default `7d`), by `day|model|account` (default `day`); bad range → 400 `range is today, 7d, 30d, or all`; bad by → 400 `by is day, model, or account`; answers the summary JSON (LED-013) with account display names and the config's `[prices]`. — `crates/slopmax-core/src/proxy/admin.rs:136-168`
- [ ] **ADM-009** `GET history?range=`: `today|7d|30d` (default `7d`); bad → 400 `range is today, 7d, or 30d`; answers the history JSON (LED-021), computed off the request path; a failed computation → 500. — `crates/slopmax-core/src/proxy/admin.rs:170-198` (tests `the_history_api_charts_what_went_through`, `history_says_what_resets_left_on_the_table`)
- [ ] **ADM-010** `GET settings` → `{"strategy","strategies":[{"id","summary"}…],"session_affinity","session_ttl_mins","redeem_expiring_credits","redeem_when_exhausted","warm_windows","paid_overflow","poll_mins"}`, strategies in the order `reset-first` (`Spend the quota that resets soonest, so none is lost`), `fill-first` (`Use accounts in priority order; fail over when one is limited`), `least-used` (`Balance load toward the least used account`), `round-robin` (`Take turns across accounts`). — `crates/slopmax-core/src/proxy/admin.rs:338-355`, `crates/slopmax-core/src/config.rs:160-167`
- [ ] **ADM-011** `POST settings`: fields from the query and the form body (body ≤64 KiB; a read failure → 400), empty keys skipped; each is validated before anything is written: unknown → 400 `{name} is not a setting slopmax changes while it runs; those are strategy, session_affinity, session_ttl_mins, redeem_expiring_credits, redeem_when_exhausted, warm_windows, paid_overflow, poll_mins`; bad strategy → `strategy is one of reset-first, fill-first, least-used, round-robin`; `session_ttl_mins` > 0 and `poll_mins` ≥ 0 integers, else `{name} is a number of minutes`; booleans `true|on|1|yes` / `false|off|0|no`, else `{name} is on or off`; none given → 400 `no settings to change`. Values are written into config.toml keeping its comments (including inline ones), applied at once with the running `listen` and `api_key` kept, logged `settings changed from the API`, and answered with the new settings. — `crates/slopmax-core/src/proxy/admin.rs:74-82`, `:357-387`, `crates/slopmax-core/src/config.rs:183-247` (test `settings_change_through_the_api_and_apply_at_once`)
- [ ] **ADM-012** `GET events` → `text/event-stream`, `cache-control: no-cache`: first `: connected\n\n`, then `data: <ledger entry JSON>\n\n` per recorded request, `: keepalive\n\n` after 15 s without one; a lagging subscriber skips what it missed; ends when the client goes. — `crates/slopmax-core/src/proxy/admin.rs:34-35`, `:389-435`
- [ ] **ADM-013** `POST use/auto` clears every pin, syncs, answers the report. — `crates/slopmax-core/src/proxy/admin.rs:84`, `:437-439`
- [ ] **ADM-014** `POST accounts/{id}/{action}`: an id not in the pool → 404 `no such account`; actions `enable`, `disable`; `priority` with `?value=<i32>` (else 400 `priority needs ?value=<number>`); `label` with `?value=` (empty or blank clears it, showing the email again); `use` (pin, as `slopmax use`); `own` (drop the import link so slopmax refreshes the tokens itself); `remove` (forget the account and its pin, as `slopmax remove`); `redeem` (ADM-015); other → 404 `no such account action`. Success syncs and answers the report; a store error → 500. — `crates/slopmax-core/src/proxy/admin.rs:441-479` (test `the_dashboard_api_reports_acts_and_streams`)
- [ ] **ADM-015** Redeem: a provider without limit resets → 400 `this account has no limit resets`; holds the redeem lock; not ready → 409 `the account needs signing in again`; the credit is `?value=` or the soonest of a fresh listing (which is recorded); an empty listing → 200 `{"outcome":"no_credit","report":…}`; a listing failure → 502; a redemption answers 200 `{"outcome": reset|nothing_to_reset|no_credit|already_redeemed|declined, "report": …}`, `reset` records the reset and logs `{id}: redeemed a limit reset on request`; a redemption failure → 502. — `crates/slopmax-core/src/proxy/admin.rs:489-548`, `crates/slopmax-core/src/provider/credits.rs:30-43` (tests `claude_limit_resets_are_listed_and_spent_as_claude_code`, `credits_are_listed_kept_and_redeemed_soonest_first`)
- [ ] **ADM-016** `POST accounts` (form from query and body, ≤64 KiB): `provider` must be a provider id (`claude`, `codex`, `anthropic`, `openai`, `xai`, `compat`) else 400 `provider is anthropic, openai, xai, or compat`; a subscription → 400 ``{title} accounts sign in with a browser: `slopmax login {provider}`, or the app``; `compat` needs `url` (400 `a compatible endpoint needs its url`) starting `http://` or `https://` (400 `url is an http:// or https:// base URL`), trailing `/` trimmed; `dialect` `chat` (default), `responses`, `messages` (else 400 `dialect is chat, responses, or messages`); `models` comma-separated, trimmed, empties dropped; `key` (may be empty) and `label`. The key is checked with the provider before saving; any error → 400 with its chain; success syncs and answers the report. — `crates/slopmax-core/src/proxy/admin.rs:86-94`, `:200-289` (test `the_api_does_what_the_cli_does_for_keys_endpoints_and_the_doctor`)
- [ ] **ADM-017** `GET keys` → `{"keys":[{"name","models"}]}`; the keys themselves are never listed. — `crates/slopmax-core/src/proxy/admin.rs:95`, `:291-300`
- [ ] **ADM-018** `POST keys` with `name` (required: 400 `a key needs a name`) and optional `models` (comma list) makes a key in config.toml, reloads, and answers `{"name","key","models"}` once (key starts `sm-`); a duplicate name or write error → 400. — `crates/slopmax-core/src/proxy/admin.rs:96-102`, `:302-325`
- [ ] **ADM-019** `POST keys/{name}/remove` (name percent-decoded): removed → reload, answer the key list; absent → 404 `no such key`; error → 500. — `crates/slopmax-core/src/proxy/admin.rs:103-105`, `:327-336`
- [ ] **ADM-020** `GET doctor` → the doctor's sections `[{"title","findings":[{"level","text","fix"?}]}]`; an error → 500. — `crates/slopmax-core/src/proxy/admin.rs:106-109`
- [ ] **ADM-021** Form fields: decoded with `net::form::decode` from `"{query}&{body}"`; the first occurrence of a name wins; values are trimmed and empty means absent. — `crates/slopmax-core/src/proxy/admin.rs:200-214`

### The dashboard page (`proxy/dashboard.html`)

The page is a static, self-contained asset (inline CSS and JS, no external
loads). The port should serve the same file byte-for-byte; these items are
what a reviewer checks if it is rebuilt.

- [ ] **ADM-030** The key arrives as `#key=…` in the URL fragment, is kept in `sessionStorage["slopmax-key"]`, and the fragment is removed with `history.replaceState`; without a key a gate asks for it; any 401 clears the key and shows the gate. — `crates/slopmax-core/src/proxy/dashboard.html:399-405`, `:475-497`, `:1350-1353`
- [ ] **ADM-031** Calls send `authorization: Bearer <key>`, form bodies as `application/x-www-form-urlencoded`; errors show `error.message`. — `crates/slopmax-core/src/proxy/dashboard.html:489-497`
- [ ] **ADM-032** Header: version, section links (Accounts, Usage, Routing, Access, Requests), a live indicator (Connecting / Running / Reconnecting), "Endpoint" copies `location.origin`, Refresh → `POST refresh` with toast `Usage and limit resets read again.` — `crates/slopmax-core/src/proxy/dashboard.html:406-421`, `:1429-1440`
- [ ] **ADM-033** Accounts summary: `N of M accounts ready` plus limited / throttled / disabled / signed out / `limit resets banked` counts; "Clear pin" shown when any account is pinned (→ `POST use/auto`). — `crates/slopmax-core/src/proxy/dashboard.html:697-723`, `:1441`
- [ ] **ADM-034** "Needs attention", the same list as the desktop app's: signed-out accounts first, limited accounts that hold resets, windows on pace to run out, resets expiring within 72 h (noting when auto-redeem is off), then nudges not already covered; each with Redeem…, Show, or a copyable `slopmax login <provider>`. — `crates/slopmax-core/src/proxy/dashboard.html:598-680`
- [ ] **ADM-035** Browser notifications: a "Notify me" button when nudges exist and permission is undecided; each nudge notified once per browser (`localStorage["slopmax-notified"]`, last 200 ids `event|account|until`). — `crates/slopmax-core/src/proxy/dashboard.html:664-695`
- [ ] **ADM-036** Subscription cards (Claude, then ChatGPT): pooled windows ("weighted by plan" when every plan's share is known, else an average), one segment per working account; rows with each window's use, pace marker, reset countdown, Pinned/Next chips, last use, priority, follows, resets held, sign-in hint, last error; a Limit resets list sorted by expiry. API keys share one card with endpoint and models. Empty state points at `slopmax login claude|codex` and Access › Add an account. — `crates/slopmax-core/src/proxy/dashboard.html:697-822`
- [ ] **ADM-037** Pace: skipped when under 3% or past the window, or at 100%; within ±5 points "On pace"; ahead "Runs out ~{time}"; behind "{n}% in reserve". Conditions: Sign in again, Disabled, Limited · back in…, Throttled, Active · N sessions, Ready. — `crates/slopmax-core/src/proxy/dashboard.html:557-587`
- [ ] **ADM-038** Account menu: Use for new sessions / Stop pinning, Redeem a limit reset…, Set priority…, Rename… (empty shows the email), Refresh here instead of {follows} (`own`), Enable/Disable, Remove… (confirm); each with its toast. Redeem confirms with the account's windows and toasts by outcome. — `crates/slopmax-core/src/proxy/dashboard.html:824-910`
- [ ] **ADM-039** Usage: Today / 7 days / 30 days → `GET history`; KPIs (Tokens, API value, Answered, Saved by failover, Cache hit); charts of tokens by provider, API value, answered vs failed; By account table with a "No account could take it" row and a total; Left on the table; Models with output speed; Token mix; Agents; "When you work" heatmap (not for today). — `crates/slopmax-core/src/proxy/dashboard.html:1039-1148`
- [ ] **ADM-040** Routing: strategy choice (reset-first marked default) and switches for session affinity (with idle minutes), redeem before expiry, redeem when spent, warm ChatGPT windows, overflow to API keys, and usage polls (0 or "Off" turns them off), each a `POST settings`. — `crates/slopmax-core/src/proxy/dashboard.html:1149-1182`, `:1411-1427`
- [ ] **ADM-041** Access: client keys (list, create with a one-time reveal and Copy, revoke with confirm), Add an account (Anthropic, OpenAI, xAI, Compatible endpoint with URL, dialect, models), Health check (`GET doctor`, "Check again"). — `crates/slopmax-core/src/proxy/dashboard.html:1186-1263`
- [ ] **ADM-042** Live requests: reads `/slopmax/events` with `fetch` and a stream reader (to send the bearer header), reconnecting with backoff from 1 s doubling to 15 s; newest first, at most 200 rows; failure when status is outside 200–399; "after failover" when attempts > 1; agent `slopmax` shown as Warmup; each event reloads history and status 8 s later (debounced). — `crates/slopmax-core/src/proxy/dashboard.html:1266-1330`
- [ ] **ADM-043** Timers: countdowns every 1 s, status every 15 s, history every 120 s; an open menu or dialog defers re-rendering accounts. Percentages round half to even, as the Rust's `{:.0}`. — `crates/slopmax-core/src/proxy/dashboard.html:526-532`, `:1332-1348`, `:1453-1461`
- [ ] **ADM-044** Theme: CSS custom properties for light, swapped under `@media (prefers-color-scheme: dark)` (`<meta name="color-scheme" content="light dark">`); light `--bg #fafafa`, `--panel #fff`, `--ink #18181b`, `--good #2f9e68`, `--warn #b8740b`, `--bad #d63d35`, `--accent #d63370`; dark `--bg #0b0b0c`, `--panel #121214`, `--ink #ededef`, `--good #3fb57f`, `--warn #e0a23b`, `--bad #ef6a60`; system UI sans and `ui-monospace` stacks; body 13.5 px/1.5; numbers tabular. Provider series are neutral greys (`--s1..--s4`) so colour means state alone. — `crates/slopmax-core/src/proxy/dashboard.html:9-37`, `:1033-1037`
- [ ] **ADM-045** Responsive: at ≤1100 px the section nav hides and the KPI row becomes a 6-column grid (first three span 2, the rest span 3); at ≤960 px page padding is 20 px, two-column grids stack, account rows wrap with the name on its own line and the kebab menu pinned top-right. Charts redraw 120 ms after the last window resize. — `crates/slopmax-core/src/proxy/dashboard.html:367-398`, `:1450-1451`
- [ ] **ADM-046** Formatting (shared by every part of the page): `dur` → `{d}d{h}h`, `{h}h{mm}m`, `{m}m{ss}s`, `{s}s` (two units, like COM-012); `until` → `now` once passed; `clock` → `HH:MM` today, `Ddd HH:MM` within the next 6 days, else `Mon D`; `dateTime` → `Mon D, HH:MM`; `ago` → `just now` (<60 s), `{m}m ago`, `{h}h ago`, `{d}d ago`; `compact` → `1.2B`/`3.4M`/`5.6k`/integer (axis labels drop `.0`); money `$1,234.56` (en-US grouping); `pct` → whole percent rounded half to even, `—` for null; `secs` → `{ms} ms` under 1 s, `{x.xx} s` under 10 s, else `{x.x} s`; window titles `5-hour`, `Weekly`, `Monthly` (`{span} · {model}` when scoped); meter tone bad ≥ 90 %, warn ≥ 70 %. — `crates/slopmax-core/src/proxy/dashboard.html:499-556`
- [ ] **ADM-047** Gate: without a key the page shows `Open the slopmax dashboard` with a password field (`sm-…` placeholder) and Open; a submitted non-empty key is stored in `sessionStorage` and the app starts. Start: live indicator `wait`, then status, settings, history, the live feed, keys, the add-account form, and the doctor load at once; timers per ADM-043. Footer: `slopmax {version} · serving|not serving on {origin} · strategy {Strategy name}`; `Updated {ago}` beside the summary, refreshed each second. — `crates/slopmax-core/src/proxy/dashboard.html:400-405`, `:1332-1353`, `:1443-1466`
- [ ] **ADM-048** Dialogs (`ask`): a modal form over a scrim with title, body, optional facts and one input; Escape, a click on the scrim, or Cancel resolves null; submit resolves the input's value (or `""` for a confirm); the input, else the primary/danger button, takes focus. Toasts stack at the bottom right and disappear after 4.5 s; errors use the error style. Tooltips follow the pointer 14 px off and flip to stay 8 px inside the viewport. Escape and any page scroll close an open account menu. — `crates/slopmax-core/src/proxy/dashboard.html:911-958`, `:1428-1429`
- [ ] **ADM-049** Account menu texts: own → dialog `Refresh {name} here?` / `slopmax follows {tool}'s copy of this account's tokens now. From here on slopmax refreshes them itself, and stops reading {tool}'s copy.` / `Refresh here`, toast `slopmax refreshes {name} itself now.`; use → `New {Provider title} sessions go to {name}.`; unpin and Clear pin → `slopmax chooses accounts again.`; enable/disable → `{name} enabled.` / `{name} disabled.`; priority → dialog `Set priority` / `Higher tiers are used first; within a tier the strategy decides. {name} is at {n}.` (number input, Save), toast `{name} is at priority {n}.` (blank input does nothing); rename → `Rename account` / `A name for this account here and in the CLI. Leave it empty to show its email again.` (prefilled with the label, placeholder the email), toast `Renamed.`; remove → `Remove {name}?` / `slopmax forgets this account and its tokens. Its sessions move to other accounts. You can sign in again later.` (danger), toast `{name} removed.`. Failures toast the API's `error.message`. — `crates/slopmax-core/src/proxy/dashboard.html:852-888`
- [ ] **ADM-050** Redeem dialog `Redeem a limit reset?`: `This spends “{credit title}”|one limit reset on {name} and resets its windows now.` plus ` It would expire {dateTime}.` when known; facts `Its windows now` list each window's `{used}% used` and ` · resets anyway in {until}` for used windows with a future reset. Outcome toasts: reset `Redeemed. {name}'s windows are reset.`; nothing_to_reset `Nothing was used, so the limit reset was kept.`; no_credit `This account has no limit reset left.`; already_redeemed `That limit reset was already redeemed.`; declined `{Provider title} would not spend it now; the limit reset was kept.`; unknown `Redeem: {outcome}`; all but reset and nothing_to_reset show as errors. — `crates/slopmax-core/src/proxy/dashboard.html:882-910`
- [ ] **ADM-051** Routing toasts: strategy → `New sessions now go by {strategy name, lowercased}.`; each switch → `{switch name} on.` / `{switch name} off.`; idle minutes (only values > 0) → `Idle sessions are forgotten after {n} minutes.`; usage polls (`""` or `off` mean 0; negatives ignored) → `Usage is polled every {n} minute[s].` or `Background usage polls are off.`; a refused change toasts the error and redraws the controls from the last good settings. — `crates/slopmax-core/src/proxy/dashboard.html:1180-1184`, `:1400-1427`
- [ ] **ADM-052** Access texts: revoke → dialog `Revoke {name}?` / `Agents using this key are refused from now on. This cannot be undone; make a new key to restore access.` / `Revoke` (danger), toast `{name} revoked.`; a new key is revealed once until `#keydone` dismisses it; adding an account sends the non-blank form fields plus `provider`, toasts `{label or provider title} added.`, and shows failures inline under the form rather than as a toast. Copy buttons toast `Copied.` (or `Copy did not work; select it instead.`); Endpoint toasts `Copied {origin}` (or just the origin when the clipboard is refused). Notify me → after permission is granted toasts `This browser will notify you when something needs doing.` — `crates/slopmax-core/src/proxy/dashboard.html:1246-1269`, `:1355-1441`
- [ ] **ADM-053** Charts are hand-drawn SVG: stacked columns (220 px tall, 48 px value axis, column width 60 % of the band within 2–28 px, top segment rounded 3 px, 2 px gaps between segments, bucket labels thinned to one per ~58 px); value-axis steps from `niceStep` (smallest of 1, 2, 2.5, 5, 10 × 10^⌊log10(max/4)⌋ that reaches max/4); hovering highlights the bucket and shows each series plus `Total`. The "When you work" heatmap is 7 rows (Mon–Sun) × 24 hours, cells up to 22 px with 3 px gaps, opacity `0.12 + 0.82 × √(v/max)` (empty cells in the track colour), hour labels at 00:00/06:00/12:00/18:00, tooltip `{Ddd} {HH}:00 | {n} request[s]`. The live feed's Clear empties it and restores `Answered and failed requests as they happen.`; new rows flash for 1.3 s. — `crates/slopmax-core/src/proxy/dashboard.html:960-1037`, `:1281-1287`, `:1442`

## 9. CLIProxyAPI-compatible management API (`proxy/hub.rs`)

Errors here are `{"error": <message>}`.

- [ ] **HUB-001** Authorized by the owner key (bearer or `x-api-key`) or `x-management-key` equal (trimmed, constant time) to `api_key`; client keys are not accepted; else 401 `missing or invalid management key; use slopmax's api_key`. — `crates/slopmax-core/src/proxy/hub.rs:43-51`, `:71-77`
- [ ] **HUB-002** Routes under `/v0/management/`: `GET auth-files`, `POST api-call`, `POST reset-quota`; anything else 404 `slopmax serves auth-files, api-call, and reset-quota of CLIProxyAPI's management API`. — `crates/slopmax-core/src/proxy/hub.rs:52-69`
- [ ] **HUB-003** `auth-files` → `{"files":[…]}`, subscription accounts only, each `{"id","auth_index" (= account id),"name":"<id>.json","type","provider","label" (display name),"status": error|disabled|active,"disabled","unavailable" (signed out or blocked),"priority"}`, plus `email` and `status_message` (the auth error) only when present, and for Codex `id_token: {chatgpt_account_id?, chatgpt_plan_type?}`. — `crates/slopmax-core/src/proxy/hub.rs:98-147`
- [ ] **HUB-004** `api-call` body (JSON ≤64 KiB): `auth_index` (also `authIndex`, `AuthIndex`), `method`, `url`, `data`, all optional strings; `header` ignored; unparsable → 400 `invalid body`; the index (trimmed) must be a subscription account's id, else 400 `no account has this auth_index`. — `crates/slopmax-core/src/proxy/hub.rs:149-166`, `:89-96`
- [ ] **HUB-005** Answered calls (method uppercased, URL trimmed and exact): `GET https://api.anthropic.com/api/oauth/usage` for Claude; `GET https://chatgpt.com/backend-api/wham/usage`, `GET …/wham/rate-limit-reset-credits`, `POST …/wham/rate-limit-reset-credits/consume` for Codex. Anything else → 403 `slopmax answers only the usage and reset-credit calls of its accounts; it does not send their tokens elsewhere`. No token ever leaves for another URL. — `crates/slopmax-core/src/proxy/hub.rs:31-34`, `:163-185` (test `hub_clients_read_usage_and_redeem_credits_without_a_relay`)
- [ ] **HUB-006** An answered call is always HTTP 200 `{"status_code":<n>,"header":{"Content-Type":["application/json"]},"body":"<JSON text>"}`; inner errors are `{"error":{"message":…}}` with their own status code. — `crates/slopmax-core/src/proxy/hub.rs:186-197`
- [ ] **HUB-007** Usage comes from slopmax's readings, never upstream: signed out → 401 `the account needs signing in again`; never read → 503 `slopmax has not read this account's usage yet`. — `crates/slopmax-core/src/proxy/hub.rs:200-221`
- [ ] **HUB-008** Claude usage shape: `{"five_hour":{"utilization","resets_at"}|null,"seven_day":…|null,"limits":[{"kind":"weekly_scoped","percent","resets_at","scope":{"model":{"display_name"}}}]}` from shared `5h`/`7d` windows and per-model windows; utilization is the use now (0 after a passed reset), `resets_at` the upcoming reset as RFC 3339 or null. — `crates/slopmax-core/src/proxy/hub.rs:223-250` (test `readings_take_the_providers_shapes`)
- [ ] **HUB-009** Codex usage shape: shared windows sorted by length (`5h` 18000 s, `30d` 2592000 s, anything else 604800 s): `{"rate_limit":{"primary_window":{"used_percent","reset_at" (epoch s)|null,"limit_window_seconds"}|null,"secondary_window":…|null}}` plus `plan_type` and `rate_limit_reset_credits.available_count` when known. — `crates/slopmax-core/src/proxy/hub.rs:252-289`
- [ ] **HUB-010** Credit list: none for providers without credits or when the usage counts 0; a list younger than 5 min is reused (unexpired entries); else listed now (not ready → 401; failure → 502) and recorded. Each credit with an expiry: `{"id","status":"available","reset_type":"codex_rate_limits","expires_at","granted_at"?}` in `{"credits":[…]}`. — `crates/slopmax-core/src/proxy/hub.rs:35-37`, `:291-337`
- [ ] **HUB-011** Consume: `data` must be `{"credit_id":…}` (else 400 `no credit_id to redeem`); no credits → 400 `this account has no limit resets`; under the redeem lock; not ready → 401; failure → 502; `reset` records it and logs `{id}: redeemed a limit reset for a hub client`; answers `{"code":<outcome>}`. — `crates/slopmax-core/src/proxy/hub.rs:339-368`
- [ ] **HUB-012** `reset-quota` body `{"auth_index"}` (aliases as HUB-004; missing → 400 `auth_index is required`); unknown → 404 `no account has this auth_index`; lifts the account's blocks; when `poll_mins > 0` and signed in, polls its usage in the background; answers `{"status":"ok","auth_index":<id>,"models":[<models whose blocks were lifted>]}`. — `crates/slopmax-core/src/proxy/hub.rs:370-391`

## 10. The daemon (`daemon.rs`)

- [ ] **DMN-001** (corrected) `serve` binds `listen` first; failure → error `cannot listen on {addr}: {holder} is using that port` when the port's holder is known (NET-031; was mis-referenced as NET-041, the WebSocket reader), else `cannot listen on {addr}`. — `crates/slopmax-core/src/daemon.rs:46-53`
- [ ] **DMN-002** `state.json` is read at start (absent → empty; malformed → start fails); then the app is built and accounts synced once (a sync error fails start). — `crates/slopmax-core/src/daemon.rs:54-56`
- [ ] **DMN-003** Each periodic task runs at once at start, then every period; a run that overruns delays the next tick (no catch-up burst); a task never overlaps itself; each reads the config as it runs, so toggles apply without a restart. — `crates/slopmax-core/src/daemon.rs:75-76`, `:137-149`
- [ ] **DMN-004** Every 2 s: sync accounts and pins (warn `reloading accounts: {e}`), then reload config.toml. — `crates/slopmax-core/src/daemon.rs:58-67`
- [ ] **DMN-005** (corrected) Every 10 s: write reset windows to `windows.jsonl` (DMN-019; was mis-referenced as DMN-018), then save the pool snapshot to `state.json` only when it changed (pretty JSON, owner-only); warn `saving state: {e}`. — `crates/slopmax-core/src/daemon.rs:68-74`, `:216-223`
- [ ] **DMN-006** Every 300 s, when `refresh_tokens`: refresh tokens due for refresh on every account without an auth error, disabled ones included; failures warn and are recorded on the account. — `crates/slopmax-core/src/daemon.rs:77-85`, `:253-265`
- [ ] **DMN-007** (corrected) Every 60 s: list limit resets that are due (DMN-016; was mis-referenced as DMN-015). — `crates/slopmax-core/src/daemon.rs:86-92`
- [ ] **DMN-008** (corrected) Every 1800 s, when `redeem_expiring_credits`: redeem resets about to expire (DMN-017; corrected, was mis-referenced as DMN-016). — `crates/slopmax-core/src/daemon.rs:93-101`
- [ ] **DMN-009** Every 60 s, when `warm_windows`: warm idle ChatGPT windows (PRX-095). — `crates/slopmax-core/src/daemon.rs:102-110`
- [ ] **DMN-010** (corrected) Every 15 s: watch account conditions and nudges (DMN-018; was mis-referenced as DMN-017). — `crates/slopmax-core/src/daemon.rs:37-38`, `:111`, `:174-214`
- [ ] **DMN-011** (corrected) Every 60 s, when `poll_mins > 0`: poll usage that is due (DMN-014; corrected, was mis-referenced as DMN-013). — `crates/slopmax-core/src/daemon.rs:112-120`
- [ ] **DMN-012** Logs info `slopmax {version} listening on {base_url}` once serving; on stop saves state a last time and logs `stopped`. — `crates/slopmax-core/src/daemon.rs:122-134`
- [ ] **DMN-013** (corrected) Stops on Ctrl-C (SIGINT), SIGTERM (Unix only; on Windows only Ctrl-C), or `POST /slopmax/shutdown`; in-flight requests get the server's drain (NET-030, 10 s; corrected, was mis-referenced as NET-040). — `crates/slopmax-core/src/daemon.rs:151-172`
- [ ] **DMN-014** Usage polls: subscription accounts without an auth error (disabled ones included); due when never read, read at least `max(poll_mins, 1)` minutes ago, a window's reset has passed since the reading, or the account is blocked and the reading is 10 min old; all due polls run concurrently and the task waits for them. `force` polls all eligible. — `crates/slopmax-core/src/daemon.rs:22-23`, `:267-284`, `:441-457`
- [ ] **DMN-015** (corrected) One poll: `usage::poll` (refreshing only if `refresh_tokens`); the reading's windows are observed; a reported plan that differs from the account's is saved to its file under the account lock (`Store::update`, off the async thread), a save failure warning `{id}: saving plan: {e}` (corrected: the save path and its warning were missing); a failure warns `{id}: usage poll failed: {e}` and records `usage poll: {e}`. — `crates/slopmax-core/src/daemon.rs:286-314`
- [ ] **DMN-016** Listing resets per account whose provider has them, skipping disabled, signed-out, those needing Claude Code's user agent when none was seen, and (for providers whose usage counts them) those whose count is 0 with none left; due when never listed, listed ≥6 h ago (counted providers) or ≥1 h ago (uncounted, i.e. Claude), or the count changed and the list is ≥10 min old; `force` lists every eligible one. A failure warns `{id}: listing limit resets: {e}`; for uncounted providers the unexpired list is re-recorded so the next try waits the hour. — `crates/slopmax-core/src/daemon.rs:26-36`, `:316-370` (test `claude_limit_resets_are_listed_and_spent_as_claude_code`)
- [ ] **DMN-017** (corrected) Redeeming expiring resets: accounts with resets left, enabled, signed in, with any window in use, and (if needed) Claude Code's user agent seen; under the redeem lock and ready: list (recorded even when nothing is redeemed), and when the _first credit in the provider's spend order_ (Claude: `next_grant_id` first, then by `ends_at`, PROV-032; Codex: by `expires_at`, PROV-058) expires within 3 h (`≤`, inclusive) redeem that credit by id; a later-listed credit that expires sooner is not considered (corrected: was "the soonest"); `reset` records it and logs `{id}: redeemed a limit reset before it expired`; other outcomes log `{id}: expiring limit reset not used ({outcome:?})`; errors warn `{id}: checking limit resets: {e}`. — `crates/slopmax-core/src/daemon.rs:24-25`, `:372-439` (test `credits_about_to_expire_are_redeemed_on_used_accounts`)
- [ ] **DMN-018** Watch: loads `nudged.json` (a list of keys; unreadable → empty); each tick computes condition changes (NOTE-011) and nudges from the live report (NOTE-009, NOTE-010) with `redeem_expiring_credits` and `[plan_prices]`; when new nudges appear the full sorted key list is written to `nudged.json` (warn `saving the nudges told: {e}`); every event is logged at info as its message and, when `[notify]` has a webhook or command, sent (warn `sending a notification: {e}`). — `crates/slopmax-core/src/daemon.rs:174-214`
- [ ] **DMN-019** Reset windows: the pool's lapsed windows become `windows.jsonl` records with the account's provider and plan (accounts no longer present are dropped); a write failure warns `recording reset windows: {e}`. — `crates/slopmax-core/src/daemon.rs:225-251`

- [ ] **DMN-021** Listing limit resets and redeeming expiring ones walk the accounts one at a time (unlike usage polls, which run concurrently); each account goes through `ready` (PRX-020) first and is skipped silently when it is not ready (signed out, refresh failed). Token refresh (DMN-006) also walks accounts one at a time, warning `{id}: {e}` with the refresh error's display (AUTH-004) and recording that text as the account's `last_error`. — `crates/slopmax-core/src/daemon.rs:253-265`, `:321-370`, `:372-413`
- [ ] **DMN-022** `POST /slopmax/refresh` runs `poll_all(force)` then `list_credits(force)` inline on the request, not coordinated with the background ticks, so a forced run may overlap a scheduled poll or listing (each is idempotent per account; the account's file lock serializes token refreshes, AUTH-013). Every redemption shares one process-wide `redeeming` mutex: the daemon's expiring-reset redeem (DMN-017), `POST accounts/{id}/redeem` (ADM-015), the hub's `api-call` consume (HUB-011), and the failover rescue (PRX-072), so only one redemption runs at a time. — `crates/slopmax-core/src/proxy/admin.rs:55-60`, `:499`, `crates/slopmax-core/src/proxy/hub.rs:355`, `crates/slopmax-core/src/proxy/forward.rs:814`, `crates/slopmax-core/src/daemon.rs:390`, `crates/slopmax-core/src/proxy/mod.rs:60-62`

## 11. Ledger, summaries, history, prices, quota left (`ledger.rs`, `summary.rs`, `history.rs`, `pricing.rs`, `waste.rs`)

### Ledger

- [ ] **LED-001** File per UTC month: `<home>/usage/YYYY-MM.jsonl` chosen by each entry's `at` in UTC (not local time); directory created 0700, files opened append-only and created 0600 on Unix. — `crates/slopmax-core/src/ledger.rs:107-138`
- [ ] **LED-002** Entry line (JSON, one per line, keys in this order): `at` (RFC 3339), `account` (`""` when no account was tried), `provider`, `model` (omitted when none), `status`, `input`, `output`, `cache_read`, `cache_write`, `ms`, `first_byte_ms` (omitted when none), `attempts` (omitted when 1; read as 1 when absent), `agent` (omitted when none; `claude`, `codex`, or `slopmax` for warmups), `session` (omitted when none). Token fields default to 0 on read. — `crates/slopmax-core/src/ledger.rs:17-76`
- [ ] **LED-003** Writes never block a request: entries queue unbounded and are appended in batches by one writer; a failure warns `writing the usage ledger: {e}`. — `crates/slopmax-core/src/ledger.rs:78-105`
- [ ] **LED-004** Reading since T: every `*.jsonl` file whose path sorts at or after T's month file, in path order; unreadable lines skipped; entries with `at ≥ T`; sorted by `at` (stable). A missing directory reads empty. — `crates/slopmax-core/src/ledger.rs:140-167` (test `writes_monthly_files_and_reads_them_back`)
- [ ] **LED-005** Failed = status ≥ 400; answered = not failed and moved any tokens; anything else (model lists, token counts) is housekeeping. — `crates/slopmax-core/src/ledger.rs:51-68`

### Summaries (`slopmax usage`, `GET /slopmax/usage`)

- [ ] **LED-010** Range start: `today` = local midnight; `7d` = that minus 6×24 h; `30d` minus 29×24 h; `all` = the epoch; anything else is invalid. — `crates/slopmax-core/src/summary.rs:14-15`, `:104-118` (test `ranges_start_at_local_midnight`)
- [ ] **LED-011** Totals: a failure only counts in `failed`; housekeeping counts nowhere; an answer adds to `requests`, the four token counts, and `cost` at its model's price, or to `unpriced` when the model has none. JSON keys `requests`, `input`, `output`, `cache_read`, `cache_write`, `cost` (rounded to 1e-6), `unpriced` and `failed` omitted when 0. — `crates/slopmax-core/src/summary.rs:22-83` (tests `unpriced_requests_are_counted_apart`, `requests_are_the_answers_alone`)
- [ ] **LED-012** Cost label: `$x.xx`; `—` when every request is unpriced; `$x.xx+` when some are. — `crates/slopmax-core/src/summary.rs:85-93`
- [ ] **LED-013** Summary JSON `{"since","by","rows":{<key>:Totals},"total"}`; rows sorted by key; keys: `day` → local `YYYY-MM-DD`, `model` → the model or `-`, `account` → display name (else id), and `(no account free)` for failures that reached no account; housekeeping rows are not made. — `crates/slopmax-core/src/summary.rs:16-20`, `:96-158` (test `usage_totals_the_ledger` in `crates/slopmax/tests/cli.rs`)

### History (`GET /slopmax/history`, the app's charts)

- [ ] **LED-020** Ranges `today`, `7d`, `30d` (titles `Today`, `7 Days`, `30 Days`); in JSON the range serializes as `"today"`, `"week"`, `"month"` (not the query keys). — `crates/slopmax-core/src/history.rs:26-60`
- [ ] **LED-021** History JSON keys in order: `range`, `buckets`, `providers`, `total` (Totals), `rescued`, `unplaced`, `billed`, `left` (LED-053), `cache_saved`, `cached` (0–1 or null), `sessions`, `first_byte` (ms or null), `monthly` (or null), `activity` (7×24 counts, Monday first), `models`, `accounts` (`[{"name","provider","totals"}]`), `agents` (`[{"name","totals"}]`), `speeds` (`[{"model","provider","tokens_per_second"}]`). Bucket keys: `label`, `tokens` (per provider, in `providers` order), `requests`, `failed`, `rescued`, `sessions`, `cost`, `cached`, `first_byte` (`[p50, p95]` or null). — `crates/slopmax-core/src/history.rs:62-156`
- [ ] **LED-022** Buckets: today = one per hour from local midnight up to the current hour; 7d = 7 days; 30d = 30 days; day index by local calendar date at each entry's own offset; entries outside are skipped; labels `HH:00` or `Mon D` (taken at noon of the day, clear of DST shifts). — `crates/slopmax-core/src/history.rs:228-238`, `:244-249`, `:421-432` (tests `days_fill_their_buckets_by_provider`, `today_counts_hours_up_to_now`)
- [ ] **LED-023** `providers` = providers in registry order (claude, codex, anthropic, openai, xai, compat) that answered anything in the range. — `crates/slopmax-core/src/history.rs:239-242`
- [ ] **LED-024** Per entry: bucket and total Totals; accounts get answers and failures that reached an account (by display name and provider); `unplaced` counts failures with no account; then for answers only: `billed` = cost of non-subscription providers; tokens per provider; `rescued` when attempts > 1; first-byte samples; sessions (distinct ids); `cache_saved += cache_read × (input price − cache-read price) / 1e6`; output speed when output ≥ 64 tokens and `ms > first_byte_ms` = output × 1000 / (ms − first_byte); agent `slopmax` (warmups) is left out of `cached` and `activity`; per-model (`unknown` when none) and per-agent Totals. — `crates/slopmax-core/src/history.rs:17-24`, `:263-333`, `:393-399` (tests `failover_failures_and_housekeeping_count_apart`, `api_keys_bill_what_subscriptions_only_value`, `caching_speed_sessions_and_agents`, `an_hour_of_warmups_alone_has_no_cache_rate`)
- [ ] **LED-025** Percentiles: sorted ascending, element at `len × p / 100` (clamped); bucket `first_byte` = `[p50, p95]`; history `first_byte` = p50. Speeds are the median `sorted[len/2]` per (model, provider), fastest first. — `crates/slopmax-core/src/history.rs:355-367`, `:434-440` (test `first_bytes_read_as_median_and_slowest_twentieth`)
- [ ] **LED-026** `cached` = cache_read / (input + cache_read + cache_write) when that sum > 0, as a 32-bit float. `monthly` = total cost × 30 / 7 for the 7-day range only. — `crates/slopmax-core/src/history.rs:163-167`, `:372-375`
- [ ] **LED-027** Agents named `Claude Code`, `Codex`, `Warmups`, `Other`, most tokens first; models and accounts sorted by (tokens, failed) descending, ties in name/provider order. — `crates/slopmax-core/src/history.rs:350-354`, `:401-409`, `:442-454`
- [ ] **LED-028** Activity: weekday (Monday = 0) and hour at each entry's local offset. — `crates/slopmax-core/src/history.rs:411-419` (test `work_falls_on_the_local_weekday_and_hour`)
- [ ] **LED-029** `load` reads the ledger and `windows.jsonl` from the range start and fills `left`. — `crates/slopmax-core/src/history.rs:169-206`

### Prices

- [ ] **LED-040** Claude list prices (USD per million: input, output, cache read; cache write = 1.25 × input): `claude-fable-5-1` 10/50/0.25, `claude-mythos-5-1` 10/50/0.25, `claude-fable-5` 10/50/1.0, `claude-mythos-5` 10/50/1.0, `claude-opus-5-5` 4/20/0.20, `claude-opus-5` 5/25/0.50, `claude-opus-4-8` 5/25/0.50, `claude-opus-4-7` 5/25/0.50, `claude-opus-4-6` 5/25/0.50, `claude-sonnet-5-5` 2/10/0.20, `claude-sonnet-5` 2/10/0.20, `claude-sonnet-4-6` 3/15/0.30, `claude-haiku-4-5` 1/5/0.10. — `crates/slopmax-core/src/pricing.rs:44-62`
- [ ] **LED-041** OpenAI list prices (cache write = input, i.e. no extra): `gpt-6-sol` 2/10/0.20, `gpt-6-luna` 0.10/0.50/0.01. — `crates/slopmax-core/src/pricing.rs:64-70` (test `openai_prices_charge_nothing_extra_to_cache`)
- [ ] **LED-042** A model matches an id when equal or the id plus `-YYYYMMDD` (8 digits); any other suffix is another model; a `[…]` suffix (Claude Code's `[1m]`) is ignored; `[prices]` entries (in key order) win over the lists; the lists are searched Claude then OpenAI, in table order. — `crates/slopmax-core/src/pricing.rs:131-161` (tests `matches_a_model_or_its_dated_snapshots`, `custom_prices_win_and_fill_in_cache_rates`)
- [ ] **LED-043** `[prices]` entries: `input`, `output`, optional `cache_read` (default 0.1 × input) and `cache_write` (default 1.25 × input); unknown fields rejected. — `crates/slopmax-core/src/pricing.rs:20-42`
- [ ] **LED-044** Plan fees a month: Claude `pro` 20, `max` 100, `max 5x` 100, `max 20x` 200, `team` 30; Codex `plus` 20, `pro` 200, `team` 30, `business` 30. The plan is trimmed and lowercased; `[plan_prices]` `"<provider>/<plan>" = n` wins. — `crates/slopmax-core/src/pricing.rs:72-102` (test `plans_are_priced_by_provider_and_can_be_set`)
- [ ] **LED-045** Pool shares by plan: Claude `pro` 1, `max 5x` 5, `max 20x` 20; only when every account's plan has a size; normalized to sum 1. — `crates/slopmax-core/src/pricing.rs:104-129` (test `shares_follow_plan_sizes_only_when_every_one_is_known`)
- [ ] **LED-046** Cost = (input × in + output × out + cache_read × cr + cache_write × cw) / 1e6. — `crates/slopmax-core/src/pricing.rs:163-172` (test `costs_every_kind_of_token`)

### Quota left on the table

- [ ] **LED-050** `windows.jsonl` records, one JSON line each, keys `ended_at`, `account`, `provider`, `plan` (omitted when none), `span`, `model` (omitted when none), `used` (percent as a float); appended, file 0600, directory 0700. — `crates/slopmax-core/src/waste.rs:27-78`
- [ ] **LED-051** Reading since T: unparsable lines skipped; `ended_at ≥ T`; duplicates of (account, span, model, ended_at) kept once; sorted by `ended_at`. — `crates/slopmax-core/src/waste.rs:80-95` (test `records_are_kept_and_read_back_once_each`)
- [ ] **LED-052** Value of the unused part: shared `7d` → monthly fee / (52/12) × unused share; shared `30d` → monthly fee × unused share; any other span or a per-model window → 0; no plan or unknown price → none. — `crates/slopmax-core/src/waste.rs:24-25`, `:97-117` (test `the_unused_part_of_a_week_costs_its_share_of_the_fee`)
- [ ] **LED-053** `left` JSON `{"windows","unused" (mean %),"dollars","unpriced","accounts":[{"name","provider","windows","unused","dollars"}]}` over shared `7d`/`30d` windows only; accounts by display name, most dollars first, then most unused. — `crates/slopmax-core/src/waste.rs:119-202` (test `left_totals_long_windows_by_account`)

## 12. Notifications and nudges (`notify.rs`)

- [ ] **NOTE-001** `[notify]` keys: `webhook` (URL), `command` (shell), `events` (list); unknown keys rejected; enabled when a webhook or command is set. — `crates/slopmax-core/src/notify.rs:21-34`, `:119-126`
- [ ] **NOTE-002** Event names: `limited`, `available`, `exhausted`, `recovered`, `signed-out`, `reset-expiring`, `quota-unused`, `test`. Default set when `events` is empty: `exhausted`, `recovered`, `signed-out`, `reset-expiring`, `quota-unused`. `test` is always sent. — `crates/slopmax-core/src/notify.rs:36-83`, `:128-135`
- [ ] **NOTE-003** Event JSON keys: `event`, `provider`?, `account`? (display name), `until`?, `message`, `at`, `worth`? (dollars, quota-unused only). — `crates/slopmax-core/src/notify.rs:85-103`
- [ ] **NOTE-004** Sending tries the webhook and the command both; failures join as `webhook: {e}; command: {e}`. — `crates/slopmax-core/src/notify.rs:137-157`
- [ ] **NOTE-005** Webhook: `POST` JSON of the event plus `text` and `content` repeating the message (Slack/Discord); a non-2xx is an error `HTTP {status}`. — `crates/slopmax-core/src/notify.rs:160-172`
- [ ] **NOTE-006** Command: `sh -c <command>` (Windows: `cmd /C`), env `SLOPMAX_EVENT`, `SLOPMAX_PROVIDER`, `SLOPMAX_ACCOUNT`, `SLOPMAX_UNTIL` (RFC 3339), `SLOPMAX_MESSAGE` (empty strings when absent), stdin null, killed after 30 s (`timed out`) or when dropped; a spawn failure is `could not start it`; a non-zero exit is `{exit status}: {stderr trimmed}`. — `crates/slopmax-core/src/notify.rs:18-19`, `:174-208` (tests `commands_get_the_event_in_variables`, `notify_sends_a_test_event_through_the_command` in `crates/slopmax/tests/cli.rs`)
- [ ] **NOTE-007** Test event message `slopmax notifications are working.` — `crates/slopmax-core/src/notify.rs:105-117`
- [ ] **NOTE-008** Times in messages read `in {human::until} ({HH:MM})`, local time. — `crates/slopmax-core/src/notify.rs:492-497`
- [ ] **NOTE-009** Nudge `reset-expiring` (only when `redeem_expiring_credits` is off): each unexpired reset on an enabled, signed-in account expiring within 24 h; key `reset:{account id}:{credit id}`; until = expiry; message ``A limit reset on {name} expires {when}; redeem it with `slopmax redeem {name}` before it is lost.`` — `crates/slopmax-core/src/notify.rs:210-212`, `:241-277`
- [ ] **NOTE-010** Nudge `quota-unused`: each shared `7d`/`30d` window whose upcoming reset is within 24 h with at least 25% unused, on an account not blocked; key `unused:{account id}:{span}:{reset epoch seconds}`; until = the reset; `worth` = LED-052 value; message `{name}'s {week|month} resets {when} with {unused:.0}% of it unused{, about ${worth:.0} of its plan (when worth ≥ 0.5)}. Work sent there before then costs nothing extra.` — `crates/slopmax-core/src/notify.rs:213-214`, `:278-325` (test `nudges_name_lapsing_resets_and_spare_weeks_once_each`)
- [ ] **NOTE-011** Conditions per account: disabled → off; auth error → signed out; limited until something → limited; else ready. The first look only takes stock (no events). — `crates/slopmax-core/src/notify.rs:328-406` (test `reports_each_change_once`)
- [ ] **NOTE-012** Per-account events on change: → limited: `limited` `{name} hit a usage limit{; back {when}}.` (the "back" part only for a future time), except when this same look turns the provider exhausted; limited → ready: `available` `{name} can serve requests again.`; → signed out: `signed-out` ``{name} is signed out ({auth error or "unknown reason"}); run `slopmax login {provider}` to sign in again.`` Disabled accounts make no events. — `crates/slopmax-core/src/notify.rs:413-448`, `:485-490` (test `disabled_accounts_are_ignored`)
- [ ] **NOTE-013** Per provider (registry order): exhausted = it has non-disabled accounts and none is ready. On change: `exhausted` `Every {title} account is limited or signed out, so {title} requests fail{ until {when}}.` (until = the soonest limited account's return); `recovered` `{title} requests are being served again.` — `crates/slopmax-core/src/notify.rs:407-476`
- [ ] **NOTE-014** Removed accounts are forgotten, so one added again starts fresh. Nudge keys already told (including from `nudged.json`) are never told again; the told set is never pruned. — `crates/slopmax-core/src/notify.rs:348-372`, `:477-480`
- [ ] **NOTE-015** `[notify].events` filters every kind but `test`. — `crates/slopmax-core/src/notify.rs:128-135` (test `settings_filter_events`)

## 13. Formats and translation (`crates/slopmax-wire`)

### Per-format basics (`lib.rs`, `*/mod.rs`)

- [ ] **WIRE-001** Dialects `messages`, `responses`, `chat` (serialized lowercase; `as_str` the same). — `crates/slopmax-wire/src/lib.rs:22-33`, `:129-135` (test `formats_have_stable_names`)
- [ ] **WIRE-002** Usage: `requests`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`; adding sums each; total = the four token counts. — `crates/slopmax-wire/src/lib.rs:35-57` (test `usage_adds_up_and_totals_every_kind_of_token`)
- [ ] **WIRE-003** Error bodies: Messages `{"type":"error","error":{"type","message"}}`; Responses and Chat `{"error":{"type","message"}}`. — `crates/slopmax-wire/src/lib.rs:80-86`, `crates/slopmax-wire/src/messages/mod.rs:11-13`, `crates/slopmax-wire/src/responses/mod.rs:15-17` (test `each_format_names_its_errors_its_own_way`)
- [ ] **WIRE-004** Limit reached: Messages → `rate_limit_error` body plus headers `anthropic-ratelimit-unified-status: rejected` and `anthropic-ratelimit-unified-reset: <epoch s>`; Responses → `{"error":{"type":"usage_limit_reached","message","resets_at":<epoch s>,"resets_in_seconds":<≥1>}}`; Chat → `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message"}}`. — `crates/slopmax-wire/src/messages/mod.rs:15-26`, `crates/slopmax-wire/src/responses/mod.rs:19-33`, `crates/slopmax-wire/src/chat/mod.rs:11-18` (test `spent_pools_answer_with_each_clients_own_limit_error`)
- [ ] **WIRE-005** Only Responses holds its stream's start. Opening: Messages and Chat → content; Responses `response.created|in_progress|queued` → wait; `response.failed`/`error` with code (from `/response/error` or `/error`, its `code` else `type`) `usage_limit_reached|usage_limit_exceeded` → refused, exhausted; `server_is_overloaded|slow_down|rate_limit_exceeded` → refused, not exhausted; any other → content. — `crates/slopmax-wire/src/lib.rs:104-118`, `crates/slopmax-wire/src/responses/mod.rs:35-72` (test `only_codex_streams_are_held_until_they_open`)
- [ ] **WIRE-006** Messages usage: from `message` (`usage`), `message_start` (`/message/usage`), `message_delta` (`usage`); each non-zero `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` overwrites (counts are cumulative, zero means unchanged); an `error` event typed `rate_limit_error` marks exhaustion. — `crates/slopmax-wire/src/messages/mod.rs:28-59` (test `usage_is_read_from_each_formats_events`)
- [ ] **WIRE-007** Responses usage: a whole `object: "response"` document's `usage`, or `/response/usage` of `response.completed|incomplete|done`; input = `input_tokens − input_tokens_details.cached_tokens` (floored at 0), cache read = cached, output = `output_tokens`; `response.failed`/`error` coded `usage_limit_reached|usage_limit_exceeded` marks exhaustion. — `crates/slopmax-wire/src/responses/mod.rs:54-98`
- [ ] **WIRE-008** Chat usage: any object `usage`; input = `prompt_tokens − prompt_tokens_details.cached_tokens`, cache read = cached, output = `completion_tokens`. — `crates/slopmax-wire/src/chat/mod.rs:20-33` (test `usage_comes_from_the_final_chunk`)
- [ ] **WIRE-009** An SSE frame is `event: <name>\n` (when named) then `data: <compact JSON>\n\n`. — `crates/slopmax-wire/src/lib.rs:138-148` (test `frames_are_server_sent_events`)

### Common form (`ir.rs`)

- [ ] **WIRE-010** Request: `model`, `system[]`, `messages[]` (role user/assistant, parts Text, Image, File, Call, Result, Reasoning), `tools[]` (name, description, schema, kind Function|Freeform), `tool_choice` (Auto, None, Required, Named), `parallel_tool_calls?`, `max_tokens?`, `temperature?`, `top_p?`, `stop[]`, `effort?`, `format?` (name, schema, strict), `stream`, `cache_key?`, `compact`. Answer events: Text, Reasoning, State (opaque), Call, Done{stop, usage}, Error{status, message}. — `crates/slopmax-wire/src/ir.rs:14-253`
- [ ] **WIRE-011** Media URL: base64 → `data:<type>;base64,<data>`; reading a URL splits `data:<type>;base64,` else keeps the URL with an empty type. — `crates/slopmax-wire/src/ir.rs:77-104` (test `data_urls_round_trip`)
- [ ] **WIRE-012** Effort names: `minimal`/`none` → Minimal, `low`, `medium`, `high`, `xhigh`/`max` → Max; a thinking budget < 4096 → Low, < 16384 → Medium, else High. — `crates/slopmax-wire/src/ir.rs:186-206` (test `budgets_map_to_efforts`)
- [ ] **WIRE-013** Failure kind by status: 400 `invalid_request_error`, 401 `authentication_error`, 403 `permission_error`, 404 `not_found_error`, 413 `request_too_large`, 429 `rate_limit_error`, 503 and 529 `overloaded_error`, else `api_error`. — `crates/slopmax-wire/src/ir.rs:255-269`
- [ ] **WIRE-014** Collecting an answer concatenates text and reasoning, keeps calls, the last Done's stop and usage, the last error; its stop is ToolUse when it ended normally (or not at all) with calls. — `crates/slopmax-wire/src/ir.rs:271-309` (test `answers_collect_and_infer_tool_use`)
- [ ] **WIRE-015** `text_of`: a string, or the `text` of each array part joined by `\n`. — `crates/slopmax-wire/src/ir.rs:311-325`

### Dispatch (`translate.rs`)

- [ ] **WIRE-020** Translatable when client ≠ upstream and upstream is not Messages: nothing is ever translated into Anthropic's format. — `crates/slopmax-wire/src/translate.rs:16-20` (test `nothing_translates_into_messages`)
- [ ] **WIRE-021** Upstream paths: Messages `/v1/messages`, Responses `/responses`, Chat `/chat/completions`. — `crates/slopmax-wire/src/translate.rs:22-29`
- [ ] **WIRE-022** Decoding a client request: invalid JSON → `the request is not valid JSON: {e}`; then per format. — `crates/slopmax-wire/src/translate.rs:31-40`
- [ ] **WIRE-023** Encoding a compaction request appends a user message with the compaction prompt (WIRE-056) and sets tool choice None. — `crates/slopmax-wire/src/translate.rs:42-63` (test `compaction_is_emulated_with_a_summary`)
- [ ] **WIRE-024** Decoder: Chat upstreams get the names of the client's freeform tools; a data line trimmed to `[DONE]` finishes; unparsable data is ignored; a whole unparsable body finishes (a cut-stream error); a whole Responses body is read by WIRE-047; a whole Chat body is one chunk then finish. — `crates/slopmax-wire/src/translate.rs:65-128`
- [ ] **WIRE-025** Encoder per client format; a Responses client asking for compaction gets the compacting encoder; whole answers likewise (`compacted` for compaction). — `crates/slopmax-wire/src/translate.rs:130-182` (tests `claude_code_through_responses_and_back`, `freeform_tools_survive_chat`)

### Messages (Claude Code) as a client

- [ ] **WIRE-030** Decode: `model` required (`the request names no model`); `stream` only when `true`; `max_tokens`, `temperature`, `top_p`; `system` string or text blocks, skipping blank ones and Claude Code's `x-anthropic-billing-header:` line; each message's role is `assistant` or else user; content string or blocks; messages with no usable parts dropped; tools only with `name` and `input_schema` (server tools dropped); `tool_choice` `any` → Required, `none` → None, `tool` → Named, else Auto, and `disable_parallel_tool_use: true` → parallel false; `stop_sequences`; effort from `output_config.effort` when named, else `thinking` `enabled` with `budget_tokens` → by budget, `disabled` → Low. — `crates/slopmax-wire/src/messages/request.rs:10-124` (tests `decodes_a_claude_code_turn`, `named_effort_wins_over_a_budget`)
- [ ] **WIRE-031** Blocks: non-empty `text`; `image` (base64 or url source); `document` (a `text` source becomes plain text, else a file named by `title`); `tool_use` (input as JSON text, `{}` when absent); `tool_result` (string or blocks, `is_error`); thinking and server-tool blocks dropped. — `crates/slopmax-wire/src/messages/request.rs:126-196`
- [ ] **WIRE-032** Stream reply: `message_start` first (`id` `msg_<token>`, the client's model, empty content, `stop_reason`/`stop_sequence` null, usage zeros); text opens a text block (`content_block_start` then `text_delta`s); reasoning and opaque state are never shown (Anthropic rejects unsigned thinking); a call closes any text block and emits a `tool_use` block start with `input: {}`, one `input_json_delta` with the whole input, and its stop; done closes, emits `message_delta` (`stop_reason`, `stop_sequence: null`, usage) and `message_stop`, with End turned into `tool_use` when calls were made; an error emits an `error` event in Messages' error shape. Every frame is named (`event:` line). — `crates/slopmax-wire/src/messages/reply.rs:11-111` (tests `streams_text_then_tool_use`, `failures_become_error_events`)
- [ ] **WIRE-033** Whole reply: text block then `tool_use` blocks (input parsed, `{}` if unparsable). Stop reasons End `end_turn`, ToolUse `tool_use`, Length `max_tokens`, Sequence `stop_sequence`, Filtered `refusal`. Usage `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. Freeform input travels as `{"input": …}`; an empty function input as `{}`. — `crates/slopmax-wire/src/messages/reply.rs:113-157` (test `whole_messages_carry_text_and_calls`)

### Responses (Codex, ChatGPT, OpenAI API)

- [ ] **WIRE-040** Decode: `model` required; `stream`; `max_output_tokens`; `temperature`; `top_p`; `parallel_tool_calls`; `reasoning.effort`; `prompt_cache_key` → cache key; non-blank `instructions` → system; `input` string (one user message) or items; tools of type `function` and `custom` (freeform) only, schema defaulting to `{"type":"object","properties":{}}`; `tool_choice` `none`, `required`, other strings Auto, an object with `name` → Named; `text.format` of type `json_schema` → format. — `crates/slopmax-wire/src/responses/request.rs:13-93` (test `decodes_codex_items_into_turns`)
- [ ] **WIRE-041** Items: `message` (default type) with role `system`/`developer` → system text; else assistant or user parts; `function_call`/`custom_tool_call` → assistant call (`arguments` / `input`); `function_call_output`/`custom_tool_call_output` → user result (string or parts); `compaction_trigger` → compact; `compaction` whose `encrypted_content` slopmax sealed → user text `<PREFIX>\n\n<summary>` (OpenAI's own ignored); `reasoning` → assistant reasoning (summary texts joined `\n\n`, `encrypted_content` as opaque); other items dropped. Calls, results, reasoning join the previous same-role message; text does not join a message that holds calls or results. — `crates/slopmax-wire/src/responses/request.rs:95-208`
- [ ] **WIRE-042** Content parts: non-empty `input_text`/`output_text`/`text`, `refusal`, `input_image` (`image_url`), `input_file` (`file_data`, `filename`). — `crates/slopmax-wire/src/responses/request.rs:210-235`
- [ ] **WIRE-043** Encode, keys in order: `model`, `instructions` (system joined by `\n\n`, possibly empty), `input`, then when tools exist `tools`, `tool_choice`, `parallel_tool_calls` (default true), then `reasoning` `{"effort","summary":"auto"}` (Max → `xhigh`), `store: false`, `stream: true` (always), `include: ["reasoning.encrypted_content"]`, `prompt_cache_key`, `text.format`, `max_output_tokens`. Temperature, top_p, and stop are not sent. — `crates/slopmax-wire/src/responses/request.rs:237-283` (test `encodes_turns_as_items`)
- [ ] **WIRE-044** Input items: text as `input_text` (user) / `output_text` (assistant), images `input_image`, files `input_file` (filename default `document.pdf`); a call flushes pending content and becomes `function_call` (`arguments`) or `custom_tool_call` (`input`); a result becomes `function_call_output` or `custom_tool_call_output` by its call's kind, output = joined text with `Error: ` prefix when an error with text; images a tool returned follow as a user message; reasoning only when it has opaque state, as `{"type":"reasoning","summary":[summary_text?],"encrypted_content"}` (foreign reasoning is never replayed). — `crates/slopmax-wire/src/responses/request.rs:285-372` (test `foreign_reasoning_is_not_replayed`)
- [ ] **WIRE-045** Tools are all `{"type":"function","name","description","parameters","strict":false}`, freeform ones with the schema `{"type":"object","properties":{"input":{"type":"string","description":"The tool's raw input."}},"required":["input"]}`; tool choice `auto`/`none`/`required`/`{"type":"function","name"}`. — `crates/slopmax-wire/src/responses/request.rs:374-403`
- [ ] **WIRE-046** Upstream events: `response.output_text.delta` → text (marks the item as streamed); `response.reasoning_summary_part.added` → `\n\n` before every part but the first; `response.reasoning_summary_text.delta` → reasoning; `response.output_item.done` → function/custom calls, reasoning state (`encrypted_content`), or the whole text of a message item that did not stream; `response.completed|incomplete|done` → done; `response.failed`/`error` → error; a stream ending without either → error 502 `the upstream stream ended before the response completed`. — `crates/slopmax-wire/src/responses/events.rs:10-114` (tests `reads_text_reasoning_state_and_calls`, `failures_and_cut_streams_are_errors`)
- [ ] **WIRE-047** A whole response: a non-null `error` → that error only; else its output items, then done. — `crates/slopmax-wire/src/responses/events.rs:116-133` (test `whole_responses_and_length_stops`)
- [ ] **WIRE-048** Done's stop: `incomplete_details.reason` `max_output_tokens` → Length, `content_filter` → Filtered, else End; usage per WIRE-007 with one request. — `crates/slopmax-wire/src/responses/events.rs:144-170`
- [ ] **WIRE-049** Failure status by code (or type): `rate_limit_exceeded`, `usage_limit_reached`, `usage_limit_exceeded` → 429; `server_is_overloaded`, `slow_down` → 529; `context_length_exceeded`, `invalid_request_error`, `invalid_prompt` → 400; else 500; message, or `the upstream response failed`. — `crates/slopmax-wire/src/responses/events.rs:172-198`
- [ ] **WIRE-050** Stream reply: `response.created` and `response.in_progress` first (response `{"id":"resp_<token>","object":"response","created_at","status","model","output"}`); every frame is named and its data gets `type` and an increasing `sequence_number` from 0 appended after the payload's own keys; text opens a message item (`output_item.added`, `content_part.added`) and streams `output_text.delta`; reasoning opens a `rs_` item and streams `reasoning_summary_text.delta`; switching kinds closes the open item (`…text.done`, `…part.done`, `output_item.done`); calls emit added (status `in_progress`), one delta, done, and item done (status `completed`); done closes and emits `response.completed` with usage, or `response.incomplete` with `incomplete_details.reason: max_output_tokens` for Length; errors emit `response.failed` with `error`. — `crates/slopmax-wire/src/responses/reply.rs:12-284` (tests `streams_items_codex_can_rebuild`, `failures_fail_the_response`)
- [ ] **WIRE-051** Ids: `resp_`, `msg_`, `rs_`, `fc_`, `ctc_`, `cmp_` (Responses), `msg_` (Messages), `chatcmpl-` (Chat), `call_` (Chat calls without an id), each followed by a 43-character token (COM-010). — `crates/slopmax-wire/src/responses/reply.rs:37`, `:152`, `:174`, `:236`, `:243`, `:288`, `crates/slopmax-wire/src/messages/reply.rs:28`, `crates/slopmax-wire/src/chat/reply.rs:27`, `crates/slopmax-wire/src/chat/events.rs:133-137`
- [ ] **WIRE-052** Compacting reply: text is gathered; on done one `compaction` item (`{"id":"cmp_…","type":"compaction","encrypted_content":<sealed summary>}`) is added and done, then `response.completed`; reasoning, state, and calls are dropped; an error still fails the response. The whole form is a completed response holding that one item. — `crates/slopmax-wire/src/responses/reply.rs:48-54`, `:76-96`, `:286-299`
- [ ] **WIRE-053** Whole reply: the answer run through the stream encoder (reasoning, text, calls), completed, with usage; Length → `incomplete`. — `crates/slopmax-wire/src/responses/reply.rs:301-324` (test `whole_responses`)
- [ ] **WIRE-054** Responses usage JSON: `input_tokens` = input + cache read + cache write, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens: 0`, `total_tokens`. Errors: 429 `rate_limit_exceeded`, 503/529 `server_is_overloaded`, 400 `invalid_request_error`, else `server_error`, as `{"code","message"}`. — `crates/slopmax-wire/src/responses/reply.rs:326-345`
- [ ] **WIRE-056** Compaction seal: `slopmax1:` + standard base64 (padded) of the summary; opening anything else yields nothing. Prompt text: `Summarize this conversation so that another assistant can continue the task without it. Include the goal and the user's instructions, what has been done (files read or changed, commands run, and what they showed), decisions made, and what remains to do. Write only the summary.` Prefix text: `The conversation so far was compacted into this summary. Continue the task from it:` (single spaces; the Rust line continuations collapse indentation). — `crates/slopmax-wire/src/responses/compaction.rs:13-35` (test `seals_round_trip_and_ignore_openais`)

### Chat Completions

- [ ] **WIRE-060** Decode: `model` required; `stream`; `max_completion_tokens` else `max_tokens`; `temperature`, `top_p`, `parallel_tool_calls`, `reasoning_effort`, `prompt_cache_key`; `stop` string or list; `system`/`developer` messages → system; `assistant` content plus `tool_calls` (arguments default `{}`); consecutive `tool` messages join one user turn of results; other roles → user; content parts `text`, `image_url`, `file` (`file_data`, `filename`); an empty string content adds nothing; tools with a `function`; `tool_choice` strings or `{function:{name}}`; `response_format.json_schema` → format. — `crates/slopmax-wire/src/chat/request.rs:12-181` (tests `decodes_and_encodes_a_tool_loop`, `freeform_calls_travel_as_functions`)
- [ ] **WIRE-061** Encode, keys in order: `model`, `messages`, `stream: true`, `stream_options: {"include_usage": true}`, then with tools `tools` (`{"type":"function","function":{name, description, parameters}}`, freeform → WIRE-045 schema), `tool_choice`, `parallel_tool_calls` (only when set); `max_tokens`, `temperature`, `top_p`, `stop` (when non-empty), `response_format` `{"type":"json_schema","json_schema":{name, schema, strict}}`. Effort and the cache key are not sent. — `crates/slopmax-wire/src/chat/request.rs:183-237`
- [ ] **WIRE-062** Messages: one `system` message (joined by `\n\n`) first; assistant text parts joined by `\n\n` (null content when empty) with `tool_calls` (freeform arguments as `{"input": …}`), skipped when empty; a user turn emits each result as `{"role":"tool","tool_call_id","content"}` (`Error: ` prefix for errors with text), then one user message with result images first and its own parts after; a lone text part is sent as a plain string. — `crates/slopmax-wire/src/chat/request.rs:239-326`
- [ ] **WIRE-063** Upstream chunks: a non-null `error` → error (status = numeric `code` within 400–599, else 500; message or `the upstream answer failed`); an object `usage` is kept; the first choice's `delta` (or `message`): `reasoning_content` and `reasoning` → reasoning, `content` → text, `tool_calls` gathered by `index` (or position): id set, name and arguments appended; `finish_reason` kept. At `[DONE]` or the end: calls in index order (freeform ones unwrapped from `{"input"}` when the client declared them freeform; missing ids become `call_<token>`), then done with `length` → Length, `tool_calls`/`function_call` → ToolUse, `content_filter` → Filtered, else End, and the usage (or one request); no finish reason → error 502 `the upstream stream ended before the answer finished`. — `crates/slopmax-wire/src/chat/events.rs:15-196` (tests `gathers_interleaved_tool_calls`, `reasoning_and_whole_completions`, `errors_and_cut_streams`)
- [ ] **WIRE-064** Stream reply (unnamed frames): first chunk `{"role":"assistant","content":""}`; text → `content`; reasoning → `reasoning_content`; each call → `tool_calls: [{"id","type":"function","function":{name, arguments},"index":n}]`; done → a chunk with empty delta and `finish_reason` (End with calls → `tool_calls`), then a usage chunk (`choices: []`) only when the client asked for `stream_options.include_usage`, then `data: [DONE]`; an error → `{"error":{"message","type":<kind>,"code":<status>}}` then `data: [DONE]`. Chunks carry `id`, `object: "chat.completion.chunk"`, `created`, `model`. — `crates/slopmax-wire/src/chat/reply.rs:12-82` (tests `streams_chunks_then_usage_and_done`, `usage_chunks_only_when_asked`)
- [ ] **WIRE-065** Whole reply `chat.completion` with message content (null when empty), `reasoning_content` and `tool_calls` when present, finish reason (`stop` for End and Sequence, `tool_calls`, `length`, `content_filter`), usage `{"prompt_tokens" (input + cache read + cache write),"completion_tokens","total_tokens","prompt_tokens_details":{"cached_tokens"}}`. — `crates/slopmax-wire/src/chat/reply.rs:84-133` (test `whole_completions`)

## 14. HTTP plumbing (`crates/slopmax-net`)

- [ ] **NET-001** Client: HTTP/1.1 only, pooled keep-alive connections (idle 60 s), TCP keepalive 60 s, `TCP_NODELAY`, connect timeout 10 s unless set. Responses are never decompressed: bodies and `content-encoding` pass through as the upstream sent them. — `crates/slopmax-net/src/client.rs:382-445`
- [ ] **NET-002** Error text: `invalid request`, `request failed`, `timed out`, `HTTP {status}`, `reading the response failed`, `unexpected response`, each followed by `: {root cause}` when there is one. — `crates/slopmax-net/src/client.rs:35-100`
- [ ] **NET-003** Proxy URLs: `http://` (CONNECT tunnel), `socks5://` (local DNS), `socks5h://` (DNS at the proxy), scheme case-insensitive; `user:pass@` percent-decoded; default port 80 (http) or 1080 (socks); a trailing `/` ignored; no scheme → `proxy "{text}" needs a scheme, like http:// or socks5://`; other schemes → `unsupported proxy scheme "{s}"`. Shown without credentials. — `crates/slopmax-net/src/client.rs:102-185` (test `parses_proxy_urls`)
- [ ] **NET-004** Which proxy: the builder's, else the config's `proxy` (set once at load), else the first non-empty of `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`, `all_proxy` (an unparsable value means none). `HTTP_PROXY` is not read. — `crates/slopmax-net/src/client.rs:156-172`, `:391-394`, `crates/slopmax-core/src/config.rs:417-418`
- [ ] **NET-005** Proxy bypass: loopback (`localhost`, any loopback IP, brackets stripped) and `NO_PROXY` (else `no_proxy`) entries, comma-separated, leading dots dropped, case-insensitive: `*`, an exact host, or a parent domain. — `crates/slopmax-net/src/client.rs:187-223`, `:250-266` (test `loopback_and_listed_hosts_bypass_the_proxy`)
- [ ] **NET-006** CONNECT proxies get `Proxy-Authorization: Basic base64(user:pass)`; SOCKS5 proxies user/password auth. — `crates/slopmax-net/src/client.rs:396-414`
- [ ] **NET-007** TLS: rustls with the system's trusted roots, loaded once; none found → every `https` request fails `request failed: no system CA certificates found; HTTPS is unavailable`; plain-HTTP clients (for the local proxy) skip loading roots and fail `https` with `this client makes plain HTTP requests only`. — `crates/slopmax-net/src/client.rs:269-291`, `:369-374`, `:420-424`, `:558-562` (test `plain_clients_refuse_https`)
- [ ] **NET-008** Origins rewrite a URL whose prefix matches, followed by end, `/`, or `?` (tests point providers at a mock). — `crates/slopmax-net/src/client.rs:293-314`, `:460-462` (test `origins_rewrite_matching_prefixes`)
- [ ] **NET-009** Request building: `header` replaces; `headers` replaces each same-named header but keeps every value given; an invalid header or JSON fails at send; `json` and `form` set the content type; the client's user agent applies only when the request has none. — `crates/slopmax-net/src/client.rs:488-572`
- [ ] **NET-010** Timeouts: a total timeout covers headers and body; the read timeout bounds the wait for headers (whichever is sooner) and every gap between body chunks (stall error `no data for {duration}`); `bytes()` reads at most 64 MiB. — `crates/slopmax-net/src/client.rs:32-33`, `:574-666`, `crates/slopmax-net/src/body.rs:102-159`
- [ ] **NET-011** A 101 response hands over its connection (`upgrade`). — `crates/slopmax-net/src/client.rs:650-657`
- [ ] **NET-012** Bodies: reading with a limit fails past it (a distinct "length limit" error, which the proxy turns into 413); `read_all` fails `body exceeds {limit} bytes`; a prefixed body yields held chunks, then the rest. — `crates/slopmax-net/src/body.rs:37-100` (tests `reads_within_the_limit`, `stalled_bodies_fail`)
- [ ] **NET-020** Form encoding (WHATWG): `A–Z a–z 0–9 * - . _` pass, space → `+`, every other byte `%XX` uppercase. Decoding: split on `&`, empty pairs skipped, a pair without `=` has an empty value, `+` → space, malformed `%` escapes kept as written, invalid UTF-8 replaced; `percent_decode` leaves `+` alone. — `crates/slopmax-net/src/form.rs:1-84` (tests `encodes_like_the_whatwg_serializer`, `decodes_pairs_and_tolerates_malformed_escapes`)
- [ ] **NET-030** Server: HTTP/1.1, keep-alive, upgrades allowed, `TCP_NODELAY` per connection, 30 s to send request headers; a failed accept warns `accepting a connection failed: {e}` and retries after 100 ms; on shutdown stops accepting, closes connections gracefully, and waits up to 10 s for in-flight requests. — `crates/slopmax-net/src/server.rs:21-78` (test `serves_until_shutdown`)
- [ ] **NET-031** Port holder: Linux reads `/proc/net/tcp` and `/tcp6` for a LISTEN socket on the port and finds the process whose fd links to `socket:[inode]` → `{comm} (pid N)`, or `another user's program` when none is visible; macOS runs `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` → `{name} (pid N)` (`a program` when unnamed); other systems → unknown. — `crates/slopmax-net/src/server.rs:114-185` (test `names_the_program_holding_a_port`)
- [ ] **NET-040** WebSocket accept key = base64(SHA-1(key trimmed + `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)); a new key = base64 of 16 random bytes. — `crates/slopmax-net/src/ws.rs:12-27` (test `accept_key_matches_the_rfc`)
- [ ] **NET-041** Reading: fragments joined; masked and unmasked frames both accepted; close payload ≥2 bytes → (code, reason as lossy UTF-8), shorter → bare close; errors for reserved bits, unknown opcodes, control frames over 125 bytes or fragmented, a data frame inside a fragmented message, a continuation without a start, messages over 64 MiB, non-UTF-8 text; a clean EOF between frames ends the stream. — `crates/slopmax-net/src/ws.rs:14-15`, `:57-164` (tests `reads_the_rfcs_frames`, `rejects_broken_frames`)
- [ ] **NET-042** Writing: each message one final frame; 7-, 16-, or 64-bit lengths; a client masks with a random key per frame, a server never masks; close reasons cut to 123 bytes; flushed after every frame. — `crates/slopmax-net/src/ws.rs:166-230` (test `round_trips_every_size_masked_or_not`)

## 15. Shared basics (`crates/slopmax-common`)

- [ ] **COM-001** Timestamps are UTC instants with nanosecond precision (i64, years 1678–2261); adding and subtracting saturate; `duration_since` may be negative. — `crates/slopmax-common/src/time.rs:56-100`, `:214-228` (test `arithmetic_saturates_and_measures`)
- [ ] **COM-002** Display: RFC 3339 UTC with `Z` and only the fractional digits needed (`…:09Z`, `…:09.25Z`, `1969-12-31T23:59:59.999Z`); this is also the JSON form. — `crates/slopmax-common/src/time.rs:230-246`, `:328-339` (tests `displays_minimal_rfc3339`, `round_trips_through_text_and_serde`)
- [ ] **COM-003** Log time: exactly three fractional digits, `2026-10-04T07:20:00.250Z`. — `crates/slopmax-common/src/time.rs:130-151`
- [ ] **COM-004** Parsing RFC 3339: surrounding whitespace trimmed; date-time separator `T`, `t`, or space; any number (≥1) of fractional digits, digits past nine ignored; offset `Z`, `z`, `±HH:MM`, or `±HHMM` (hours ≤ 23, minutes ≤ 59); second 60 read as 59; out-of-range fields rejected. Old nanosecond values (`.855123456Z`) read back. — `crates/slopmax-common/src/time.rs:248-326` (tests `parses_rfc3339_with_offsets_and_fractions`, `rejects_malformed_timestamps`)
- [ ] **COM-005** HTTP dates: IMF-fixdate with `GMT` only (`Sun, 06 Nov 1994 08:49:37 GMT`); anything else (other zones, delta seconds) is none. — `crates/slopmax-common/src/time.rs:102-128` (test `parses_http_dates`)
- [ ] **COM-006** Calendar: date and time of day at an offset, midnight of a date at an offset, proleptic Gregorian via Hinnant's day algorithms. — `crates/slopmax-common/src/time.rs:153-177`, `:345-419` (tests `civil_conversion_matches_known_days`, `dates_shift_by_offset`)
- [ ] **COM-007** Local offset: on Unix the zone offset at that instant (DST included, via `localtime_r`); on Windows and wherever it cannot be read, zero (UTC). Every "local" day, hour, and midnight in summaries, history, and notifications uses it. — `crates/slopmax-common/src/time.rs:179-195`
- [ ] **COM-008** Durations: seconds, minutes, hours, millis, fractional seconds; `as_secs` truncates toward zero. — `crates/slopmax-common/src/time.rs:14-54`
- [ ] **COM-010** Ids: OS random bytes; SHA-256; `token` = 32 random bytes base64url without padding (43 chars); `hex64` = 32 bytes lowercase hex; `uuid_v4` RFC 4122 v4. — `crates/slopmax-common/src/ids.rs:8-53` (test `shapes`)
- [ ] **COM-011** Logging to stderr as `{time} {LABEL} {message}`; labels `ERROR`, `WARN `, `INFO `, `DEBUG` (five wide); colored (31/33/32/2) only when stderr is a terminal and `NO_COLOR` is unset; level from `SLOPMAX_LOG`: `off|none`, `error`, `warn|warning`, `info`, `debug|trace`, case- and space-insensitive, or a filter `slopmax=info,other=warn` where the last directive for `slopmax` or without a target wins; unreadable → the caller's default (warn when never set). — `crates/slopmax-common/src/log.rs:1-94` (tests `reads_plain_levels_and_target_filters`, `levels_order_by_verbosity`, `labels_line_up_and_colors_tell_levels_apart`, `the_default_level_writes_warnings_and_errors_only`, `levels_read_case_and_space_insensitively`)
- [ ] **COM-012** Durations for people, two units: `42s`, `9m30s`, `2h05m`, `3d4h`; negative → `0s`; `until` → `now` once passed. Counts: `999`, `12.3k`, `1.2M`, `5.0B` (one decimal, Rust rounding). — `crates/slopmax-common/src/human.rs:6-41` (tests `durations_use_two_units`, `until_reports_now_when_passed`, `counts_keep_three_figures`)

- [ ] **COM-021** A string that is not RFC 3339 fails with the error text `invalid RFC 3339 timestamp` (this is what a malformed `state.json`, ledger line, or account file timestamp reports inside its context, e.g. DMN-002's start failure). The id helpers panic with `operating system RNG is unavailable` only when the OS has no randomness source. — `crates/slopmax-common/src/time.rs:248-256`, `crates/slopmax-common/src/ids.rs:13`

## 16. Environment variables and files touched by this area

- [ ] **COM-020** (cross-ref) `SLOPMAX_LOG`, `NO_COLOR` (COM-011); `HTTPS_PROXY`/`https_proxy`/`ALL_PROXY`/`all_proxy`, `NO_PROXY`/`no_proxy` (NET-004, NET-005); `SLOPMAX_EVENT`, `SLOPMAX_PROVIDER`, `SLOPMAX_ACCOUNT`, `SLOPMAX_UNTIL`, `SLOPMAX_MESSAGE` set for notify commands (NOTE-006). `SLOPMAX_HOME` and `SLOPMAX_LISTEN` belong to the paths/config inventory but decide where every file below lives and where the daemon binds.
- [ ] **DMN-020** (cross-ref) Files: `config.toml` (read every 2 s; written by `POST settings`, `POST keys`, `keys/…/remove`), `state.json` (read at start, written every 10 s when changed and at stop), `pins.json`, `accounts/`, `usage/YYYY-MM.jsonl`, `windows.jsonl`, `nudged.json` — all under the slopmax home, directories 0700 and files 0600 on Unix.

## 17. Rust tests to mirror

Every test below is ported with its Rust name as the test title (see `ts/docs/CONVENTIONS.md`). Grouped by Rust file; `name (line)`. 169 tests in this area, plus the two CLI tests cited above that exercise it (`usage_totals_the_ledger`, `notify_sends_a_test_event_through_the_command`, owned by the CLI inventory). `daemon.rs` has no unit tests: its tasks are covered through `tests/proxy.rs` and `tests/failover.rs`, and the port should add tests for DMN-003 (schedule shape) and DMN-016 (listing cadence) with `TestClock`.

### `crates/slopmax-common/src/human.rs`

- `durations_use_two_units` (48)
- `until_reports_now_when_passed` (58)
- `counts_keep_three_figures` (65)

### `crates/slopmax-common/src/ids.rs`

- `shapes` (60)

### `crates/slopmax-common/src/log.rs`

- `reads_plain_levels_and_target_filters` (133)
- `levels_order_by_verbosity` (146)
- `labels_line_up_and_colors_tell_levels_apart` (151)
- `the_default_level_writes_warnings_and_errors_only` (161)
- `levels_read_case_and_space_insensitively` (177)

### `crates/slopmax-common/src/time.rs`

- `parses_rfc3339_with_offsets_and_fractions` (431)
- `rejects_malformed_timestamps` (454)
- `displays_minimal_rfc3339` (476)
- `round_trips_through_text_and_serde` (492)
- `civil_conversion_matches_known_days` (509)
- `dates_shift_by_offset` (523)
- `parses_http_dates` (533)
- `arithmetic_saturates_and_measures` (546)

### `crates/slopmax-core/src/history.rs`

- `days_fill_their_buckets_by_provider` (484)
- `failover_failures_and_housekeeping_count_apart` (516)
- `api_keys_bill_what_subscriptions_only_value` (564)
- `caching_speed_sessions_and_agents` (585)
- `an_hour_of_warmups_alone_has_no_cache_rate` (629)
- `today_counts_hours_up_to_now` (656)
- `work_falls_on_the_local_weekday_and_hour` (676)
- `first_bytes_read_as_median_and_slowest_twentieth` (687)

### `crates/slopmax-core/src/ledger.rs`

- `writes_monthly_files_and_reads_them_back` (193)

### `crates/slopmax-core/src/notify.rs`

- `reports_each_change_once` (520)
- `disabled_accounts_are_ignored` (573)
- `settings_filter_events` (602)
- `commands_get_the_event_in_variables` (616)
- `nudges_name_lapsing_resets_and_spare_weeks_once_each` (643)

### `crates/slopmax-core/src/pricing.rs`

- `matches_a_model_or_its_dated_snapshots` (183)
- `shares_follow_plan_sizes_only_when_every_one_is_known` (197)
- `plans_are_priced_by_provider_and_can_be_set` (206)
- `openai_prices_charge_nothing_extra_to_cache` (221)
- `custom_prices_win_and_fill_in_cache_rates` (231)
- `costs_every_kind_of_token` (262)

### `crates/slopmax-core/src/proxy/forward.rs`

- `upstream_errors_are_retold_with_their_message` (1100)
- `a_failure_event_inside_a_stream_is_found` (1123)
- `unreadable_errors_pass_their_first_500_bytes` (1134)
- `claude_code_hears_server_errors_as_overloaded` (1146)
- `the_earliest_return_wins_across_steps` (1160)

### `crates/slopmax-core/src/proxy/hub.rs`

- `readings_take_the_providers_shapes` (400)

### `crates/slopmax-core/src/proxy/mod.rs`

- `routes_prefixed_and_v1_paths` (540)
- `client_keys_reach_the_proxy_but_not_the_admin_api` (623)
- `auth_accepts_bearer_or_api_key` (647)
- `forwardable_drops_only_credentials_and_hop_by_hop` (664)

### `crates/slopmax-core/src/proxy/models.rs`

- `claude_code_and_codex_keep_their_own_lists` (109)

### `crates/slopmax-core/src/proxy/rawjson.rs`

- `finds_nested_values` (168)
- `strings_end_only_at_unescaped_quotes` (190)
- `splice_replaces_in_place` (201)

### `crates/slopmax-core/src/proxy/socket.rs`

- `the_routing_hint_names_the_model` (560)
- `spent_accounts_close_the_socket_and_request_errors_pass` (571)
- `moved_sockets_drop_old_account_state` (592)

### `crates/slopmax-core/src/proxy/sse.rs`

- `claude_usage_merges_start_and_delta` (238)
- `codex_usage_separates_cached_input` (268)
- `whole_json_responses_report_usage` (284)
- `codex_in_stream_usage_limit_is_exhaustion` (319)
- `tapped_stream_reports_once_even_when_dropped` (326)

### `crates/slopmax-core/src/proxy/start.rs`

- `content_streams_with_the_held_start_replayed` (90)
- `a_spent_quota_is_caught_before_the_agent_sees_it` (99)
- `request_failures_go_to_the_agent` (111)

### `crates/slopmax-core/src/proxy/transcode.rs`

- `chat_chunks_split_anywhere_become_messages_events` (225)
- `replay_is_per_account_and_bounded` (252)

### `crates/slopmax-core/src/summary.rs`

- `unpriced_requests_are_counted_apart` (185)
- `requests_are_the_answers_alone` (200)
- `ranges_start_at_local_midnight` (216)

### `crates/slopmax-core/src/waste.rs`

- `the_unused_part_of_a_week_costs_its_share_of_the_fee` (225)
- `records_are_kept_and_read_back_once_each` (278)
- `left_totals_long_windows_by_account` (294)

### `crates/slopmax-core/tests/failover.rs`

- `a_rejected_token_is_refreshed_and_the_request_retried` (292)
- `a_refused_refresh_moves_on_to_the_next_account` (329)
- `without_refreshing_a_rejected_token_benches_the_account` (387)
- `a_throttled_account_is_set_aside_briefly_not_blocked` (405)
- `only_throttled_accounts_pass_the_refusal_back` (425)
- `an_unreachable_endpoint_fails_over_and_records_why` (448)
- `codex_streams_that_open_overloaded_move_on_without_benching` (481)
- `requests_without_a_model_are_turned_away` (508)
- `claude_paths_refuse_other_clients_before_routing` (521)

### `crates/slopmax-core/tests/proxy.rs`

- `claude_fails_over_and_forwards_the_request_unchanged` (605)
- `every_account_spent_returns_the_agents_own_limit_error` (687)
- `codex_fails_over_with_workspace_and_version_headers` (730)
- `codex_exhaustion_uses_usage_limit_shape` (769)
- `rejects_requests_without_the_slopmax_key` (785)
- `revoked_tokens_move_to_the_next_account` (820)
- `spent_codex_pool_redeems_a_credit_when_allowed` (831)
- `spent_codex_pool_keeps_its_credits_by_default` (861)
- `credits_about_to_expire_are_redeemed_on_used_accounts` (871)
- `claude_limit_resets_are_listed_and_spent_as_claude_code` (911)
- `credits_are_listed_kept_and_redeemed_soonest_first` (1000)
- `websockets_off_or_for_other_models_send_codex_to_http` (1051)
- `codex_websockets_are_relayed_to_chatgpt` (1126)
- `spent_accounts_close_the_socket_so_codex_reconnects_elsewhere` (1180)
- `fast_mode_refusals_reach_claude_code_without_benching_accounts` (1226)
- `codex_streams_that_open_spent_move_to_the_next_account` (1244)
- `claude_accounts_serve_claude_code_only` (1268)
- `chat_clients_reach_keys_and_endpoints_by_model` (1328)
- `keys_serve_subscription_models_only_as_paid_overflow` (1395)
- `claude_code_may_use_other_vendors_messages_endpoints` (1431)
- `claude_code_runs_gpt_models_on_chatgpt_accounts` (1459)
- `translated_failures_reach_the_client_in_its_format` (1552)
- `openai_clients_list_every_model_they_can_use` (1585)
- `the_dashboard_api_reports_acts_and_streams` (1645)
- `client_keys_are_held_to_their_models` (1815)
- `idle_chatgpt_windows_are_warmed_once` (1914)
- `agents_see_the_pool_not_the_serving_account` (1970)
- `codex_sockets_report_the_pool_too` (1998)
- `hub_clients_read_usage_and_redeem_credits_without_a_relay` (2058)
- `sessions_keep_their_account_so_the_prompt_cache_stays_warm` (2279)
- `affinity_can_be_turned_off_for_the_proxy_or_one_request` (2317)
- `moving_without_affinity_still_drops_another_accounts_state` (2368)
- `passing_server_errors_are_retried_once_on_the_same_account` (2386)
- `settings_change_through_the_api_and_apply_at_once` (2438)
- `a_changed_config_file_applies_without_a_restart` (2511)
- `the_history_api_charts_what_went_through` (2533)
- `history_says_what_resets_left_on_the_table` (2562)
- `the_api_does_what_the_cli_does_for_keys_endpoints_and_the_doctor` (2592)

### `crates/slopmax-net/src/body.rs`

- `reads_within_the_limit` (166)
- `stalled_bodies_fail` (187)

### `crates/slopmax-net/src/client.rs`

- `plain_clients_refuse_https` (674)
- `parses_proxy_urls` (683)
- `origins_rewrite_matching_prefixes` (696)
- `loopback_and_listed_hosts_bypass_the_proxy` (709)

### `crates/slopmax-net/src/form.rs`

- `encodes_like_the_whatwg_serializer` (91)
- `decodes_pairs_and_tolerates_malformed_escapes` (104)

### `crates/slopmax-net/src/server.rs`

- `serves_until_shutdown` (87)
- `names_the_program_holding_a_port` (194)

### `crates/slopmax-net/src/ws.rs`

- `accept_key_matches_the_rfc` (238)
- `reads_the_rfcs_frames` (247)
- `round_trips_every_size_masked_or_not` (270)
- `rejects_broken_frames` (294)

### `crates/slopmax-wire/src/chat/events.rs`

- `gathers_interleaved_tool_calls` (208)
- `reasoning_and_whole_completions` (262)
- `errors_and_cut_streams` (279)

### `crates/slopmax-wire/src/chat/mod.rs`

- `usage_comes_from_the_final_chunk` (40)

### `crates/slopmax-wire/src/chat/reply.rs`

- `streams_chunks_then_usage_and_done` (149)
- `usage_chunks_only_when_asked` (190)
- `whole_completions` (204)

### `crates/slopmax-wire/src/chat/request.rs`

- `decodes_and_encodes_a_tool_loop` (341)
- `freeform_calls_travel_as_functions` (392)

### `crates/slopmax-wire/src/ir.rs`

- `data_urls_round_trip` (332)
- `answers_collect_and_infer_tool_use` (342)
- `budgets_map_to_efforts` (364)

### `crates/slopmax-wire/src/lib.rs`

- `each_format_names_its_errors_its_own_way` (161)
- `spent_pools_answer_with_each_clients_own_limit_error` (174)
- `only_codex_streams_are_held_until_they_open` (188)
- `usage_is_read_from_each_formats_events` (203)
- `formats_have_stable_names` (232)
- `usage_adds_up_and_totals_every_kind_of_token` (239)
- `frames_are_server_sent_events` (255)

### `crates/slopmax-wire/src/messages/reply.rs`

- `streams_text_then_tool_use` (179)
- `failures_become_error_events` (230)
- `whole_messages_carry_text_and_calls` (248)

### `crates/slopmax-wire/src/messages/request.rs`

- `decodes_a_claude_code_turn` (204)
- `named_effort_wins_over_a_budget` (266)

### `crates/slopmax-wire/src/responses/compaction.rs`

- `seals_round_trip_and_ignore_openais` (42)

### `crates/slopmax-wire/src/responses/events.rs`

- `reads_text_reasoning_state_and_calls` (216)
- `failures_and_cut_streams_are_errors` (258)
- `whole_responses_and_length_stops` (274)

### `crates/slopmax-wire/src/responses/reply.rs`

- `streams_items_codex_can_rebuild` (364)
- `failures_fail_the_response` (413)
- `whole_responses` (429)

### `crates/slopmax-wire/src/responses/request.rs`

- `decodes_codex_items_into_turns` (447)
- `encodes_turns_as_items` (478)
- `foreign_reasoning_is_not_replayed` (520)

### `crates/slopmax-wire/src/translate.rs`

- `claude_code_through_responses_and_back` (192)
- `freeform_tools_survive_chat` (233)
- `nothing_translates_into_messages` (261)
- `compaction_is_emulated_with_a_summary` (273)

### Integration harness contract (`crates/slopmax-core/tests/proxy.rs`, `tests/failover.rs`)

The 47 end-to-end tests above only port unchanged if the harness they stand
on behaves the same. Prefix `HAR`.

- [ ] **HAR-001** Mock provider: one HTTP/1.1 server per test on `127.0.0.1:0`; it records every request (path with query, headers, body) and answers by method, path, and bearer token; a request for `/` is answered 404 and not recorded (other programs probe open ports); a request carrying `upgrade` goes to the WebSocket mock, recorded as `ws {uri}` and then one `ws message` entry per text frame received. — `crates/slopmax-core/tests/proxy.rs:80-99`, `:170-231`; `crates/slopmax-core/tests/failover.rs:70-88`
- [ ] **HAR-002** The proxy runs in-process: `App::new(config, Home::at(tempdir), empty pool state, origins)`, `pool.sync(store.list(), no pins)`, and `proxy::handle` served on a second `127.0.0.1:0` server; no daemon loop runs, so tests call `poll_all`/`list_credits`/`redeem_expiring` and `pool.observe` directly. Config: `api_key = "sm-test-key"`, `strategy = fill-first`, `refresh_tokens = false` (proxy.rs; failover.rs sets it per test), the rest default, with a per-test `configure` hook. Temp homes `slopmax-it-{pid}-{token}` / `slopmax-failover-{token}` under the OS temp dir, deleted when the harness drops. — `crates/slopmax-core/tests/proxy.rs:422-537`; `crates/slopmax-core/tests/failover.rs:149-254`
- [ ] **HAR-003** Origin rewriting (FS-019, NET client `Origins`): proxy.rs maps `https://api.anthropic.com` → mock, `https://chatgpt.com/backend-api` → mock, `https://api.x.ai` → `{mock}/xai`, `https://api.openai.com` → `{mock}/openai`; failover.rs maps `https://api.anthropic.com`, `https://platform.claude.com`, and `https://chatgpt.com` → mock. Every outbound call (inference, OAuth token, profile, usage, credits, model lists) must go through this rewrite, or the tests reach the real providers. — `crates/slopmax-core/tests/proxy.rs:512-521`; `crates/slopmax-core/tests/failover.rs:235-239`
- [ ] **HAR-004** Accounts: `Account::new(provider, {access_token: <token>, refresh_token: "refresh-{name}", expires_at: now + 8 h})`, email `{name}@example.com`, `org_id` `org-{name}` (proxy.rs only), `account_id` `acct-{name}`, `added_at` = epoch second `1000 + i` so fill-first tries them in the order given, name `{provider}{i}`; ids assigned, then upserted. Compatible endpoints (failover.rs): token `key-local`, Chat dialect, models `["local-model"]`. — `crates/slopmax-core/tests/proxy.rs:440-481`; `crates/slopmax-core/tests/failover.rs:180-213`
- [ ] **HAR-005** Claude mock `POST /v1/messages` by bearer: `tok-ok` → 200 SSE (`message_start` usage input 10, cache read 90, output 1; `message_delta` output 25) with `anthropic-ratelimit-unified-5h-utilization: 0.25` and `-5h-reset: now+7200`; `tok-limited` → 429 with unified `status: rejected`, `5h-status: rejected`, `5h-reset: now+3600`, `5h-utilization: 1.0`, body `rate_limit_error`; `tok-fast` → 429 with unified `status: allowed` and message `Usage credits are required for fast mode.`; anything else → 401 `authentication_error`. — `crates/slopmax-core/tests/proxy.rs:253-306`
- [ ] **HAR-006** Codex mock `POST /codex/responses` by bearer: `tok-talk` streams reasoning (`encrypted_content: "enc-1"`), text `Hello`, a `Bash` function call `call_1`, and completion (30 in, 10 cached, 5 out); `tok-quiet` streams `response.created` then `response.failed` `usage_limit_reached` inside a 200; `tok-limited`, and `tok-credit` until any `/consume` has been seen, → 429 `{"error":{"type":"usage_limit_reached","message":"limit","resets_at":now+5400}}`; `tok-flaky` → 503 `upstream connect error` on each odd-numbered request carrying it (the current one counted), else success; `tok-down` → 502; `tok-ok`/`tok-credit`/`tok-flaky` success → 200 SSE completion (100 in, 60 cached, 7 out) with `x-codex-primary-used-percent: 40`, `-window-minutes: 10080`, `-reset-at: now+86400`; else 401. — `crates/slopmax-core/tests/proxy.rs:308-374`
- [ ] **HAR-007** Other proxy.rs mock routes: `GET /wham/usage` (only `tok-ok`: plan `pro`, primary 5 %, 18000 s window, reset now+3600); `GET /wham/rate-limit-reset-credits` (`credit-later` +48 h for all; `tok-expiring` also `credit-soon` +1 h granted −29 d and a `redeemed` `credit-spent`); `POST …/consume` → `{"code":"reset"}`; `GET /api/oauth/usage` → five_hour 25 % and `cedar_ember`: not Claude Code UA → `eligible:false, ineligible_reason:"surface"`; `tok-ok` → grants `older` (+30 h) and `launch` (labelled, ±15 d) with `next_grant_id: "launch"`; else `no_grant`; `POST /api/organizations/*/reset_rate_limits` → `{"result":"reset","resets_left":0,"cleared":["five_hour","seven_day"]}`; `POST /xai/v1/chat/completions` (`Bearer key-xai`) and `POST /local/v1/chat/completions` (no key) → chat completion usage 12/3; `GET /xai/v1/models` → `grok-4`, `grok-code-fast-1`; `GET /codex/models` (`tok-ok`) → `gpt-6-sol` (list) and `gpt-internal` (hide); `POST /openai/v1/responses` (`Bearer key-openai`) → SSE completion 5/2; `POST /kimi/v1/messages` (`x-api-key: key-kimi`) → JSON message 3/1; anything else 404, a wrong key 401. — `crates/slopmax-core/tests/proxy.rs:100-168`, `:376-420`
- [ ] **HAR-008** WebSocket mock: for each text frame, `tok-limited` answers `response.created` then `{"type":"error","status":429,"error":{"type":"usage_limit_reached",…,"resets_at":now+5400}}`; any other token answers `response.created`, `codex.rate_limits` (primary 33 %, 300 min, reset now+3600), a `Hi` delta, and `response.completed` (50 in, 20 cached, 4 out). — `crates/slopmax-core/tests/proxy.rs:170-231`
- [ ] **HAR-009** failover.rs mock: `POST /v1/oauth/token` with `refresh_token: "refresh-good"` → `{"access_token":"tok-renewed","refresh_token":"refresh-next","expires_in":3600}`, any other → 400 `{"error":"invalid_grant","error_description":"refresh token revoked"}`; `GET /api/oauth/profile` → `{}`; `/v1/messages`: `tok-ok`/`tok-renewed` → 200 SSE (input 10, output 1), `tok-busy` → 429 `rate_limit_error` `slow down` with no window headers, else 401 `invalid token`; `/backend-api/codex/responses`: `tok-ok` → 200 SSE (3 in, 1 out), `tok-overloaded` → 200 stream with `response.failed` `server_is_overloaded`; `/local/v1/chat/completions` → 200 chat usage 4/1; else 404 `{}`. — `crates/slopmax-core/tests/failover.rs:58-147`
- [ ] **HAR-010** Client requests: Claude = `POST {proxy}/v1/messages?beta=true` with `authorization: Bearer sm-test-key`, `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14`, `x-claude-code-session-id: sess-1`, `user-agent: claude-cli/2.1.287 (external, cli)`, `accept-encoding: gzip, br`, JSON body naming `claude-opus-5-5` with `metadata.user_id` JSON (`session_id: sess-1`), a `x-anthropic-billing-header:` system block, and `stream: true` (the test asserts this body reaches upstream byte-for-byte); Codex = `POST {proxy}/codex/responses` with `{"model":"gpt-6-sol","input":[],"stream":true}`. `eventually` retries a check 50 × 20 ms before failing (ledger writes and background effects are asynchronous); `observe_usage(id, used)` records a `7d` window at `used` % resetting in 72 h with 2 reset credits. — `crates/slopmax-core/tests/proxy.rs:539-603`; `crates/slopmax-core/tests/failover.rs:256-290`

## 18. Effect port notes

What fits:

- **Services (`Context.Service` + `Layer`).** `App` splits into a few services that hold state: the config holder (a `SubscriptionRef<Config>` swapped whole, PRX-018), the pool (owned by the pool inventory), the ledger writer, the live feed, the reasoning replay store, the model-catalog cache, the redeem lock (`Effect.makeSemaphore(1)`, PRX-072/ADM-015/HUB-011/DMN-017), and the HTTP clients (inference vs `auth_http`). Tests swap the provider origins exactly as `net::Origins` does (NET-008); keep that a plain URL rewrite inside the client service so integration tests can point every provider at one mock.
- **Pure modules stay pure.** `wire` (all of it), `rawjson`, `route` lookups, `retold` message extraction, `pricing`, `summary`/`history`/`waste` aggregation, `notify::nudges` and `Watcher.changes`, `human`, time parsing and formatting, form encoding, WebSocket frame encode/decode: synchronous functions over `Uint8Array` and plain objects, per CONVENTIONS.
- **Schema** for what slopmax owns on disk and on its API: ledger `Entry` (LED-002, with `attempts` defaulting to 1 and omitted when 1, optional keys omitted rather than `null`), `windows.jsonl` records (LED-050), `nudged.json` (string array), `[notify]` settings with unknown keys rejected (NOTE-001), `[prices]` entries (LED-043), the admin/hub request bodies (HUB-004 aliases `authIndex`/`AuthIndex` via a transformation), and the reply shapes (Summary, History, settings, Report). Decode ledger and windows lines with `Schema.decodeUnknownOption` and skip failures (LED-004, LED-051); a malformed `state.json` must still fail startup (DMN-002).
- **Stream** for every body: the tap (PRX-080..083) is a `Stream.mapChunks` pass-through plus a finalizer that reports once — `Stream.ensuring`/`onExit` covers end, error, and the client dropping the response, which is what Rust's `Drop` on `Tapped` gives. The held start (PRX-085) is `Stream.peel`/a pull loop with `Effect.timeout` on the 3 s budget, then `Stream.concat(Stream.fromIterable(held), rest)`. Transcoding (PRX-087) is a stateful `Stream.mapAccum` over lines with a final flush in `Stream.concat(…, Stream.suspend(end))`. The admin feed (ADM-012) is `PubSub.sliding(256)` (lagging subscribers drop, as tokio `broadcast` does) merged with a 15 s keepalive via `Stream.merge` + `Stream.tick`, prefixed by `: connected`.
- **Schedule** for the daemon (DMN-003..011): each task is `task.pipe(Effect.repeat(Schedule.spaced(period)))` forked with `Effect.forkScoped`. tokio's `interval` with `MissedTickBehavior::Delay` fires at once, never overlaps, and after an overrun waits a full period from the late tick; `Schedule.spaced` (wait after each run) is close and simpler; `Schedule.fixed` would match tokio's cadence when runs are short. Pick one and test it with `TestClock`. Each task must re-read the config ref on every run (toggles apply live).
- **Scope** for resources: the listener, each relayed WebSocket (two readers, two writer fibers, `Queue.bounded(64)` per direction, the 5 s flush grace as `Effect.timeout` in the finalizer), notify child processes (`ChildProcess` with a 30 s timeout and kill on interruption, NOTE-006), and the daemon itself (shutdown = closing the scope, then a final `save_state`, DMN-012/013). `POST /slopmax/shutdown` completes a `Deferred` the server waits on.
- **SubscriptionRef** for the config and for anything a UI watches; the daemon's watcher (DMN-018) reads snapshots, it does not need to subscribe.
- **Errors**: the proxy never fails a request with a defect; every path ends in a dialect-shaped error reply (PRX-014). Model upstream failures as data (`Failure`, `Verdict`) rather than Effect errors inside the failover loop, which is a plain loop with early returns; `Effect.catchTag` only at I/O edges (network error → PRX-054).

Traps (Rust mechanisms that need a different design):

- **No automatic decompression.** hyper passes `content-encoding` bodies through, and the proxy forwards `accept-encoding` (PRX-015) and relies on seeing compressed bodies as opaque (PRX-080, PRX-031). `fetch`/undici and Bun's `fetch` decompress by default; use a client that does not (Bun: `fetch(url, { decompress: false })`; Node: `undici.request`, which does not decode) or the byte-for-byte forwarding test fails and the headers lie. Checked on Bun 1.4.4: a default `fetch` of a gzip response returns the 17 decoded bytes while `content-encoding: gzip` stays set; with `decompress: false` it returns the 28 raw bytes.
- **HTTP/1.1 upgrades and raw sockets.** The WebSocket relay needs the raw socket of an inbound 101 and of an outbound 101 (WS-009..011, NET-011) and does its own RFC 6455 framing (NET-040..042) so it can rewrite `codex.rate_limits` and inspect turns. `effect/http`'s server does not expose a raw upgrade; Bun's server has its own `upgrade()` with a managed WebSocket, which could serve the client side if its ping/pong and close handling is checked against WS-012/014 and it can set the 101 headers of WS-010; outbound needs either `node:net`/`node:tls` with the ported framing or a WebSocket client that exposes the 101 headers (WS-010 copies `openai-model`, `x-reasoning-included`, `x-models-etag`; WS-009 sets `openai-beta` and drops `accept-encoding`). The browser-style `WebSocket` cannot set arbitrary request headers, so it is not usable upstream.
- **HEAD and hop-by-hop handling.** PRX-002 answers every HEAD with 200 before routing; many frameworks auto-route HEAD to GET handlers. Node/Bun servers also add `transfer-encoding`/`connection` themselves; the returnable-header filter (PRX-016) must still drop upstream ones.
- **JSON number rendering.** `serde_json` writes floats with a decimal point (`25.0`, `30.0`, `0.0`) and `f32` values in their shortest f32 form; `JSON.stringify` writes `25`, `30`, `0`, and `Math.fround(x)` as a long f64 (`0.8333333134651184`). Tests compare parsed values (`== 30.0` passes for `30`), but byte-identical output (rate-limit headers such as `x-codex-primary-used-percent: 25.0` in the pool view, history `cached`, ledger costs) needs a float formatter. Integers above 2^53 do not occur (tokens, ms) but `u64` fields should still be read as numbers, not BigInt.
- **Rust float formatting rounds half to even** (`{:.0}`, `{:.1}`, `{:.2}`): `human::compact` (COM-012), nudge percentages and dollars (NOTE-010), `cost_label` (LED-012). `Number.prototype.toFixed` rounds the decimal expansion half up and differs on exact ties (`(0.125).toFixed(2)` is `0.13`, Rust gives `0.12`). The dashboard already ships a half-even `round()` (ADM-043); reuse that logic in `@slopmax/common`.
- **Nanosecond timestamps.** Rust `Timestamp` is nanoseconds and prints only the digits needed; ledger lines and `state.json` written by the Rust carry up to nine fractional digits, and the time test `round_trips_through_text_and_serde` round-trips 123 456 789 ns. CONVENTIONS asks for epoch milliseconds. Reading must accept nine digits (truncate to ms) and the port's writer prints at most three; that test then needs a ms-precision version, listed in `NOT-PORTED.md` with the reason, or the port keeps a `bigint`/`{ms, ns}` timestamp in `common` only.
- **Local time.** `local_offset` asks the OS per instant (DST-aware) on Unix and returns UTC on Windows (COM-007). `new Date(t).getTimezoneOffset()` is DST-aware on every platform, so the port would differ from the Rust on Windows; decide deliberately (matching the Rust means forcing UTC on `win32`). History uses the offset of each entry's own instant (LED-022, LED-028), not today's.
- **Ledger month files use the UTC month** (LED-001) while summaries use local days; keep both.
- **Insertion order of JSON keys** is part of the contract (byte-identical forwarding of edited bodies, PRX-051, WS-013, and the encoders' key orders WIRE-043/050/061). JS objects keep insertion order except for integer-like keys, which no shape here uses. Never re-serialize a client body: splice bytes (PRX-051, `rawjson`), and in WS-013 re-serialize only when something was removed.
- **`rawjson` on bytes.** Port it over `Uint8Array` with `indexOf` for the quote/backslash scan; do not `TextDecoder` the whole body. `find_str` alone decodes (via `JSON.parse` of the slice).
- **Duplicate keys.** `models_named` (PRX-034) counts top-level `model` keys; `JSON.parse` keeps only the last, so the count needs the raw scanner. `rawjson::find` takes the first `model`, `JSON.parse` the last — the key check and routing must both use the scanner.
- **Constant-time key comparison** (PRX-006, HUB-001): use `crypto.timingSafeEqual` after a length check, as the Rust does.
- **Rust `{:?}` quoting in messages**: PRX-034/038 quote key names and PRX-037 the model with Rust's Debug escaping (`"laptop"`); `JSON.stringify` matches for ordinary strings.
- **Process-wide defaults.** `Proxy::set_default` (NET-004) is a `OnceLock` set from the config at load; in Effect make the proxy part of the client layer's construction instead of a global, but keep the precedence order.
- **TLS roots.** rustls loads the OS store; Bun and Node use their bundled Mozilla roots unless told otherwise (`NODE_EXTRA_CA_CERTS`, Node's `--use-system-ca`; check Bun's equivalent before relying on it). Corporate MITM roots that work with the Rust may fail in the port; NET-007's "no roots → HTTPS unavailable" path has no direct equivalent.
- **SIGTERM on Windows** is not delivered to the Rust either (DMN-013); Bun/Node emit `SIGINT` on Ctrl-C and `SIGBREAK` on Ctrl-Break — map only what the Rust maps.
- **Port holder** (NET-031) reads `/proc` and runs `lsof`; port it as a small Node-API module isolated in `net`, per CONVENTIONS.
- **Broadcast vs PubSub capacity.** tokio `broadcast(256)` makes a slow subscriber skip (`Lagged`), never block the proxy; use a sliding PubSub, not a bounded one that applies back-pressure to request handling.
- **The ledger writer** batches whatever is queued and appends off the request path (LED-003); an unbounded `Queue` drained by one fiber with `Queue.takeAll` gives the same batching. Appends must be `O_APPEND` writes with mode 0600 on creation.
- **Timers inside requests**: the 400 ms transient wait (PRX-064), the 3 s held start (PRX-085), the 15 s socket handshake (WS-009), and the 600 s stall timeout (PRX-025, NET-010) should all come from `Clock` so `TestClock` drives them.
