# Parity: slopmax-core — accounts, config, sign-in, providers, agents, routing, pool, limits, service, background, doctor, report

Scope: `crates/slopmax-core/src/` modules `config.rs`, `account.rs`, `paths.rs`, `fsx.rs`, `auth/`, `import.rs`,
`provider/` (mod, claude/, codex/, keys, compat, credits), `agent/`, `route.rs`, `pool.rs`, `limits.rs`, `usage.rs`,
`service.rs`, `background.rs`, `doctor.rs`, `report.rs`, `testkit.rs`.
Paths below are relative to `crates/slopmax-core/src/` unless they start with `crates/`.

Each line: **ID** — behavior a TypeScript port must reproduce — `rust/location:line`.
"Exact text" means a test asserts the wording or a front end shows it verbatim; keep it byte-for-byte.
Test lists at the end of each section name every Rust test (from `rust-tests.tsv`) the port must mirror with the same title.

---

## CFG — config.toml (`config.rs`)

### Keys and defaults

| Key                       | Type                                                             | Default                                                 | Notes                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`                  | socket address string                                            | `"127.0.0.1:7567"`                                      | `DEFAULT_PORT = 7567` ("slop" on a keypad)                                                                                                                                                               |
| `api_key`                 | string                                                           | `""` → generated `sm-<43-char base64url>` on first load |                                                                                                                                                                                                          |
| `strategy`                | `reset-first` \| `fill-first` \| `least-used` \| `round-robin`   | `reset-first`                                           | kebab-case                                                                                                                                                                                               |
| `session_ttl_mins`        | u64                                                              | `60`                                                    |                                                                                                                                                                                                          |
| `session_affinity`        | bool                                                             | `true`                                                  | per-request override header `x-slopmax-affinity: on\|off`                                                                                                                                                |
| `poll_mins`               | u64                                                              | `5`                                                     | 0 disables polling                                                                                                                                                                                       |
| `refresh_tokens`          | bool                                                             | `true`                                                  |                                                                                                                                                                                                          |
| `redeem_expiring_credits` | bool                                                             | `true`                                                  |                                                                                                                                                                                                          |
| `redeem_when_exhausted`   | bool                                                             | `false`                                                 |                                                                                                                                                                                                          |
| `websockets`              | bool                                                             | `true`                                                  |                                                                                                                                                                                                          |
| `warm_windows`            | bool                                                             | `false`                                                 |                                                                                                                                                                                                          |
| `paid_overflow`           | bool                                                             | `false`                                                 |                                                                                                                                                                                                          |
| `proxy`                   | optional string                                                  | absent                                                  | `http://`, `socks5://`, `socks5h://`                                                                                                                                                                     |
| `[aliases]`               | map string→string                                                | empty                                                   |                                                                                                                                                                                                          |
| `[fallbacks]`             | map string→string[]                                              | empty                                                   |                                                                                                                                                                                                          |
| `[prices."<model>"]`      | `{input, output, cache_read?, cache_write?}` (f64, deny unknown) | empty                                                   | `input` and `output` required                                                                                                                                                                            |
| `[plan_prices]`           | map string→f64 (`"claude/max 20x" = 200`)                        | empty                                                   |                                                                                                                                                                                                          |
| `[notify]`                | `{webhook?, command?, events?[]}` (deny unknown)                 | empty                                                   | events: `limited`, `available`, `exhausted`, `recovered`, `signed-out`, `reset-expiring`, `quota-unused`, `test`; default set when empty: exhausted, recovered, signed-out, reset-expiring, quota-unused |
| `[[keys]]`                | `{name, key, models?[]}` (deny unknown)                          | empty                                                   |                                                                                                                                                                                                          |

- **CFG-001** — Config struct fields and defaults exactly as in the table above (listen 127.0.0.1:7567, ttl 60, affinity true, poll 5, refresh true, redeem_expiring true, redeem_when_exhausted false, websockets true, warm_windows false, paid_overflow false) — `config.rs:104`
- **CFG-002** — `DEFAULT_PORT` is 7567 — `config.rs:17`
- **CFG-003** — Unknown top-level keys are rejected (`deny_unknown_fields`); every field is optional (`serde(default)`) so a partial file parses — `config.rs:20`
- **CFG-004** — Unknown keys inside `[[keys]]` entries are rejected; `models` defaults to empty — `config.rs:84`
- **CFG-005** — Unknown keys inside `[prices.*]` are rejected; `input` and `output` are required (`[prices.m] input = 1` alone is an error); integers accepted as floats (`output = 8`) — `pricing.rs:23`
- **CFG-006** — Unknown keys inside `[notify]` rejected; `[notify]` fields `webhook`, `command`, `events` — `notify.rs:22`
- **CFG-007** — Serialization omits `proxy` when absent, and `aliases`, `fallbacks`, `prices`, `plan_prices`, `notify`, `keys` when empty — `config.rs:58`
- **CFG-008** — `ClientKey::allows(model)`: true when `models` is empty, else any pattern matches via `provider::matches` (`*` wildcard) — `config.rs:95`
- **CFG-009** — `Strategy` serializes kebab-case; `Display` gives `reset-first`/`fill-first`/`least-used`/`round-robin`; `Strategy::ALL` order is ResetFirst, FillFirst, LeastUsed, RoundRobin; `parse(name)` matches the display name exactly — `config.rs:131`
- **CFG-010** — `Strategy::summary` exact texts: "Spend the quota that resets soonest, so none is lost" / "Use accounts in priority order; fail over when one is limited" / "Balance load toward the least used account" / "Take turns across accounts" — `config.rs:160`
- **CFG-011** — `LIVE` list (order matters; shown by `slopmax config`, dashboard, app): strategy "reset-first, fill-first, least-used, or round-robin"; session_affinity "keep a session on its account, for the prompt cache"; session_ttl_mins "idle minutes before a session's account is forgotten"; redeem_expiring_credits "redeem a limit reset before it expires unused"; redeem_when_exhausted "redeem one when every account is spent"; warm_windows "start idle ChatGPT accounts' windows as they reset"; paid_overflow "let API keys take over once subscriptions are limited"; poll_mins "minutes between usage polls (0 turns them off)" — `config.rs:183`
- **CFG-012** — `live_value(name, value)`: unknown name → `"{name} is not a setting slopmax changes while it runs; those are strategy, session_affinity, session_ttl_mins, redeem_expiring_credits, redeem_when_exhausted, warm_windows, paid_overflow, poll_mins"` — `config.rs:219`
- **CFG-013** — `live_value` trims the value; strategy must parse else `"strategy is one of reset-first, fill-first, least-used, round-robin"` — `config.rs:227`
- **CFG-014** — `live_value` minutes: `session_ttl_mins` must be integer > 0; `poll_mins` integer ≥ 0; else `"{name} is a number of minutes"`; parsed as i64 (negative rejected) — `config.rs:236`
- **CFG-015** — `live_value` booleans accept `true|on|1|yes` and `false|off|0|no` (case-sensitive), else `"{name} is on or off"`; values become TOML bool/int/string — `config.rs:240`
- **CFG-016** — `Config::live(name)` returns the current value as config.toml writes it (`"true"`, `"60"`, `"reset-first"`), `None` for non-live names such as `api_key`; each default round-trips through `live_value` — `config.rs:251`
- **CFG-017** — `Config::load()` reads `$SLOPMAX_HOME/config.toml`; env `SLOPMAX_LISTEN` (non-empty) overrides `listen`; an unparsable value errors `SLOPMAX_LISTEN="<v>" is not an address` (Rust `{:?}` quoting) — `config.rs:267`
- **CFG-018** — `load_from`: missing file → defaults; read error → `reading <path>`; parse error → `invalid config <path>` — `config.rs:279`
- **CFG-019** — First-run key: if `api_key` is empty, take `.config.lock` (sibling of config file, exclusive file lock), re-read; if another process already made a key, return its config — all concurrent processes agree on one key — `config.rs:297`
- **CFG-020** — Generated key format `sm-` + `ids::token()` (32 random bytes base64url no pad, 43 chars) — `config.rs:308`
- **CFG-021** — When no file existed, write the template (CFG-030) with the key; when a file existed without a key, append `api_key = "<key>"` via toml_edit preserving comments and formatting exactly (`"{original}api_key = \"{key}\"\n"`) — `config.rs:309`
- **CFG-022** — Config writes go through `fsx::write_private` (atomic, 0600, parent dir 0700) — `config.rs:318`
- **CFG-023** — `add_key(path, name, models)`: duplicate name → `a key named "<name>" already exists`; new key `sm-<token>`; appends a `[[keys]]` table with `name`, `key`, and `models` (array, only when non-empty), preserving comments; `keys` that is not an array of tables → "`keys` in config.toml is not a list of [[keys]] tables" — `config.rs:326`
- **CFG-024** — `remove_key(path, name)`: returns false when no `keys` or no match; removes matching tables; removes the whole `keys` entry when it becomes empty; writes only when something changed — `config.rs:351`
- **CFG-025** — `Config::set(path, values)`: missing file starts an empty document; each value keeps the old value's decor (inline comment stays beside it); the resulting text must deserialize as a Config (`invalid setting for <path>`) before anything is written — `config.rs:372`
- **CFG-026** — `base_url()`: `http://<host>:<port>` where unspecified IP (0.0.0.0 / ::) → `127.0.0.1`, IPv6 wrapped in brackets — `config.rs:401`
- **CFG-027** — `apply()`: when `proxy` set, parse it (scheme `http`/`socks5`/`socks5h`, default socks port 1080) and set as process-wide default upstream proxy; errors as ``config `proxy`: <e>`` (e.g. `proxy "x" needs a scheme, like http:// or socks5://`, `unsupported proxy scheme "ftp"`) — `config.rs:415`, `crates/slopmax-net/src/client.rs:121`
- **CFG-028** — `dashboard_url()` = `<base_url>/slopmax/dashboard#key=<api_key>` (key in fragment, never sent to the server) — `config.rs:425`
- **CFG-029** — `Config` derives PartialEq; `load_from` twice yields equal configs (key stable) — `config.rs:550`
- **CFG-030** — First-run template text, byte-exact (the test compares the whole file to `template(key)`), reproduced verbatim below — `config.rs:433`
- **CFG-031** — Template property: parsing it yields defaults+key; uncommenting every line that starts with `# ` and whose remainder contains `=` and does not start with a space yields the same config, and that set of top-level keys equals the set of keys the default Config serializes (i.e. the template lists every serialized setting at its default) — `config.rs:624`
- **CFG-032** — Strategy env/config name errors and `Strategy::parse` drive the CLI and dashboard `config` endpoints; no other validation of `listen` beyond SocketAddr parse — `config.rs:155`

Template (CFG-030), exact:

```toml
# slopmax settings. Everything but api_key is optional; the commented
# values are the defaults.

# Key agents present to the proxy, as a bearer token or x-api-key.
api_key = "{api_key}"

# Address the proxy listens on.
# listen = "127.0.0.1:7567"

# How a new session picks its account:
#   reset-first  spend the quota that resets soonest, so none is lost
#   fill-first   drain accounts in priority order (plain failover)
#   least-used   spread sessions over the least used accounts
#   round-robin  hand sessions to each account in turn
# strategy = "reset-first"

# Keep a session on the account it started on while that account can serve,
# so the provider's prompt cache stays warm. Off, every request is placed by
# the strategy (load balancing, at the cost of the cache). A client can
# decide per request with the header `x-slopmax-affinity: on` or `off`.
# session_affinity = true

# Minutes a session stays on its account after its last request.
# session_ttl_mins = 60

# Minutes between usage polls per account (0 turns polling off).
# poll_mins = 5

# Refresh OAuth tokens before they expire. Turn this off only while another
# tool uses the same accounts: every refresh rotates the refresh token.
# refresh_tokens = true

# Redeem a ChatGPT reset credit in its last hours, if the account has usage
# to reset, rather than let it expire unused.
# redeem_expiring_credits = true

# When every Codex account is spent, redeem a reset credit instead of
# failing the request.
# redeem_when_exhausted = false

# Relay Codex's WebSocket connections to ChatGPT, which starts answers
# sooner than HTTP streaming. `slopmax setup codex` turns them on in Codex.
# websockets = true

# ChatGPT starts a 5-hour window at an account's first request. With this
# on, an idle account gets one tiny request as soon as its window resets,
# so its next reset comes sooner when you need it. Claude accounts are
# never warmed.
# warm_windows = false

# Let API keys (`slopmax login openai`, `slopmax login anthropic`) serve a
# subscription's models once every subscription account is limited. Off,
# they serve those models only when asked for by name (`openai/gpt-6-sol`)
# or when you have no such subscription.
# paid_overflow = false

# Proxy for requests to providers, instead of HTTPS_PROXY:
#   proxy = "socks5h://127.0.0.1:1080"

# Model names that stand for others, and models to try once one is limited
# on every account. A name may pick a provider or account: "openai/gpt-6-sol".
#   [aliases]
#   fast = "gpt-6-sol-mini"
#   [fallbacks]
#   "gpt-6-sol" = ["openai/gpt-6-sol"]

# Notifications, sent when every account of a kind is limited (so requests
# fail), when it recovers, when an account needs `slopmax login` again, when
# a limit reset would expire unused (with redeem_expiring_credits off), and
# when a week is about to reset with much of its quota unused.
# A webhook gets a JSON POST (with "text" and "content", so Slack and
# Discord show it); a command runs in the shell with SLOPMAX_EVENT,
# SLOPMAX_PROVIDER, SLOPMAX_ACCOUNT, SLOPMAX_UNTIL, and SLOPMAX_MESSAGE set.
# Add "limited" and "available" to events to hear about each account too.
# Check the setup with `slopmax notify`.
#   [notify]
#   webhook = "https://hooks.slack.com/services/..."
#   command = 'notify-send slopmax "$SLOPMAX_MESSAGE"'
#   events = ["exhausted", "recovered", "signed-out", "reset-expiring", "quota-unused"]

# More keys, for other machines and tools, made with `slopmax key add`. A
# key may be limited to some models; only api_key reaches slopmax's own API.
#   [[keys]]
#   name = "laptop"
#   key = "sm-..."
#   models = ["gpt-*"]

# What each subscription costs a month, for what unused quota is worth.
# List prices are built in (Claude Pro $20, Max 5x $100, Max 20x $200;
# ChatGPT Plus $20, Pro $200); set what you really pay:
#   [plan_prices]
#   "claude/max 20x" = 200
#   "codex/pro" = 200

# API prices for `slopmax usage`, in dollars per million tokens. Anthropic's
# and OpenAI's list prices are built in; add models it can't price. Cache reads default
# to a tenth of input, cache writes to 1.25x input. For example:
#   [prices."my-model"]
#   input = 2.0
#   output = 8.0
#   cache_read = 0.5
```

(`{api_key}` is substituted; the file ends with a single newline after `#   cache_read = 0.5`.)

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `config.rs` (9):
  - `first_load_writes_the_template_with_a_fresh_key` — `config.rs:550`
  - `a_missing_key_is_added_without_rewriting_the_file` — `config.rs:562`
  - `live_settings_are_checked_before_they_are_written` — `config.rs:575`
  - `processes_started_together_agree_on_the_key` — `config.rs:609`
  - `template_lists_every_setting_at_its_default` — `config.rs:624`
  - `parses_partial_config` — `config.rs:659`
  - `parses_custom_prices` — `config.rs:669`
  - `client_keys_are_added_and_removed_in_place` — `config.rs:681`
  - `rejects_unknown_keys` — `config.rs:704`

---

## FS — paths and private files (`paths.rs`, `fsx.rs`)

- **FS-001** — `user_home()` = OS home dir, else `.` — `paths.rs:7`
- **FS-002** — Env dirs are honored only when set and non-empty (`env_dir`) — `paths.rs:11`
- **FS-003** — `Home::current()` = `$SLOPMAX_HOME` else `~/.slopmax` — `paths.rs:28`
- **FS-004** — Home files: `accounts/`, `config.toml`, `state.json`, `usage/`, `slopmax.log`, `pins.json`, `nudged.json`, `windows.jsonl` — `paths.rs:37`
- **FS-005** — Module-level helpers (`home`, `accounts_dir`, `config_file`, `state_file`, `usage_dir`, `log_file`, `pins_file`) resolve through `Home::current()` each call (env read at call time) — `paths.rs:77`
- **FS-006** — Claude Code dir = `$CLAUDE_CONFIG_DIR` else `~/.claude` — `paths.rs:106`
- **FS-007** — Codex dir = `$CODEX_HOME` else `~/.codex` — `paths.rs:111`
- **FS-008** — CLIProxyAPI dir = `~/.cli-proxy-api` (no env override) — `paths.rs:116`
- **FS-009** — `write_private(path, data)`: create parent with `private_dir`; write to sibling temp `.<name>.<pid>.tmp` opened 0600 create+truncate; write, fsync, close, rename over target; on failure remove the temp file and return the error — `fsx.rs:14`
- **FS-010** — `write_json`: pretty JSON (serde_json 2-space indent) plus a trailing `\n`, via `write_private` — `fsx.rs:33`
- **FS-011** — `read_json`: missing file → `None`; invalid JSON → error of kind InvalidData; other IO errors propagate — `fsx.rs:40`
- **FS-012** — `lock(path)`: creates parent dir privately, opens/creates the lock file 0600 without truncating, takes an exclusive (blocking) OS file lock; released when the handle drops — `fsx.rs:54`
- **FS-013** — `private_dir`: recursive create with mode 0700 on Unix for newly created dirs; existing dirs keep their permissions; no-op modes on Windows — `fsx.rs:65`
- **FS-014** — Unix: files 0600, dirs 0700; Windows: default ACLs (mode calls are `cfg(unix)`) — `fsx.rs:68`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `fsx.rs` (3):
  - `new_directories_are_private` — `fsx.rs:93`
  - `write_private_round_trips_and_restricts_permissions` — `fsx.rs:105`
  - `read_json_missing_file_is_none` — `fsx.rs:123`
- `paths.rs`: no tests

---

## ACC — accounts, the Store, pins (`account.rs`)

### File format: `accounts/<id>.json` (pretty JSON + newline, 0600)

```jsonc
{
  "id": "claude-1a2b3c4d", // required
  "provider": "claude", // required: claude|codex|anthropic|openai|xai|compat
  "label": "work", // optional, omitted when null
  "email": "...",
  "plan": "max 20x",
  "account_id": "...",
  "org_id": "...",
  "org_name": "...", // optional, omitted when null
  "disabled": false, // always written; default false
  "priority": 0, // always written; i32; default 0
  "auth_error": "...", // optional
  "tokens": {
    // required
    "access_token": "...", // required
    "refresh_token": "...",
    "id_token": "...",
    "expires_at": "<RFC3339>",
    "refreshed_at": "<RFC3339>", // optional
  },
  "link": { "tool": "cliproxyapi", "path": "/abs/file.json" }, // optional
  "endpoint": { "base_url": "...", "dialect": "chat|responses|messages", "models": ["..."] }, // optional; models omitted when empty
  "added_at": "<RFC3339>", // required
}
```

- **ACC-001** — Account JSON field set, optionality and omission rules exactly as above (unknown fields tolerated on read: no `deny_unknown_fields`) — `account.rs:50`
- **ACC-002** — Tokens JSON: `access_token` required; `refresh_token`, `id_token`, `expires_at`, `refreshed_at` optional and omitted when absent — `account.rs:24`
- **ACC-003** — `Tokens::expires_within(lead, now)` true iff `expires_at` is known and `expires_at - now <= lead`; unknown expiry never expires — `account.rs:40`
- **ACC-004** — `Tokens::is_expired(now)` = `expires_within(0, now)` (exactly-now counts as expired) — `account.rs:45`
- **ACC-005** — `Endpoint { base_url, dialect, models }`; request paths appended to base_url (`/chat/completions`, `/responses` for OpenAI-style, `/v1/messages` for Anthropic-style) — `account.rs:93`
- **ACC-006** — `Link { tool, path }`: tool that owns the tokens (`cliproxyapi`) and its file — `account.rs:106`
- **ACC-007** — `Account::new(provider, tokens)`: no label/email/etc., disabled false, priority 0, `added_at = now`, id assigned immediately — `account.rs:115`
- **ACC-008** — `identity_key()` = provider identity (Claude: org_id else account_id; Codex: account_id; keys: key-derived; compat: base_url-derived) else email else refresh_token else `""` — `account.rs:138`
- **ACC-009** — `assign_id()`: `"<provider>-" + hex(sha256(identity_key)[0..4])` (8 lowercase hex chars); stable forever: Claude org `org-1`/email `me@x.dev` → `claude-c24787a7`; Codex workspace `ws-9` → `codex-372c403d` — `account.rs:147`
- **ACC-010** — `name()`: label if set; else for an endpoint the host of base_url (text after last `://`, up to first `/`); else for non-subscription providers `"<Spec.title> key …<last 4 chars of key>"`; else email (or id) plus ` (<org_name>)` unless org_name contains the email — `account.rs:155`
- **ACC-011** — `inherit_settings(old)`: keep new label if set else old label; take old `disabled`, `priority`, `added_at` — `account.rs:176`
- **ACC-012** — `Store::open()` = `$SLOPMAX_HOME/accounts`; `Store::at(dir)` for tests and the proxy's own home — `account.rs:191`
- **ACC-013** — `Store::list()`: missing dir → empty; reads only `*.json`; files that fail to parse are skipped with a warn log `skipping <path>: <e>`; sorted by provider (enum order Claude, Codex, Anthropic, OpenAI, Xai, Compat), then priority descending, then `added_at` ascending — `account.rs:208`
- **ACC-014** — `Store::get(id)` reads `<dir>/<id>.json`, `None` if missing; errors carry `reading account <id>` — `account.rs:231`
- **ACC-015** — `Store::save` writes without locking (used by refresh, which already holds the lock); errors `saving account <id>` — `account.rs:238`
- **ACC-016** — `Store::update(id, f)`: under the account lock, re-read, apply `f`, save; missing → `account <id> no longer exists` — `account.rs:246`
- **ACC-017** — `Store::upsert(account)`: re-assign id, lock, merge settings from an existing record (ACC-011), save; returns `(account, is_new)` — `account.rs:258`
- **ACC-018** — `Store::remove(id)`: under lock delete `<id>.json` (error `removing account <id>` if missing), then release and best-effort delete `.<id>.lock` — `account.rs:269`
- **ACC-019** — Per-account lock file path `<accounts>/.<id>.lock`; `lock()` errors `locking account <id>` — `account.rs:277`
- **ACC-020** — `Store::find(query)`: a positive integer N selects the Nth account (1-based) of `list()` order; else exact matches on id, label, or email; if none exact, id-prefix matches; one → it; none → `no account matches "<q>" (see \`slopmax status\`)`; several → `"<q>" is ambiguous: id1, id2`—`account.rs:288`
- **ACC-021** — `pins.json` format: JSON object provider-id → account id (Pins = BTreeMap<ProviderId,String>); `pin()` reads (missing = empty), sets the account's provider, writes privately — `account.rs:324`
- **ACC-022** — `unpin_all()` writes an empty `{}` to pins.json — `account.rs:332`
- **ACC-023** — `forget()`: remove the account, then drop its provider's pin only if it pins this account — `account.rs:337`
- **ACC-024** — `Store::list` reads an absent accounts directory as empty, but a directory that exists and cannot be read fails with context `reading accounts directory`, and an error while iterating its entries propagates (the whole list fails, unlike a bad file, which is skipped per ACC-013); only names ending `.json` are read, so `.<id>.lock` files and stray files are ignored; a file that vanishes between listing and reading is skipped silently — `account.rs:208-228`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `account.rs` (5):
  - `ids_hash_the_identity_as_before` — `account.rs:359`
  - `same_email_in_two_orgs_are_distinct_accounts` — `account.rs:379`
  - `upsert_merges_settings_on_relogin` — `account.rs:387`
  - `find_resolves_ids_labels_emails_and_positions` — `account.rs:410`
  - `expiry_checks_respect_lead` — `account.rs:430`

---

## AUTH — sign-in, callback server, PKCE, JWT, refresh (`auth/`)

### Types and classification

- **AUTH-001** — `Grant { access_token, refresh_token?, id_token?, expires_at? }`; `into_tokens(now)` copies fields and sets `refreshed_at = now` — `auth/mod.rs:22`
- **AUTH-002** — `RefreshError::{Revoked(reason), Transient(error)}` — `auth/mod.rs:43`
- **AUTH-003** — `RefreshError::classify(status, body)`: Revoked if status is 401, or a 4xx whose body contains any of `invalid_grant`, `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`; else Transient. Revoked reason text `refresh token rejected (<status>)`; Transient text `token refresh failed (<status>): <body>` (status rendered like `401 Unauthorized`, `502 Bad Gateway`) — `auth/mod.rs:53`
- **AUTH-004** — Display: Revoked → `"<reason>; log in again"`; Transient → error chain joined `": "` (`{:#}`) — `auth/mod.rs:69`
- **AUTH-005** — `http_client(origins)`: user-agent `slopmax/<CARGO_PKG_VERSION>`, connect timeout 10 s, total timeout 30 s, origin rewrites for tests — `auth/mod.rs:81`
- **AUTH-006** — `LoginOptions { device, no_browser, endpoint?, key? }`; Debug output redacts the key as `<redacted>` and never prints it — `auth/mod.rs:91`
- **AUTH-007** — `LoginEvent::Authorize { title, url, opened, port }`, `DeviceCode { url, code }`, `Notice(text)` — `auth/mod.rs:116`
- **AUTH-008** — `Prompt`: an event sink plus optional stream of pasted lines; `pasted()` yields `None` when there is no paste channel or it is closed; Debug prints `Prompt { pasted: false, .. }` / contains `pasted: true` — `auth/mod.rs:135`
- **AUTH-009** — `connect(store, provider, label, options, prompt)`: uses a fresh `http_client`, runs `provider.login`, sets label only when given (a later login without label keeps the earlier label via upsert), then `store.upsert`; returns `(account, is_new)` — `auth/mod.rs:177`
- **AUTH-010** — `browser_login(title, url, (port,path), state, options, prompt)`: opens browser unless `no_browser` (`opened` = launch succeeded), emits `Authorize{title,url,opened,port}` before waiting, then `callback::receive` — `auth/mod.rs:195`

### Refresh under lock

- **AUTH-011** — `ensure_fresh(http, store, account, force)`: due = `force || expires_within(provider.refresh_lead, now)`; not due → returns the account unchanged with no network call — `auth/mod.rs:221`
- **AUTH-012** — Linked accounts (`link` set) never refresh; they `follow` the source file (AUTH-016) — `auth/mod.rs:233`
- **AUTH-013** — Refresh runs detached (survives caller cancellation): take the account's file lock (blocking, off the async thread), re-read stored copy (fallback: the stale copy if missing); if stored access token differs from the caller's (rotated elsewhere) or stored copy is no longer due, return stored copy without network — `auth/mod.rs:236`
- **AUTH-014** — `refresh_and_save`: no refresh token → `Revoked("no refresh token stored")` with no network; provider refresh failure that is Revoked sets `auth_error = reason` and saves (best effort); Transient leaves the file untouched — `auth/mod.rs:297`
- **AUTH-015** — On success: tokens from grant (`refreshed_at=now`); missing refresh_token keeps old one; missing id_token keeps old one; `expires_at` taken from grant even if None; clear `auth_error`; run `provider.identify` (failures ignored, existing identity kept); save before returning (save failure logged `refreshed <id> but could not save it: <e>` but the new account is still returned) — `auth/mod.rs:317`
- **AUTH-016** — `follow` (linked): read the source's tokens (`import::linked_tokens`), lock, reload; if account file missing return the in-hand copy; if access token unchanged return stored; else replace tokens, clear `auth_error`, save — `auth/mod.rs:260`
- **AUTH-017** — `follow` error: if the source has not rotated and (`force` or the token is expired) → Transient `"<tool> has not refreshed this login yet (\`slopmax own\` lets slopmax refresh it)"`; due-but-unexpired returns the current copy — `auth/mod.rs:285`
- **AUTH-018** — Default `Provider::refresh` (API keys) → `Revoked("<title> keys cannot be refreshed")`, rendered e.g. `OpenAI API keys cannot be refreshed; log in again` — `provider/mod.rs:283`
- **AUTH-019** — Unreachable token endpoint and non-JSON 200 are Transient — `auth/mod.rs:612`

### Callback server (`auth/callback.rs`)

- **AUTH-020** — Login waits at most 600 s (`LOGIN_TIMEOUT`); timeout → `timed out waiting for authorization` — `auth/callback.rs:22`
- **AUTH-021** — `Callback { code, state? }`; provider error param → `authorization failed: <error> <error_description>`; missing/empty code → `no code` — `auth/callback.rs:40`
- **AUTH-022** — Code containing `#` with no separate state splits into `code` and `state` (Anthropic's manual page shows `code#state`); with a separate state the `#` stays in the code — `auth/callback.rs:49`
- **AUTH-023** — `parse_pasted(input)`: trims; if it contains `?` take the query after the first `?`; else if it contains `=` treat it as a bare query; else the whole input is the code; a `#fragment` after the query is dropped; query is form-decoded (`%2B` → `+`, `+` → space) and only `code`, `state`, `error`, `error_description` are read — `auth/callback.rs:61`
- **AUTH-024** — `receive(port, path, expected_state, prompt)`: binds `127.0.0.1:<port>` (IPv4 loopback only); if the bind fails emits Notice `port <port> is busy (<io error>); paste the redirect address instead` and waits only on pastes — `auth/callback.rs:103`
- **AUTH-025** — Waits on redirects and pasted lines concurrently; blank pasted lines are ignored; a failed attempt emits Notice `"<error>; try again"` and keeps waiting — `auth/callback.rs:122`
- **AUTH-026** — No server and no paste channel (or paste channel closed) → error `port <port> is busy and no redirect address can be pasted` — `auth/callback.rs:132`
- **AUTH-027** — After a result the server task is aborted; a returned state that differs from expected → `OAuth state mismatch; start over`; a missing state is accepted — `auth/callback.rs:142`
- **AUTH-028** — Callback HTTP server: any path other than the registered one → 404 empty body; registered path → 200 `text/html; charset=utf-8` with SUCCESS_PAGE (contains "Account connected") on a code, FAILURE_PAGE (contains "Authorization failed") on an error; both results are forwarded to the waiter — `auth/callback.rs:153`
- **AUTH-029** — Exact pages: `<!doctype html><title>slopmax</title><body style="font-family:system-ui;text-align:center;padding:4em"><h2>Account connected</h2><p>You can close this tab and return to slopmax.</p>` and same with `<h2>Authorization failed</h2><p>slopmax shows what went wrong.</p>` — `auth/callback.rs:208`
- **AUTH-030** — `has_browser()`: always true on macOS and Windows; on others true iff `DISPLAY` or `WAYLAND_DISPLAY` is set — `auth/callback.rs:181`
- **AUTH-031** — `open_browser(url)`: false when no browser; runs `open` (macOS), `explorer` (Windows), `xdg-open` (else) with stdio nulled, detached; returns whether spawn succeeded — `auth/callback.rs:188`

### PKCE and JWT

- **AUTH-032** — PKCE verifier = `ids::token()` (43 chars, `[A-Za-z0-9_-]`), challenge = base64url-nopad(SHA-256(verifier)); RFC 7636 Appendix B vector `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` — `auth/pkce.rs:16`
- **AUTH-033** — OAuth `state` = `ids::token()` (43-char base64url) — `provider/claude/oauth.rs:131`
- **AUTH-034** — `jwt::claims(token)`: second `.`-segment, trailing `=` trimmed, base64url-nopad decoded, parsed as JSON; any failure → None; signature never verified — `auth/jwt.rs:13`
- **AUTH-035** — `jwt::expiry` = integer `exp` claim as a timestamp — `auth/jwt.rs:20`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `auth/mod.rs` (19):
  - `linked_accounts_follow_their_source` — `auth/mod.rs:338`
  - `classifies_refresh_failures` — `auth/mod.rs:385`
  - `fresh_tokens_are_used_without_a_refresh` — `auth/mod.rs:454`
  - `due_tokens_are_refreshed_identified_and_saved` — `auth/mod.rs:466`
  - `forced_refreshes_keep_tokens_the_provider_did_not_rotate` — `auth/mod.rs:514`
  - `a_token_another_process_rotated_is_reused` — `auth/mod.rs:538`
  - `a_stored_copy_that_is_no_longer_due_is_not_refreshed` — `auth/mod.rs:555`
  - `rejected_refresh_tokens_mark_the_account` — `auth/mod.rs:571`
  - `passing_failures_leave_the_account_alone` — `auth/mod.rs:587`
  - `unreachable_token_endpoints_are_passing_failures` — `auth/mod.rs:612`
  - `accounts_without_a_refresh_token_must_log_in_again` — `auth/mod.rs:628`
  - `api_keys_cannot_be_refreshed` — `auth/mod.rs:642`
  - `linked_accounts_wait_for_their_source_when_forced` — `auth/mod.rs:671`
  - `links_to_unknown_tools_fail_softly` — `auth/mod.rs:700`
  - `connect_signs_in_and_merges_repeat_logins` — `auth/mod.rs:714`
  - `prompts_deliver_events_and_pasted_lines` — `auth/mod.rs:769`
  - `login_options_never_print_the_key` — `auth/mod.rs:788`
  - `grants_become_tokens_stamped_now` — `auth/mod.rs:801`
  - `refresh_errors_read_as_what_to_do` — `auth/mod.rs:818`
- `auth/callback.rs` (10):
  - `parses_full_redirect_url` — `auth/callback.rs:221`
  - `parses_code_hash_state` — `auth/callback.rs:228`
  - `parses_bare_query_and_decodes` — `auth/callback.rs:235`
  - `surfaces_provider_errors` — `auth/callback.rs:241`
  - `empty_codes_and_fragments_are_handled` — `auth/callback.rs:248`
  - `desktops_have_a_browser` — `auth/callback.rs:261`
  - `the_redirect_delivers_the_code_and_a_page` — `auth/callback.rs:310`
  - `busy_ports_fall_back_to_pasted_addresses` — `auth/callback.rs:334`
  - `a_foreign_state_is_refused` — `auth/callback.rs:358`
  - `nothing_to_wait_for_is_an_error` — `auth/callback.rs:369`
- `auth/jwt.rs` (2):
  - `decodes_claims_and_expiry` — `auth/jwt.rs:38`
  - `rejects_non_jwt` — `auth/jwt.rs:45`
- `auth/pkce.rs` (2):
  - `challenge_matches_rfc7636_example` — `auth/pkce.rs:31`
  - `verifier_is_url_safe_and_unique` — `auth/pkce.rs:39`

---

## IMP — importing logins (`import.rs`)

- **IMP-001** — `Source` names: `all`, `claude-code`, `codex`, `cliproxyapi`; anything else → `unknown source "<s>"` — `import.rs:37`
- **IMP-002** — `discover(http, source)`: in order Claude Code (`agent.import`), Codex (`agent.import`), then CLIProxyAPI files; missing sources are skipped silently — `import.rs:83`
- **IMP-003** — `Found { origin, account: Result }`; `Saved { origin, account: Result<(Account,bool)> }` — a broken login is reported, not fatal — `import.rs:52`
- **IMP-004** — `save(store, found, own)`: with `own`, clear `link` (slopmax refreshes it itself); each upserted (merging settings) — `import.rs:67`
- **IMP-005** — CLIProxyAPI scan: dir `~/.cli-proxy-api`; unreadable dir → none; only `*.json`, sorted by path; unreadable/unparsable files skipped; only `type` `claude` or `codex` imported (others like `xai` skipped; non-JSON like `config.yaml` ignored) — `import.rs:124`
- **IMP-006** — CLIProxyAPI file fields read: `type`, `access_token`, `refresh_token`, `id_token`, `expired`, `last_refresh`, `email`, `account_uuid`, `organization_uuid`, `organization_name`, `account_id`, `plan_type`, `label`, `disabled` (default false), `priority` (number or numeric string); others ignored — `import.rs:104`
- **IMP-007** — Tokens from a CLIProxyAPI file: missing access_token → error `no access token`; `expires_at` = JWT `exp` of access token, else parsed `expired` (RFC 3339 with any offset); `refreshed_at` = parsed `last_refresh`; empty refresh/id tokens become absent — `import.rs:153`
- **IMP-008** — Imported CLIProxyAPI accounts are linked: `link = {tool:"cliproxyapi", path:<file>}`; email, label, disabled, priority (default 0) copied — `import.rs:188`
- **IMP-009** — Claude import: account_id←account_uuid, org_id←organization_uuid, org_name←organization_name; if the token is not expired, fetch the profile and `apply_profile` (failures ignored) — `import.rs:200`
- **IMP-010** — Codex import: account_id←account_id, plan←plan_type, then `apply_claims` (JWT claims fill workspace/plan/email when present) — `import.rs:210`
- **IMP-011** — Id assigned after identity fields are set — `import.rs:218`
- **IMP-012** — `linked_tokens(link)`: tool `cliproxyapi` reads and parses the file (`reading <path>` / `parsing <path>` errors); any other tool → `cannot follow logins from <tool>` — `import.rs:166`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `import.rs` (1):
  - `reads_cliproxyapi_files` — `import.rs:236`

---

## PROV — providers (`provider/`)

### Registry, Spec, matching (`provider/mod.rs`)

| id          | title            | api                                     | dialects           | models                                  | billing               | agent_only | refresh_lead | credential       |
| ----------- | ---------------- | --------------------------------------- | ------------------ | --------------------------------------- | --------------------- | ---------- | ------------ | ---------------- |
| `claude`    | `Claude`         | `https://api.anthropic.com`             | messages           | `claude-*`                              | Subscription          | `claude`   | 1 h          | OAuth, no device |
| `codex`     | `ChatGPT`        | `https://chatgpt.com/backend-api/codex` | responses          | `gpt-*`, `codex-*`, `o1*`, `o3*`, `o4*` | Subscription          | —          | 24 h         | OAuth + device   |
| `anthropic` | `Anthropic API`  | `https://api.anthropic.com`             | messages           | `claude-*`                              | Metered, backs claude | `claude`   | 0            | Key (required)   |
| `openai`    | `OpenAI API`     | `https://api.openai.com/v1`             | responses, chat    | same as codex                           | Metered, backs codex  | —          | 0            | Key (required)   |
| `xai`       | `xAI API`        | `https://api.x.ai/v1`                   | chat               | `grok-*`                                | Metered, backs none   | —          | 0            | Key (required)   |
| `compat`    | `Compatible API` | `""` (per account)                      | `[]` (per account) | `[]` (per account)                      | Metered, backs none   | —          | 0            | Key (optional)   |

- **PROV-001** — `ProviderId` serialized lowercase (`"claude"`, `"codex"`, `"anthropic"`, `"openai"`, `"xai"`, `"compat"`); `ALL` order Claude, Codex, Anthropic, OpenAI, Xai, Compat (subscriptions first: the order requests try them) and that order is also the sort order (`Ord`) — `provider/mod.rs:43`
- **PROV-002** — Parsing an unknown id → `expected one of claude, codex, anthropic, openai, xai, compat, got "<s>"` — `provider/mod.rs:91`
- **PROV-003** — Spec table above, per provider — `provider/claude/mod.rs:25`, `provider/codex/mod.rs:29`, `provider/keys.rs:45`, `provider/compat.rs:19`
- **PROV-004** — `Spec::is_subscription()` iff billing is Subscription; `device_login()` iff credential is `OAuth{device:true}` — `provider/mod.rs:134`
- **PROV-005** — Every Metered `backs` points at a subscription provider — `provider/mod.rs:402`
- **PROV-006** — `matches(pattern, model)`: `*` matches any run (including empty); first segment anchors at start, last at end, middle segments matched leftmost in order, last segment may not overlap a middle match (`ab*b*ab` ≠ `abab`); no `*` means exact equality; `""` matches only `""` — `provider/mod.rs:169`
- **PROV-007** — `Reading { limits, plan? }`; `UsageError::{Unauthorized, Other}` — `provider/mod.rs:190`
- **PROV-008** — Usage endpoint body handling: 401 → Unauthorized; other non-2xx → Other `usage endpoint returned <status>: <first 200 chars of body>`; non-JSON → Other; network error → Other — `provider/mod.rs:206`
- **PROV-009** — `Verdict` variants: Final, Unauthorized, Forbidden, StaleState, Exhausted{until?, model?}, Throttled{until?}; `of_status`: 401→Unauthorized, 403→Forbidden, else Final; `Refusal` converts one-to-one — `provider/mod.rs:226`
- **PROV-010** — Provider trait defaults: refresh → Revoked `<title> keys cannot be refreshed`; identify no-op; usage → Other `<title> has no usage windows`; api = spec.api; dialects = spec.dialects; serves = any spec model pattern matches; rebind → None; shape no-op; limits → None; show_pool no-op; credits → None; catalog → empty — `provider/mod.rs:266`

### Claude (`provider/claude/`)

- **PROV-011** — Claude identity = org_id, else account_id — `provider/claude/mod.rs:44`
- **PROV-012** — OAuth constants: client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`; authorize `https://claude.ai/oauth/authorize`; token `https://platform.claude.com/v1/oauth/token`; profile `https://api.anthropic.com/api/oauth/profile`; scopes `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`; callback `http://localhost:54545/callback`; beta flag `oauth-2025-04-20` — `provider/claude/oauth.rs:15`
- **PROV-013** — Authorize URL query, in order: `code=true`, `client_id`, `response_type=code`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `state`; form-encoded (space → `+`, `:`/`/` percent-encoded) — `provider/claude/oauth.rs:33`
- **PROV-014** — Claude login: PKCE + state, browser_login titled `Claude` on port 54545 path `/callback`; exchange uses the returned state if any, else the generated one — `provider/claude/oauth.rs:129`
- **PROV-015** — Code exchange: JSON POST `{grant_type:"authorization_code", code, redirect_uri, client_id, code_verifier, state}`; non-2xx → `token exchange failed (<status>): <body>`; unparsable → `unexpected token response`; `expires_at = now + expires_in`; account/org uuid, email_address, org name copied from the token answer — `provider/claude/oauth.rs:140`
- **PROV-016** — After exchange, profile lookup (GET with bearer + `anthropic-beta: oauth-2025-04-20`, non-2xx is an error); success applies profile (profile email wins), failure only logs `profile lookup failed: <e>` and keeps token identity — `provider/claude/oauth.rs:167`
- **PROV-017** — `Profile::plan()`: base = `organization_type` minus `claude_` prefix, else `max` if `account.has_claude_max`, else `pro` if `has_claude_pro`, else None; for `max`, append ` <mult>` when the last `_` segment of `rate_limit_tier` ends with `x` (`default_claude_max_20x` → `max 20x`); multipliers never qualify other plans — `provider/claude/oauth.rs:112`
- **PROV-018** — `apply_profile` only overwrites with non-empty values (account_id, email, org_id, org_name, plan); never erases — `provider/claude/oauth.rs:188`
- **PROV-019** — Claude refresh: JSON POST `{grant_type:"refresh_token", refresh_token, client_id, scope:SCOPES}`; success parse failure → Transient; non-2xx → `RefreshError::classify` — `provider/claude/oauth.rs:203`
- **PROV-020** — Claude `identify` re-fetches the profile and applies it; failures change nothing — `provider/claude/mod.rs:68`
- **PROV-021** — Claude usage: `GET https://api.anthropic.com/api/oauth/usage` with bearer and `anthropic-beta: oauth-2025-04-20`; plan not reported (None) — `provider/claude/mod.rs:119`
- **PROV-022** — Claude upstream headers: `forwardable(client)` (drops hop-by-hop, `x-slopmax-*`, `host`, `content-length`, `authorization`, `x-api-key`, `cookie`), sets `anthropic-beta` to the client's list (split on `,`, trimmed, blanks dropped) with `oauth-2025-04-20` appended once if missing, joined with `,` (no spaces), and `authorization: Bearer <token>`; everything else (user-agent, accept-encoding, x-app, body) untouched — `provider/claude/wire.rs:13`, `proxy/mod.rs:493`
- **PROV-023** — `client_agent(headers)`: user-agent starting `claude-cli/` and ≤ 200 bytes, else None — `provider/claude/wire.rs:42`
- **PROV-024** — Claude header windows: `anthropic-ratelimit-unified-{5h,7d}-utilization` (0–1 fraction ×100) and `-reset` (unix seconds); window omitted when its utilization header is missing; none → no Limits — `provider/claude/limits.rs:15`
- **PROV-025** — Claude `pool_headers`: remove every `anthropic-ratelimit-unified-*` header; for each pool window with span 5h/7d set `-<k>-utilization` = clamp(used/100, 0, 0.99) formatted with 2 decimals, `-<k>-status` = `allowed_warning` past 0.75 (else `allowed`), `-<k>-reset` (if known), `-<k>-surpassed-threshold` = `0.95` or `0.75` (highest passed); other spans skipped; then for the fullest window set `anthropic-ratelimit-unified-status` (`allowed_warning` when used ≥ 75 else `allowed`), `-representative-claim` (`five_hour`/`seven_day`) only when warning, `-reset` if known; other headers kept — `provider/claude/limits.rs:34`
- **PROV-026** — Claude usage endpoint parse: `five_hour`→5h, `seven_day`→7d (utilization in percent, `resets_at` ISO or number); `limits[]` items with `kind=="weekly_scoped"` and `scope.model.display_name` + `percent` → 7d window scoped to that model; legacy top-level `seven_day_opus`→`Opus`, `seven_day_sonnet`→`Sonnet` only if no scoped window for that model; `observed_at = now`, no credits — `provider/claude/limits.rs:101`
- **PROV-027** — `fast_mode_refused(headers, body)`: false if `5h-status` or `7d-status` is `rejected`; else message = lowercased `error.message` (or whole body) contains `fast request rejected`, or contains `fast` and (`usage credits` or `credits are required`) — `provider/claude/limits.rs:156`
- **PROV-028** — Claude 429 refusal: if 5h or 7d status rejected → Exhausted(account-wide) until max of those rejected resets, retry-after and unified reset, keeping only times after now (None if none); else if unified `status` rejected → Exhausted until max(`7d_oi` reset, unified reset, retry-after) > now, scoped to the request's model only when overage-only (`7d_oi-status` rejected, or `overage-status` rejected, or `representative-claim` contains `overage`); else Throttled until retry-after — `provider/claude/limits.rs:177`
- **PROV-029** — Claude verdict: 429 + fast-mode refusal → Final (the request's problem, accounts stay healthy); other 429 → refusal; else `of_status` — `provider/claude/mod.rs:100`
- **PROV-030** — Claude limit resets ("cedar_ember"): `counted()=false` (listed hourly, not on count change), `needs_agent()=true`; without a seen Claude Code user agent both list and redeem fail with `Claude answers limit resets to Claude Code alone, and none of its requests has come through slopmax yet` — `provider/claude/credits.rs:39`
- **PROV-031** — Claude listing: `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` with bearer, `anthropic-beta: oauth-2025-04-20`, and `user-agent: <last seen claude-cli UA>`; non-2xx → `listing limit resets failed (<status>)`; non-JSON → `unexpected usage reply`; logs `Claude would not list its limit resets (<reason>)` when `eligible:false` and `ineligible_reason` is `surface` or `cli_version` — `provider/claude/credits.rs:83`
- **PROV-032** — `available(body)`: non-object → error `unexpected usage reply`; missing/null `cedar_ember` → empty; non-object → `unexpected limit reset status`; grants with valid id (1–40 chars of `[a-z0-9_-]`) and `resets_left` > 0, not expired (`ends_at` > now); sorted: `next_grant_id` first, then by `ends_at` (none last); one Credit per remaining reset, capped at 20 per grant; title = label whitespace-collapsed, control chars removed, ≤120 chars, empty → None; `granted_at`←`starts_at`, `expires_at`←`ends_at` — `provider/claude/credits.rs:105`
- **PROV-033** — Claude redeem: requires `org_id` that is a canonical UUID (36 chars, dashes at 8/13/18/23, hex elsewhere) else `the account's organization is unknown; sign in again`; credit id given or first listed (none → Outcome NoCredit); `POST /api/organizations/<org>/reset_rate_limits` JSON `{program:"cedar_ember", grant_id, request_id:<uuid v4>}` as Claude Code; up to 2 tries on network errors reusing the same request_id; non-2xx → `using a limit reset failed (<status>)`; unparsable → `unexpected reply to using a limit reset` — `provider/claude/credits.rs:201`
- **PROV-034** — Claude claim outcomes: result `reset`→Reset; `not_limited`→NothingToReset; `already_used`→AlreadyRedeemed; reason `no_grant|unknown_grant|expired`→NoCredit; anything else → Declined (logged `Claude kept its limit reset (<result>, <reason or "no reason given">)`) — `provider/claude/credits.rs:186`

### Codex / ChatGPT (`provider/codex/`)

- **PROV-035** — Codex identity = account_id (ChatGPT workspace) — `provider/codex/mod.rs:48`
- **PROV-036** — OAuth constants: client id `app_EMoamEEZ73f0CkXaXp7hrann`; issuer `https://auth.openai.com`; scopes `openid profile email offline_access`; callback `http://localhost:1455/auth/callback`; device verify URL `https://auth.openai.com/codex/device`; device redirect `https://auth.openai.com/deviceauth/callback`; device timeout 15 min — `provider/codex/oauth.rs:18`
- **PROV-037** — Authorize URL `https://auth.openai.com/oauth/authorize?` with params in order `response_type=code`, `client_id`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `prompt=login`, `state`, `originator=codex_cli_rs` — `provider/codex/oauth.rs:38`
- **PROV-038** — Codex login: `device` → device flow; else PKCE browser login titled `ChatGPT` on 1455 `/auth/callback`, exchange with the local redirect URI — `provider/codex/oauth.rs:57`
- **PROV-039** — Code exchange: form POST `/oauth/token` with `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier`; errors as Claude (`token exchange failed (<status>): <body>`, `unexpected token response`); `expires_at` = JWT `exp` of the access token; then `apply_claims` — `provider/codex/oauth.rs:89`
- **PROV-040** — `apply_claims`: look in id_token claims then access-token claims; workspace ← `["https://api.openai.com/auth"].chatgpt_account_id`, plan ← `...chatgpt_plan_type`, email ← top-level `email` else `["https://api.openai.com/profile"].email`; empty strings ignored; existing values kept when absent; then re-assign id — `provider/codex/oauth.rs:122`
- **PROV-041** — Codex refresh: JSON POST `/oauth/token` with exactly `{client_id, grant_type:"refresh_token", refresh_token}` (no scope); classify as AUTH-003 — `provider/codex/oauth.rs:153`
- **PROV-042** — Device login: POST `/api/accounts/deviceauth/usercode` `{client_id}`; non-2xx → `device login is unavailable`; `user_code` also accepted as `usercode`; `interval` number or numeric string, default 5, min 1 second; emits `DeviceCode{url: verify URL, code}`; polls POST `/api/accounts/deviceauth/token` `{device_auth_id, user_code}` after each sleep; 403/404 = pending; 2xx → `{authorization_code, code_verifier}` exchanged with the device redirect URI; other status → `device login failed (<status>): <body>`; past 15 min → `device code expired; run login again` — `provider/codex/oauth.rs:196`
- **PROV-043** — Codex `identify` = `apply_claims` (no network) — `provider/codex/mod.rs:69`
- **PROV-044** — Codex upstream headers: forwardable + `authorization: Bearer <token>`, `chatgpt-account-id` when known, drop `x-codex-turn-state` when the session moved, force `accept-encoding: identity`, add `version: <x.y.z>` from a `codex*/<x.y.z>` user agent when the client sent no `version` — `provider/codex/wire.rs:13`
- **PROV-045** — `client_version`: product before `/` must start with `codex`; version = leading digits/dots; must have exactly 3 dot parts — `provider/codex/wire.rs:44`
- **PROV-046** — `strip_account_state(body)` (rebind): parse JSON; remove top-level `previous_response_id` and `encrypted_content` from `input[]` items whose `type=="reasoning"`; keep summaries and key order; None when nothing removed or not JSON — `provider/codex/wire.rs:66`
- **PROV-047** — `rejects_account_state(body)` (case-insensitive): contains `encrypted content`, `invalid_encrypted_content`, `not issued to this caller`, or (`item with id` and `not found`) — `provider/codex/wire.rs:84`
- **PROV-048** — `reports_usage_limit(body)` (case-insensitive): `usage_limit_reached` or `usage limit has been reached` — `provider/codex/wire.rs:94`
- **PROV-049** — Codex `shape`: removes `max_output_tokens` from translated object bodies; non-objects untouched — `provider/codex/mod.rs:95`
- **PROV-050** — Codex verdict: 429/402 → refusal (PROV-055); 400 with account-state rejection → StaleState; any 5xx whose body reports a usage limit → Exhausted{None,None}; else `of_status` — `provider/codex/mod.rs:110`
- **PROV-051** — Codex header windows: `x-codex-{primary,secondary}-used-percent` (required per slot), `-window-minutes` (span by length: <1 day→5h, ≥28 days→30d, else 7d; missing → 7d), `-reset-at` (unix seconds) — `provider/codex/limits.rs:13`
- **PROV-052** — Codex `pool_headers`: remove `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at,reset-after-seconds,over-secondary-limit-percent}`; fill primary then secondary from pool windows in order: `used-percent` with 1 decimal (`60.0`), `window-minutes` (300/10080/43200), `reset-at` when known; other `x-codex-*` headers (e.g. `x-codex-credits-has-credits`) kept — `provider/codex/limits.rs:30`
- **PROV-053** — `pool_event` for `codex.rate_limits` socket events: only when `rate_limits` is an object; sets `primary`/`secondary` to `{used_percent (1 dp), window_minutes, reset_at|null}` or null; `limit_reached` = any pool window ≥ 100; `allowed` = its negation; other event fields kept — `provider/codex/limits.rs:63`
- **PROV-054** — `from_event`: reads `rate_limits.{primary,secondary}` objects with `used_percent`, `window_minutes`, `reset_at`; null slots skipped; none → None — `provider/codex/limits.rs:85`
- **PROV-055** — Codex refusal: error object = `body.error` or body; kind = `type` else `code`; exhausted if status 402 or kind in {`usage_limit_reached`, `usage_limit_exceeded`, `usage_not_included`, `insufficient_quota`}; else Throttled(retry-after); exhausted until = body `resets_at` (unix/ISO) or `now+resets_in_seconds`, used only if in the future, else header windows' `exhausted_until`, else retry-after; never model-scoped — `provider/codex/limits.rs:135`
- **PROV-056** — Codex usage: `GET https://chatgpt.com/backend-api/wham/usage` with bearer and `chatgpt-account-id` when known; windows from `rate_limit.{primary,secondary,tertiary}_window` (`used_percent`, `limit_window_seconds` → span, `reset_at` else `now + reset_after_seconds`); null windows skipped; `reset_credits` ← `rate_limit_reset_credits.available_count`; plan ← `plan_type` — `provider/codex/mod.rs:169`, `provider/codex/limits.rs:102`
- **PROV-057** — Codex catalog: `GET /backend-api/codex/models?client_version=<version>` with bearer and workspace header; non-2xx is an error; returns `models[].slug` except `visibility=="hide"` and entries without slug — `provider/codex/mod.rs:147`
- **PROV-058** — Codex reset credits (`counted()=true`, `needs_agent()=false`): list `GET /wham/rate-limit-reset-credits` (bearer + workspace if known); non-2xx → `listing reset credits failed (<status>)`; bad JSON → `unexpected reset credit list`; keep status empty or `available` (case-insensitive) and `reset_type` absent or `codex_rate_limits`; sort by `expires_at` (none last) — `provider/codex/credits.rs:78`
- **PROV-059** — Codex redeem: `POST /wham/rate-limit-reset-credits/consume` JSON `{redeem_request_id:<uuid v4>, credit_id?}`; 2 tries on network error with the same id; non-2xx → `redeeming a reset credit failed (<status>)`; answer `{code: reset|nothing_to_reset|no_credit|already_redeemed|declined}` (snake_case Outcome), bad JSON → `unexpected redeem response` — `provider/codex/credits.rs:112`

### Reset credits trait (`provider/credits.rs`)

- **PROV-060** — `Credit { id, title?, granted_at?, expires_at? }` (optional fields omitted in JSON); `Outcome` snake_case: `reset`, `nothing_to_reset`, `no_credit`, `already_redeemed`, `declined` — `provider/credits.rs:19`
- **PROV-061** — `ResetCredits` defaults: `counted()=true`, `needs_agent()=false`; `list` returns spend order; `redeem(credit?)` spends the named one or the provider's next — `provider/credits.rs:49`

### API keys (`provider/keys.rs`)

- **PROV-062** — `KeyHeader::for_dialect`: Messages → `x-api-key`; Responses/Chat → `authorization: Bearer` — `provider/keys.rs:29`
- **PROV-063** — Key provider identity = the key itself (so ids are `anthropic-…`, `openai-…`, `xai-…` from the key hash) — `provider/keys.rs:109`
- **PROV-064** — Key login: missing or empty key → `no <title> key entered` (e.g. `no OpenAI API key entered`); checks the key against the models URL (`https://api.anthropic.com/v1/models`, `https://api.openai.com/v1/models`, `https://api.x.ai/v1/models`) with the first dialect's header; stores the key as a never-expiring access token — `provider/keys.rs:113`
- **PROV-065** — `with_key(client, header, key)`: forwardable headers; empty key adds no credential; else `x-api-key: <key>` or `authorization: Bearer <key>` — `provider/keys.rs:165`
- **PROV-066** — `check(url, header, key)`: GET with `x-api-key` + `anthropic-version: 2023-06-01` or bearer (no credential when key empty); network error → warn `could not check the key against <url>: <e>`, Ok(None); 2xx → Some(ids from `data[].id`) or None if body is not JSON; 401/403 → error `<url> rejected the key (<status>)`; other statuses → warn `could not check the key: <url> answered <status>`, Ok(None) — `provider/keys.rs:183`
- **PROV-067** — Key catalog = `check(...)` ids or empty; rejected key → error — `provider/keys.rs:139`
- **PROV-068** — `metered_verdict`: looks at first 4096 body bytes; out of funds = contains `insufficient_quota`, `credit balance`, or `exceeded your current quota`; 402 → Exhausted; 400/429 out of funds → Exhausted; 429/503/529 → Throttled(retry-after); else `of_status` — `provider/keys.rs:234`

### Compatible endpoints (`provider/compat.rs`)

- **PROV-069** — Compat identity = `"<base_url> <key>"` (so one server under two keys is two accounts); no endpoint → None — `provider/compat.rs:37`
- **PROV-070** — Compat login: no endpoint → `a compatible endpoint needs its address: --url <base url>`; key optional (empty → no credential); check models URL (base without trailing `/` + `/v1/models` for messages, `/models` otherwise); named models kept, else listed ids; none → `could not list the models at <base_url>; name them with --models`; rejected key → error — `provider/compat.rs:45`
- **PROV-071** — Compat api/dialects/serves come from the account's endpoint (none → `""`, `[]`, serves nothing); headers use the endpoint dialect's key header, Chat (bearer) without an endpoint — `provider/compat.rs:78`
- **PROV-072** — Compat catalog lists named models only (patterns containing `*` skipped) — `provider/compat.rs:92`
- **PROV-073** — Compat verdict = `metered_verdict` — `provider/compat.rs:128`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `provider/mod.rs` (7):
  - `patterns_match_with_wildcards` — `provider/mod.rs:381`
  - `registry_ids_are_unique_and_round_trip` — `provider/mod.rs:395`
  - `unknown_ids_list_the_known_ones` — `provider/mod.rs:410`
  - `edge_patterns` — `provider/mod.rs:421`
  - `specs_say_how_accounts_sign_in_and_pay` — `provider/mod.rs:432`
  - `refusals_become_verdicts` — `provider/mod.rs:445`
  - `subscriptions_without_a_catalog_list_nothing` — `provider/mod.rs:465`
- `provider/claude/mod.rs` (7):
  - `accounts_are_keyed_by_organization_then_account` — `provider/claude/mod.rs:165`
  - `requests_carry_the_token_and_the_oauth_beta` — `provider/claude/mod.rs:175`
  - `windows_come_from_headers_and_the_pool_replaces_them` — `provider/claude/mod.rs:190`
  - `verdicts_tell_spent_windows_from_fast_mode_and_auth` — `provider/claude/mod.rs:222`
  - `usage_reads_both_windows` — `provider/claude/mod.rs:275`
  - `new_tokens_bring_the_profile` — `provider/claude/mod.rs:304`
  - `unreachable_usage_endpoints_are_other_failures` — `provider/claude/mod.rs:318`
- `provider/claude/oauth.rs` (11):
  - `authorize_url_carries_pkce_and_scopes` — `provider/claude/oauth.rs:236`
  - `plan_from_profile` — `provider/claude/oauth.rs:247`
  - `apply_profile_never_erases_identity` — `provider/claude/oauth.rs:266`
  - `plans_read_the_organization_first` — `provider/claude/oauth.rs:284`
  - `profiles_fill_identity_but_skip_blanks` — `provider/claude/oauth.rs:306`
  - `exchanges_codes_for_an_identified_account` — `provider/claude/oauth.rs:350`
  - `a_failed_profile_lookup_keeps_the_token_identity` — `provider/claude/oauth.rs:377`
  - `failed_exchanges_say_why` — `provider/claude/oauth.rs:387`
  - `refresh_classifies_the_token_endpoints_answer` — `provider/claude/oauth.rs:405`
  - `profiles_need_a_working_token` — `provider/claude/oauth.rs:429`
  - `logs_in_with_a_pasted_code_and_state` — `provider/claude/oauth.rs:435`
- `provider/claude/wire.rs` (3):
  - `oauth_beta_is_added_once` — `provider/claude/wire.rs:58`
  - `claude_code_is_known_by_its_agent` — `provider/claude/wire.rs:73`
  - `only_the_credential_changes` — `provider/claude/wire.rs:89`
- `provider/claude/limits.rs` (7):
  - `pool_headers_replace_the_accounts` — `provider/claude/limits.rs:217`
  - `claude_headers_convert_fractions_to_percent` — `provider/claude/limits.rs:302`
  - `claude_usage_reads_shared_and_scoped_windows` — `provider/claude/limits.rs:317`
  - `claude_refusal_blocks_until_latest_rejected_reset` — `provider/claude/limits.rs:339`
  - `claude_overage_only_refusal_scopes_to_model` — `provider/claude/limits.rs:359`
  - `fast_mode_credit_refusals_are_told_apart` — `provider/claude/limits.rs:378`
  - `claude_plain_429_is_throttling` — `provider/claude/limits.rs:391`
- `provider/claude/credits.rs` (8):
  - `grants_list_one_credit_per_reset_the_next_first` — `provider/claude/credits.rs:267`
  - `a_refused_caller_or_an_account_without_any_lists_none` — `provider/claude/credits.rs:312`
  - `claims_answer_as_outcomes` — `provider/claude/credits.rs:338`
  - `only_a_uuid_names_the_organization` — `provider/claude/credits.rs:362`
  - `nothing_is_listed_or_spent_before_claude_code_is_seen` — `provider/claude/credits.rs:390`
  - `failures_name_the_step_that_failed` — `provider/claude/credits.rs:407`
  - `unreachable_servers_fail_after_a_retry` — `provider/claude/credits.rs:451`
  - `odd_usage_replies_are_errors_or_empty` — `provider/claude/credits.rs:465`
- `provider/codex/mod.rs` (7):
  - `requests_carry_the_token_and_workspace` — `provider/codex/mod.rs:211`
  - `translated_requests_drop_output_limits_and_moved_state` — `provider/codex/mod.rs:228`
  - `verdicts_cover_limits_stale_state_and_disguised_limits` — `provider/codex/mod.rs:244`
  - `windows_come_from_headers_and_the_pool_replaces_them` — `provider/codex/mod.rs:301`
  - `new_tokens_are_read_for_identity` — `provider/codex/mod.rs:331`
  - `usage_reads_windows_plan_and_credits` — `provider/codex/mod.rs:367`
  - `the_catalog_lists_visible_models` — `provider/codex/mod.rs:392`
- `provider/codex/oauth.rs` (9):
  - `authorize_url_uses_registered_redirect` — `provider/codex/oauth.rs:250`
  - `claims_fill_identity_leniently` — `provider/codex/oauth.rs:259`
  - `email_falls_back_to_access_token_profile_claim` — `provider/codex/oauth.rs:282`
  - `exchanges_codes_for_an_account_named_by_its_claims` — `provider/codex/oauth.rs:342`
  - `failed_exchanges_say_why` — `provider/codex/oauth.rs:372`
  - `refresh_sends_json_and_classifies_failures` — `provider/codex/oauth.rs:389`
  - `device_codes_sign_in_once_approved` — `provider/codex/oauth.rs:433`
  - `device_logins_report_failures` — `provider/codex/oauth.rs:466`
  - `browser_logins_accept_a_pasted_redirect` — `provider/codex/oauth.rs:485`
- `provider/codex/wire.rs` (3):
  - `upstream_headers_swap_credentials_and_add_version` — `provider/codex/wire.rs:112`
  - `strips_encrypted_reasoning_but_keeps_summaries` — `provider/codex/wire.rs:134`
  - `recognizes_account_state_rejections` — `provider/codex/wire.rs:151`
- `provider/codex/limits.rs` (6):
  - `pool_headers_and_events_describe_the_pool` — `provider/codex/limits.rs:190`
  - `websocket_rate_limit_events` — `provider/codex/limits.rs:231`
  - `codex_headers_classify_by_window_length` — `provider/codex/limits.rs:254`
  - `codex_usage_reads_windows_plan_and_reset_credits` — `provider/codex/limits.rs:269`
  - `codex_usage_limit_uses_body_reset` — `provider/codex/limits.rs:289`
  - `codex_rate_limit_is_throttling` — `provider/codex/limits.rs:310`
- `provider/codex/credits.rs` (2):
  - `only_codex_window_credits_count` — `provider/codex/credits.rs:144`
  - `listing_and_redeeming_report_failures` — `provider/codex/credits.rs:181`
- `provider/credits.rs`: no tests
- `provider/keys.rs` (9):
  - `keys_replace_the_slopmax_key` — `provider/keys.rs:269`
  - `verdicts_tell_funds_from_rate_limits` — `provider/keys.rs:284`
  - `model_lists_read_either_shape` — `provider/keys.rs:319`
  - `key_accounts_are_named_by_their_tail` — `provider/keys.rs:326`
  - `logging_in_checks_the_key_with_the_vendor` — `provider/keys.rs:379`
  - `checks_tolerate_outages_and_open_endpoints` — `provider/keys.rs:422`
  - `catalogs_list_what_the_key_can_use` — `provider/keys.rs:458`
  - `keys_have_no_windows_refreshes_or_state` — `provider/keys.rs:483`
  - `overload_throttles_briefly` — `provider/keys.rs:539`
- `provider/compat.rs` (7):
  - `endpoints_are_the_accounts_data` — `provider/compat.rs:165`
  - `logins_list_the_models_when_none_are_named` — `provider/compat.rs:225`
  - `named_models_survive_an_endpoint_that_cannot_list` — `provider/compat.rs:250`
  - `logins_need_an_address` — `provider/compat.rs:277`
  - `catalogs_name_models_but_not_patterns` — `provider/compat.rs:286`
  - `accounts_without_an_endpoint_serve_nothing` — `provider/compat.rs:294`
  - `keys_go_in_the_header_the_dialect_expects` — `provider/compat.rs:310`

---

## LIM — usage windows and refusals (`limits.rs`)

- **LIM-001** — `Window { span: "5h"|"7d"|"30d", model?, used (0–100, clamped on construction), resets_at? }`; JSON omits `model`/`resets_at` when absent — `limits.rs:16`
- **LIM-002** — `used_at(now)`: 0 once `resets_at <= now`, else `used` — `limits.rs:40`
- **LIM-003** — `upcoming_reset(now)` only when strictly after now; `is_full` = `used_at ≥ 100` — `limits.rs:48`
- **LIM-004** — `label()`: `<span>` or `<span> <model>` (`7d Fable`) — `limits.rs:57`
- **LIM-005** — `span_for(seconds)`: < 86 400 → `5h`; ≥ 28 days → `30d`; else `7d` — `limits.rs:71`
- **LIM-006** — `Limits { windows[], observed_at?, reset_credits? (u32) }`, JSON omits empty/absent — `limits.rs:82`
- **LIM-007** — `Lapse { span, model?, used, ended_at }` (windows.jsonl lines) — `limits.rs:95`
- **LIM-008** — `UNKNOWN_SCORE = 101.0` (no data: worse than any reading but selectable) — `limits.rs:106`
- **LIM-009** — `STALE_AFTER = 5 min`: a full window without a future reset only counts while the reading is < 5 min old — `limits.rs:109`
- **LIM-010** — `Limits::observed(windows, now)`: None when empty — `limits.rs:113`
- **LIM-011** — `merge(newer)`: drop old windows of the same (span, model) slot as any newer window, and old windows whose reset ≤ newer.observed_at (or now); append newer; sort by span rank (5h, 7d, other) then model (None first); observed_at = newer's or old; reset_credits replaced only when newer has one — `limits.rs:123`
- **LIM-012** — `lapsed(newer, now)`: each old window with a reset that has passed (`≤ now`) or whose slot in `newer` resets more than 1 h after the old reset (a new period) — reported with old `used` and `ended_at` — `limits.rs:141`
- **LIM-013** — `score(now)` = max `used_at` over shared (non-model) windows, else 101 — `limits.rs:167`
- **LIM-014** — `exhausted_until(now)` = latest upcoming reset among full shared windows (fresh or with future reset); `is_exhausted` = any such full window — `limits.rs:187`
- **LIM-015** — `urgency(now)`: `week_ending` = soonest reset of a non-5h shared window with ≤ 90% used (URGENT_SPARE 10) resetting within 24 h (URGENT); `short` = soonest reset of a started (used > 0), not full 5h window; `long` = soonest reset of a not-full non-5h window; `key()` sorts by (week_ending, short, long), None last — `limits.rs:201`
- **LIM-016** — `expiring_at(now)` = week_ending ?? short ?? long — `limits.rs:231`
- **LIM-017** — `PoolWindow { span, used, resets_at? }`; `minutes()`: 5h→300, 30d→43 200, else 10 080 — `limits.rs:265`
- **LIM-018** — `pooled`/`pooled_by`: for spans 5h, 7d, 30d: each account with a shared window of that span contributes `used_at`, or 100 if blocked and this is its shortest span; weighted mean (weights default 1; skip span if no readings or total weight ≤ 0); `resets_at` = soonest upcoming reset among readings with used > 0 — `limits.rs:289`
- **LIM-019** — Header helpers: values trimmed; f64 must be finite; time headers are unix seconds (fraction truncated) — `limits.rs:344`
- **LIM-020** — `retry_after(headers, now)`: numeric seconds (negative clamped to 0, fractional allowed) → now + secs; else HTTP-date — `limits.rs:362`
- **LIM-021** — `parse_time(json)`: string → RFC 3339 (any offset, fractional seconds), number → unix seconds; else None — `limits.rs:370`
- **LIM-022** — `Refusal::{Exhausted{until?, model?}, Throttled{until?}}` — `limits.rs:380`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `limits.rs` (5):
  - `elapsed_windows_start_over` — `limits.rs:400`
  - `pools_read_as_one_account` — `limits.rs:421`
  - `unknown_usage_scores_above_full` — `limits.rs:467`
  - `a_window_lapses_once_its_reset_passes_or_a_new_period_shows` — `limits.rs:473`
  - `expiring_at_prefers_started_windows_with_headroom` — `limits.rs:506`

---

## AGT — agents, run/env/setup/undo, backups (`agent/`)

### Registry and shared behavior (`agent/mod.rs`)

- **AGT-001** — `AGENTS = [ClaudeCode, Codex]` (order matters for `detect`); ids `claude`, `codex`; titles `Claude Code`, `Codex`; providers Claude, Codex — `agent/mod.rs:36`
- **AGT-002** — Every subscription provider has exactly one native agent and every `agent_only` names a registered agent — `agent/mod.rs:226`
- **AGT-003** — `find(id)` by CLI id; unknown (e.g. `gemini`) → None — `agent/mod.rs:39`
- **AGT-004** — `detect(headers)` = first agent whose `detect` matches — `agent/mod.rs:44`
- **AGT-005** — `session(agent?, headers, body)`: with an agent, its own rule; else first of headers `session-id`, `session_id`, `x-session-id`, else body `prompt_cache_key` (top-level string, via rawjson scan) — `agent/mod.rs:50`
- **AGT-006** — `servable(agent, accounts)`: any account of the agent's provider, or a Metered account that `backs` it — `agent/mod.rs:115`
- **AGT-007** — `wiring(agent, config)`: `wired_to()` containing `config.base_url()` or starting with `slopmax` → Slopmax; other value → Elsewhere(value); None → Direct — `agent/mod.rs:136`
- **AGT-008** — `run(agent, config, args)`: Unix replaces the process (`exec`), failure → `could not start <program>: <err>`; non-Unix spawns and waits, returning the exit code (1 if none), spawn failure `could not start <program>` — `agent/mod.rs:147`
- **AGT-009** — Setup backup file `$SLOPMAX_HOME/setup-backup.json`: JSON object agent-id → saved value — `agent/mod.rs:166`
- **AGT-010** — The agent config path is canonicalized (symlinks followed so the target is edited in place, link kept); a missing path is used as-is — `agent/mod.rs:173`
- **AGT-011** — `setup(agent, config)`: load backup (missing = empty); if the agent has no saved entry, the agent records what it replaces and the backup is written; a repeated setup keeps the original backup; returns the edited file path — `agent/mod.rs:182`
- **AGT-012** — `undo(agent)`: no saved entry → `no <title> setup to undo`; else agent.undo, then remove the entry and rewrite the backup — `agent/mod.rs:197`
- **AGT-013** — `shell_quote(s)`: unchanged when non-empty and every char is ASCII alphanumeric or one of `-_./:=@`; else single-quoted with `'` → `'\''`; empty → `''` — `agent/mod.rs:210`

### Claude Code (`agent/claude_code.rs`)

- **AGT-014** — Detect: user-agent starts with `claude-cli/` or `claude-code/` (CLI, Agent SDK, IDE, desktop) — `agent/claude_code.rs:62`
- **AGT-015** — Session: header `x-claude-code-session-id`; else body `metadata.user_id` string, which is parsed as JSON for `session_id`, else the legacy form `user_<hash>_account_<uuid>_session_<id>` (text after the last `_session_`) — `agent/claude_code.rs:69`
- **AGT-016** — Env set for `run`/`env`: `ANTHROPIC_BASE_URL=<base_url>`, `ANTHROPIC_AUTH_TOKEN=<api_key>`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, in that order — `agent/claude_code.rs:37`
- **AGT-017** — `run claude`: program `claude`, args passed through, the env above, and `ANTHROPIC_API_KEY` removed from the environment — `agent/claude_code.rs:84`
- **AGT-018** — `env claude` prints `export K=<shell_quote(v)>\n` per variable then `unset ANTHROPIC_API_KEY\n` — `agent/claude_code.rs:93`
- **AGT-019** — Config file `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`) — `agent/claude_code.rs:102`
- **AGT-020** — Setup: settings must be a JSON object (else `<path> is not a JSON object`; missing file = `{}`); `env` created if missing, must be an object (else ``settings.json `env` is not an object``); backup records `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, `ANTHROPIC_API_KEY` (null when absent); sets BASE_URL, AUTH_TOKEN, GATEWAY_MODEL_DISCOVERY=`"1"`; removes `ANTHROPIC_API_KEY`; other keys untouched; written with `write_json` (0600) — `agent/claude_code.rs:106`
- **AGT-021** — Undo: saved value must be an object (else `the saved Claude Code settings are unreadable`); for each saved key, null removes it and a value restores it; if `env` no longer exists the file is rewritten unchanged; a fresh-machine setup+undo leaves `{"env":{}}` — `agent/claude_code.rs:132`
- **AGT-022** — Setup note exact: "Restart Claude Code and the apps that run it. The Claude desktop app's Code tab and Cowork keep using the app's own login." — `agent/claude_code.rs:148`
- **AGT-023** — `wired_to` = `env.ANTHROPIC_BASE_URL` from settings.json — `agent/claude_code.rs:157`
- **AGT-024** — `has_login`: credentials readable from `$CLAUDE_CONFIG_DIR/.credentials.json`, else (macOS only) `security find-generic-password -s "Claude Code-credentials" -w`; payload JSON `claudeAiOauth.{accessToken, refreshToken?, expiresAt? (ms)}` — `agent/claude_code.rs:193`
- **AGT-025** — Import origin text `claude code`; expired login: no refresh token → `login expired; log in again`, else refresh via Claude OAuth (keeping the old refresh token when none rotated); then the profile must load (`could not read the Claude profile`) and is applied — `agent/claude_code.rs:163`, `agent/claude_code.rs:220`

### Codex (`agent/codex.rs`)

- **AGT-026** — Detect: user-agent starts with `codex` — `agent/codex.rs:98`
- **AGT-027** — Session: header `session-id`, else `session_id`, else `x-codex-turn-metadata` header JSON `session_id`, else body `prompt_cache_key` — `agent/codex.rs:107`
- **AGT-028** — Run overrides (each as `-c key=<TOML string>`): `model_provider="slopmax"`, `model_providers.slopmax.name="OpenAI"`, `.base_url="<base_url>/codex"`, `.wire_api="responses"`, `.env_key="SLOPMAX_API_KEY"`, plus `-c model_providers.slopmax.supports_websockets=true` when `websockets` — `agent/codex.rs:42`
- **AGT-029** — Argument placement: if the first user arg is a session subcommand (`exec`, `e`, `review`, `resume`, `fork`) the overrides go right after it; otherwise at the root before the user's args — `agent/codex.rs:70`
- **AGT-030** — `run codex`: program `codex`, env `SLOPMAX_API_KEY=<api_key>` — `agent/codex.rs:123`
- **AGT-031** — `env codex` prints exactly `codex() { <shell_quote(exe)> run codex "$@"; }\n` — `agent/codex.rs:133`
- **AGT-032** — Config file `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) — `agent/codex.rs:138`
- **AGT-033** — Setup (TOML edited preserving comments; missing file = empty doc; unparsable → `parsing <path>`): backup `{"model_provider": <previous or null>}` (a previous value of `slopmax` counts as null); set `model_provider = "slopmax"`; `[model_providers]` created implicit if missing (non-table → `` `model_providers` in config.toml is not a table ``); `[model_providers.slopmax]` replaced with `name="OpenAI"`, `base_url="<base_url>/codex"`, `wire_api="responses"`, `experimental_bearer_token="<api_key>"`, `supports_websockets=true` when websockets on, `requires_openai_auth=true` when `auth.json` exists beside the config; other providers kept; written 0600 — `agent/codex.rs:142`
- **AGT-034** — Undo: restore `model_provider` to the saved string or remove it; remove `[model_providers.slopmax]`; write 0600 — `agent/codex.rs:184`
- **AGT-035** — Setup note exact: "Restart Codex. Quit and reopen the Codex (ChatGPT) desktop app, which reads the same config." — `agent/codex.rs:198`
- **AGT-036** — `has_login`: `$CODEX_HOME/auth.json` parses and has `tokens` — `agent/codex.rs:203`
- **AGT-037** — `wired_to`: `model_provider` value, formatted `<provider> (<base_url>)` when `[model_providers.<provider>].base_url` exists, else the provider name — `agent/codex.rs:211`
- **AGT-038** — Import from `auth.json` (only if the file exists; origin = its path): `tokens.{id_token?, access_token, refresh_token?}`, `last_refresh` → refreshed_at, expiry from the access JWT; no `tokens` → `not a ChatGPT login (API key or proxy auth)`; unparsable → `reading <path>`; claims applied — `agent/codex.rs:225`, `agent/codex.rs:259`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `agent/mod.rs` (4):
  - `registry_ids_are_unique_and_cover_every_subscription` — `agent/mod.rs:226`
  - `sessions_come_from_the_agent_or_common_ids` — `agent/mod.rs:242`
  - `setup_edits_a_symlinked_config_in_place` — `agent/mod.rs:256`
  - `shell_quoting` — `agent/mod.rs:281`
- `agent/claude_code.rs` (10):
  - `session_id_comes_from_header_then_metadata` — `agent/claude_code.rs:261`
  - `detects_every_claude_code_entrypoint` — `agent/claude_code.rs:284`
  - `env_points_at_the_proxy` — `agent/claude_code.rs:300`
  - `setup_round_trips_and_keeps_other_settings` — `agent/claude_code.rs:309`
  - `the_command_runs_claude_through_the_proxy_without_an_api_key` — `agent/claude_code.rs:337`
  - `settings_that_are_not_an_object_are_refused` — `agent/claude_code.rs:360`
  - `setup_on_a_fresh_machine_creates_settings_and_undo_empties_them` — `agent/claude_code.rs:379`
  - `a_live_login_is_imported_with_its_profile` — `agent/claude_code.rs:442`
  - `an_expired_login_is_refreshed_first_and_keeps_its_refresh_token` — `agent/claude_code.rs:457`
  - `logins_that_cannot_be_read_are_errors` — `agent/claude_code.rs:472`
- `agent/codex.rs` (7):
  - `overrides_define_a_custom_provider` — `agent/codex.rs:296`
  - `overrides_sit_at_the_users_level` — `agent/codex.rs:305`
  - `env_hands_off_to_run` — `agent/codex.rs:320`
  - `session_prefers_header_then_metadata_then_cache_key` — `agent/codex.rs:329`
  - `imports_the_codex_login` — `agent/codex.rs:347`
  - `api_key_logins_are_not_imported` — `agent/codex.rs:375`
  - `setup_round_trips_and_keeps_comments` — `agent/codex.rs:385`

---

## ROUTE — model → steps (`route.rs`)

- **ROUTE-001** — `Step { provider, model, accounts: [id] }`; `Table { accounts, aliases, fallbacks, paid_overflow }`; `Request { model, dialect, agent?, default? }` (default = the provider the path belongs to, e.g. `/codex/…` → Codex) — `route.rs:25`
- **ROUTE-002** — `NoRoute::{Refused{provider, agent title}, Unserved{model}, NoModel}` (NoModel is raised by the proxy when there is neither model nor path provider) — `route.rs:55`
- **ROUTE-003** — `plan`: primary = alias of the request model (one level, no chains); fallbacks = `fallbacks[request.model]` else `fallbacks[primary]`, each alias-resolved; models tried primary then fallbacks in order — `route.rs:68`
- **ROUTE-004** — The path's default provider applies to the primary model only, not to fallbacks — `route.rs:80`
- **ROUTE-005** — Steps are deduplicated (an identical step from a fallback is not added twice) — `route.rs:83`
- **ROUTE-006** — When no step survives: the first policy refusal seen (Refused or Unserved from `permitted`) else `Unserved{model: request.model}` (the client's name, not the alias target) — `route.rs:91`
- **ROUTE-007** — `steps_for(model)`: for each provider in `ProviderId::ALL` order, the accounts of that provider that `serve` the model; a Metered provider that backs a subscription is skipped when that subscription has any account and `paid_overflow` is off (with no such subscription, keys serve directly) — `route.rs:105`
- **ROUTE-008** — Selectors are tried only when no provider serves the whole name (so `qwen/qwen3-coder` stays a model when some account serves it): `<provider-id>/<model>` → that provider's accounts (all of them, not checked against serves) with the rest as model, or no step if it has none; else `<account id|label|email>/<model>` → that one account — `route.rs:140`
- **ROUTE-009** — Last resort: the path default provider, if it has accounts, gets every account of that provider with the model as named (Codex sends unclaimed models like `o5-mini` to ChatGPT) — `route.rs:170`
- **ROUTE-010** — `permitted`: a provider with `agent_only` refuses requests whose agent id differs (`Refused{provider, agent: "Claude Code"}`, agent title from the registry); then keeps accounts whose dialects include the client's dialect or one it can be translated into (`can_translate(client, up)` = client ≠ up and up ≠ Messages: nothing is ever translated into Anthropic's format); none → `Unserved{model: step.model}` — `route.rs:187`, `crates/slopmax-wire/src/translate.rs:18`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `route.rs` (4):
  - `subscriptions_come_first_and_keys_only_as_paid_overflow` — `route.rs:307`
  - `claude_models_serve_claude_code_only` — `route.rs:337`
  - `models_find_their_provider_in_the_clients_format` — `route.rs:356`
  - `selectors_aliases_and_fallbacks` — `route.rs:402`

---

## POOL — health, affinity, placement (`pool.rs`)

### state.json (written by the daemon; pretty JSON, 0600)

```jsonc
{
  "accounts": {                          // id → AccountState
    "<id>": {
      "limits": { "windows": [...], "observed_at": "...", "reset_credits": 2 },   // always present (default {})
      "blocked_until": "<ts>",           // optional
      "model_blocks": [{ "model": "...", "until": "<ts>" }],  // omitted when empty
      "throttled_until": "<ts>", "last_used": "<ts>", "last_error": "...",       // optional
      "usage": { ...wire::Usage counters... },                                   // always present
      "credits": { "credits": [Credit...], "listed_at": "<ts>", "counted": 2 }   // optional; counted optional
    }
  },
  "sessions": [{ "provider": "claude", "session": "...", "account": "<id>", "last_used": "<ts>" }], // omitted when empty
  "agents": { "claude": "claude-cli/2.1.0 (external, cli)" }                     // omitted when empty
}
```

- **POOL-001** — `DEFAULT_BLOCK = 5 min` (quota refusal without reset time, or exhausted reading without one); `DEFAULT_THROTTLE = 30 s` — `pool.rs:34`
- **POOL-002** — AccountState/State/CreditList JSON shapes and omission rules as above; every field has a default so older/partial files load — `pool.rs:46`
- **POOL-003** — `credits_left(now)`: count of unexpired listed credits once a list exists, else `limits.reset_credits` or 0 — `pool.rs:84`
- **POOL-004** — `blocked(model, now)`: latest of `blocked_until`, `throttled_until`, quota exhaustion (`exhausted_until` or now+5 min), and blocks for this model, considering only times after now; Ok when none — `pool.rs:100`
- **POOL-005** — `is_blocked` = quota reasons only (blocked_until in future or limits exhausted), not throttling; `limited_until` = max(blocked_until, quota time) — `pool.rs:121`
- **POOL-006** — `Pins` = map provider → account id — `pool.rs:160`
- **POOL-007** — `Routing { strategy, session_ttl (= session_ttl_mins), affinity (= session_affinity) }`; `Routing::of(config)` — `pool.rs:170`
- **POOL-008** — `Pool::new(strategy, ttl, state)`: restores saved sessions younger than ttl, states and agents; affinity starts true — `pool.rs:292`
- **POOL-009** — `set_routing` takes effect for later picks; bound sessions keep their accounts if affinity stays on — `pool.rs:328`
- **POOL-010** — `sync(accounts, pins)`: replace accounts and pins; drop session bindings to accounts no longer present and all bindings of providers whose pin changed — `pool.rs:340`
- **POOL-011** — `saw_agent(provider, ua)` records the provider's own client UA (marks dirty only on change); `agent(provider)` returns it — `pool.rs:363`
- **POOL-012** — `pick`: usable = accounts of the provider, not disabled, no auth_error, within routing candidates; none usable → Unavailable `every <provider> account is disabled or signed out` (if any exist) or `` no <provider> accounts connected; run `slopmax login <provider>` `` (until None) — `pool.rs:390`
- **POOL-013** — `pick`: ready = usable and not blocked for the model and not in `exclude`; blocked (including excluded-but-blocked) accounts feed `soonest` return time — `pool.rs:411`
- **POOL-014** — `pick` order: the session's bound account (bound within ttl) if affinity (request header overrides config) and it is ready; else the pinned account if ready; else strategy placement in the top priority tier — `pool.rs:425`
- **POOL-015** — `pick` with no choice: `every <provider> account is rate limited` with until = soonest when any is blocked, else `every <provider> account failed this request` (until None) — `pool.rs:436`
- **POOL-016** — `moved_from` = the previously bound account when it differs from the chosen one (reported even when affinity is off) — `pool.rs:446`
- **POOL-017** — Non-housekeeping picks advance the round-robin counter for the chosen account; housekeeping (model lists, token counts) takes no turn — `pool.rs:447`
- **POOL-018** — A pick with a session (re)binds it to the chosen account at `now` and marks dirty — `pool.rs:452`
- **POOL-019** — `next(provider)`: no side effects; ready ignores sessions/excludes; pinned and ready → Pinned; else placement; reason OnlyReady when the chosen tier has one account; reset-first → WeekEndsSoonest (urgency.week_ending) / ResetsSoonest (short or long) / MostRoom; fill-first → FirstInOrder; least-used → MostRoom; round-robin → NextInTurn; None when nothing ready — `pool.rs:471`
- **POOL-020** — `Reason` JSON kebab-case (`pinned`, `only-ready`, `week-ends-soonest`, `resets-soonest`, `first-in-order`, `most-room`, `next-in-turn`); `text()` exact: "pinned for new sessions", "the only account ready", "its week resets within the day with quota to spare", "its quota resets soonest", "first in priority order", "the most room left", "next in turn" — `pool.rs:226`
- **POOL-021** — `record_success`: last_used=now, clears throttled_until and last_error — `pool.rs:519`
- **POOL-022** — `observe(limits)`: compute lapses vs the old reading, merge, lift `blocked_until` when the merged reading is not exhausted (a fresh reading proves the block lifted early), queue lapses — `pool.rs:529`
- **POOL-023** — `take_lapses(now)`: queued lapses plus windows whose reset passed with no reading; deduplicated by (account, span, model, ended_at) against those already told; told list keeps only lapses ended within the last 8 days — `pool.rs:549`
- **POOL-024** — `block(id, until, model?, reason)`: model blocks keep the later deadline per model; account blocks only extend (`max`); sets last_error=reason — `pool.rs:577`
- **POOL-025** — `throttle(id, until)` extends throttled_until only — `pool.rs:599`
- **POOL-026** — `record_error` sets last_error only — `pool.rs:607`
- **POOL-027** — `record_credits(list)`: stores `{credits, listed_at: now, counted: limits.reset_credits}` — `pool.rs:614`
- **POOL-028** — `record_reset(id, now, credit?)`: clears blocks, model blocks, throttle, last_error; zeroes every window's used and reset; observed_at=now; reset_credits −1 (saturating); removes the named credit from the list (and counted −1), or if unknown sets counted=None so the list is fetched again — `pool.rs:628`
- **POOL-029** — `clear_blocks(id)` lifts blocked_until, throttled_until and model blocks; returns the models unblocked — `pool.rs:659`
- **POOL-030** — `add_usage` sums token usage into state — `pool.rs:672`
- **POOL-031** — `pooled(provider)`: working accounts (enabled, no auth error), weighted by plan capacity shares when every plan's size is known (`pricing::shares`), else equal weights; blocked = `is_blocked` — `pool.rs:685`, `pricing.rs:116`
- **POOL-032** — `snapshot(now)`: returns state plus whether it changed since the last snapshot (clears dirty); drops expired model blocks; keeps only states of known accounts (all states before the first sync); drops sessions past ttl — `pool.rs:708`
- **POOL-033** — `session_counts(now)`: live sessions per account — `pool.rs:748`
- **POOL-034** — Placement only within the highest priority among ready accounts. fill-first: earliest `added_at`; reset-first: min by (urgency key, score, last_used); least-used: min by (score, last_used) (unmeasured score 101 ranks last; None last_used sorts first); round-robin: min by (last pick counter or 0, added_at) — `pool.rs:762`
- **POOL-035** — Score compare is a total order on f64 — `pool.rs:818`
- **POOL-036** — `is_unmeasured(state)` iff score ≥ 101 — `pool.rs:825`
- **POOL-037** — Mutex poisoning is ignored (state stays usable after a panic in another thread) — `pool.rs:332`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `pool.rs` (21):
  - `round_robin_takes_turns_within_the_top_tier` — `pool.rs:885`
  - `reset_windows_are_told_once_with_what_was_used` — `pool.rs:903`
  - `next_says_who_a_new_session_would_get_and_why` — `pool.rs:932`
  - `without_affinity_a_session_is_placed_afresh_but_its_move_is_known` — `pool.rs:966`
  - `a_shorter_session_ttl_forgets_sessions_sooner` — `pool.rs:997`
  - `reset_first_spends_the_window_that_expires_soonest` — `pool.rs:1013`
  - `reset_first_saves_a_week_about_to_be_lost_before_any_5_hour_window` — `pool.rs:1034`
  - `fill_first_drains_in_order` — `pool.rs:1080`
  - `least_used_prefers_headroom_and_ranks_unknown_last` — `pool.rs:1095`
  - `sessions_stick_until_their_account_cannot_serve` — `pool.rs:1114`
  - `sessions_survive_a_restart` — `pool.rs:1164`
  - `moved_from_reports_a_session_leaving_its_account` — `pool.rs:1198`
  - `sessions_expire_after_ttl` — `pool.rs:1219`
  - `priority_tiers_and_pins_come_before_strategy` — `pool.rs:1232`
  - `known_exhaustion_is_skipped_without_a_request` — `pool.rs:1246`
  - `unavailable_reports_the_earliest_return` — `pool.rs:1260`
  - `model_blocks_only_affect_that_model` — `pool.rs:1271`
  - `fresh_reading_lifts_a_block_early` — `pool.rs:1289`
  - `disabled_and_signed_out_accounts_are_skipped` — `pool.rs:1303`
  - `blocks_on_tried_accounts_still_report_when_the_pool_frees_up` — `pool.rs:1318`
  - `credits_count_from_their_list_and_leave_it_when_redeemed` — `pool.rs:1336`

---

## LIM (cont.) — polling one account (`usage.rs`)

- **LIM-023** — `usage::poll(http, store, account, refresh)`: with `refresh`, `ensure_fresh` first (not forced); read usage; `Other` errors pass through unchanged — `usage.rs:13`
- **LIM-024** — Usage 401 with refresh allowed → forced refresh then one retry; a second 401 → `token rejected after refresh`; 401 with refresh disabled → `token rejected (refresh disabled)` (no token call) — `usage.rs:27`
- **LIM-025** — Refresh failures inside poll: Revoked → `"<reason>; run \`slopmax login <provider>\`"`; Transient → its own message (e.g. `token refresh failed (503 …): …`) — `usage.rs:39`
- **LIM-026** — Returns the possibly refreshed account with the reading (caller persists nothing extra; `ensure_fresh` already saved) — `usage.rs:18`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `usage.rs` (8):
  - `reads_usage_with_a_working_token` — `usage.rs:107`
  - `refreshes_a_due_token_before_reading` — `usage.rs:123`
  - `a_rejected_token_is_refreshed_once_and_retried` — `usage.rs:136`
  - `a_token_rejected_after_refresh_is_an_error` — `usage.rs:148`
  - `without_refresh_a_rejected_token_is_reported` — `usage.rs:157`
  - `revoked_logins_say_how_to_reconnect` — `usage.rs:167`
  - `passing_refresh_failures_keep_their_reason` — `usage.rs:177`
  - `other_failures_pass_through_before_and_after_a_refresh` — `usage.rs:189`

---

## SVC — login service (`service.rs`)

- **SVC-001** — `Manager::detect()`: env `SLOPMAX_NO_SERVICE` non-empty → None (demos/tests never touch the user's launchd/systemd); macOS → Launchd; Linux → Systemd iff `systemctl --user --version` succeeds; else None (Windows has no service) — `service.rs:35`
- **SVC-002** — Service files: systemd `$XDG_CONFIG_HOME/systemd/user/slopmax.service` (XDG_CONFIG_HOME used only if absolute, else `~/.config`); launchd `~/Library/LaunchAgents/dev.slopmax.plist` — `service.rs:48`, `service.rs:131`
- **SVC-003** — Systemd unit text, exact (with `{exe}`, `{log}` = `$SLOPMAX_HOME/slopmax.log`, and the Environment line only when `SLOPMAX_HOME` is set in the installer's env): `[Unit]\nDescription=slopmax account pool for Claude Code and Codex\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart="{exe}" serve\n[Environment="SLOPMAX_HOME={home}"\n]Restart=on-failure\nRestartSec=5\nStandardOutput=append:{log}\nStandardError=append:{log}\n\n[Install]\nWantedBy=default.target\n` — `service.rs:138`
- **SVC-004** — Launchd plist text, exact: XML header and DOCTYPE, `Label` `dev.slopmax`, `ProgramArguments` [`{exe}`, `serve`], `RunAtLoad` true, `KeepAlive` dict `SuccessfulExit` false, `StandardOutPath`/`StandardErrorPath` = log, optional `EnvironmentVariables` dict with `SLOPMAX_HOME` (2-space indentation as in source), ends `</dict>\n</plist>\n`; paths XML-escaped for `&`, `<`, `>` only — `service.rs:163`
- **SVC-005** — Install: write the file privately (`writing <file>` on failure); systemd: `systemctl --user daemon-reload`, then `systemctl --user enable --now slopmax`; launchd: `launchctl bootout gui/<uid>/dev.slopmax` (failure ignored) then `launchctl bootstrap gui/<uid> <file>` — `service.rs:60`
- **SVC-006** — Uninstall: systemd `systemctl --user disable --now slopmax` (ignored failure) / launchd bootout (ignored); remove the file — missing → `no service installed`; other errors `removing <file>`; systemd then `daemon-reload` (ignored) — `service.rs:84`
- **SVC-007** — Status: installed = file exists; running: systemd `systemctl --user is-active --quiet slopmax` succeeds, launchd `launchctl print gui/<uid>/dev.slopmax` succeeds (both only when installed); lingering (Linux only) = `loginctl show-user $USER --property=Linger` prints exactly `Linger=yes` (None when USER unset or loginctl absent); launchd lingering None — `service.rs:105`, `service.rs:211`
- **SVC-008** — Start: systemd `systemctl --user start slopmax`; launchd `launchctl kickstart gui/<uid>/dev.slopmax` — `service.rs:122`
- **SVC-009** — launchd domain `gui/<output of id -u>`; target `gui/<uid>/dev.slopmax` — `service.rs:221`
- **SVC-010** — Running external programs: spawn failure → `running <program>`; non-zero exit → `<program> <args joined by space> failed: <trimmed stderr>`; `succeeds` = spawned and exit 0 — `service.rs:238`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `service.rs` (7):
  - `systemd_unit_runs_serve_and_appends_to_the_log` — `service.rs:262`
  - `launchd_plist_escapes_paths` — `service.rs:282`
  - `launchd_plist_sets_slopmax_home_when_moved` — `service.rs:294`
  - `commands_report_their_stderr_when_they_fail` — `service.rs:308`
  - `launchd_targets_the_users_gui_domain` — `service.rs:323`
  - `service_files_live_where_each_manager_looks` — `service.rs:331`
  - `lingering_is_a_linux_question` — `service.rs:340`

---

## BG — the proxy seen from outside (`background.rs`)

- **BG-001** — `Daemon::new(config)`: base = `config.base_url()`, key = `api_key`, plain-HTTP client (no TLS roots), total timeout 30 s, connect timeout 1 s — `background.rs:26`
- **BG-002** — `version()`: `GET <base>/healthz` must be JSON with `service == "slopmax"`, returns `version`; anything else (another program on the port, non-JSON, connection refused) → None; `is_running()` = version is Some — `background.rs:39`
- **BG-003** — `report(refresh)`: `GET /slopmax/status` (refresh=false) or `POST /slopmax/refresh` (refresh=true) with `authorization: Bearer <api_key>`; any failure, non-2xx (e.g. wrong key 401), or unparsable report → None — `background.rs:55`, `background.rs:103`
- **BG-004** — `sync()`: `POST /slopmax/sync` with the key, returns the report — `background.rs:62`
- **BG-005** — `redeem(id)`: `POST /slopmax/accounts/<id>/redeem` with the key; connection failure → `the proxy is not running`; non-2xx → body `error.message` or `it failed`; 2xx body `{outcome, report}`, unparsable → `unexpected answer from the proxy` — `background.rs:68`
- **BG-006** — `shutdown()`: `POST /slopmax/shutdown` with the key; non-2xx or connection failure is an error — `background.rs:93`
- **BG-007** — `current_exe()` error text `locating the slopmax binary` — `background.rs:116`
- **BG-008** — `ensure_running(config, exe)`: false when one already answers; else `launch` and true — `background.rs:122`
- **BG-009** — `launch`: if a service manager is detected and its service is installed → `manager.start()`; else spawn detached; then wait until running — `background.rs:132`
- **BG-010** — `stop(config)`: false when nothing answers (no error); else shutdown and true — `background.rs:141`
- **BG-011** — `install_service`: stop a running proxy first and wait 300 ms to free the port, install, then wait until running; returns the service file — `background.rs:153`
- **BG-012** — Detached spawn: create `$SLOPMAX_HOME` privately; open `slopmax.log` create+append; run `<exe> serve` with stdin null, stdout and stderr appended to the log; Unix: new process group (`process_group(0)`) so it outlives the terminal; spawn error `starting the proxy` — `background.rs:164`
- **BG-013** — Wait until running: up to 50 checks 100 ms apart (~5 s); failure → `the proxy did not start; see <log path>` — `background.rs:185`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `background.rs` (8):
  - `the_running_proxy_reports_its_version` — `background.rs:259`
  - `another_program_on_the_port_is_not_the_proxy` — `background.rs:267`
  - `nothing_listening_is_not_running` — `background.rs:275`
  - `reports_are_read_with_the_key_and_refreshes_and_syncs_post` — `background.rs:294`
  - `a_wrong_key_reads_as_no_report` — `background.rs:321`
  - `redeeming_returns_the_outcome_or_the_proxys_reason` — `background.rs:334`
  - `stopping_asks_a_running_proxy_to_shut_down` — `background.rs:350`
  - `the_current_binary_is_found` — `background.rs:362`

---

## DOC — `slopmax doctor` checks (`doctor.rs`)

Output shape (also served to the app/dashboard): `[{ "title": "<section>", "findings": [{ "level": "ok|note|warn|fail", "text": "...", "fix": "..."|null }] }]`. Findings never contain a key or token.

- **DOC-001** — `Level` ordered Ok < Note < Warn < Fail, serialized lowercase; `Finding { level, text, fix? }` (fix serialized as null when absent); `Section { title, findings }` — `doctor.rs:27`
- **DOC-002** — `check(config, store)`: sections in order Proxy, Accounts, Claude Code, Codex, CLIProxyAPI, Network, Files; then the unserved-agent pass; sections with no findings are dropped — `doctor.rs:67`
- **DOC-003** — Unserved pass: for each agent without a servable account (AGT-006), rewrite fixes equal to `slopmax setup <id>` in its section to `slopmax login <provider>, then slopmax setup <id>`; if the agent is wired to slopmax add Fail `points at slopmax, but no <provider title> account is connected to serve it` with fix ``slopmax login <provider>, or `slopmax setup <id> --undo` `` — `doctor.rs:90`
- **DOC-004** — Proxy: running with this version → Ok `running on <base_url>`; other version → Warn `running version <v>, but this binary is <ours>`, fix `slopmax stop && slopmax start` — `doctor.rs:129`
- **DOC-005** — Proxy not answering and the listen port cannot be bound (AddrInUse) → Fail `port <port> is taken by <holder>`, holder from `port_holder` (`<comm> (pid N)` from /proc on Linux, `another user's program` when unseen, `lsof` on macOS, else `another program`), fix ``set `listen` in config.toml to a free port`` — `doctor.rs:138`, `crates/slopmax-net/src/server.rs:117`
- **DOC-006** — Proxy not answering, port free → Warn `not running`, fix ``slopmax start (or `slopmax service install` to start at login)`` — `doctor.rs:147`
- **DOC-007** — Non-loopback `listen` → Note `listens beyond this machine on <addr>: anyone who can reach it with the key (<n> client key[s] besides api_key) can use your accounts` ("key" singular only when n == 1), fix ``give other machines their own keys with `slopmax key add <name>` `` — `doctor.rs:153`
- **DOC-008** — Service (only when a manager is detected): not installed → Note `not installed as a service` / `slopmax service install`; installed+running → Ok `runs as a login service`; installed, not running → Warn `the service is installed but not running` / `slopmax start`; installed and lingering is false → Note `the service stops when you log out` / `loginctl enable-linger $USER` — `doctor.rs:166`
- **DOC-009** — Accounts: none → Fail `no accounts connected`, fix `slopmax login claude, slopmax login codex, or slopmax import` (and stop); else Ok with per-provider counts in `ProviderId::ALL` order, `<n> <title> account[s]` joined with `, ` — `doctor.rs:195`
- **DOC-010** — Per account: auth_error → Fail `<name> needs a new login (<error>)`, fix `slopmax login <provider>`; else if linked and the source file is gone → Warn `<name> follows <tool>, but <path> is gone`, fix `slopmax own <id>`; else if linked and token expired → Warn `<name>'s token expired and <tool> has not refreshed it`, fix `start <tool> again, or slopmax own <id>`; disabled → Note `<name> is disabled` — `doctor.rs:215`
- **DOC-011** — Claude Code: `claude` not on PATH → Note `` `claude` is not on PATH ``; settings.json env BASE_URL == base_url and AUTH_TOKEN == api_key → Ok `wired through settings.json, for the CLI and the apps that run it`; BASE_URL ours, other key → Warn `settings.json points at slopmax with a different key`; other BASE_URL → Warn `settings.json sends Claude Code to <base>`; none → Note ``not wired in settings.json (`slopmax run claude` still works)``; fixes `slopmax setup claude` — `doctor.rs:254`
- **DOC-012** — `ANTHROPIC_API_KEY` set in the environment → Warn `ANTHROPIC_API_KEY is set in this shell and conflicts with the proxy's key`, fix `unset ANTHROPIC_API_KEY` — `doctor.rs:292`
- **DOC-013** — (corrected) Codex: `codex` not on PATH → Note `` `codex` is not on PATH `` with no fix (the exact text was missing; Claude Code's twin in DOC-011 is `` `claude` is not on PATH ``, also without a fix); `model_provider = "slopmax"` with `[model_providers.slopmax].base_url == <base_url>/codex` and `experimental_bearer_token == api_key` → Ok `wired through config.toml, for the CLI and the desktop app`; slopmax selected but table missing → Warn `config.toml selects slopmax, but its provider table is gone (the Codex desktop app can rewrite the file)`; slopmax with other address/key → Warn `config.toml's slopmax provider has an old address or key`; other provider → Warn ``config.toml sends Codex to the `<p>` provider``; none/unreadable → Note ``not wired in config.toml (`slopmax run codex` still works)``; fixes `slopmax setup codex` — `doctor.rs:302`
- **DOC-014** — CLIProxyAPI section only when accounts link to `cliproxyapi`: TCP connect to `127.0.0.1:8317` within 300 ms → Note `still running and refreshing <n> account[s] slopmax follows`, fix `once you stop CLIProxyAPI: slopmax own all`; else Warn `not running, so nothing refreshes the <n> accounts slopmax follows`, fix `slopmax own all` (connect only; never binds the port) — `doctor.rs:22`, `doctor.rs:363`
- **DOC-015** — Network: GET `https://api.anthropic.com/api/hello` and `https://chatgpt.com/backend-api/wham/usage` (10 s timeout each, any HTTP answer counts) → Ok `<Anthropic|ChatGPT> is reachable`; error → Fail `cannot reach <name>: <e>`, fix `check the network, or set HTTPS_PROXY` — `doctor.rs:393`
- **DOC-016** — Clock skew from the first answer carrying a `Date` header; > 1 min → Warn `the system clock is off by <human::duration>` (reported once), fix ``enable time sync (e.g. `timedatectl set-ntp true`)`` — `doctor.rs:403`
- **DOC-017** — Files (Unix only): accounts dir with any group/other bits → Warn `<dir> is readable by other users`, fix `chmod 700 <dir>`; count of entries with such bits → Warn `<n> account files are readable by other users`, fix `chmod 600 <dir>/*`; nothing on Windows — `doctor.rs:434`
- **DOC-018** — `on_path(program)`: some `$PATH` entry contains a regular file of that exact name (no PATHEXT handling) — `doctor.rs:466`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `doctor.rs` (17):
  - `a_running_proxy_of_this_version_is_fine` — `doctor.rs:533`
  - `an_older_proxy_should_be_restarted` — `doctor.rs:547`
  - `another_program_on_the_port_is_named` — `doctor.rs:556`
  - `a_stopped_proxy_says_how_to_start_it` — `doctor.rs:567`
  - `listening_beyond_this_machine_is_pointed_out` — `doctor.rs:575`
  - `the_login_service_is_reported` — `doctor.rs:592`
  - `no_accounts_is_a_failure` — `doctor.rs:617`
  - `accounts_are_counted_and_each_problem_has_a_fix` — `doctor.rs:623`
  - `claude_code_wiring_is_checked_against_this_proxy` — `doctor.rs:709`
  - `codex_wiring_is_checked_against_this_proxy` — `doctor.rs:771`
  - `cliproxyapi_matters_only_with_linked_accounts` — `doctor.rs:808`
  - `reachable_services_with_a_sound_clock_are_fine` — `doctor.rs:837`
  - `a_skewed_clock_is_reported_once` — `doctor.rs:853`
  - `unreachable_services_fail_with_a_fix` — `doctor.rs:874`
  - `account_files_others_can_read_are_flagged` — `doctor.rs:895`
  - `programs_are_looked_up_on_path` — `doctor.rs:926`
  - `levels_order_by_severity` — `doctor.rs:932`

---

## REP — the status report (`report.rs`)

### `Report` JSON (served at `/slopmax/status|refresh|sync`, read by the CLI and the app)

```jsonc
{
  "version": "0.3.0",            // CARGO_PKG_VERSION of the process that built it
  "strategy": "reset-first",
  "live": true,                  // from a running proxy (vs. from disk)
  "generated_at": "<RFC3339>",
  "accounts": [{
    "id": "...", "provider": "claude", "name": "...",
    "email": "...", "plan": "...",                 // optional
    "disabled": false, "priority": 0, "pinned": false,
    "auth_error": "...", "follows": "cliproxyapi", // optional
    "token_expires_at": "<ts>",                    // optional
    "endpoint": "https://api.openai.com/v1",        // optional: non-subscription accounts only
    "models": ["gpt-*", ...],                       // omitted when empty
    "sessions": 0,
    "state": { ...AccountState (POOL-002)... }
  }],
  "pools": [{ "provider": "claude", "accounts": 2, "windows": [Window...],
              "next": { "account": "<id>", "reason": "resets-soonest", "why": "its quota resets soonest" },  // optional
              "shares": { "<id>": 0.8 } }],                                                             // omitted when empty
  "nudges": [ notify::Event... ]   // omitted when empty
}
```

- **REP-001** — Report/AccountReport/PoolReport/NextReport field names and omission rules exactly as above — `report.rs:20`
- **REP-002** — `build`: for each account (store order) copy id/provider/email/plan/disabled/priority/auth_error; `name = account.name()`; `pinned` = pins[provider] == id; `sessions` from the session counts (0 default); `token_expires_at`; `follows` = link tool; `endpoint` = `provider.api(account)` for non-subscription providers only; `models` = endpoint models, else the spec's patterns for non-subscription providers, else empty — `report.rs:315`
- **REP-003** — `pools`: one per subscription provider (ALL order) with at least one working account (enabled, no auth error); windows = `pooled_by` over shared windows (weighted by plan shares when all known), then one model-scoped window per distinct (span, model) seen, sorted by (span, model), averaged with the same weights over accounts reporting it, reset = soonest upcoming among readings with use > 0; `shares` = id → share when known; `next` None until `with_next` — `report.rs:372`
- **REP-004** — `with_next(pool)`: fills each pool's `next` from `Pool::next` with `why = reason.text()` — `report.rs:84`
- **REP-005** — `with_nudges(config)`: nudges computed by `notify::nudges(subjects, redeem_expiring_credits, plan_prices, now)` — `report.rs:65`
- **REP-006** — `offline(config, store, refresh)`: reads `state.json` and `pins.json` from `$SLOPMAX_HOME` (missing = empty), builds a Pool (ttl 1 h); with refresh polls every subscription account without auth_error via `usage::poll(…, config.refresh_tokens)`, observing readings and recording failures as last_error `usage poll: <error chain>`, then writes `state.json`; returns `build(... live=false, sessions empty)` + next + nudges — `report.rs:438`
- **REP-007** — `Condition` precedence: SignInNeeded(auth_error) > Disabled > Limited(limited_until) > Throttled (throttled_until in the future) > Active(sessions>0) > Ready — `report.rs:227`
- **REP-008** — Condition text exact: `sign in again (<error>)`, `disabled`, `limited · back in <human::until>` (e.g. `limited · back in 1m30s`), `throttled`, `● active · 1 session`, `● active · <n> sessions`, `ready` — `report.rs:142`
- **REP-009** — Condition tone: SignInNeeded Bad; Disabled Muted; Limited/Throttled Warn; Active/Ready Good — `report.rs:154`
- **REP-010** — `Tone` values Good, Muted, Accent, Warn, Bad; `Tone::of_use`: ≥90 Bad, ≥70 Warn, else Good — `report.rs:167`, `report.rs:217`
- **REP-011** — Notes in order: Pinned; Priority(p) if p ≠ 0; Follows(tool); ResetCredits(n) if `credits_left` > 0; Served{requests, total tokens} if requests > 0; LastError unless the condition already explains it (auth_error set or limited) — `report.rs:264`
- **REP-012** — Note text exact: `pinned`, `priority <p>`, `follows <tool>`, `1 limit reset` / `<n> limit resets`, `<requests> req · <human::compact(tokens)> tok` (e.g. `12 req · 1.5M tok`), `last error: <e>`; tone Accent for Pinned and ResetCredits, Muted otherwise — `report.rs:193`
- **REP-013** — `window(span)` = the shared window of that span; `long_window` = 7d else 30d; `scoped_windows` = model windows (for AccountReport and PoolReport) — `report.rs:245`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `report.rs` (12):
  - `conditions_put_the_most_pressing_first` — `report.rs:482`
  - `use_turns_yellow_at_70_and_red_at_90_percent` — `report.rs:512`
  - `conditions_read_the_same_in_every_front_end` — `report.rs:556`
  - `notes_read_the_same_in_every_front_end` — `report.rs:582`
  - `limits_and_idle_accounts_have_their_own_conditions` — `report.rs:614`
  - `notes_come_in_order_and_skip_errors_the_condition_explains` — `report.rs:630`
  - `windows_are_found_by_span_and_scope` — `report.rs:702`
  - `keys_report_their_endpoint_and_models_and_get_no_pool` — `report.rs:722`
  - `pools_average_working_accounts_and_their_model_windows` — `report.rs:773`
  - `a_pool_with_no_working_account_is_left_out` — `report.rs:833`
  - `with_next_names_the_account_a_new_session_gets_and_why` — `report.rs:841`
  - `reports_survive_a_json_round_trip` — `report.rs:867`

---

## FS (cont.) — test support (`testkit.rs`)

testkit is test-only, but the port's tests depend on the same harness, so it is part of the contract for mirroring tests.

- **FS-015** — `temp_dir(name)`: creates `<os tmp>/slopmax-<name>-<43-char token>` — `testkit.rs:19`
- **FS-016** — `Mock`: an HTTP server on `127.0.0.1:0` that records every request (method, path+query, headers, body) and answers with a handler; requests to `/` are answered 404 and not recorded (probes) — `testkit.rs:75`
- **FS-017** — `Seen.route()` = path without query; `seen_at(route)` filters by it; `json()`/`text()`/`header()` helpers — `testkit.rs:35`
- **FS-018** — `reply(status, body)`; `json(status, value)` sets `content-type: application/json` — `testkit.rs:55`
- **FS-019** — `Mock.client(prefixes)`: a plain-HTTP client whose `Origins` rewrite each prefix (e.g. `https://api.anthropic.com`) to the mock's URL — port must support the same origin rewriting in its HTTP client layer — `testkit.rs:130`

**Rust tests to mirror** (title = Rust fn name; `file:line`):

- `testkit.rs` (1):
  - `the_mock_records_requests_sent_to_redirected_origins` — `testkit.rs:141`

---

## Cross-cutting index

### Environment variables read or written by this area

| Variable                                                                                                                           | Read/Written                                                    | Effect                                                                    | Items                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `SLOPMAX_HOME`                                                                                                                     | read                                                            | moves `~/.slopmax`; copied into the systemd unit / launchd plist when set | FS-003, SVC-003, SVC-004  |
| `SLOPMAX_LISTEN`                                                                                                                   | read                                                            | overrides `listen` (containers)                                           | CFG-017                   |
| `SLOPMAX_NO_SERVICE`                                                                                                               | read                                                            | hides the service manager (demos, tests)                                  | SVC-001                   |
| `CLAUDE_CONFIG_DIR`                                                                                                                | read                                                            | Claude Code dir                                                           | FS-006                    |
| `CODEX_HOME`                                                                                                                       | read                                                            | Codex dir                                                                 | FS-007                    |
| `XDG_CONFIG_HOME`                                                                                                                  | read                                                            | systemd user dir (absolute only)                                          | SVC-002                   |
| `USER`                                                                                                                             | read                                                            | `loginctl show-user`                                                      | SVC-007                   |
| `DISPLAY`, `WAYLAND_DISPLAY`                                                                                                       | read                                                            | Linux browser detection                                                   | AUTH-030                  |
| `PATH`                                                                                                                             | read                                                            | `on_path`                                                                 | DOC-018                   |
| `ANTHROPIC_API_KEY`                                                                                                                | read (doctor) / removed (`run claude`) / `unset` (`env claude`) | conflict warning                                                          | DOC-012, AGT-017, AGT-018 |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | written (child env / `env` output)                              | wire Claude Code                                                          | AGT-016                   |
| `SLOPMAX_API_KEY`                                                                                                                  | written (child env of `run codex`)                              | Codex `env_key`                                                           | AGT-028, AGT-030          |
| `HOME` (via OS home dir)                                                                                                           | read                                                            | `~`                                                                       | FS-001                    |

- **CFG-033** — `SLOPMAX_LISTEN` is applied only by `Config::load()`, not `load_from(path)` (tests and `Config::set` see the file's value) — `config.rs:267`
- **CFG-034** — First-run race detail: when the re-read under the lock still has no key, the text from the _first_ read is the one edited (a concurrent writer that changed other settings without adding a key would be overwritten) — `config.rs:302`
- **CFG-035** — What a running proxy picks up from an edited config.toml (README: "applies a changed config.toml within two seconds, without a restart; only `listen` and `proxy` need one"): every setting is re-read on the daemon's 2 s tick (DMN-004, PRX-018) except `listen` (bound at start, and `SLOPMAX_LISTEN` wins over the file) and `proxy` (installed process-wide by `apply()` at start only, PRX-102); an emptied `api_key` keeps the running key; `[[keys]]`, `[aliases]`, `[fallbacks]`, `[prices]`, `[plan_prices]`, `[notify]` apply on the next request or tick — `config.rs:415`, `proxy/mod.rs:141-165`

### Files this area reads or writes

| Path                                                                     | Format                                                 | Writer                    | Items             |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------- | ----------------- |
| `$SLOPMAX_HOME/config.toml`                                              | TOML, comment-preserving edits, 0600                   | config.rs                 | CFG-*             |
| `$SLOPMAX_HOME/.config.lock`                                             | empty lock file, 0600                                  | config.rs                 | CFG-019           |
| `$SLOPMAX_HOME/accounts/<id>.json`                                       | pretty JSON, 0600; dir 0700                            | account.rs                | ACC-001           |
| `$SLOPMAX_HOME/accounts/.<id>.lock`                                      | empty lock file                                        | account.rs, auth          | ACC-019, AUTH-013 |
| `$SLOPMAX_HOME/pins.json`                                                | `{"<provider>": "<id>"}`                               | account.rs                | ACC-021           |
| `$SLOPMAX_HOME/state.json`                                               | POOL-002 shape                                         | daemon / report::offline  | POOL-002, REP-006 |
| `$SLOPMAX_HOME/setup-backup.json`                                        | `{"claude": {...}, "codex": {"model_provider": ...}}`  | agent/mod.rs              | AGT-009           |
| `$SLOPMAX_HOME/slopmax.log`                                              | append                                                 | background spawn, service | BG-012, SVC-003   |
| `.<name>.<pid>.tmp` beside any private file                              | transient                                              | fsx                       | FS-009            |
| `~/.claude/settings.json`                                                | JSON object, `env` block                               | agent/claude_code.rs      | AGT-020           |
| `~/.claude/.credentials.json` / macOS keychain `Claude Code-credentials` | `claudeAiOauth` JSON (read only)                       | —                         | AGT-024           |
| `~/.codex/config.toml`                                                   | TOML, comment-preserving                               | agent/codex.rs            | AGT-033           |
| `~/.codex/auth.json`                                                     | JSON (read only)                                       | —                         | AGT-036, AGT-038  |
| `~/.cli-proxy-api/*.json`                                                | CLIProxyAPI credential JSON (read only; never written) | —                         | IMP-005           |
| `~/.config/systemd/user/slopmax.service`                                 | systemd unit                                           | service.rs                | SVC-003           |
| `~/Library/LaunchAgents/dev.slopmax.plist`                               | plist XML                                              | service.rs                | SVC-004           |

### Platform-specific behavior

- macOS: browser `open` (AUTH-031), keychain import via `security` (AGT-024), launchd agent `gui/<uid>/dev.slopmax` (SVC-*), `lsof` for port holder (DOC-005), always "has a browser" (AUTH-030).
- Linux: `xdg-open` only with `DISPLAY`/`WAYLAND_DISPLAY` (AUTH-030/031), systemd user unit when `systemctl --user` works (SVC-001), lingering via `loginctl` (SVC-007), `/proc` port holder (DOC-005).
- Windows: `explorer` for URLs, always "has a browser", no service manager, no file-mode bits (FS-014), `doctor` Files section empty (DOC-017), `run` spawns and returns the child's exit code instead of exec (AGT-008).
- Unix only: `exec` replaces the process in `run` (AGT-008), new process group for the detached proxy (BG-012), 0600/0700 modes (FS-014).

### Exit codes and process behavior

- **AGT-039** — `agent::run` result is the agent's exit status (non-Unix: `code` or 1 when killed by a signal); on Unix the slopmax process _is_ the agent after exec, so the agent's exit status and signals are the caller's directly — `agent/mod.rs:147`

---

## Effect port notes

**Services (Layer/Context).** Make services only where state or replaceable I/O lives:
`Home` (resolves `SLOPMAX_HOME` through Effect `Config` so tests set it with a `ConfigProvider`; exposes the FS-004 paths),
`Store` (accounts dir + per-account locks, ACC-_), `FileLock` (FS-012), `PrivateFiles` (FS-009..013 over `FileSystem`),
`OAuthHttp` (the AUTH-005 client: UA `slopmax/<version>`, 10 s connect / 30 s total, plus an `Origins` rewrite implemented as `HttpClient.mapRequest` so tests point provider URLs at a mock, FS-019),
`Browser` (AUTH-030/031), `ServiceManager` (SVC-_, over `effect/process` `ChildProcess`), `DaemonClient` (BG-001..006, plain HTTP, no TLS roots).
`ProviderId.get()`/`AGENTS` stay static registries of plain objects implementing a `Provider`/`Agent` interface; their async methods return `Effect`s that require `HttpClient`.
`route.plan`, `pool` placement, `limits`, `matches`, verdict/refusal classifiers, header shaping, `apply_profile`/`apply_claims`, `Profile.plan`, `parse_pasted`, `Strategy`/`live_value`, report `build`/`Condition`/`Note` are pure synchronous functions (CONVENTIONS: pure code stays pure).

**Schema.** Every file and wire body slopmax owns gets a Schema: Account/Tokens/Endpoint/Link (ACC-001), Pins, State/AccountState/CreditList/Credit (POOL-002, PROV-060), setup-backup.json, Report (REP-001), doctor Section/Finding, Outcome literals, `/slopmax/accounts/:id/redeem` answer `{outcome, report}`.
Read-only foreign shapes (CLIProxyAPI file IMP-006, Codex `auth.json` AGT-038, Claude `claudeAiOauth` AGT-024, Claude/OpenAI token answers, Claude profile, `/wham/usage`, cedar_ember listing, Codex credit list) get lenient Schemas: unknown fields ignored, every documented field optional, a number-or-numeric-string union where Rust accepts both (`priority`, device `interval`).
Config uses Schema with excess properties rejected at the top level and in `[[keys]]`, `[prices.*]`, `[notify]` (CFG-003..006), with decoding defaults for every key (CFG-001).
Serialization must reproduce serde's omission rules (`skip_serializing_if`): optional fields absent, not `null`; `disabled`/`priority` always written; `doctor` `fix` written as `null`.

**Timestamps.** Rust `Timestamp` is i64 nanoseconds, serialized as `YYYY-MM-DDTHH:MM:SS[.fraction]Z` with the fraction trimmed of trailing zeros and omitted when zero, and parsed from RFC 3339 with any offset (and a space instead of `T`). `Date#toISOString()` always writes `.000Z` — a trap for byte-level comparisons and golden tests. Store epoch ms in memory (CONVENTIONS), but use a Schema transform that parses 0–9 fraction digits and formats like Rust. Rust `Timestamp::MAX` is a sort sentinel (credits, urgency): use `Number.POSITIVE_INFINITY`/`Number.MAX_SAFE_INTEGER` consistently.

**Time and timers (Schedule, Clock).** Device-code polling: `Schedule.spaced(interval s)` bounded by 15 min (PROV-042). Login wait: `Effect.timeout` 10 min (AUTH-020). `wait_until_running`: 50 × 100 ms (BG-013). `install_service` 300 ms pause (BG-011). Credit redeem retries: exactly one retry on transport error only, with the same request id (PROV-033, PROV-059) — `Effect.retry({ times: 1, while: isTransportError })`. All "now" values from `Clock` so `TestClock` drives expiry (`expires_within`), refresh lead, STALE_AFTER, DEFAULT_BLOCK, lapse windows.

**Scope (resources).** Callback server: `HttpServer` (platform layer) acquired in a `Scope`, closed as soon as a callback is accepted (AUTH-027); bind failure must be detected as "address in use"/any bind error and turned into the Notice, not a defect. File locks: `Effect.acquireRelease(lock, unlock)`. Temp files: removed on failure (FS-009).

**Concurrency.** `receive` races two sources — redirects (bounded `Queue` of `Either<Callback, Error>`) and pasted lines (`Queue<string>`, where shutdown/end means "no more pastes") — loop until a valid callback; when both sources are exhausted fail with AUTH-026. `Prompt` is `{ tell: (LoginEvent) => void, pasted: Option<Queue.Dequeue<string>> }`; LoginEvent is a `Data.TaggedEnum`. The pool (POOL-*) is synchronous shared mutable state on the hot path: a plain class (single-threaded JS needs no mutex; POOL-037 poisoning is N/A) whose changes the daemon observes through the `dirty` flag; expose a `SubscriptionRef` only at the app boundary.

**Traps (Rust mechanisms that need a different design).**

1. _Cross-process file locks (FS-012, CFG-019, ACC-016..019, AUTH-013)._ Rust uses `File::lock` (flock/LockFileEx). Node 24 has no flock API; Bun only via `bun:ffi` (libc `flock`), which Electron's Node main process cannot use. Options: a Bun FFI `flock` + a Node fallback (N-API addon, or a lock owned by the Bun CLI process), or an `O_EXCL`/`mkdir` lock with stale-PID recovery. Only real `flock` interoperates with Rust processes sharing the same home during side-by-side runs; say so in the package notes. Never block the event loop: use `LOCK_NB` and poll with a `Schedule`, or a worker.
2. _Detached refresh (AUTH-013)._ Rust runs the refresh in `tokio::spawn` so a cancelled request cannot lose a rotated single-use refresh token. In Effect, a request fiber interrupted mid-refresh would interrupt the refresh too: run it with `Effect.forkDaemon` and `Fiber.join` (or an `uninterruptible` region from token POST through save).
3. _`exec` in `run` (AGT-008)._ Neither Node nor Bun can replace the process image. Spawn with inherited stdio, forward SIGINT/SIGTERM/SIGHUP, and exit with the child's code (or 128+signal) so `slopmax run claude` behaves like the agent itself.
4. _Comment-preserving TOML (CFG-021/023/024/025, AGT-033/034)._ toml_edit edits in place and keeps decor; no JS TOML library does all of that (Bun's built-in TOML is parse-only and Bun-only). Needed operations are few: add/replace a root key keeping its inline comment, append/remove `[[keys]]` tables, replace `[model_providers.slopmax]`, set/remove root `model_provider`. Note toml_edit puts a _new_ root key after the last root key-value, before the first `[table]` header — not at end of file — and renders strings as basic `"…"` unless a literal `'…'` avoids escapes (the Codex `-c` overrides use that rendering, AGT-028). Pin these with golden tests generated from the Rust binary. Parse/validate with a full TOML parser plus Schema.
5. _Error text = Rust Display._ anyhow's `to_string()` shows only the outermost context (`unexpected token response`, `reading <path>`), while `{:#}` (logs, `usage poll: …`, RefreshError::Transient display) joins the chain with `": "`. Model errors as tagged errors with a `message` (outer) and a `cause`, plus a `chain()` renderer. HTTP status text must use the `http` crate's canonical reason phrases (`401 Unauthorized`, `502 Bad Gateway`, `409 Conflict`, `503 Service Unavailable`), never the upstream's reason phrase.
6. _Float formatting._ Rust `{:.2}`/`{:.1}` (PROV-025, PROV-052) and `serde_json` (whole floats as `50.0`, not `50`) differ from `toFixed`/`JSON.stringify` at exact ties and for integral floats; header values must match byte-for-byte (`0.80`, `60.0`, `10080`).
7. _JWT/base64 strictness (AUTH-034)._ `Buffer.from(x, "base64url")` silently skips invalid characters; Rust rejects them. Check `^[A-Za-z0-9_-]*$` (after trimming `=`) before decoding so `a.!!!.c` and standard-alphabet payloads stay `None`.
8. _Header maps._ Rust `HeaderMap` is case-insensitive and multi-valued; `forwardable` keeps duplicate headers via `append`. Web `Headers` folds duplicates into `", "` — acceptable for these headers, but `anthropic-beta` merging (PROV-022) must split and rejoin exactly.
9. _Detached daemon spawn (BG-012)._ Use `node:child_process.spawn(exe, ["serve"], { detached: true, stdio: ["ignore", logFd, logFd] }).unref()` in one small module (works in Bun and Electron); Effect `ChildProcess` is for the attached cases (systemctl, launchctl, security, loginctl, id).
10. _The live CLIProxyAPI on 8317._ `doctor` only _connects_ to 127.0.0.1:8317 (DOC-014) and the port is a parameter in tests; ported tests must pass a throwaway port and never bind 8317. `port_taken` (DOC-005) binds the configured listen address briefly; tests must use free ports only.
11. _Bun vs Node._ Bun can run and compile all of this area (node:crypto `createHash`/`randomBytes`/`randomUUID`, node:fs, node:net, node:child_process are implemented); `Bun.spawn`, `Bun.TOML`, `bun:ffi` would tie `@slopmax/core` to Bun and break Electron's Node main — keep them behind the platform layer, as CONVENTIONS requires.
