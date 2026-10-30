# Parity inventory: the front ends (CLI, app core, desktop app)

Scope: `crates/slopmax` (the `slopmax` binary: `args.rs`, `commands.rs` and
`commands/*.rs`, `term.rs`, `ui.rs`, `tests/cli.rs`, `examples/bench.rs`),
`crates/slopmax-app` (`App`, `Snapshot`, `view`, `alerts`), and
`crates/slopmax-desktop-gpui` (window, pages, menu bar item and panel,
notifications, theme, motion, fonts, accessibility, keys, macOS bundle),
plus `DIST`: the repository-level build, packaging, install script, Docker
image, CI and release workflows, mise tasks, dev scripts, and the performance
baseline (added by the completeness pass).

Each line is one checkable behavior: a stable ID, what the TypeScript port
must do, and the Rust source as `path:line` (paths under `crates/`). Where a
front end only calls the core, the core location is given after "via"; the
core's own behavior is inventoried in the core parity file, and is listed
here only as far as the front end's output or exit code depends on it.

Wording in `backticks` is exact output (ANSI styling noted separately).
`{x}` is a substitution; `{x:?}` means Rust Debug quoting (a double-quoted,
escaped string: `"laptop"`). "bold/dim/green/…" refer to CLI-200's styles.

---

## CLI (`crates/slopmax`)

### Process entry and exit codes (`src/main.rs`)

- **CLI-001** Log level defaults to `info` when `argv[1]` is exactly `serve`, else `warn`; `SLOPMAX_LOG` (`error|warn|info|debug|off`, or `target=level,…` where the last `slopmax=` or untargeted directive wins) overrides; an unreadable value keeps the default. `slopmax/src/main.rs:22`; via `slopmax-common/src/log.rs:59`
- **CLI-002** Log lines are colored only when `NO_COLOR` is unset and stderr is a TTY. via `slopmax-common/src/log.rs:64`
- **CLI-003** A command's returned code is clamped to 0..=255 and becomes the exit status. `slopmax/src/main.rs:29`
- **CLI-004** Any command error prints `error: {e:#}` to stderr (the word `error:` red when colors are on; `{e:#}` is the error and its context chain joined by `: `) and exits 1. `slopmax/src/main.rs:30-33`
- **CLI-005** Parser usage errors are printed to stderr verbatim (CLI-015) and exit 2; help and version text go to stdout and exit 0. Neither loads the config, so printing help never creates `SLOPMAX_HOME`. `slopmax/src/commands.rs:455-465`; asserted `slopmax/tests/cli.rs:287`
- **CLI-006** After a successful parse and before dispatch, every command: loads config.toml (creating it from the commented template with a fresh `api_key` on first use, under `.config.lock`), applies the config's `proxy` process-wide, and opens the account store. `slopmax/src/commands.rs:467-469`; via `slopmax-core/src/config.rs:265-300,415-422`
- **CLI-007** A config.toml that does not parse fails every command (after parsing) with exit 1 and an `error:` line, and the file is left byte-for-byte untouched. `slopmax/tests/cli.rs:339-343`
- **CLI-008** `SLOPMAX_LISTEN`, when set and non-empty, overrides `listen`; an unparsable value fails with `SLOPMAX_LISTEN={value:?} is not an address`, exit 1. via `slopmax-core/src/config.rs:269-276`; asserted `slopmax/tests/cli.rs:347-356`
- **CLI-009** A bare `slopmax` (zero arguments) with stdin and stdout both TTYs and an empty store runs the guided setup (asking, empty plan) and exits 0; otherwise it runs the default command `status`. `slopmax/src/commands.rs:454,471-474`; `slopmax/src/commands/init.rs:111-115`; asserted `slopmax/tests/cli.rs:394-395`
- **CLI-010** The `mimalloc` cargo feature only swaps the allocator; no behavior to port (note in NOT-PORTED). `slopmax/src/main.rs:15-17`; `slopmax/Cargo.toml:14-17`

### The parser (`src/args.rs`)

- **CLI-011** The first token picks a command by name or alias; with no token, the default command (`status`). `slopmax/src/args.rs:163-164,189,307-311`
- **CLI-012** First token `-h`/`--help` prints the top-level help; `-V`/`--version` prints `slopmax {version}\n` (the workspace package version). `slopmax/src/args.rs:166-172`
- **CLI-013** First token `help` prints the top-level help; `help <cmd>` prints that command's help (aliases accepted); `help <unknown>` is an app-level unknown-command error. `slopmax/src/args.rs:174-182`
- **CLI-014** Any other first token starting with `-` is an app-level error `unexpected argument '{arg}'` with usage `slopmax [COMMAND]` and hint `--help`. `slopmax/src/args.rs:158-162,183-185`
- **CLI-015** A usage error renders exactly `error: {message}\n\nUsage: {usage}\n\nFor more information, try '{hint}'.\n`; for a command the usage is CLI-030's line and the hint `slopmax {canonical name} --help` (the canonical name even when an alias was typed). `slopmax/src/args.rs:141-149,190-194`
- **CLI-016** Unknown command: `unrecognized command '{name}'`, plus `\n\n  tip: a similar command exists: '{close}'` when a command name (aliases are not candidates) is within Levenshtein distance 2; the smallest distance wins, the earliest in table order on ties. `slopmax/src/args.rs:313-321,340-346`
- **CLI-017** A token is an option only if options have not ended, it starts with `-`, is longer than 1 char, and its second char is not an ASCII digit: `-` and `-1`/`-2` are positionals (negative priorities parse). `slopmax/src/args.rs:214-217`; test `negative_numbers_are_values_and_rest_is_verbatim`
- **CLI-018** The first `--` ends options and is dropped; later tokens are positionals. `slopmax/src/args.rs:218-221`
- **CLI-019** For a command with a trailing Rest argument, once every positional is filled the current token and all after it go to `rest` verbatim (including `--`, `--help`, flags); options before that point are still parsed (`run --help` prints help). `slopmax/src/args.rs:198,208-213`
- **CLI-020** A positional with choices must equal one exactly, else `invalid value '{arg}' for '{usage}'\n  [possible values: a, b, c]` where usage is `<NAME>` or `[NAME]`. `slopmax/src/args.rs:222-234`
- **CLI-021** A positional beyond those declared: `unexpected argument '{arg}'`. `slopmax/src/args.rs:223-225`
- **CLI-022** `-h`/`--help` anywhere among a command's options prints that command's help and exits 0, even if required positionals are missing. `slopmax/src/args.rs:239-241`
- **CLI-023** Long options: `--name` or `--name=value`; an unknown one fails `unexpected argument '{arg}'` plus `\n\n  tip: a similar argument exists: '--x'` (candidates are Flag/Value args as `--name`; the typed text up to its first `=` is compared). `slopmax/src/args.rs:242-252,323-337`
- **CLI-024** Short options: `-x` matches any Flag or Value with that short. For a Value, the rest of the token is the inline value (`-n100`, `-lfront`); for a Flag, each remaining char must be another short Flag (`-gw`), else unknown option `-{c}`. `slopmax/src/args.rs:253-277`
- **CLI-025** A Flag given an inline value fails `'--{name}' takes no value`. `slopmax/src/args.rs:280-282`
- **CLI-026** A Value with nothing after it fails `'--{name} <PLACEHOLDER>' needs a value`; otherwise the next token is the value even if it starts with `-`. `slopmax/src/args.rs:283-291`
- **CLI-027** Repeated options are accepted; reading a value returns its first occurrence. `slopmax/src/args.rs:98-109`
- **CLI-028** A missing Required positional fails `the following required argument was not provided: <NAME>` (the first missing one). `slopmax/src/args.rs:295-303`
- **CLI-029** An absent Optional positional reads as its default, including the empty-string default some commands use to mean "not given". `slopmax/src/args.rs:98-109`
- **CLI-030** A command's usage line: `slopmax {name}`, then ` [OPTIONS]` if it has any Flag/Value, then each positional/rest as `<X>`, `[X]`, or `[X]...` (names upper-cased). `slopmax/src/args.rs:71-81,366-384`
- **CLI-031** Typed conversion of a value fails `missing <NAME>` or `invalid <NAME> {value:?}: {reason}`; these are command errors (exit 1), not usage errors. `slopmax/src/args.rs:112-123`
- **CLI-032** Top-level help: about line, blank, `Usage: slopmax [COMMAND]`, blank, `Commands:`, rows `  {name:width}  {about}` with ` [alias: x]` appended where aliased, blank, `Options:` with `-h, --help  Print help` and `-V, --version  Print version`, blank, `Run without a command to show account status.`, newline. Each section's left column is padded to its widest entry. `slopmax/src/args.rs:387-396,399-425`
- **CLI-033** Command help: about, blank, `Usage: …`; `Arguments:` with each positional/rest (`[default: x]` appended for a non-empty Optional default), followed by one row per choice with an empty left cell and `  {value:width}  {help}`; `Options:` rows `-x, --name <P>` (or four spaces in place of `-x, `) and finally `-h, --help  Print help`. `slopmax/src/args.rs:427-466`
- **CLI-034** Edit distance is Levenshtein over Unicode scalar values. `slopmax/src/args.rs:349-364`
- **CLI-035** Completion shells are `bash`, `zsh`, `fish`; the Shell type's own parse error reads `expected bash, zsh, or fish`. `slopmax/src/args.rs:471-488`
- **CLI-036** bash script: `_slopmax() {`, `  local cur=${COMP_WORDS[COMP_CWORD]}`, at word 1 `compgen -W "{commands…} help --help --version"`, then `case "${COMP_WORDS[1]}" in` with one `    {name}|{alias}) COMPREPLY=($(compgen -W "{first positional's choices} {--options} --help" -- "$cur")) ;;` per command, ending `  esac\n}\ncomplete -F _slopmax slopmax`. `slopmax/src/args.rs:514-546`
- **CLI-037** zsh script is the bash script preceded by `#compdef slopmax` and `autoload -U bashcompinit && bashcompinit`. `slopmax/src/args.rs:515-520`
- **CLI-038** fish script: `complete -c slopmax -f`; per command `complete -c slopmax -n __fish_use_subcommand -a {name} -d '{about}'`; each first-positional choice `-n '__fish_seen_subcommand_from {name}' -a {value}`; each option `-n '…' -l {long}[ -s {short}][ -r] -d '{help}'` (`-r` for Values); `'` in text escaped as `\'`; aliases are not offered. `slopmax/src/args.rs:548-580`

### The command table (`src/commands.rs`)

- **CLI-040** Program name `slopmax`; about `Multi-account switcher and proxy for Claude Code and Codex`; default command `status`; after-help `Run without a command to show account status.` `slopmax/src/commands.rs:166-171`
- **CLI-041** Command order, as help and completions list them: setup (alias `init`), status (alias `ls`), login, import, own, use, label, priority, enable, disable, remove, redeem, serve, start, stop, service, run, env, config, usage, key, logs, notify, dashboard, doctor, completions. `slopmax/src/commands.rs:171-440`
- **CLI-042** `setup`/`init` — about `Set everything up step by step, or point one agent at the proxy`; `[AGENT]` (claude|codex, default empty) `Wire just this agent (else run the whole setup)`; `--undo` `With an agent: restore what setup replaced`; `-y, --yes` `Ask nothing: take the flags, else the recommended answers`; `--import <SOURCES>` `Take logins from claude-code, codex, cliproxyapi, all, or none`; `--login <PROVIDERS>` `Sign in to these subscriptions: claude, codex`; `--keys-from-env` `Add the keys in ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY`; `--strategy <STRATEGY>` `reset-first, fill-first, least-used, or round-robin`; `--affinity <on|off>` `on: sessions keep their account; off: every request placed afresh`; `--agents <AGENTS>` `Point these agents at the proxy: claude, codex, or none`; `--no-service` `Don't start slopmax at login`. `slopmax/src/commands.rs:172-228`
- **CLI-043** `status`/`ls` — `Show accounts, usage windows, and when limits reset`; `-r, --refresh` `Fetch fresh usage from the providers first`; `-w, --watch` `Keep the display updated`; `--json` `Print machine-readable JSON`. `slopmax/src/commands.rs:229-242`
- **CLI-044** `login` — `Connect an account: sign in, or enter an API key`; `<PROVIDER>` `Which kind of account` with choices `claude` `Claude Pro/Max, used by Claude Code`, `codex` `ChatGPT Plus/Pro/Team, used by Codex`, `anthropic` `An Anthropic API key (for Claude Code)`, `openai` `An OpenAI API key`, `xai` `An xAI API key, for Grok models`, `compat` `Any OpenAI- or Anthropic-compatible endpoint (needs --url)`; `--label <LABEL>` `Display name for the account`; `--device` `Sign in with a code instead of a browser redirect (Codex only)`; `--no-browser` `Print the sign-in URL instead of opening a browser`; `--url <URL>` `Compatible endpoint's base URL, e.g. http://localhost:11434/v1`; `--dialect <DIALECT>` `Its format: chat (the default), responses, or messages`; `--models <MODELS>` `Models the endpoint serves, comma-separated (default: what it lists)`. `slopmax/src/commands.rs:30-55,243-283`
- **CLI-045** `import` — `Copy existing logins from Claude Code, Codex, or CLIProxyAPI`; `[SOURCE]` `Where to import from` default `all`, choices `all` `Every source below`, `claude-code` `Claude Code's login (~/.claude/.credentials.json or the macOS keychain)`, `codex` `The Codex CLI login (~/.codex/auth.json)`, `cliproxyapi` `CLIProxyAPI credential files (~/.cli-proxy-api/*.json)`; `--own` `Refresh imported CLIProxyAPI logins here instead of following its files`. `slopmax/src/commands.rs:68-85,284-299`
- **CLI-046** `own` — `Take over refreshing an account slopmax follows from another tool`; `<ACCOUNT>` `Number from \`slopmax status\`, the account's id, email, or label, or \`all\``. `slopmax/src/commands.rs:300-308`
- **CLI-047** `use` — `Prefer an account for new sessions, or \`auto\` to let slopmax choose`; `<ACCOUNT>`with the shared help`Number from \`slopmax status\`, or the account's id, email, or label`. `slopmax/src/commands.rs:28,164,309-313`
- **CLI-048** `label` — `Set an account's display name`; `<ACCOUNT>`, `<LABEL>` `The new name`. `slopmax/src/commands.rs:314-321`
- **CLI-049** `priority` — `Set an account's priority; higher tiers are used first`; `<ACCOUNT>`, `<PRIORITY>` `Tier, 0 by default; negative values hold an account in reserve`. `slopmax/src/commands.rs:322-333`
- **CLI-050** `enable` `Route to an account again`; `disable` `Stop routing to an account (its tokens are still kept fresh)`; `remove` `Forget an account`; each takes `<ACCOUNT>`. `slopmax/src/commands.rs:334-340`
- **CLI-051** `redeem` — `Redeem a banked limit reset, resetting a Claude or ChatGPT account's limits`; `<ACCOUNT>`; `-y, --yes` `Skip the confirmation prompt`. `slopmax/src/commands.rs:341-348`
- **CLI-052** `serve` `Run the proxy in the foreground`; `start` `Start the proxy in the background`; `stop` `Stop the background proxy`; no arguments. `slopmax/src/commands.rs:349-351`
- **CLI-053** `service` — `Run the proxy as a service that starts at login`; `<ACTION>` `What to do`: `install` `Start slopmax at login (systemd user unit or launchd agent)`, `uninstall` `Remove the service`, `status` `Show whether the service is installed and running`. `slopmax/src/commands.rs:87-100,352-356`
- **CLI-054** `run` — `Launch an agent through the proxy, starting the proxy if needed`; `<AGENT>` `Which agent` (claude `Claude Code`, codex `Codex`); `[ARGS]...` `Arguments passed to the agent` (Rest). `slopmax/src/commands.rs:57-66,357-364`
- **CLI-055** `env` — `Print shell setup that points an agent at the proxy, for \`eval\``; `<AGENT>`. `slopmax/src/commands.rs:365-369`
- **CLI-056** `config` — `Show the routing and redeem settings, or change one while the proxy runs`; `[NAME]` `The setting, e.g. strategy`; `[VALUE]` `Its new value, e.g. round-robin` (both free text, default empty). `slopmax/src/commands.rs:370-385`
- **CLI-057** `usage` — `Show token usage and its API-equivalent cost`; `[RANGE]` `Which period` default `7d`, choices `today` `Since midnight`, `7d` `Today and the 6 days before`, `30d` `Today and the 29 days before`, `all` `Everything recorded`; `-b, --by <BY>` `Group by day, model, or account`; `--json`. `slopmax/src/commands.rs:117-134,386-398`
- **CLI-058** `key` — `Manage keys for other machines and tools`; `[ACTION]` default `list`, choices `list` `Show the keys`, `add` `Make a key for another machine or tool`, `remove` `Revoke a key`; `[NAME]` `The key's name`; `--models <MODELS>` `Models it may use, comma-separated patterns (default: any)`. `slopmax/src/commands.rs:102-115,399-411`
- **CLI-059** `logs` — `Show the background proxy's log`; `-f, --follow` `Keep printing new lines`; `-n, --lines <N>` `How many lines to show first (default 40)`. `slopmax/src/commands.rs:412-423`
- **CLI-060** `notify` `Send a test notification`; `dashboard` `Open the dashboard in a browser, starting the proxy if needed` with `--print` `Print its address instead of opening a browser`; `doctor` `Check the setup and say how to fix problems`; `completions` `Print a shell completion script` with `<SHELL>` `Which shell` (bash `Bash`, zsh `Zsh`, fish `Fish`). `slopmax/src/commands.rs:136-149,424-439`
- **CLI-061** The `login` provider choices equal the core provider registry in order (`claude, codex, anthropic, openai, xai, compat`) and the agent choices equal the agent registry (`claude, codex`). `slopmax/src/commands.rs:809-817` (test `agent_choices_match_the_registry`)
- **CLI-062** Every command has a typical invocation that parses (the 31 lines in the test, e.g. `priority 3 -1`, `run codex exec -c model=m hi`, `logs -f -n 100`, `key add laptop --models gpt-*`). `slopmax/src/commands.rs:819-871`

### Account references (shared by own/use/label/priority/enable/disable/remove/redeem)

- **CLI-065** `<ACCOUNT>` resolves, in order: a 1-based index into the store's list; an exact id, label, or email; else a unique id prefix. None → `no account matches {q:?} (see \`slopmax status\`)`; several → `{q:?} is ambiguous: {id}, {id}`; both exit 1. via `slopmax-core/src/account.rs:288-318`; asserted `slopmax/tests/cli.rs:333,452-453`

### Dispatch and small commands (`src/commands.rs`)

- **CLI-070** `setup <agent>` (non-empty agent) wires or, with `--undo`, restores that one agent (CLI-090/091); the plan flags are ignored in that form. `slopmax/src/commands.rs:476-478`
- **CLI-071** `setup --undo` without an agent fails ``--undo restores one agent: `slopmax setup claude --undo` ``. `slopmax/src/commands.rs:480-482`
- **CLI-072** Full `setup` asks nothing (Defaults) when `--yes` is given or stdin is not a TTY; otherwise asks. `slopmax/src/commands.rs:483-487`
- **CLI-073** `--strategy` must be `reset-first|fill-first|least-used|round-robin` exactly, else `--strategy takes reset-first, fill-first, least-used, or round-robin, got {s:?}`. `slopmax/src/commands.rs:492-499`
- **CLI-074** `--affinity` accepts `on|true|yes` and `off|false|no`, else `expected on or off, got {value:?}`. `slopmax/src/commands.rs:500,753-759`
- **CLI-075** Setup flag lists are validated before anything runs (no account, file, or stub touched on error): `--import` sources via `unknown source {s:?}`, `--login` via CLI-142, `--agents` via `unknown agent {name:?}`. `slopmax/src/commands.rs:488-503`; asserted `slopmax/tests/cli.rs:1131-1151`
- **CLI-076** `status --watch --json` fails `--json cannot be combined with --watch` (exit 1). `slopmax/src/commands.rs:512-514`
- **CLI-077** `login`: when `--url` is given, the endpoint is parsed first (CLI-078); then `compat` without `--url` fails `a compatible endpoint needs its address: --url <base url>`; then a non-compat provider with `--url` fails ``--url, --dialect, and --models are for `slopmax login compat` ``. `--dialect`/`--models` without `--url` are silently ignored for non-compat providers. `slopmax/src/commands.rs:517-528`
- **CLI-078** Endpoint parsing: URL must start with `http://` or `https://`, else `--url takes an http:// or https:// base URL, got {url:?}`; trailing `/`s trimmed; dialect `chat` (default) | `responses` | `messages`, else `--dialect takes chat, responses, or messages, got {other:?}`; models split on `,`, trimmed, empties dropped. `slopmax/src/commands.rs:680-702`
- **CLI-079** `label`: resolves the account, sets its label, prints `Renamed {id} to {bold name}`. `slopmax/src/commands.rs:541-546`
- **CLI-080** `priority`: `<PRIORITY>` parsed as i32 (negative allowed), prints `{bold name} now has priority {p}`. `slopmax/src/commands.rs:547-552`; asserted `slopmax/tests/cli.rs:419-421`
- **CLI-081** `serve` runs the daemon in the foreground until a `POST /slopmax/shutdown` (e.g. `slopmax stop`), then exits 0. `slopmax/src/commands.rs:557`; asserted `slopmax/tests/cli.rs:1072-1098`
- **CLI-082** `run <agent> [args…]`: ensures the proxy runs (CLI-123), then launches the agent with its proxy environment and the rest args. On Unix the process is replaced (exec), so the exit status is the agent's; failure is `could not start {program}: {err}` (exit 1, proxy left running). On non-Unix it spawns, waits, and returns the child's code (1 if none). `slopmax/src/commands.rs:561-564`; via `slopmax-core/src/agent/mod.rs:147-163`; asserted `slopmax/tests/cli.rs:1059-1060`
- **CLI-083** `env <agent>` prints the agent's shell setup exactly as the core produces it (no newline added), using the path of the running binary. `slopmax/src/commands.rs:565-568`; asserted `slopmax/tests/cli.rs:689-700`
- **CLI-084** `usage --by` defaults to `day`; anything but `day|model|account` fails `--by takes day, model, or account` (exit 1, after parse). `slopmax/src/commands.rs:574-578`
- **CLI-085** `notify`: with neither webhook nor command under `[notify]`, fails `notifications are off; set a webhook or command under [notify] in {config path}`; else sends the core's test event (`SLOPMAX_EVENT=test` to a command) through a default-origins HTTP client and prints `Sent a test notification.`. `slopmax/src/commands.rs:587-598`; asserted `slopmax/tests/cli.rs:989-1002`
- **CLI-086** `logs`: `--lines` parses as a non-negative integer, else `--lines takes a number`; default 40. `slopmax/src/commands.rs:600-606`
- **CLI-087** `dashboard`: ensures the proxy runs; without `--print`, if a browser opens prints `Opened the dashboard in your browser.`; otherwise (or with `--print`) prints `Open the dashboard at:\n\n  {url}\n` then dim `On another machine, forward the port first: ssh -L {port}:127.0.0.1:{port} <this host>`. URL is `{base_url}/slopmax/dashboard#key={api_key}`. `slopmax/src/commands.rs:607-622`; via `slopmax-core/src/config.rs:425-427`
- **CLI-088** `completions <shell>` prints the script (CLI-036..038) to stdout. `slopmax/src/commands.rs:624`
- **CLI-089** `doctor` returns its own exit code (CLI-135). `slopmax/src/commands.rs:623`
- **CLI-090** `setup <agent>`: writes the agent's config (core `agent::setup`), prints `{title} now uses slopmax {dim ({path})}`, then the dim setup note; if no connected account can serve the agent, prints ``{yellow Note:} no {provider title} account is connected to serve it; until one is, its requests fail. Add one with `slopmax login {provider}`, or undo with `--undo`.``; then dim ``Undo with `--undo`.`` when the proxy runs, else ``Start the proxy with `slopmax start` (or `slopmax service install`). Undo with `--undo`.`` `slopmax/src/commands.rs:766-802`
- **CLI-091** `setup <agent> --undo`: restores the backup and prints `Restored {title} {dim ({path})}`; with no backup fails `no {title} setup to undo`. Setting up twice keeps the first backup so undo restores the original byte-for-byte; on a fresh machine undo leaves no slopmax wiring. `slopmax/src/commands.rs:767-776`; via `slopmax-core/src/agent/mod.rs:203`; asserted `slopmax/tests/cli.rs:613-686`
- **CLI-092** `key` / `key list`: no keys → `No client keys. Make one with \`slopmax key add <name>\`.`; else one line per key `{bold name} {dim models joined ", " | "any model"}`; the secret is never listed. A name given to `list`is ignored.`slopmax/src/commands.rs:636-648`
- **CLI-093** `key add <name> [--models a,b]`: models split on `,`, trimmed, empties dropped; prints only the new key on stdout; on stderr dim `Added the key {name:?}. Clients present it as a bearer token or x-api-key; a running proxy takes it within seconds.`; the key is written to config.toml. `slopmax/src/commands.rs:649-666`; asserted `slopmax/tests/cli.rs:485-519`
- **CLI-094** `key remove <name>` prints `Revoked the key {name:?}.`; an unknown name fails `no key named {name:?}`. `key add|remove` without a name fails `` `slopmax key {action}` needs the key's name ``. `slopmax/src/commands.rs:667-673`
- **CLI-095** `config` (no name): one line per live setting, in core order (`strategy, session_affinity, session_ttl_mins, redeem_expiring_credits, redeem_when_exhausted, warm_windows, paid_overflow, poll_mins`): `{name padded to widest}  {bold value padded to 11}  {dim description}`, then a blank line and dim `` `slopmax config <name> <value>` changes one; the rest live in {config path}. `` `slopmax/src/commands.rs:706-727`; via `slopmax-core/src/config.rs:183-216`
- **CLI-096** `config <name>`: prints the current value as config.toml writes it; an unknown name fails `{name} is not a setting slopmax changes while it runs; those are {names, comma-separated}`. `slopmax/src/commands.rs:728-734`
- **CLI-097** `config <name> <value>`: validated by the core (`strategy is one of …`; `{name} is a number of minutes`, minutes > 0 except `poll_mins` may be 0; switches take `true|on|1|yes`/`false|off|0|no`, else `{name} is on or off`); written into config.toml keeping comments; then `POST /slopmax/sync`; prints `{name} = {bold value} {dim (applied now)}` or `{dim (the proxy applies it when it starts)}`. `slopmax/src/commands.rs:735-749`; via `slopmax-core/src/config.rs:219-248`

### Account commands (`src/commands/accounts.rs`)

- **CLI-100** `login --device` for a provider without device sign-in fails `--device works for ChatGPT accounts; {title} signs in with a browser`. `slopmax/src/commands/accounts.rs:28-33`
- **CLI-101** Key providers read the key with CLI-197, prompt `{spec title} key` (titles `Anthropic API`, `OpenAI API`, `xAI API`, so `OpenAI API key: `), or `API key (leave empty if it needs none)` when the key is optional (compat). `slopmax/src/commands/accounts.rs:34-41`
- **CLI-102** After connecting, prints `{Connected|Updated} {provider id} account {bold name}{ ({plan})} as {dim id}`; for an update nothing more. `slopmax/src/commands/accounts.rs:42-57`; asserted `slopmax/tests/cli.rs:892,916`
- **CLI-103** For a new account, a dim note: subscription → ``Check limits with `slopmax status --refresh`.``; metered → `It serves {models}.` (endpoint's models if any, else the spec's patterns, joined `, `), or, when the provider backs a subscription that has an account here, `It serves {models} when asked for by name ({provider}/<model>), or once every {sub title} account is limited if \`paid_overflow = true\` in config.toml.` `slopmax/src/commands/accounts.rs:58-81`; asserted `slopmax/tests/cli.rs:893,945-960`
- **CLI-104** Sign-in/key failures come from the core and exit 1, e.g. `rejected the key`, `name them with --models`, `no {spec title} key entered` (e.g. `no OpenAI API key entered`); a key that cannot be checked (network down) is kept. via core `auth::connect`; asserted `slopmax/tests/cli.rs:918-966`
- **CLI-105** `import [source] [--own]`: discovers logins; none → `No logins found to import.`; each saved one prints `  {green "+" new | yellow "~" updated} {provider} {bold name} {dim "from {origin}"}`; each failure `  {dim skipped} {origin}: {err}`. `slopmax/src/commands/accounts.rs:84-111`; asserted `slopmax/tests/cli.rs:770-848`
- **CLI-106** When any imported account is linked: blank line then `{cyan linked:} CLIProxyAPI keeps refreshing {n} of these, and slopmax follows its files,\n        so both can run while you switch over. Once CLIProxyAPI is stopped, run\n        \`slopmax own all\` so slopmax refreshes them.` `slopmax/src/commands/accounts.rs:112-119`
- **CLI-107** When more were imported than linked: blank line then `{yellow note:} Imported logins share refresh tokens with their source, and whichever\n      refreshes first invalidates the other's copy. Use the agents through slopmax\n      from now on (\`slopmax setup claude\`, \`slopmax setup codex\`).` `slopmax/src/commands/accounts.rs:120-127`
- **CLI-108** `own all` takes only linked accounts; none → `No accounts follow another tool.`. `own <account>`: an unlinked one prints `{bold name} already refreshes here.`; a linked one is unlinked and prints `slopmax now refreshes {bold name} {dim (was following {tool})}`; after the list (when non-empty) dim `Its first refresh signs the old copy out, so keep the other tool stopped.` `slopmax/src/commands/accounts.rs:132-163`; asserted `slopmax/tests/cli.rs:457-482`
- **CLI-109** `use auto` clears every pin and prints `slopmax will choose accounts automatically.`; `use <account>` pins it for its provider in `pins.json` (`{"claude": "<id>"}`) and prints `New {provider} sessions will use {bold name} while it has quota.` `slopmax/src/commands/accounts.rs:165-180`; asserted `slopmax/tests/cli.rs:429-440`
- **CLI-110** `enable`/`disable` set `disabled` and print `Enabled {bold name}` / `Disabled {bold name}`. `slopmax/src/commands/accounts.rs:182-188`
- **CLI-111** `remove` forgets the account (file and its pin) and prints `Removed {bold name}`. `slopmax/src/commands/accounts.rs:190-195`; asserted `slopmax/tests/cli.rs:442-448`
- **CLI-112** `redeem` on a provider without limit resets fails `{name} is a {title} account, which has no limit resets`. `slopmax/src/commands/accounts.rs:199-205`
- **CLI-113** `redeem` refreshes the token first when `refresh_tokens` is on; reads the last agent user agent per provider from `state.json` (`agents.{provider}`) and lists resets with it; network failure → `error:` exit 1. `slopmax/src/commands/accounts.rs:206-216`; asserted `slopmax/tests/cli.rs:978-986`
- **CLI-114** No resets → `{bold name} has no limit resets.` exit 0; else `{bold name} has {n} limit reset{s}{; the next expires in {human until}}.` then (unless `--yes`) confirm `Reset its usage windows now?` default No; declining (or closed stdin) exits 0 without redeeming. `slopmax/src/commands/accounts.rs:217-234`
- **CLI-115** Redeems the first listed (soonest) reset; outcomes print `Reset the usage windows on {bold name}.` (then `POST /slopmax/refresh`, result ignored), `Nothing to reset yet; the limit reset was kept.`, `No limit reset was available.`, `That limit reset was already used.`, `{provider title} would not use one right now, so it was kept.` `slopmax/src/commands/accounts.rs:235-252`

### Background, service, logs (`src/commands/background.rs`)

- **CLI-120** `start`: when a proxy answers, `slopmax is already running on {base_url}`; else launches and prints `slopmax running on {base_url} {dim (log: {log path})}`. `slopmax/src/commands/background.rs:14-26`
- **CLI-121** Launch: through the login service if one is installed, else spawns `{this binary} serve` detached in its own process group, stdin null, stdout and stderr appended to `slopmax.log` (home created 0700 first); then polls `/healthz` 50 times at 100 ms, failing `the proxy did not start; see {log path}`. via `slopmax-core/src/background.rs:132-139,169-201`
- **CLI-122** `stop`: if running, `POST /slopmax/shutdown` (bearer api_key) and `slopmax stopped`; else `slopmax is not running`. `slopmax/src/commands/background.rs:28-35`; via `slopmax-core/src/background.rs:141-149`
- **CLI-123** "Running" means `GET {base_url}/healthz` answers JSON with `service == "slopmax"` and a string `version`. The client is plain HTTP (no TLS roots), 1 s connect and 30 s total timeout. `base_url` maps an unspecified listen IP to `127.0.0.1` and brackets IPv6. via `slopmax-core/src/background.rs:26-51`; `slopmax-core/src/config.rs:401-411`
- **CLI-124** `service <action>` with no manager fails ``no supported service manager here (systemd user services or launchd); run `slopmax start` from a login script instead`` (also when `SLOPMAX_NO_SERVICE` is non-empty). `slopmax/src/commands/background.rs:44-47`; asserted `slopmax/tests/cli.rs:1101-1109`
- **CLI-125** `service install`: stops a running proxy (then waits 300 ms), writes and starts the unit/plist, waits for `/healthz`, prints `slopmax now starts at login {dim ({file})}`, and when lingering is known off, dim ``To keep it running after you log out (on a server), run `loginctl enable-linger $USER`.`` `slopmax/src/commands/background.rs:49-65`; via `slopmax-core/src/background.rs:153-161`
- **CLI-126** `service uninstall` prints `Removed the service {dim ({file})}`. `slopmax/src/commands/background.rs:66-72`
- **CLI-127** `service status` prints `service: not installed` | `service: {green installed and running}` | `service: {yellow installed, not running}`, plus dim ``It stops when you log out; `loginctl enable-linger $USER` keeps it.`` when installed and lingering is known off. `slopmax/src/commands/background.rs:73-87`
- **CLI-128** `logs` with no log file: `No log yet: {path} is written once the proxy runs in the background.` (exit 0); with `-f` it instead waits, rechecking every 500 ms. `slopmax/src/commands/background.rs:101-116`
- **CLI-129** `logs` reads at most the last 1 MiB, decodes it leniently (invalid UTF-8 replaced), and prints its last N lines each with `\n`. `slopmax/src/commands/background.rs:93,117-127`; asserted `slopmax/tests/cli.rs:1005-1016`
- **CLI-130** `logs -f` then polls the file size every 500 ms: growth is written raw and flushed; a shrink (truncated or replaced) reopens and restarts from byte 0; runs until interrupted. `slopmax/src/commands/background.rs:128-148`

### Doctor (`src/commands/doctor.rs`)

- **CLI-135** For each core doctor section: blank line, bold title; each finding `  {mark} {text}` with marks `✓` green (ok), `·` dim (note), `!` yellow (warn), `✗` red (fail), and a fix on its own line `      {dim fix:} {fix}`. Then a blank line and `{green Everything looks good.}` when no fails and no warnings, else `{n} problem{s}, {m} warning{s}.` Exit 1 when any finding failed, else 0. `slopmax/src/commands/doctor.rs:12-44`; asserted `slopmax/tests/cli.rs:703-762`

### Guided setup (`src/commands/init.rs`)

- **CLI-140** Opens with blank line, bold `slopmax setup`, dim `One local endpoint that spreads your agents across your accounts.`; steps print `\n{bold title}`: `Accounts`, `Routing`, `Agents`, `Background`. `slopmax/src/commands/init.rs:117-123,198-200`
- **CLI-141** Flag lists split on `,`, trimmed, empties and `none` dropped (`none` alone means an empty list). `slopmax/src/commands/init.rs:103-107`
- **CLI-142** `--login` accepts only subscription providers; others fail ``--login signs in to subscriptions (claude, codex); add {name} keys with --keys-from-env or `slopmax login {name}` ``; an unknown name fails with the provider parse error `expected one of claude, codex, anthropic, openai, xai, compat, got {s:?}`. `slopmax/src/commands/init.rs:82-94`; via `slopmax-core/src/provider/mod.rs:91-103`
- **CLI-143** Accounts step, `--import` given: each source is discovered and saved (not owned); each save prints `    {green +} {bold name}` or `    {dim skipped:} {err}`; a source that saved nothing records `--import {name} found no login to take`. `slopmax/src/commands/init.rs:219-233,351-363`
- **CLI-144** Accounts step, no `--import`: CLIProxyAPI logins found → `  CLIProxyAPI has {n} account{s} here. slopmax can follow them while\n  CLIProxyAPI keeps refreshing, so nothing gets signed out.` and confirm `  Import them?` default Yes. Then for each agent with a login of its own and no account of its provider yet, confirm `  Import {title}'s own login? (Signing in fresh below avoids sharing its tokens.)` default No; imported prints `    {green +} {bold name}` or `    {dim skipped:} {err}`. With Defaults the confirms take their defaults. `slopmax/src/commands/init.rs:309-348`
- **CLI-145** `--keys-from-env`: for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` (in that order) with a non-blank value, connects the trimmed key; prints `    {green +} {bold name} {dim from VAR}` or `    {yellow skipped} VAR: {err}` and records `VAR was not added`. `slopmax/src/commands/init.rs:68-72,237-261`
- **CLI-146** Which subscriptions to sign in to: `--login` list; with Defaults and no flag, none; asking: `term::choose_many("  Which accounts will slopmax pool?")` over every provider with phrases (`Claude Pro or Max, for Claude Code`, `ChatGPT Plus, Pro, or Team, for Codex`, `an Anthropic API key, billed per token`, `an OpenAI API key, billed per token`, `an xAI API key, for Grok models`, `any OpenAI- or Anthropic-compatible endpoint`), defaults = subscriptions with no account yet. A `--login` provider that adds nothing records `--login {provider} did not sign in`. `slopmax/src/commands/init.rs:203-212,263-292`
- **CLI-147** Adding one provider: prints `\n  {bold title}`; OAuth providers on a machine without a browser use device code (if supported) and no-browser; compat with Defaults fails ``a compatible endpoint needs `slopmax login compat --url <base url>` ``; asking, compat reads `  Base URL, e.g. http://localhost:11434/v1:` (empty stops) and `  Its API: chat, responses, or messages` [chat] (anything else → chat). A failure prints `    {yellow not added:} {err}` and continues. For subscriptions when asking, confirm `  Add another {title} account?` default No loops. `slopmax/src/commands/init.rs:367-411`
- **CLI-148** After adding, if any accounts: `  {dim connected:} {n} {title}, …` in provider order. `slopmax/src/commands/init.rs:293-303`
- **CLI-149** No accounts after the step: with Defaults, fails with `no accounts are connected, so there is nothing to proxy. Add one of:` and the four indented option lines (`--import claude-code,codex …`, `--import cliproxyapi …`, `--login claude,codex …`, `--keys-from-env …`), exit 1, nothing after `Accounts` printed; asking, prints `\n  No accounts yet. Run \`slopmax setup\` again, or add one with \`slopmax login claude\`\n or \`slopmax login codex\`.`and exits 0.`slopmax/src/commands/init.rs:126-143`; asserted `slopmax/tests/cli.rs:1112-1128`
- **CLI-150** Routing step: strategy from `--strategy`, else (Defaults) the current one, else `term::choose("  How should a new session pick its account?")` over the four strategies with their summaries, default the current; affinity from `--affinity`, else confirm `  Keep each session on the account it started on, so its prompt cache stays warm?` default = current. Prints `  {dim routing:} {strategy}, {sessions keep their account | every request placed afresh}`. Writes `strategy` and `session_affinity` to config.toml only if either changed, keeping the in-memory `listen`. `slopmax/src/commands/init.rs:415-466`
- **CLI-151** Agents step, per agent in registry order: skipped when `--agents` was given without it; when no account can serve it and it was not named, prints `  {title} left as it is: no {provider title} account to serve it. \`slopmax setup {id}\` wires it once there is one.`; when named but unservable, prints ` {yellow note:} {title} has no {provider title} account to serve it yet.`and wires anyway.`slopmax/src/commands/init.rs:148-176`; asserted `slopmax/tests/cli.rs:1242-1264`
- **CLI-152** Wiring: already through slopmax → `  {title} already uses slopmax.`; else confirm `  Point {title} at slopmax?{ (it uses {target} now; \`slopmax setup {id} --undo\` restores that)}`default Yes; wiring prints` {green wired} {dim file}`and` {dim setup note}`. `slopmax/src/commands/init.rs:468-487`
- **CLI-153** Background step: if a proxy runs, `  The proxy is running on {base}.`; with a manager not installed and no `--no-service`, confirm `  Start slopmax at login?` default Yes → install, `    {green installed} {dim file}`; installed → `  slopmax starts at login.`; no manager → `  {dim No login service here: the proxy runs until it is stopped; \`slopmax start\` brings it back.}`; finally ensures the proxy runs and, if it started one, ` The proxy is running on {base} {dim (log: {path})}`. `slopmax/src/commands/init.rs:489-520`
- **CLI-154** Ends `\n{green Done.} {1 account | n accounts} behind {bold base}.\n  Restart Claude Code, Codex, and the apps that run them. \`slopmax\` shows each\n account's usage, \`slopmax dashboard\` opens the dashboard, and \`slopmax doctor\`\n checks the setup.`; with Defaults and anything recorded as missed, then fails `set up, but not all that was asked: {missed joined "; "}`(exit 1).`slopmax/src/commands/init.rs:181-195`; asserted `slopmax/tests/cli.rs:1267-1296`

### Status (`src/commands/status.rs`)

- **CLI-160** The report comes from the running proxy (`GET /slopmax/status`, or `POST /slopmax/refresh` with `--refresh`), else is built offline from disk (polling providers first with `--refresh`; unreachable providers do not fail it). `slopmax/src/commands/status.rs:22-28`; asserted `slopmax/tests/cli.rs:398-405,1031-1034`
- **CLI-161** `--json` prints the core `Report` as pretty JSON (2-space indent) and exits. `slopmax/src/commands/status.rs:29-32`
- **CLI-162** `--watch` clears the screen (`\x1b[2J\x1b[H`) and redraws every 5 s; only the first round refreshes. `slopmax/src/commands/status.rs:34-43`
- **CLI-163** No accounts: `No accounts yet. Connect one with \`slopmax login claude\` or \`slopmax login codex\`,\nor bring existing logins over with \`slopmax import\`.\n` `slopmax/src/commands/status.rs:54-60`
- **CLI-164** Column constants: bar 10, plan 9, usage cell 22 (= bar + 12); name width = widest visible account name clamped to 7..=36. `slopmax/src/commands/status.rs:46-49,61-67`
- **CLI-165** Providers in registry order; subscription header `\n{bold UPPERCASE id padded nw+4}  {dim PLAN padded 9}  {dim 5H padded 22}  {dim WEEK padded 22}  {dim STATUS}`. `slopmax/src/commands/status.rs:69-90`
- **CLI-166** Account row: `{dim index right-aligned 2} {name cut to nw chars, padded nw+1}  {plan or "—" padded 9}  {5h cell}  {long-window cell}  {status}`; the index counts 1.. across all providers in display order. `slopmax/src/commands/status.rs:91-103`
- **CLI-167** Window cell: absent → dim `—` padded to 22; else `{bar} {percent "{:>3.0}%" colored by level} {dim countdown}`, countdown (human until) only when used > 0 and a reset is upcoming; padded to 22. `slopmax/src/commands/status.rs:223-240`
- **CLI-168** Status cell: condition description in its tone, then each note in its tone, joined by dim `·` (e.g. `limited · back in 1h00m`). `slopmax/src/commands/status.rs:242-253`
- **CLI-169** Model-scoped windows: a row `   {dim "└ {label}" padded to column-3}{cell}` under the 5H column (column = nw+4+2+9+2) for 5h windows, else under WEEK (+24). `slopmax/src/commands/status.rs:182-204`
- **CLI-170** Pool row only when the provider's pool has more than one account: `   {bold pool padded nw+1}  {dim "{n} accts" padded 9}  {5h}  {long}  {dim what the agents see}`, then the pool's scoped rows. `slopmax/src/commands/status.rs:207-221`; test `pools_get_a_row_of_their_own`
- **CLI-171** When the pool names a next account: `   {dim next session → {name or id}, {why}}`. `slopmax/src/commands/status.rs:108-118`
- **CLI-172** Metered providers: header with `BILLING` (9) and `MODELS` (width 46); rows `{idx} {name}  per token  {models joined ", " cut to 45 chars + "…" when longer than 46}  {status}`. `slopmax/src/commands/status.rs:142-179`
- **CLI-173** Nudges: blank line then `{yellow •} {message}` each. `slopmax/src/commands/status.rs:120-125`
- **CLI-174** Footer: blank line then dim `strategy {strategy} · proxy running` or `· proxy not running (last known state)`. `slopmax/src/commands/status.rs:126-138`

### Usage (`src/commands/usage.rs`)

- **CLI-180** Reads the ledger since the range's start, with account names from the store and `[prices]`; reads `windows.jsonl` since then for what was left on the table with `[plan_prices]`. An unknown range (unreachable via the parser) fails `unknown range {r:?}; use today, 7d, 30d, or all`. `slopmax/src/commands/usage.rs:18-31`
- **CLI-181** `--json`: the core summary report as pretty JSON with an added top-level `left_on_the_table`. Tests read `total.requests` (answered only) and `total.failed`. `slopmax/src/commands/usage.rs:33-38`; asserted `slopmax/tests/cli.rs:604-609`
- **CLI-182** Range title: `today`, `all time`, or `the last {N} days`; with no answered and no failed requests prints `No requests recorded for {title}.` `slopmax/src/commands/usage.rs:39-47`
- **CLI-183** Table: header `\n{bold BY padded w}  {REQ:>6}  {INPUT:>8}  {OUTPUT:>8}  {CACHE READ:>10}  {CACHE WRITE:>11}  {API COST:>9}` (headings dim; w = widest row key, at least 5); rows the same widths with compact counts and the cost label; a bold `total` row. `slopmax/src/commands/usage.rs:48-80`
- **CLI-184** Dim note: `Usage for {title}. API cost is what these requests would cost at API list prices (Anthropic's as of 2026-09, and any set in config.toml).`, plus `\n+ leaves out {n} request{s} to models without a price; set one under [prices] in {config path}.` and `\n{n} request{s} failed (the provider answered with an error, or no account could take it) and {is|are} left out.` when applicable. `slopmax/src/commands/usage.rs:81-103`
- **CLI-185** Left on the table (only when any weekly window lapsed): `\n{bold Left on the table:} {bold ${:.2}}, {:.0}% unused on average, across {n} weekly window{s}`; then accounts with unused ≥ 0.5%: `  {name padded 28}  {"${:.2}" right-aligned 7}  {dim "{:.0}% unused over {n}"}`; then dim ``What each plan costs for the part of its weekly quota a reset threw away. `slopmax status` shows what is left this week.`` + ` Plans without a known price are left out; set them under [plan_prices].` when some are unpriced. `slopmax/src/commands/usage.rs:110-144`

### Terminal input (`src/term.rs`)

- **CLI-190** One reader for the whole process consumes stdin line by line in order; questions and a sign-in waiting for a pasted address share it and never compete. `slopmax/src/term.rs:14-37`
- **CLI-191** `confirm(q, default)`: prints `{q} {dim [Y/n]|[y/N]} ` (no newline, flushed); empty answer or end of input → default; else true only for `y`/`yes` (case-insensitive, trimmed); any other text is No. `slopmax/src/term.rs:40-49`
- **CLI-192** `ask(q, default)`: prints `{q} ` or `{q} {dim [default]} `; trimmed answer, empty → default. `slopmax/src/term.rs:52-63`
- **CLI-193** `choose`: prints the question and the option list (CLI-195) with the default marked; asks `  Choose 1-{n}` [default+1] up to 3 times, each wrong answer printing `  {dim One number, please.}`; then the default. `slopmax/src/term.rs:67-82`
- **CLI-194** `choose_many`: list with defaults marked; asks `  Numbers, e.g. 1,3 ({bold 0} for none)` [defaults joined `,`]; an empty answer takes the defaults via ask; `0` or an empty defaults list → none; invalid → `  {dim Numbers from 1 to {n}.}`, 3 tries, then defaults. `slopmax/src/term.rs:86-112`
- **CLI-195** Option list rows: `  {green • if marked, else space} {dim index:>2} {name padded}  {dim help}`. `slopmax/src/term.rs:114-133`
- **CLI-196** Choice parsing: split on `,` and space, ignore empties, each an integer in 1..=len (0 or out of range → invalid), duplicates kept once in first-seen order, empty → invalid. `slopmax/src/term.rs:136-148`; test `choices_are_numbers_from_one`
- **CLI-197** Secrets: piped stdin → read all of it, trimmed (so `login xai < key.txt` works); TTY → `{prompt}: ` on stderr, echo off (Unix termios; no-op elsewhere), read a line, restore echo, newline on stderr, trimmed. `slopmax/src/term.rs:153-165,214-256`
- **CLI-198** Sign-in events go to stderr: Authorize → `\n  {Opened|Authorize} your {title} account in the browser:\n\n  {url}\n` then `  Waiting for the redirect to localhost:{port}. If the browser runs on another\n  machine, paste the final localhost URL from its address bar here.\n`; DeviceCode → `\n  Open {url}\n  and enter the code: {code}\n`; Notice → `  {text}`. `slopmax/src/term.rs:191-211`
- **CLI-199** While a sign-in waits, typed lines are forwarded to it as pasted redirect addresses (checking every 100 ms); once it ends, lines go to the next question. `slopmax/src/term.rs:169-189`

### Terminal output (`src/ui.rs`)

- **CLI-200** Colors only when `NO_COLOR` is unset and stdout is a TTY (decided once per process; also for text written to stderr). Codes: bold 1, dim 2, red 31, green 32, yellow 33, cyan 36, each `\x1b[{c}m…\x1b[0m`. `slopmax/src/ui.rs:10-46`
- **CLI-201** Tone colors: good green, muted dim, accent cyan, warn yellow, bad red; usage percent colored by `Tone::of_use`. `slopmax/src/ui.rs:49-62`
- **CLI-202** Bar: `round(clamp(p,0,100)/100 × width)` `█` then `░` to width, colored by level. `slopmax/src/ui.rs:65-69`; test `bar_fills_proportionally`
- **CLI-203** Padding measures visible width: chars outside `\x1b…m` sequences, one column per Unicode scalar (no East Asian width). `slopmax/src/ui.rs:72-90`; test `visible_width_ignores_escapes`

### Environment variables and files the CLI touches

- **CLI-210** Env read: `SLOPMAX_HOME` (home dir, default `~/.slopmax`; empty = unset), `SLOPMAX_LISTEN`, `SLOPMAX_LOG`, `SLOPMAX_NO_SERVICE` (non-empty hides the service manager), `NO_COLOR`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`XAI_API_KEY` (setup `--keys-from-env`), `DISPLAY`/`WAYLAND_DISPLAY` (has a browser on Linux), `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `USER`, `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (core). via `slopmax-core/src/paths.rs:11-30`, `service.rs:36,63,132,212`, `auth/callback.rs:181-185`, `config.rs:269`
- **CLI-211** Files: `config.toml`, `.config.lock`, `accounts/*.json`, `pins.json`, `state.json` (read by redeem), `usage/YYYY-MM.jsonl`, `windows.jsonl`, `slopmax.log`, `setup-backup.json`, plus the agents' `settings.json` and `config.toml`. Formats are the core's. `slopmax/src/commands.rs` (various); ARCHITECTURE.md:273-284
- **CLI-212** Browser opening: `open` (macOS), `explorer` (Windows), `xdg-open` (elsewhere); false (address printed instead) when Linux has neither `DISPLAY` nor `WAYLAND_DISPLAY`. via `slopmax-core/src/auth/callback.rs:181-200`

### Platform-specific behavior

- **CLI-215** Unix: `run` execs the agent; secrets typed with echo off; `serve` spawned in its own process group. Non-Unix: `run` spawns and waits; echo is not turned off. `slopmax/src/term.rs:219-243`; via `slopmax-core/src/agent/mod.rs:150-162`, `background.rs:186-190`
- **CLI-216** Service manager: launchd on macOS; systemd `--user` on Linux when `systemctl --user --version` succeeds; none elsewhere or with `SLOPMAX_NO_SERVICE`. Linger hints only where lingering is reported (Linux). via `slopmax-core/src/service.rs:35-47`
- **CLI-217** macOS `import` of Claude Code's login consults the keychain (`security find-generic-password`) when no credentials file exists; a present-but-expired file skips the keychain. asserted `slopmax/tests/cli.rs:774-778,841-847`

### The bench rig (`examples/bench.rs`), kept for side-by-side runs

- **CLI-220** Subcommands: `upstream <addr>` (mock provider), `proxy <addr> <upstream-url> <home>` (real server with throwaway accounts), `bodies <dir>`; anything else fails `usage: bench upstream <addr> | bench proxy <addr> <upstream-url> <home> | bench bodies <dir>`. `slopmax/examples/bench.rs:40-60`
- **CLI-221** Mock: `POST /v1/messages` streams `text/event-stream`: message_start (usage input 1200, cache read 48000, cache write 900), content_block_start, 60 text deltas of `The quick brown fox jumps over the lazy dog, then naps for a while. `, content_block_stop, message_delta (output 620), message_stop; headers `anthropic-ratelimit-unified-status: allowed`, `-5h-utilization: 0.21`, `-5h-reset: now+3h` (epoch s), `-7d-utilization: 0.43`, `-7d-reset: +1 day more`, `request-id: req_bench`. `slopmax/examples/bench.rs:97-110,247-272`
- **CLI-222** Mock: `POST /codex/responses` streams response.created, 60 `response.output_text.delta`, response.completed (input 1200, cached 1000, output 620); headers `x-codex-primary-used-percent: 21.0`, `-window-minutes: 300`, `-reset-at`, `x-codex-secondary-used-percent: 43.0`, `-window-minutes: 10080`, `-reset-at`. Other paths 404. `slopmax/examples/bench.rs:111-127,274-288`
- **CLI-223** Mock limit resets: `GET /wham/rate-limit-reset-credits` lists two credits per `bench-codex-0/1` token (dates fixed from mock start; ids `{token}-credit-{i}`), `POST …/consume` with `credit_id` answers `{"code":"reset"|"already_redeemed","windows_reset":2}`; `GET /api/oauth/usage` answers `cedar_ember` with one grant `opus55-launch-promax-20260921` for `bench-claude-0` only when the user agent starts `claude-cli/` (else `eligible:false, ineligible_reason:"surface"`); `POST …/reset_rate_limits` with `grant_id` answers `reset`/`already_used`/`ineligible`. `slopmax/examples/bench.rs:86-93,141-233`
- **CLI-224** `proxy`: creates two Claude and two Codex accounts (tokens `bench-{provider}-{i}`, emails `{provider}{i}@bench.invalid`, org UUIDs, plans `max 20x`/`max 5x` and `pro`/`plus`), config from the home with `listen`, `api_key = "bench"`, `refresh_tokens = false`, `poll_mins = 0`, and origins rewriting `https://api.anthropic.com` and `https://chatgpt.com/backend-api` to the upstream. `slopmax/examples/bench.rs:292-335`
- **CLI-225** `bodies`: writes `claude-small.json`, `claude-large.json` (~300 KB: 25 tools, 60 tool turns with thinking + signature, 2500-word system), `codex-small.json`, `codex-large.json` (60×4 items), filler from xorshift64 seeded 7 over 16 words, so every run sends the same bytes. `slopmax/examples/bench.rs:339-445`

### The integration-test harness contract (`tests/cli.rs`)

- **CLI-230** Every CLI test runs the built binary with a cleared environment: `PATH={stubs}:/usr/bin:/bin`, `HOME`, `SLOPMAX_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` in a temp dir, `SLOPMAX_LISTEN=127.0.0.1:{free port}`, `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY=http://127.0.0.1:9` (dead), `SLOPMAX_NO_SERVICE=1`, stdin null; stubs for `launchctl systemctl loginctl security open xdg-open` log their args and exit 1. The TS binary must honor these so the suite ports unchanged. `slopmax/tests/cli.rs:29-39,122-149`
- **CLI-231** The sandbox runs `slopmax stop` when dropped, so a test never leaves a proxy behind. `slopmax/tests/cli.rs:197-203`

### CLI Rust tests to mirror

`src/args.rs`: parses_flags_values_and_defaults (686), negative_numbers_are_values_and_rest_is_verbatim (699), explains_mistakes (709), renders_help (724), writes_completions (743), edit_distance (757).
`src/commands.rs`: agent_choices_match_the_registry (810), every_command_parses_a_typical_invocation (820).
`src/commands/init.rs`: lists_read_as_flags_give_them (527).
`src/commands/status.rs`: pools_get_a_row_of_their_own (271), renders_windows_status_and_scoped_limits (314), empty_report_explains_next_steps (367).
`src/term.rs`: choices_are_numbers_from_one (263).
`src/ui.rs`: visible_width_ignores_escapes (97), bar_fills_proportionally (103).
`tests/cli.rs`: help_version_and_completions_print_and_succeed (275), mistakes_explain_themselves_and_fail (296), a_bad_listen_override_is_named (347), status_shows_accounts_from_disk (359), refreshing_status_reports_unreachable_providers_without_failing (399), account_commands_change_the_store (408), own_takes_over_linked_accounts (457), keys_are_added_listed_and_revoked (485), usage_totals_the_ledger (556), setup_wires_the_agents_and_undo_restores_their_files_exactly (613), setup_on_a_fresh_machine_and_undo_leave_no_wiring (670), env_prints_shell_setup_for_each_agent (689), doctor_reports_findings_and_fails_on_problems (703), doctor_names_what_holds_the_port (747), import_brings_over_codex_and_cliproxyapi_logins (770), login_with_keys_reads_them_from_stdin (873), sign_ins_that_need_the_network_fail_cleanly (970), redeem_needs_an_account_with_resets (978), notify_sends_a_test_event_through_the_command (989), logs_show_the_tail_of_the_background_log (1005), the_background_proxy_starts_reports_and_stops (1019), serve_runs_in_the_foreground_until_stopped (1072), service_commands_find_no_manager_in_the_sandbox (1101), unattended_setup_with_nothing_to_pool_fails_and_says_what_to_add (1112), setup_flags_that_make_no_sense_are_refused (1131), unattended_setup_imports_routes_wires_and_starts_the_proxy (1154), unattended_setup_leaves_alone_an_agent_it_has_no_account_for (1242), unattended_setup_that_misses_part_of_what_was_asked_says_so (1267).

(43 tests.)

---

## APP (`crates/slopmax-app`: the desktop app without a toolkit)

### State (`src/lib.rs`)

- **APP-001** `Snapshot` fields: `proxy`, `address` (base URL), `report` (live or offline, optional), `agents`, `service` (optional), `sign_in` (optional), `notice` (optional), `history` (optional), `today` (optional), `redeeming` (account id, optional), `config` (as config.toml has it), `notifications` (bool), `new_key` (optional), `doctor`. `slopmax-app/src/lib.rs:51-82`
- **APP-002** Initial snapshot: proxy `Checking`, address = config base URL, every optional empty, agents empty, config = loaded config, notifications = told file's `enabled`, doctor `NotRun`. `slopmax-app/src/lib.rs:270-285`
- **APP-003** `Proxy` = `Checking | Starting | Running { version } | Stopped`. `slopmax-app/src/lib.rs:176-181`
- **APP-004** `Doctor` = `NotRun | Running | Done(sections) | Failed(message)`. `slopmax-app/src/lib.rs:93-99`
- **APP-005** `SignIn { provider, step, notes }`; `Step` = `Starting | Authorize { url, opened } | DeviceCode { url, code }`. `slopmax-app/src/lib.rs:192-212`
- **APP-006** `Notice { text, error, shown }` where `shown` is a monotonic instant. `slopmax-app/src/lib.rs:215-219`
- **APP-007** `NewKey { name, key }` (shown once); `NewEndpoint { url, dialect, models, key, label? }`; `AgentStatus { id, title, wiring }`. `slopmax-app/src/lib.rs:86-89,104-112,184-188`
- **APP-008** `Setting` variants and their config keys: Strategy→`strategy`, SessionAffinity→`session_affinity`, RedeemExpiringCredits→`redeem_expiring_credits`, RedeemWhenExhausted→`redeem_when_exhausted`, SessionTtlMins→`session_ttl_mins`, WarmWindows→`warm_windows`, PaidOverflow→`paid_overflow`, PollMins→`poll_mins`. Values serialize as `slopmax config` takes them (strategy kebab name, `true`/`false`, minutes). `slopmax-app/src/lib.rs:117-162`
- **APP-009** `Setting::write(path)`: validated by core `live_value` exactly as `slopmax config` (session TTL 0 rejected with `… is a number of minutes`), written with comments kept (including an inline comment beside the value), returns the reread config; a config that does not load is left untouched and errors. `slopmax-app/src/lib.rs:167-171`; tests `settings_are_written_into_config_toml`, `a_config_that_will_not_load_is_left_alone`, `advanced_settings_are_checked_as_the_cli_checks_them`

### Lifecycle and background work

- **APP-010** `App::start()` = `start_with(true)`; loads config (with `SLOPMAX_LISTEN`), applies `proxy`, builds a 2-worker runtime named `slopmax-app`, loads the told file, spawns the watcher and a proxy start. `slopmax-app/src/lib.rs:252-306`
- **APP-011** `start_with(false)` (screenshot mode) never hands nudges to the UI nor marks them told (no told state at all), though `notifications` still shows the file's flag. `slopmax-app/src/lib.rs:258,288`
- **APP-012** `subscribe()` returns a watch on the snapshot usable from any executor; `snapshot()` clones the latest; `handle()` exposes the runtime; `config()` is the config the app started with (address and key fixed for its life). `slopmax-app/src/lib.rs:310-327`
- **APP-013** Proxy start at launch and on demand: if `/healthz` answers, nothing; else `proxy = Starting`, ensure the bundled CLI's proxy runs; on failure `proxy = Stopped` and error notice `Could not start the proxy: {e}`; always asks for a full look. `slopmax-app/src/lib.rs:830-846`
- **APP-014** The CLI the app runs: `slopmax` (`slopmax.exe` on Windows) beside the app's executable, else `../bin/slopmax` relative to it, else the first on `PATH`; none → `cannot find the slopmax command line, which the app runs the proxy with; reinstall the app`. `slopmax-app/src/lib.rs:821-826,966-986`
- **APP-015** Watcher loop: each round asks the proxy for its report (`GET /slopmax/status`); if none, builds the offline report from disk (no refresh); hands new nudges (APP-060); updates `report`; expires a non-error notice older than 6 s; sets proxy to `Running{version from the live report}`, else keeps `Starting` if starting, else `Stopped`. `slopmax-app/src/lib.rs:850-878`
- **APP-016** A full look (first round, every 15 s, or when an action asked) rereads each agent's wiring and the login service status, and rereads config.toml into `snapshot.config` (adopting the running listen and api_key, APP-019); a config that fails to load leaves the old one. `slopmax-app/src/lib.rs:880-900,931-941`
- **APP-017** Between rounds it waits 2 s or until woken by an action, whichever first. `slopmax-app/src/lib.rs:41-44,902-905`
- **APP-018** Error notices stay until dismissed; others clear on the first round at least 6 s after shown. `slopmax-app/src/lib.rs:45-47,866-872`
- **APP-019** `adopt(running, read)`: a reread config takes the running config's `listen` and `api_key`. `slopmax-app/src/lib.rs:946-950`; test `a_reread_config_keeps_the_address_and_key_the_app_runs_with`
- **APP-020** After every account/config action (`act`/`change`/connect/import), `POST /slopmax/sync`: the returned report replaces `report`; no proxy → a quick look; then always a full look. `slopmax-app/src/lib.rs:813-819`
- **APP-021** `act`: runs the action off the async workers (blocking-capable), shows its text as a notice (error tone on failure, with the error chain; a panicked action reads `the action stopped`), then syncs. `slopmax-app/src/lib.rs:777-791`
- **APP-022** `change(id, …)`: loads account `id` from the store first, failing `account {id} is gone`. `slopmax-app/src/lib.rs:760-773`

### Actions and their notices

- **APP-030** `sign_in(provider)`: browser OAuth with default options. `add_key(provider, key)`: connects with that key. `add_endpoint(e)`: compat with the URL trimmed of whitespace and trailing `/`, its dialect, models, key, and label. `slopmax-app/src/lib.rs:330-356`
- **APP-031** Connecting cancels any sign-in in progress, clears the notice, sets `sign_in = {provider, Starting, []}`, routes login events into it (APP-038), and runs `auth::connect`; on finish clears `sign_in`, notices `Connected {name}.` / `Updated {name}.` or error `Sign-in failed: {e}`, then syncs. `slopmax-app/src/lib.rs:725-756`
- **APP-032** `paste(address)` hands a pasted redirect URL to the sign-in in progress (dropped if none). `cancel_sign_in()` aborts the sign-in task, drops the paste channel, clears `sign_in`. `slopmax-app/src/lib.rs:424-436`
- **APP-033** `import()`: discovers every source (`all`), saves without owning; notice `No logins found to import.` | `Imported {n account(s)}.` | `Imported {n account(s)} of {found} logins found.`; then syncs. `slopmax-app/src/lib.rs:439-457,988-990`; test `counts_of_accounts_agree`
- **APP-034** `pin(id)` → `New {provider} sessions will use {name} while it has quota.`; `unpin_all()` → `slopmax will choose accounts automatically.`; `set_disabled(id, b)` → `Disabled {name}.`/`Enabled {name}.`; `set_priority(id, p)` → `{name} now has priority {p}.`; `rename(id, label|None)` → `Renamed it {name}.` (None returns to email/key); `remove(id)` → `Removed {name}.`; `own(id)` (unlink) → `slopmax now refreshes {name} itself.` `slopmax-app/src/lib.rs:415-420,460-511`
- **APP-035** `connect_agent(id)` → `{title} now uses slopmax. {setup note}`; `disconnect_agent(id)` → `{title} is back to its own setup.`; an unknown id does nothing. `slopmax-app/src/lib.rs:514-533`
- **APP-036** `stop_proxy()` → `Stopped the proxy.` or error `Could not stop the proxy: {e}`; then a full look. `start_proxy()` = APP-013. `slopmax-app/src/lib.rs:535-548`
- **APP-037** `install_service()` (no manager → `this system has no service manager`) → `slopmax now starts at login.` or `Could not install the service: {e}`; `uninstall_service()` → `slopmax no longer starts at login.` or `Could not remove the service: {e}`, then starts the proxy the app's way (removing the service stopped it). `slopmax-app/src/lib.rs:551-587`
- **APP-038** Login events update the sign-in: Authorize → step `Authorize{url, opened}`; DeviceCode → `DeviceCode{url, code}`; Notice → appended to `notes`; ignored when no sign-in. `slopmax-app/src/lib.rs:952-961`; test `sign_in_progress_moves_the_step_along`
- **APP-039** `redeem(id)`: sets `redeeming = id`, asks the proxy (`POST /slopmax/accounts/{id}/redeem` → `{outcome, report}`; non-2xx → its `error.message`, else `it failed`; no proxy → `the proxy is not running`), clears `redeeming`, takes the report, and notices: `Reset the usage windows on {name}.`, `{name} had nothing to reset yet, so the limit reset was kept.`, `{name} has no limit reset left.` (error tone), `That limit reset was already used.`, `{provider title} would not use a limit reset on {name} right now, so it was kept.`; failure `Could not redeem a limit reset: {e}`. Name/provider come from the last report, else the id and `Its provider`. `slopmax-app/src/lib.rs:592-630`; via `slopmax-core/src/background.rs:68-91`
- **APP-040** `set(setting)`: writes it (APP-009), adopts the new config into the snapshot, notices `view::setting_changed`, syncs. `slopmax-app/src/lib.rs:633-640`
- **APP-041** `add_client_key(name, models)`: adds the trimmed name to config.toml, rereads config, sets `new_key`, notices `Made the key {name}.`; `revoke_key(name)`: missing → error `there is no key named {name}`; clears `new_key` if it was that one; notices `Revoked the key {name}.`; `dismiss_new_key()` clears it. `slopmax-app/src/lib.rs:360-397`
- **APP-042** `check_setup()`: `doctor = Running`, runs the core doctor against the snapshot's config, then `Done(sections)` or `Failed("{e:#}")`. `slopmax-app/src/lib.rs:400-411`
- **APP-043** `refresh()`: `POST /slopmax/refresh`; a report replaces `report`; no proxy → nothing. `slopmax-app/src/lib.rs:659-666`
- **APP-044** `load_history(range)` / `load_today()`: reads the ledger off-thread with account names from the last report and plan prices from the snapshot's config, into `history` / `today`. `slopmax-app/src/lib.rs:670-711`
- **APP-045** `open_dashboard()`: opens `{base}/slopmax/dashboard#key={key}`; no browser → error notice `Could not open a browser.` `slopmax-app/src/lib.rs:714-719`
- **APP-046** `dismiss_notice()` clears the notice; `set_notifications(on)` saves the told file's `enabled` (when the app tells at all) and sets `notifications`. `slopmax-app/src/lib.rs:649-656,721-723`
- **APP-047** `alerts()` hands the alert receiver to the UI once (later calls return none). `slopmax-app/src/lib.rs:644-646`

### Notifications state (`src/alerts.rs`)

- **APP-060** Each watcher round with a report: the core's nudges for the report's accounts (`redeem_expiring_credits`, `[plan_prices]` from the snapshot's config, now); new ones (by key) are remembered and, if enabled, each sent as an `Alert`; the told file is saved whenever anything changed (even when disabled). `slopmax-app/src/lib.rs:911-927`; `slopmax-app/src/alerts.rs:96-104`
- **APP-061** Told file `{home}/desktop-notified`, written owner-only: first line `enabled = true|false`, then one line per told key: `{key}\t{epoch seconds when it stops mattering}`. `slopmax-app/src/alerts.rs:37-39,63-69`
- **APP-062** Loading: missing/unreadable file → enabled, no keys; `enabled = ` value is false only when exactly `false` (trimmed); lines without a tab or with an unparsable time are skipped. `slopmax-app/src/alerts.rs:45-60`; test `a_missing_or_broken_file_starts_afresh_with_notifications_on`
- **APP-063** `fresh(found, now)`: drops keys whose time ≤ now; each found key not yet told is recorded with the event's `until` (else now) and returned as new; returns whether anything changed. `slopmax-app/src/alerts.rs:74-92`; tests `a_nudge_is_told_once`, `what_was_told_outlasts_a_restart_until_its_moment_passes`
- **APP-064** Alert titles: ResetExpiring `Limit reset expiring`, QuotaUnused `Quota going unused`, Exhausted `Every account is limited`, Recovered `Accounts are back`, SignedOut `Sign in again`, Limited `Account limited`, Available `Account available`, Test `slopmax`. `slopmax-app/src/alerts.rs:107-118`
- **APP-065** Alert body = the core message with every backtick removed; the alert carries its key (re-posting under a key replaces). `slopmax-app/src/alerts.rs:122-144`; test `a_notification_reads_plainly`

### What a window draws (`src/view.rs`)

- **APP-070** `groups(report, now)`: one Group per provider with accounts, in registry order: title, `subscription`, `limits` (column titles), rows, overview, `working`, `weighted`, `credits`, `next`, `next_short`. `slopmax-app/src/view.rs:24-51,454-519`
- **APP-071** Window columns ("slots"): every distinct (span, model) any account reports, sorted unscoped first, then by span order 5h, 7d, 30d, other, then span text, then model. Titles `5-hour`, `Weekly`, `Monthly`, else the span; scoped ones `{span title} · {model}`. `slopmax-app/src/view.rs:573-626`; test `a_window_for_one_model_gets_a_column_after_the_shared_ones`
- **APP-072** Overview per slot: the pool's matching window, or a lone account's own when the provider has no pool and one account; gauge as APP-085 but without pace; shares per account in group order. `slopmax-app/src/view.rs:472-495`
- **APP-073** Share: weight = the pool's plan share for the account (0 if absent) when the pool has shares, else 1 for all; fraction = used/100 clamped; tone by use; `idle` when disabled or signed out. `weighted` is true when the pool has shares. `slopmax-app/src/view.rs:466-471,888-896`; test `a_weighted_pool_sizes_its_segments_by_plan`
- **APP-074** `working` = the pool's account count, else the count of serving (enabled and signed-in) accounts. `slopmax-app/src/view.rs:508-511,884-886`
- **APP-075** Row: id, name, plan (`title_case(plan)`, else `per token` for metered, else empty), one gauge or none per slot, status, notes, pinned, disabled, priority, `last_used` (`ago`), credits, `next` (is the pool's next account), `follows` (tool name). `slopmax-app/src/view.rs:54-76,497-500,1116-1156`; test `plans_read_in_title_case_and_a_followed_login_names_its_tool`
- **APP-076** Row status = condition's words in its tone, with ` · pinned` appended when pinned (but not when disabled). Notes exclude reset-credit and pinned notes; the served note reads `{grouped n} request(s), {compact tokens} tokens all time`. `slopmax-app/src/view.rs:1131-1147,1233-1251`; test `a_pin_reads_in_the_status_and_use_says_its_period`
- **APP-077** `ago`: `used just now` (<60 s), `used {m}m ago`, `used {h}h ago`, `used {d}d ago`; future times count as 0. `slopmax-app/src/view.rs:1068-1076`; test `last_use_reads_coarsely`
- **APP-078** `grouped`: thousands separated by `,`. `title_case`: each space-separated word capitalized. `slopmax-app/src/view.rs:1159-1182`
- **APP-079** Group `credits`: total unexpired credits across accounts; none → absent; `{n limit reset(s)}` plus ` · the next expires in {until}` when any has an expiry. `slopmax-app/src/view.rs:629-651`
- **APP-080** Row `credits` only for providers with a credits API and credits left: title `{n} limit reset(s)`, credit lines soonest first, `clears` = unscoped window titles lowercase-first joined as English (`a`, `a and b`, `a, b, and c`), `held` = `Sign in again to redeem one` (signed out) | `Turn it on to redeem one` (disabled) | `Nothing to reset yet` (every unscoped window ≤ 0% used) | none. `slopmax-app/src/view.rs:654-688,867-874`; tests `reset_credits_show_their_dates_and_what_they_clear`, `lists_read_as_english`
- **APP-081** Credit line: `expires` = `Expires {clock}` or `Does not expire`; `line` = `Expires in {until} · {clock}` or `Does not expire`; `left` = `in {until}`; `granted` = `Granted {day}`; tone warn when it expires within 72 h, else muted. `slopmax-app/src/view.rs:94-110,690-714`
- **APP-082** `next` line: with a pool next → `New sessions → {name} · {why}` muted (short form uses the address's local part); without → `No account can take a new session until {clock}, when {name} is back` for the soonest-limited enabled account, else `No account can take a new session`, warn. `slopmax-app/src/view.rs:524-568`; tests `a_pool_says_where_new_sessions_go`, `with_no_account_free_it_says_when_one_is_back`
- **APP-083** `clock(at, now, offset)`: `HH:MM` on now's local day; `{Mon..Sun} HH:MM` 1–6 days ahead; `{Mon abbrev} {day}` otherwise (including past days). Offset is the local UTC offset at `at` (DST-aware). `slopmax-app/src/view.rs:1078-1114`; test `resets_read_on_the_local_clock`
- **APP-084** `day(at, now, offset)`: `today`, `yesterday`, else `{Mon} {d}`. `slopmax-app/src/view.rs:1085-1095`
- **APP-085** Gauge: fraction used/100 clamped, percent `{used:.0}%`, `resets_in`/`resets_at` only when used > 0 and a reset is upcoming, tone by use, pace. `slopmax-app/src/view.rs:1010-1021`; test `groups_carry_gauges_status_and_the_pool`
- **APP-086** Pace (5h/7d/30d only): elapsed = (length − time to reset)/length; none before 3% elapsed, at/after 100%, or when used ≥ 100; within ±5 points of even → `On pace` muted; ahead → `Runs out ~{clock of now + (100−used)/rate}` warn (rate = used per elapsed second); behind → `{-ahead:.0}% in reserve` muted. `slopmax-app/src/view.rs:1024-1065`; test `pace_compares_use_with_an_even_spend`
- **APP-087** `status(report)`: over enabled accounts, ready = Ready or Active; headline `No accounts yet` (none at all), `Every account is turned off`, `Your account is ready` (1 of 1), `All {n} accounts are ready`, `{r} of {n} accounts are ready`; detail parts `{n} limited` (Limited or Throttled), `1 needs signing in`/`{n} need signing in`, `{n} turned off` joined `·`; tone bad if any signed out, else warn if any limited, else good. `slopmax-app/src/view.rs:170-223`; test `status_and_attention_say_what_wants_a_look`
- **APP-088** `attention(report)` over enabled accounts: signed out → `{name} needs signing in again` / what `sign in again`, bad, remedy SignIn (nothing else for it); limited while holding credits → `{name} is limited until {clock}, and holds {n limit reset(s)}` / `limited until {clock}, {n} held`, warn, Redeem; merely limited → nothing; each unscoped window whose pace is warn → `{name}'s {window title lowercase-first} window {pace lowercase-first}` / `{title} {pace}`, warn, Look; an unexpired credit expiring within 72 h → `A limit reset on {name} expires in {until} · {clock}` (+ `; auto-redeem is off` when a ResetExpiring nudge names the account) / `reset expires in {until}`, warn, Redeem. Then nudges (APP-089); sorted stably with bad first. `who` is the name's local part. `slopmax-app/src/view.rs:236-350`
- **APP-089** Nudges joined: only those naming an account in the report; ResetExpiring skipped if that account already has a Redeem item, else text = the message's first sentence (split at `. `, trailing `.` dropped, backticks removed, every ` (x)` rewritten ` · x`) / `reset expires in {until}`; QuotaUnused → `{name}'s {week|month} resets in {until} · {clock} with {unused:.0}% of it unused{, about ${worth:.0} of its plan when worth ≥ 0.5}` / `{period} ends in {until}, {unused:.0}% unused`, warn, Look; unused is 100 − used of the account's unscoped 7d/30d window now. `slopmax-app/src/view.rs:354-451`; tests `nudges_join_what_wants_a_look_once`, `a_reset_already_offered_is_not_offered_twice`
- **APP-090** `menu_bar(report)`: per pool `{title} {5h used:.0}%` or `{title} —`, joined `·`; no pools → `slopmax`. `slopmax-app/src/view.rs:900-917`; tests `the_menu_bar_shows_each_pool`, `the_menu_bar_without_pools_shows_the_name`
- **APP-091** `proxy_line`: `Looking for the proxy…`, `Starting the proxy…`, `Running {version} at {address}`, `Stopped: agents cannot reach slopmax`. `slopmax-app/src/view.rs:920-927`; test `the_proxy_line_says_how_it_stands`
- **APP-092** `agent_line`: `Goes through slopmax` (connected), `Goes to {target}`, `Goes straight to its provider`. `slopmax-app/src/view.rs:930-936`
- **APP-093** `login(service)`: none → off, unavailable, `This system has no login service slopmax can use, so the app starts the proxy while it runs.`; else on = installed, available, `Runs the proxy whenever you log in. It is not running now.` (installed, not running) or `Runs the proxy whenever you log in, even while the app is closed.` `slopmax-app/src/view.rs:941-966`; test `agents_and_the_service_read_plainly`
- **APP-094** `sign_in` view: title `Signing in to {title}`; detail `Starting…` | `Finish signing in to {title} in your browser, which opened this address:` (+link) | `Open this address in a browser and sign in to {title}:` (+link) | `Open {url} and enter this code:` (+code, no link); notes joined by newline. `slopmax-app/src/view.rs:970-1008`; test `a_sign_in_says_what_to_do_next`
- **APP-095** Strategy titles `Reset first`, `Fill first`, `Least used`, `Round robin`; detail = core summary + `.`; `routing(config)` = `{title} · sessions keep their account|sessions move between accounts`. `slopmax-app/src/view.rs:737-760`; tests `every_strategy_has_a_name_and_a_sentence`, `routing_reads_as_a_line`
- **APP-096** Fixed words: AFFINITY `Keep a conversation on the account it started on, so its prompt cache stays warm. Off, the strategy places every request.`; AFFINITY_HEADER `A request can ask otherwise with the x-slopmax-affinity header, set to on or off.`; `redeem_expiring_detail` `Redeem it 3 hours before, if the account has quota to reset.`; REDEEM_EXHAUSTED `Redeem one so the pool keeps serving, rather than wait for a reset.` `slopmax-app/src/view.rs:763-777`
- **APP-097** `auto_redeem(config, provider)`: both on → `slopmax redeems one by itself when every {provider} account is spent, and 3 hours before one would expire unused.`; expiring only → `slopmax redeems one by itself 3 hours before it would expire unused, if the account has quota to reset.`; exhausted only → `slopmax redeems one by itself when every {provider} account is spent.`; neither → none. The 3 is `CREDIT_EXPIRY_LEAD` in hours. `slopmax-app/src/view.rs:718-734`; test `auto_redeem_follows_the_config`
- **APP-098** `setting_changed`: `slopmax now routes {strategy title lowercased}.`; `Sessions keep the account they started on.` / `The strategy now places every request.`; `Limit resets are redeemed before they expire.` / `Limit resets are left to expire.`; `A limit reset is redeemed once every account is spent.` / `Once every account is spent, the pool waits for a reset.`; `A session keeps its account through {minutes} idle.`; `Idle ChatGPT windows start as they reset.` / `Idle windows wait for their first request.`; `API keys take over once subscriptions are limited.` / `API keys serve a subscription's models only when asked for by name.`; `slopmax no longer polls usage.` (0) / `slopmax polls usage every {minutes}.` `slopmax-app/src/view.rs:781-814`; tests `changing_a_setting_says_what_it_does_now`, `advanced_settings_step_and_read`
- **APP-099** `live_detail(name)`: the core LIVE description, first letter upper-cased, `.` appended; unknown → empty. `slopmax-app/src/view.rs:818-828`
- **APP-100** Steppers: session TTL steps `5, 15, 30, 60, 120, 240, 480, 1440`; poll steps `0, 1, 2, 5, 10, 15, 30, 60`; `step(up)` = first step greater than current, `step(down)` = last step less than current (a hand-set value between steps moves to the nearer one in that direction); `minutes`: `1 day` (1440), `{h} h` (whole hours ≥ 60), else `{m} min`. `slopmax-app/src/view.rs:832-853`
- **APP-101** `left_line(windows, unused)`: `No weekly window reset in this range` | `1 weekly window · {u:.0}% unused` | `{n} weekly windows · {u:.0}% unused on average across them`. `slopmax-app/src/view.rs:858-864`; test `what_resets_left_reads_as_a_line`
- **APP-102** `patterns(text)`: split on commas and any whitespace, empties dropped. `range_title`: `Today`, `7 days`, `30 days`. `slopmax-app/src/view.rs:1185-1199`; test `small_words_for_the_access_page_and_ranges`
- **APP-103** `pool_basis`: `weighted by plan` | `average of accounts`; `segments_tip`: `One segment per account, as wide as its plan's share of the pool` | `One segment per account; the pool reads as their average`. `slopmax-app/src/view.rs:1203-1218`
- **APP-104** `level_tone`: doctor Ok→good, Note→muted, Warn→warn, Fail→bad. `slopmax-app/src/view.rs:1221-1229`
- **APP-105** `history` is re-exported from the core (`history::Range` default `Week`, `ALL = [Today, Week, Month]`). `slopmax-app/src/lib.rs:12`; via `slopmax-core/src/history.rs:26-37`

### APP Rust tests to mirror

`src/alerts.rs`: a_nudge_is_told_once (167), what_was_told_outlasts_a_restart_until_its_moment_passes (190), a_missing_or_broken_file_starts_afresh_with_notifications_on (221), a_notification_reads_plainly (234).
`src/lib.rs`: settings_are_written_into_config_toml (1021), a_config_that_will_not_load_is_left_alone (1051), advanced_settings_are_checked_as_the_cli_checks_them (1060), each_setting_has_its_key (1078), a_reread_config_keeps_the_address_and_key_the_app_runs_with (1098), sign_in_progress_moves_the_step_along (1135), counts_of_accounts_agree (1183), commands_are_looked_up_on_path (1190).
`src/view.rs`: groups_carry_gauges_status_and_the_pool (1327), a_window_for_one_model_gets_a_column_after_the_shared_ones (1350), resets_read_on_the_local_clock (1382), pace_compares_use_with_an_even_spend (1396), last_use_reads_coarsely (1413), reset_credits_show_their_dates_and_what_they_clear (1422), status_and_attention_say_what_wants_a_look (1488), the_menu_bar_shows_each_pool (1538), a_pool_says_where_new_sessions_go (1546), with_no_account_free_it_says_when_one_is_back (1572), a_pin_reads_in_the_status_and_use_says_its_period (1599), nudges_join_what_wants_a_look_once (1622), a_reset_already_offered_is_not_offered_twice (1674), advanced_settings_step_and_read (1707), what_resets_left_reads_as_a_line (1744), a_weighted_pool_sizes_its_segments_by_plan (1754), plans_read_in_title_case_and_a_followed_login_names_its_tool (1773), small_words_for_the_access_page_and_ranges (1785), the_menu_bar_without_pools_shows_the_name (1801), every_strategy_has_a_name_and_a_sentence (1807), routing_reads_as_a_line (1821), changing_a_setting_says_what_it_does_now (1836), auto_redeem_follows_the_config (1863), lists_read_as_english (1884), the_proxy_line_says_how_it_stands (1912), agents_and_the_service_read_plainly (1934), a_sign_in_says_what_to_do_next (1972).

(39 tests.)

---

## DESK (`crates/slopmax-desktop-gpui`: the desktop app)

### The screens at a glance (layout to rebuild)

**Main window** (1160×800 at first, centered; minimum 880×560; title `slopmax`;
macOS traffic lights at x 18, y 19). A horizontal split:

- _Sidebar_ (left, 220 wide by default, resizable 190–340, background
  `sidebar`, right hairline): a 52-tall header strip that drags the window
  (left padding 84 on macOS, 16 elsewhere): the 18-point logo tile, `slopmax`
  14/semibold, and a hide-sidebar icon button at the right. Then a scrolling
  list (padding x 8, bottom 12, 1 gap): `Overview`; heading `Accounts`; one
  row per provider that has accounts (or a faint `None yet`); heading
  `Activity`: `Usage`, `Performance`; heading `Setup`: `Agents`, `Access`,
  `Diagnostics`, `Settings`. Rows are 30 tall, 6 radius, icon 15 + title,
  provider rows trail a status dot or account count. At the foot (top
  hairline): a proxy-status button: dot, state, and address.
- _Page_ (right): a 52-tall title bar (title 20/semibold at left, tools at
  right; left padding 32, or 84 on macOS when the sidebar hides, with a
  show-sidebar button before the title), then a scrolling body (padding x 32,
  top 4, bottom 40, gap 32): an optional sign-in card, then the page content
  capped at 1080 wide.
- A toast floats at the bottom right (20 from the edges, 400 wide) for the
  latest notice.

**Overview**: a status line (dot, headline, muted detail) with the routing
line link at the right; `Needs attention` panel (if any); `Subscriptions`
panel, one clickable block per pool; `Today` panel: 4 stats and an hourly
column chart.

**Provider page**: `Pool` section (if the provider has pool windows): cells
side by side per window (title, big percent + `used`, segmented bar, resets
line), then a footer row (`Across …` and credits); `Accounts` section (with
`Let slopmax choose` when any is pinned): a table header (`Account`, one
column per window, controls) and one row per account (name block, window
cells, `…` menu), notes beneath, and an opened reset-credit well.

**Usage**: 4 stats; Tokens chart; Requests | API value charts side by side;
Models | Token mix; Agents; When you work (not for Today); Accounts table;
Left on the table. **Performance**: 4 stats; Reliability | Input from cache;
Output speed | Time to first byte.

**Agents**: intro text and one row per agent. **Access**: intro, `Add an
account` panel (Sign in, Import, API key, Compatible endpoint), `Client keys`
panel. **Diagnostics**: intro and one card of findings. **Settings**:
Appearance, Proxy, Routing, Limit resets, Notifications, Advanced.

**Menu bar panel**: a 340-wide card hanging 6 below the menu bar item: header
(logo, `slopmax`, status line, refresh), `Needs attention` (≤3), each pool,
`Today`, then commands `Open slopmax ⌘O`, `Settings… ⌘,`, `Quit slopmax ⌘Q`.

### Process, actions, keys, menus (`src/main.rs`)

- **DESK-001** On launch: starts slopmax-app (posting nothing when `SLOPMAX_SHOTS` is set), registers assets, quits only explicitly (closing the window leaves the menu bar item running; reopening from the Dock opens the window again), loads prefs and themes, binds actions, keys, menus, the panel, builds the menu bar item (failure logs `slopmax: no menu bar icon: {e}` and continues), opens the window, and starts posting notifications. `slopmax-desktop-gpui/src/main.rs:156-209`
- **DESK-002** Actions: OpenWindow, Refresh (app.refresh), Quit, Hide, HideOthers, ShowAll, CloseWindow, Minimize, Zoom (front window), SignInClaude, SignInChatGpt (sign in to Codex), ImportLogins (app.import), AddKey (window at Access), OpenSettings (window at Settings), ToggleSidebar; sidebar SelectPrevious/SelectNext; panel ClosePanel. `slopmax-desktop-gpui/src/main.rs:49-69,170-187`; `panel.rs:33`
- **DESK-003** Key bindings: `cmd-q` Quit, `cmd-h` Hide, `alt-cmd-h` HideOthers, `cmd-w` CloseWindow, `cmd-m` Minimize, `cmd-r` Refresh, `cmd-o` OpenWindow, `cmd-,` OpenSettings, `ctrl-cmd-s` ToggleSidebar (instant, no slide); `up`/`down` move through pages while the sidebar list has focus; `escape` closes the panel. `slopmax-desktop-gpui/src/main.rs:224-238`; `panel.rs:45`
- **DESK-004** Menus: `slopmax` (Settings…, —, Services, —, Hide slopmax, Hide Others, Show All, —, Quit slopmax); `File` (Sign In with Claude…, Sign In with ChatGPT…, Import Logins, Add an API Key…, —, Close Window); `Edit` (Undo, Redo, —, Cut, Copy, Paste, Select All — reaching the focused field); `View` (`Hide Sidebar` or `Show Sidebar` by current state, —, Refresh Usage); `Window` (Minimize, Zoom). Menus are rebuilt whenever the sidebar shows or hides. `slopmax-desktop-gpui/src/main.rs:242-289`
- **DESK-005** Opening the window dismisses the panel; an existing window is activated instead of a second opened; window-open failure logs `slopmax: could not open the window: {e}`. `slopmax-desktop-gpui/src/main.rs:319-357`
- **DESK-006** `show(section)` opens/activates the window and goes to that page. `slopmax-desktop-gpui/src/main.rs:360-370`
- **DESK-007** Window geometry: 1160×800 centered, minimum 880×560, title `slopmax`, traffic lights at (18, (52−14)/2). `slopmax-desktop-gpui/src/main.rs:330-344`
- **DESK-008** Each snapshot change redraws the window and, when a report exists, sets the menu bar item's title to `view::menu_bar`. `slopmax-desktop-gpui/src/main.rs:497-515`
- **DESK-009** A 1 s tick: on Usage/Performance reloads the range's history when 60 s old (or never asked); elsewhere redraws (countdowns), and on Overview reloads today's history when 60 s old. `slopmax-desktop-gpui/src/main.rs:93,516-525,562-577`
- **DESK-010** The window follows the system's light/dark when Appearance is System; the window becoming active closes the panel. `slopmax-desktop-gpui/src/main.rs:526-534`
- **DESK-011** Initial state: page Overview, sidebar list focused, key provider Anthropic, range Week, today's history requested. `slopmax-desktop-gpui/src/main.rs:535-559`
- **DESK-012** Going to a page: same page → nothing; Usage/Performance → load history for the range; Overview → load today; Diagnostics → run the checks unless running. `slopmax-desktop-gpui/src/main.rs:590-606`
- **DESK-013** Page order (sidebar and arrow keys): Overview, one per provider with accounts (registry order), Usage, Performance, Agents, Access, Diagnostics, Settings; arrows clamp at the ends. `slopmax-desktop-gpui/src/main.rs:610-641`
- **DESK-014** Page titles: `Overview`, provider title (`Claude`, `ChatGPT`, …), `Usage`, `Performance`, `Agents`, `Access`, `Diagnostics`, `Settings`; icons LayoutDashboard, Users, ChartColumn, Zap, Bot, KeyRound, Stethoscope, Settings. `slopmax-desktop-gpui/src/main.rs:114-140`

### Sidebar

- **DESK-020** Width starts at the saved width clamped to 190–340 (default 220); hidden state restored from prefs. `slopmax-desktop-gpui/src/main.rs:83-87,418-427`
- **DESK-021** Pressing the sidebar button slides it (ease-in-out) from wherever a slide under way has reached, over 220 ms × max(0.3, distance left); the keyboard and menu toggle instantly. Every toggle saves prefs and rebuilds menus. `slopmax-desktop-gpui/src/main.rs:437-475,646-651,1121-1129`; tests `a_slide_runs_from_where_it_set_out_to_where_it_rests`, `a_slide_turned_back_sets_out_from_where_it_had_reached`, `the_keyboard_shows_and_hides_it_at_once`
- **DESK-022** The sidebar keeps its width while sliding; its pane clips it. `slopmax-desktop-gpui/src/main.rs:1114-1129`
- **DESK-023** A 6-wide edge at x = width − 3 (col-resize cursor) starts a drag; the pointer anywhere in the window sets width = x clamped 190–340; x < 130 hides the sidebar, restoring the width the drag began at and ending the drag; mouse up, or a move without the left button, ends the drag and saves. `slopmax-desktop-gpui/src/main.rs:656-684,1140-1147,1176-1197`
- **DESK-024** Sidebar rows: 30 tall, padding x 10, gap 10, radius 6, body size; selected = `selected` background, foreground, medium weight; others sidebar-foreground with hover background; mouse down focuses the list and selects; click also selects (for screen readers). `slopmax-desktop-gpui/src/main.rs:781-834`
- **DESK-025** Provider rows trail the worst tone among that provider's attention items (bad over warn) as a dot, else the account count in small faint tabular figures. `slopmax-desktop-gpui/src/main.rs:719-738`
- **DESK-026** Headings `Accounts`, `Activity`, `Setup`: padding x 10, top 16, bottom 4, small, medium, faint; `None yet` row when no provider has accounts. `slopmax-desktop-gpui/src/main.rs:705-718,739-747,1203-1212`
- **DESK-027** Proxy status foot: dot + state (`Running {version}` good, `Starting…` warn, `Looking for the proxy…` muted, `Stopped` bad) over the address (11.5, faint); clicking opens Settings. `slopmax-desktop-gpui/src/main.rs:837-883`
- **DESK-028** Sidebar toggle button: PanelLeft icon, tooltip/label `Hide Sidebar` in the sidebar header, `Show Sidebar` in the page header while hidden. `slopmax-desktop-gpui/src/main.rs:887-900`

### Page header tools

- **DESK-030** Overview and provider pages: `Refresh usage` icon button (RefreshCw; disabled unless the proxy runs) and primary `Add account` (Plus icon) going to Access. `slopmax-desktop-gpui/src/main.rs:910-925`
- **DESK-031** Usage and Performance: a segmented `Today | 7 days | 30 days` that sets the range and reloads history. `slopmax-desktop-gpui/src/main.rs:926-937`
- **DESK-032** Diagnostics: `Check again` (disabled while checking). Agents, Access, Settings: no tools. `slopmax-desktop-gpui/src/main.rs:938-947`
- **DESK-033** A mouse down on the tools never starts a window drag. `slopmax-desktop-gpui/src/main.rs:908`

### Toast and sign-in card

- **DESK-035** Toast for the current notice: CircleCheck good or CircleX bad icon (16), text, `Dismiss` (Close icon) which clears it; absolute right 20, width 400, padding 10/left 14, radius 8, border, popover background, shadow y 8 blur 24 (black 0.4 dark / 0.08 light). It rises from bottom 12 to 20 with opacity 0→1 over 200 ms ease-out, replayed only when the text changes. `slopmax-desktop-gpui/src/main.rs:973-1019`
- **DESK-036** Sign-in card above the page while signing in: title (semibold) over the detail; `Cancel` (cancels). Device code: shown in a well, 20/semibold tabular. Link step: the URL (caption, truncated), `Open again` (opens URL), `Copy link` (clipboard), then a field `Browser on another machine? Paste the address it ended on` and `Use address` (sends the paste and clears the field). Notes: warn-colored small text after a warn dot. `slopmax-desktop-gpui/src/main.rs:493-496,1023-1095`

### Overview page (`src/overview.rs`)

- **DESK-040** No report yet → empty panel `Looking for the proxy…` / `slopmax shows your accounts as soon as it answers.` `slopmax-desktop-gpui/src/overview.rs:26-32`
- **DESK-041** No accounts → empty `No accounts yet` / `Sign in, import your agents' logins, or add an API key, with Add account above.`; else a row: standing (dot of status tone, medium headline, muted detail as a sentence) and at the right the routing line link. `slopmax-desktop-gpui/src/overview.rs:36-51,149-164`
- **DESK-042** Routing link: small muted text + ChevronRight, foreground on hover, tooltip `Change in Settings`, role link, label `Routing: {line}. Change it in Settings`; clicking opens Settings. `slopmax-desktop-gpui/src/overview.rs:168-184`
- **DESK-043** `Needs attention` section (only when items): panel rows (padding y 10): tone dot, text, and a button `Sign in…` (starts that provider's sign-in) | `Redeem…` (opens the account's credits and goes to its provider page) | `Show` (goes to its provider page). `slopmax-desktop-gpui/src/overview.rs:62-91`
- **DESK-044** `Subscriptions` section (pools with overview windows): one block each (padding 16×14, gap 10, hairline between, hover background, role button, label `{title} accounts`, click → provider page): title medium, `{ready} of {enabled} ready` caption, ChevronRight; per window, indented 14: title (100 wide), segmented bar, percent (40 wide, right, tabular, medium), resets caption (200 wide); credits sentence; the next line. `slopmax-desktop-gpui/src/overview.rs:188-285`
- **DESK-045** Next line: small muted text; a non-muted tone colors it and adds a dot. `slopmax-desktop-gpui/src/overview.rs:289-300`
- **DESK-046** `Today` section: before today's history `Reading today's ledger…`; else stats `Requests` (grouped; `none failed`/`{n} failed`), `Tokens` (compact; `{r:.0}% from cache`/`no cache reads`), `API value` (priced; `what the API would charge`), `Saved by failover` (grouped; `answered by another account`), over 24 hourly columns (56 tall, 60% wide up to 14, min 3, meter color; zero hours a 3-tall track stub) with `00:00`, `06:00`, `12:00`, `18:00` labels in axis size. `slopmax-desktop-gpui/src/overview.rs:95-144,304-359`

### Provider page (`src/accounts.rs`)

- **DESK-050** No accounts for the provider → empty `No {title} accounts` / `Add one with Add account, above.` `slopmax-desktop-gpui/src/accounts.rs:44-50`
- **DESK-051** `Pool` section, trailing the next line: per window a cell (padding 16, gap 8, hairline between): caption title, figure percent (20) + caption `used`, segmented bar, resets caption; footer row `Across {n} account(s), {basis}` or `Across {w} of {n} account(s), {basis}; the rest are out of service`, and the credits sentence. `slopmax-desktop-gpui/src/accounts.rs:388-443`
- **DESK-052** `Accounts` section with `Let slopmax choose` (unpins all) when any account is pinned; table header (small muted): `Account` (240 wide), one column per window (min 120, flex), controls (28). `slopmax-desktop-gpui/src/accounts.rs:59-87`
- **DESK-053** Account row (padding 16×14, top hairline): name (medium; muted when disabled), under it the status label, faint plan, and a `Next` badge when new sessions go to it; faint last-used caption. `slopmax-desktop-gpui/src/accounts.rs:92-135`
- **DESK-054** Window cell (min 120): percent medium tabular; meter (fill by tone) with a 2×10 muted marker at the pace's elapsed point; resets caption; pace label in its tone. No window → faint `—`. Faded to 45% when the account is disabled, or when another of its windows is full (≥100%) and this one is not. `slopmax-desktop-gpui/src/accounts.rs:99-102,141-150,447-480`
- **DESK-055** Notes line (when notes or credits): the credits disclosure first, then the notes as labels; only the last note may shrink. `slopmax-desktop-gpui/src/accounts.rs:152-167`
- **DESK-056** Credits disclosure: `{n limit resets}` + ChevronRight/ChevronDown, medium, muted unless open; role disclosure triangle, label `{title} on {name}`, expanded state; click toggles open and cancels a pending confirm for it. `slopmax-desktop-gpui/src/accounts.rs:484-523`
- **DESK-057** Account menu (`…` icon `More`, label `More for {name}`, anchored top-right): `Stop pinning` (unpin all) or `Use for new sessions` (disabled when the account is disabled); `Enable`/`Disable`; —; label `Priority {p}`; `Raise priority` (+1); `Lower priority` (−1); when it follows a tool: —, `Refresh here instead of {tool}` (own); when it has credits: —, `Redeem a limit reset…` (disabled when held) which opens its credits and asks to confirm. There is no rename or remove in the window. `slopmax-desktop-gpui/src/accounts.rs:187-260`
- **DESK-058** Credits well (padding 14, radius 6, well background): `Limit resets` over `Each one resets this account's {clears} windows at once.`; action: `Redeeming…` while redeeming; confirming → `Redeem one now?`, `Cancel`, primary `Redeem` (label `Redeem it now on {name}`) which redeems; else the held reason (or `Start the proxy to redeem one` when the proxy is not running) and `Redeem…` (disabled when held; label `Redeem a limit reset on {name}…`). Then `Listing them…` when none listed, each credit line (top border, small; warn color + dot when expiring soon) with the faint granted date at the right, and the auto-redeem policy caption. It drops in from −6 with opacity over 200 ms ease-out. `slopmax-desktop-gpui/src/accounts.rs:266-383`

### Usage and Performance pages (`src/usage.rs`)

- **DESK-060** Before the range's history → empty `Reading the ledger…` / `Every request slopmax answers is counted here.`; nothing in it → `Nothing yet today` or `Nothing in this range` / `Requests show here once an agent sends them through slopmax.` A history for another range is not shown. `slopmax-desktop-gpui/src/usage.rs:38-62`
- **DESK-061** Usage stats: `Tokens` (`{r:.0}% from cache` / `no cache reads`), `Requests` (`in {n conversation(s)}` / `answered`), `API value` (`Billed to API keys {dollars}` when billed > 0, else `at API prices`, else `{n request(s)} unpriced`), `A month at this pace` (`—` when unknown; note `at API prices` for 7 days, else `from a week's use`). `slopmax-desktop-gpui/src/usage.rs:103-144`
- **DESK-062** Usage sections in order: `Tokens` (legend of providers), stacked column chart 180 tall; `Requests` (legend `Answered`, `Failed`) and `API value` side by side (132 tall); `Models` and `Token mix` side by side; `Agents`; `When you work` (not for Today); `Accounts`; `Left on the table`. Side-by-side pairs wrap one over the other below 320 each. `slopmax-desktop-gpui/src/usage.rs:76-83,90-165`
- **DESK-063** Column charts: one slot per bucket; columns 60% wide up to 18 (stacked, gap 1, min part 2) or 70% up to 22 (grouped); a value axis 40 wide with gridlines and round ticks (DESK-067), bucket labels every `margin`th (Today 3, Week 1, Month 5) beneath; hovering a slot highlights it and shows a multi-line tooltip. `slopmax-desktop-gpui/src/usage.rs:26,66-72,357-518`
- **DESK-064** Tooltips: tokens `{label}` + `{provider}: {compact}` per provider; requests `{label}\n{n request(s)}` (+`\n{n} failed`); cost `{label}\n{dollars} at API prices`; reliability `{label}\n{n} saved by failover\n{n} failed`; cache `{label}\n{r:.0}% from cache` or `No input`; first byte `{label}\nMedian {s:.2} s\nSlowest 5% {s:.2} s` or `No answers`. `slopmax-desktop-gpui/src/usage.rs:246-298,607-614,643-646,678-686`
- **DESK-065** Axis labels: tokens compact without `.0`; counts grouped; money `$N` when whole else `$N.NN`; cache `{v:.0}%`; first byte `{v:.places$} s`. `slopmax-desktop-gpui/src/usage.rs:258,284,300-306,652,692`
- **DESK-066** Line charts (cache, first byte): straight 1.5-wide segments between consecutive buckets with values, a 4-point dot for an isolated value; cache axis ends at 100% and starts at 100 − the smallest of 10/20/50/100 that keeps the lowest value (minus 1) inside, 3 ticks; first byte axis from 0 to a round top over the slowest, two series (slowest 5% in `series(2)`, median in meter). `slopmax-desktop-gpui/src/usage.rs:523-590,628-697`
- **DESK-067** `axis(most, finest)`: for 3, 4, 5 steps, step = smallest of 1, 2, 2.5, 5 × 10^⌊log10(max(most/steps, finest))⌋ ≥ that (whole steps only when finest ≥ 1), else 10×; pick the lowest top; ticks = steps + 1. `places(step)`: 0, 1, or 2 decimals. `slopmax-desktop-gpui/src/usage.rs:703-728`; tests `axes_end_on_round_values`, `ticks_keep_the_places_their_steps_need`
- **DESK-068** Models: the top 5 by name in mono small (160 wide), the rest summed as `Other` when it has tokens; meter relative to the largest; compact tokens (52) and muted priced value (64). `slopmax-desktop-gpui/src/usage.rs:28,758-809`
- **DESK-069** Token mix: one 8-tall bar of Input, Cache read, Cache write, Output in `series(0..3)` shares (min 3 each, zero parts omitted), a 2×2 key with compact counts, a rule, then `Context per request` ((input+cache read+cache write)/requests) and `Output per request`. `slopmax-desktop-gpui/src/usage.rs:813-880`
- **DESK-070** Agents: per agent name, meter, compact tokens (56), `{n request(s)}` (112), priced value (72). `slopmax-desktop-gpui/src/usage.rs:909-933`
- **DESK-071** When you work: a 7×24 grid (rows Mon..Sun, 16 tall cells), shade = foreground at 0.12 + 0.68 × n/most (track when 0), hour labels every 6; trailing `Busiest at {HH}:00 on {Day}` (when any) and a `Less ■■■■ More` scale (0.12, 0.35, 0.58, 0.8). `slopmax-desktop-gpui/src/usage.rs:937-1006`
- **DESK-072** Accounts table: header `Account` (260), `Share of tokens`, `Tokens`, `Requests`, `Failed`, `API value` (64/72/56/76); rows name + muted provider title, meter vs largest and `{share:.0}%` of the sum, numbers (`—` for 0 failed); a muted `No account could take it` row with `Every account was limited or out of rotation` when unplaced > 0; a medium `Total` row. `slopmax-desktop-gpui/src/usage.rs:1011-1137`
- **DESK-073** Left on the table: none → a panel with `No weekly window reset in this range`; else figure dollars + left line (+ `{n weekly window(s)} on plans without a known price left out` at the right when unpriced), a header `Account`, `Unused at reset`, `Weekly windows`, `Unused`, `Left`, and rows; caption `The share of each plan's weekly fee that resets threw away, at plan list prices or [plan_prices] in config.toml.` `slopmax-desktop-gpui/src/usage.rs:1142-1233`
- **DESK-074** Performance stats: `Answered` `{requests/(requests+failed)×100:.1}%` (`none failed`/`{n} failed`), `Saved by failover`, `From cache` (`{r:.0}%` or `—`; note `saving {priced cache_saved}`), `First byte` (`{ms/1000:.2} s` or `—`; `the median wait`). Then `Reliability` (grouped columns, legend `Saved by failover`, `Failed`) beside `Input from cache`, and `Output speed` (top 6: mono model, provider, `{tok/s:.0} tok/s`; or `No answers long enough to time yet.`) beside `Time to first byte` (legend `Median`, `Slowest 5%`). `slopmax-desktop-gpui/src/usage.rs:167-228,594-623,884-906`
- **DESK-075** Number words: `grouped` thousands commas; `count(n, noun)` `1 noun` / `{grouped} nouns`; `dollars` `$1,204` (≥1000, rounded) else `$412.30`; `priced` `—` when every request was unpriced (and there were some), `{dollars}+` when some were, else dollars. `slopmax-desktop-gpui/src/usage.rs:1236-1273`

### Agents page (`src/settings.rs`)

- **DESK-080** Intro (max 560, muted) `Connecting points an agent's own settings at slopmax, so its requests share your accounts. Disconnecting puts back what was there.`; one setting row per agent: title over its wiring line; at right a label `Connected` (good) / `Not connected` (muted) and a `Connect`/`Disconnect` button (label `{verb} {title}`). `slopmax-desktop-gpui/src/settings.rs:26-68`

### Access page (`src/access.rs`)

- **DESK-085** Intro `The accounts slopmax sends requests to, and the keys other machines and tools reach it with.`; sections `Add an account`, `Client keys`. `slopmax-desktop-gpui/src/access.rs:73-82`
- **DESK-086** Add an account rows: `Sign in` / `With your browser, as the agent's own sign-in does.` with `Claude` and `ChatGPT` buttons; `Import` / `Logins Claude Code, Codex, or CLIProxyAPI already have.` with `Import`; `API key` / `A key bills by the token; slopmax spends subscriptions first.` with a segmented `Anthropic API | OpenAI API | xAI API` (provider titles), a masked field `Paste an API key`, and primary `Add key` (ignored when empty; clears the field). `slopmax-desktop-gpui/src/access.rs:86-154`; `main.rs:74,488-492`
- **DESK-087** Compatible endpoint row: `Compatible endpoint` / `An API that speaks OpenAI's or Anthropic's format, such as a local model server or a gateway. Its key is checked before it is saved.`; labeled lines (96 wide labels) `Address` (`https://example.com/v1`), `API` (segmented `Chat completions | Responses | Messages`, default Chat), `Models` (`Models it serves, as patterns (any if empty)`), `Key` (masked, `Its API key`), `Name` (`Name (optional)`); primary `Add endpoint` (ignored when the address is blank) takes and clears every field, models via `patterns`, empty name → none. `slopmax-desktop-gpui/src/access.rs:24-63,313-392`
- **DESK-088** Client keys panel: a just-made key first (well background): `The key {name}` / `Copy it now: you won't see it again. Give it to the tool as its API key, with slopmax's address.`, the key in mono small in a bordered box, primary `Copy` (clipboard), `Done` (dismiss). Then each config key: name medium over `Any model` or models joined `, ` in mono; `Revoke…` (label `Revoke the key {name}…`) → `Revoke it?`, `Cancel`, primary `Revoke` (label `Revoke the key {name}`). Last row: name field (200 wide, `Name, such as laptop`), models field (`Models it may use, as patterns (any if empty)`), primary `Create key` (ignored when the name is blank). Caption `A tool presents its key as an API key. Revoking one refuses it at once; slopmax's own key, in config.toml, stays as it is.` `slopmax-desktop-gpui/src/access.rs:158-309`

### Diagnostics page (`src/access.rs`)

- **DESK-090** Not run or running → empty `Checking your setup…` / `The same checks slopmax doctor runs.`; failed → `Could not check the setup` / the error. `slopmax-desktop-gpui/src/access.rs:399-411`
- **DESK-091** Done: intro `The checks slopmax doctor runs, with what to do about each.` and one panel: a row per finding with the section title (120 wide, muted) on its first finding only, a tone dot, the finding's text with backticks removed, capitalized, and when it has a fix a mono chip with the command and a `Copy the command` icon button (20). `slopmax-desktop-gpui/src/access.rs:412-485`

### Settings page (`src/settings.rs`)

- **DESK-095** Sections in order: Appearance, Proxy, Routing, Limit resets, Notifications, Advanced; each a panel of setting rows (min 60 tall: medium title over caption detail at left, control at right). `slopmax-desktop-gpui/src/settings.rs:70-79,431-457`
- **DESK-096** Appearance: `Theme` / `Follow the system, or keep to light or dark.` segmented `System | Light | Dark`; choosing saves prefs and re-themes every window at once. `slopmax-desktop-gpui/src/settings.rs:170-191`
- **DESK-097** Proxy: `Status` / `slopmax serves your agents while it runs.` label (`Running {v}` good, `Starting…`, `Looking for it…`, `Stopped` bad) and `Stop` (when running) or primary `Start`; `Address for agents` / `Where an agent sends its requests.` address in a tabular well + `Copy`; `Web dashboard` / `The same at a glance, in your browser.` `Open in browser` (disabled unless running); `Start at login` / login detail with a switch (checked = installed; disabled without a manager; on → install, off → uninstall). `slopmax-desktop-gpui/src/settings.rs:83-166`
- **DESK-098** Routing: one row per strategy (radio 16: filled foreground with a 6 background dot when chosen, else faint ring; title over `strategy_detail`; role radio, selected state; clicking an unchosen one sets it); then `Session affinity` switch with AFFINITY detail; caption AFFINITY_HEADER. `slopmax-desktop-gpui/src/settings.rs:195-284`
- **DESK-099** Limit resets: `When one would expire unused` (redeem_expiring_detail) and `When every account is spent` (REDEEM_EXHAUSTED) switches. `slopmax-desktop-gpui/src/settings.rs:287-321`
- **DESK-100** Notifications: `Notify me` / `When a limit reset is about to lapse unredeemed, or a week is about to reset with quota to spare.` (or the reason they are unavailable) with a switch checked only when on and available, disabled when unavailable. `slopmax-desktop-gpui/src/settings.rs:326-345`
- **DESK-101** Advanced: `Session timeout` stepper (TTL steps, `minutes`), `Usage polling` stepper (poll steps, `Off` at 0), `Warm ChatGPT windows` switch, `Overflow to API keys` switch, details from `live_detail`; caption `Each is saved to config.toml and applied at once; slopmax config changes them too.` A stepper button with nowhere to go is faint and inert. `slopmax-desktop-gpui/src/settings.rs:349-428`

### Menu bar item and panel (`src/main.rs`, `src/panel.rs`, `src/native.rs`)

- **DESK-105** Menu bar item: title `slopmax` and tooltip `slopmax` until a report arrives, then `view::menu_bar`; a click toggles the panel. macOS: the item's image is the SF Symbol `chart.bar.fill` as a template (accessibility description `slopmax`); elsewhere the tray icon is `assets/tray.svg` (pink tile, three white bars). `slopmax-desktop-gpui/src/main.rs:71,300-316`; `native.rs:34-45`
- **DESK-106** Panel opens 340 wide, centered under the item, kept 8 inside its display's edges, 6 below the menu bar; a popup window, focused, not movable/resizable/minimizable, transparent background around the 10-radius card. Without a menu bar item position (not macOS), opening the panel opens the window instead. `slopmax-desktop-gpui/src/panel.rs:36,72-124`; `native.rs:47-62,149-151`
- **DESK-107** The panel fits its content's height (re-hung only on a change over 1 point, keeping its top under the menu bar). `slopmax-desktop-gpui/src/panel.rs:198-203,304-311`; `native.rs:83-108`
- **DESK-108** The panel closes on Escape, on a click in any other app (global mouse-down monitor, macOS), when the main window becomes active, when the item is clicked again, and before it opens the window. It does not close merely on losing focus. `slopmax-desktop-gpui/src/panel.rs:8-11,44-70`; `native.rs:64-78`
- **DESK-109** Panel header: logo 22, `slopmax` semibold, status line with tone dot: running → status headline (or `Running`), starting/checking → `Starting the proxy…` muted, stopped → `The proxy is stopped` bad; `Refresh usage` icon (disabled unless running). `slopmax-desktop-gpui/src/panel.rs:207-243`
- **DESK-110** Panel `Needs attention` (when any): first 3 items as dot, medium `who` (shrinks first), faint `·`, muted `what`; `+{n} more` when more; click → window at Overview. `slopmax-desktop-gpui/src/panel.rs:427-479`
- **DESK-111** Panel pools (each with overview windows), click → provider page: title + `{ready} of {enabled} ready`; per window title (92 wide), segmented bar, percent (34 wide), and a faint 11.5 resets caption indented under the bar; accounts with warn/bad status not already in Needs attention by name with their status sentence; credits sentence; the short next line. No pools → `No accounts yet. Open slopmax to add one.` `slopmax-desktop-gpui/src/panel.rs:262-273,327-424`
- **DESK-112** Panel Today (once loaded): `Today` + `Nothing yet` or `{n} requests`; when not quiet, `{compact} tokens[, {value} at API prices]` and 24 hourly columns 28 tall; click → Usage. Reloads today on open and every 60 s while shown; redraws every second. `slopmax-desktop-gpui/src/panel.rs:41,153-188,482-546`
- **DESK-113** Panel commands (menu items, 28 tall, shortcut at right faint): `Open slopmax ⌘O` (closes panel, opens window), `Settings… ⌘,` (closes panel, opens Settings), `Quit slopmax ⌘Q`. `slopmax-desktop-gpui/src/panel.rs:277-293,550-576`
- **DESK-114** Parts of the panel are separated by hairlines (`separator`); each part padding 14×10, gap 8. `slopmax-desktop-gpui/src/panel.rs:316-323`

### Notifications (`src/notifications.rs`)

- **DESK-120** Alerts from slopmax-app are posted as system notifications as they arrive (not in screenshot mode). `slopmax-desktop-gpui/src/main.rs:213-222`
- **DESK-121** macOS: needs a bundle identifier; without one, posts nothing, logs once `slopmax: not posting notifications: Notifications need the installed slopmax app; this copy runs outside one.`, and Settings shows that sentence. With one: requests alert+sound authorization each post (the system asks once), and on grant posts title, body, default sound, identified by the alert key so a repost replaces. `slopmax-desktop-gpui/src/notifications.rs:29-73`
- **DESK-122** Other systems post nothing; Settings shows `slopmax posts notifications on macOS.` with the switch disabled. Clicking a notification just activates the app. `slopmax-desktop-gpui/src/notifications.rs:7-9,83-87`

### Theme, fonts, tokens (`src/theme.rs`, `assets/`)

- **DESK-125** Bundled fonts IBM Plex Sans Regular, Medium, SemiBold (OFL license shipped); load failure logs `slopmax: could not load IBM Plex Sans: {e}`. Mono face for model names and keys: `Menlo` on macOS, `DejaVu Sans Mono` elsewhere. Figures that change use tabular numerals (`tnum`). `slopmax-desktop-gpui/src/theme.rs:23-27,30-34,75-85`; `assets/fonts/OFL.txt`
- **DESK-126** Themes `slopmax Light` and `slopmax Dark` (font IBM Plex Sans 13, radius 6, large radius 8, no shadow) with the token values in `assets/themes/slopmax.json` (e.g. light background `#ffffff`, foreground `#1d1d1f`, border `#e4e4e7`, muted fg `#6e6e76`, sidebar `#f7f7f8`, success `#2e9d64`, warning `#b7791f`, danger `#d93f36`, ring `#d6337080`, primary `#1d1d1f`/fg `#ffffff`; dark background `#1b1b1d`, foreground `#e6e6e8`, border `#2c2c30`, muted fg `#9b9ba3`, sidebar `#161618`, popover `#222225`, success `#4cb782`, warning `#d9a23f`, danger `#e5534b`, ring `#d6337099`). `slopmax-desktop-gpui/assets/themes/slopmax.json:8,54,216,224,270,435`; `theme.rs:20-22,35-48`
- **DESK-127** Appearance: System follows the window's appearance; Light/Dark force it. `slopmax-desktop-gpui/src/theme.rs:52-71`
- **DESK-128** Extra colors (light/dark): well `#f7f7f8`/`#212124`, separator `#efeff1`/`#26262a`, faint `#a2a2aa`/`#6a6a72`, track `#ebebee`/`#2c2c31`, meter `#5a5a62`/`#a8a8b0`, hover `#0000000a`/`#ffffff0a`, selected `#00000010`/`#ffffff12`, accent pink `#d63370` (logo and focus only); raised segment `white`/`#333338`. `slopmax-desktop-gpui/src/theme.rs:118-143`; `ui.rs:312-316`
- **DESK-129** Tone colors: good=success, muted/accent=muted fg, warn=warning, bad=danger; meter fill neutral except warn/bad; stacked parts meter, series(2), series(3); series ramp light `#1d1d1f #76767e #a9a9b0 #d2d2d7`, dark `#e6e6e8 #9b9ba3 #6a6a72 #45454b`. `slopmax-desktop-gpui/src/theme.rs:146-184`

### Components and type scale (`src/ui.rs`)

- **DESK-130** Type scale: title 20, heading 15, body 13, small 12, axis 11; every control 28 tall. `slopmax-desktop-gpui/src/ui.rs:21-30`
- **DESK-131** Button: 28 tall, padding x 12, medium, quiet (hairline) unless primary (inverted). Icon button: ghost, 28 square, 16-point icon, tooltip = accessibility label. Text field: 28 tall, padding x 10, body size. `slopmax-desktop-gpui/src/ui.rs:37-63`
- **DESK-132** Panel: radius 8, border, page background. Row: padding 16×12, gap 16, separator top border unless first. Section: heading 15 semibold (min 24 tall, gap 12 with trailing) over content at gap 10. `slopmax-desktop-gpui/src/ui.rs:71-110`
- **DESK-133** Stat: caption title, 20 semibold tabular figure, faint caption note; stats side by side with separators, padding 16. `slopmax-desktop-gpui/src/ui.rs:113-146`
- **DESK-134** Label: good → foreground text after a good dot; muted/accent → muted text, no dot; warn/bad → text and dot in the tone; text via `sentence` (leading `●` dropped, first letter capitalized). `slopmax-desktop-gpui/src/ui.rs:162-185`; test `the_cores_words_read_as_a_sentence`
- **DESK-135** Badge: 20 tall, padding x 7, radius 5, border, 11.5 muted. Dot: 6 round. Swatch: 8, radius 2. `slopmax-desktop-gpui/src/ui.rs:156-158,188-199,274-276`
- **DESK-136** Meter: 4 tall, radius 2, track background, fill to fraction (min 2 wide when > 0). Segmented bar: gap 3, padding y 4, each account a meter with flex basis weight/total (min 4), idle at 40% opacity, tooltip = segments tip. `slopmax-desktop-gpui/src/ui.rs:202-247`
- **DESK-137** Resets wording: `Resets in {in} · {at}`, `Resets in {in}`, else `Nothing to reset`. `slopmax-desktop-gpui/src/ui.rs:251-257`
- **DESK-138** Logo: a pink (`accent`) tile, radius 14/64 of its size, with three white bars on the 64 grid at (14,34,9×16), (27.5,24,9×26), (41,14,9×36), radius 2. `slopmax-desktop-gpui/src/ui.rs:280-300`
- **DESK-139** Segmented control: 28 tall, padding 2, gap 2, radius 7, well background, border; segments padding x 10, radius 5, small medium; chosen raised with border, others muted with hover; role radio button with label and selected state. `slopmax-desktop-gpui/src/ui.rs:304-361`
- **DESK-140** Stepper: 28 tall, radius 7, well, border; 26-square Minus/Plus buttons (icon 13; faint and inert when none), labels `Less {title}` / `More {title}`; value min 64 wide, small medium tabular. `slopmax-desktop-gpui/src/ui.rs:369-417`
- **DESK-141** Drag strip: drags the window; double-click zooms (macOS: the system's title bar double-click action; Linux: zoom; Windows handles both natively via the control area). `slopmax-desktop-gpui/src/ui.rs:421-439`
- **DESK-142** Empty state: panel, centered, padding y 40, medium title over caption. `slopmax-desktop-gpui/src/ui.rs:443-455`

### Motion (`src/motion.rs`)

- **DESK-145** Durations: appear 200 ms (toast, credits well), slide 220 ms (sidebar). Curves: ease-out cubic-bezier(0.23, 1, 0.32, 1); ease-in-out cubic-bezier(0.77, 0, 0.175, 1), evaluated by 24-step bisection. Nothing else animates; the panel opens at once; reduced-motion skips every animation. `slopmax-desktop-gpui/src/motion.rs:1-47`; tests `curves_run_from_rest_to_rest`, `the_ease_out_answers_at_once`, `the_ease_in_out_holds_back_then_settles`

### Window prefs (`src/prefs.rs`)

- **DESK-150** `{SLOPMAX_HOME or ~/.slopmax}/desktop.json`, pretty JSON `{"sidebar_width": f32, "sidebar_hidden": bool, "appearance": "system"|"light"|"dark"}`; missing fields take defaults (220, false, system); an unreadable or invalid file yields all defaults; save creates the directory and logs `slopmax: could not save {path}: {e}` on failure. `slopmax-desktop-gpui/src/prefs.rs:13-78`; test `missing_settings_take_their_defaults`

### Accessibility

- **DESK-155** Roles and labels: sidebar list (`Sidebar`), items (list item, title, selected), proxy status button (`Proxy: {state}`), segmented choices (radio, title, selected), stepper buttons (`Less/More {title}`), routing link (`Routing: {line}. Change it in Settings`), pool blocks and panel pools (button, `{title} accounts`), panel `Needs attention` and `Today's usage` buttons, panel commands (menu item, title), credit disclosure (`{n limit resets} on {name}`, expanded), account menu (`More for {name}`), redeem buttons (`Redeem a limit reset on {name}…`, `Redeem it now on {name}`), revoke buttons (`Revoke the key {name}…`, `Revoke the key {name}`), agent buttons (`Connect/Disconnect {title}`), switches (`Start at login`, `Session affinity`, `When one would expire unused`, `When every account is spent`, `Notifications`, `Warm ChatGPT windows`, `Overflow to API keys`), strategy rows (radio, title, selected), every icon button labeled by its tooltip. `slopmax-desktop-gpui/src/main.rs:703-704,819-821,859-860`; `ui.rs:55,339-341,387-388`; `overview.rs:178-179,227-228`; `panel.rs:346-347,440-441,505-506,566-567`; `accounts.rs:198,305,319,501-503`; `access.rs:243,253`; `settings.rs:33,155,259-261,282,340`

### Screenshot mode (`src/shots.rs`, feature `shots`)

- **DESK-160** With the `shots` build and `SLOPMAX_SHOTS={dir}`: reduced motion on, window 1160 × (`SLOPMAX_SHOTS_HEIGHT` if ≥ 400, else 1400), waits (≤20 s) for report and today, then for Light and Dark (not saved) draws each sidebar page to `{mode}-{title lowercased, spaces→-}.png` (waiting for history on Usage/Performance and for the checks on Diagnostics; opening the first account's credits on provider pages) and the panel to `{mode}-panel.png`, printing each path, then quits; errors log `slopmax: could not draw the pages: {e}`. `slopmax-desktop-gpui/src/shots.rs:20-184`; `Cargo.toml:12-15`

### Assets and bundle

- **DESK-165** Icons: gpui-kit's set plus Lucide ChartColumn, KeyRound, Stethoscope, Users, Zap. `slopmax-desktop-gpui/src/assets.rs:10-30`
- **DESK-166** `macos/bundle.sh [debug|release]` (default release): builds `slopmax` and the app, writes `target/{profile}/slopmax.app/Contents/Info.plist` with `VERSION` replaced by the workspace version, copies both binaries into `Contents/MacOS/` (the app finds the CLI beside itself), ad-hoc signs the CLI then the app, prints the app path. `slopmax-desktop-gpui/macos/bundle.sh:1-29`
- **DESK-167** Info.plist: `CFBundleIdentifier` `dev.slopmax.desktop`, name and display name `slopmax`, executable `slopmax-desktop-gpui`, package type `APPL`, short version and version = workspace version, minimum macOS 11.0, high resolution capable. `slopmax-desktop-gpui/macos/Info.plist:7-24`

### Platform-specific summary

- **DESK-170** macOS: traffic-light inset (84 lead), Menlo, template SF Symbol glyph, panel hung under the item with outside-click closing, UserNotifications, launchd login service, `cmd` shortcuts. Linux/Windows: 16 lead, DejaVu Sans Mono, SVG tray icon, panel replaced by the window, no notifications (explained in Settings), systemd (Linux) or no login service (Windows; the Start at login switch disabled). `slopmax-desktop-gpui/src/main.rs:80`; `theme.rs:75-79`; `native.rs:143-166`; `notifications.rs:79-91`

### DESK Rust tests to mirror

`src/main.rs`: a_slide_runs_from_where_it_set_out_to_where_it_rests (1233), a_slide_turned_back_sets_out_from_where_it_had_reached (1242), the_keyboard_shows_and_hides_it_at_once (1261).
`src/motion.rs`: curves_run_from_rest_to_rest (54), the_ease_out_answers_at_once (68), the_ease_in_out_holds_back_then_settles (74).
`src/prefs.rs`: missing_settings_take_their_defaults (85).
`src/ui.rs`: the_cores_words_read_as_a_sentence (463).
`src/usage.rs`: axes_end_on_round_values (1281), ticks_keep_the_places_their_steps_need (1294).

(10 tests.)

---

## DIST (repository root: build, packaging, install, CI, dev scripts)

Not Rust behavior a user sees in one command, but the contract of how
slopmax is built, shipped, installed, checked, and measured. A port that
drops any of these breaks `install.sh` users, the Docker image, the release
page, or the side-by-side benchmarks. Paths are relative to the repository
root.

- **DIST-001** Workspace package metadata: version `0.3.0`, edition 2024, MSRV 1.89 (the desktop crate 1.92), license MIT, repository `https://github.com/KaBankz/slopmax`; every crate shares the version, which `slopmax --version` (CLI-012), `/healthz` (PRX-001), the report's `version`, the doctor's version check (DOC-004), and the macOS bundle (DESK-166) all print. A plain build/test covers the CLI and libraries; the desktop app is built on its own (`default-members`). `Cargo.toml:1-21`
- **DIST-002** Release profile: fat LTO, one codegen unit, stripped symbols; dependencies built at opt-level 2 even in dev (a GPUI frame is 50–110 ms unoptimized). `unsafe_code` is denied workspace-wide and allowed in exactly two places (the local time offset and turning terminal echo off). `Cargo.toml:50-66`; `ARCHITECTURE.md:317`
- **DIST-003** Cargo features: `slopmax/mimalloc` swaps the allocator only (4–30 % more throughput at 32 concurrent streams, 2–5× the memory; the Docker image uses it; CLI-010); `slopmax-desktop-gpui/shots` draws every page to images headless when `SLOPMAX_SHOTS` names a directory, then quits (DESK-160). `crates/slopmax/Cargo.toml:13-17`; `crates/slopmax-desktop-gpui/Cargo.toml:12-15`; `ARCHITECTURE.md:310`
- **DIST-004** Budgets (`mise run budget`, CI job `Size budget`): at most 70 third-party crates in the host target's normal dependency tree of `slopmax` (path crates excluded; prints `{n} crates for {host} (budget 70)` and the list on failure), and a release `target/release/slopmax` of at most 6,291,456 bytes (prints `{bytes} bytes (budget 6291456)`); either over budget fails CI. A port states its own budgets in the same two terms (dependency count, shipped binary size) and keeps them in CI. `mise.toml:23-37`; `ARCHITECTURE.md:286-288`
- **DIST-005** mise is the single task runner, locally and in CI; tools: `rust 1.99` with clippy and rustfmt. Tasks: `build` (`cargo build --release --locked`), `check` (`cargo fmt --all --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test --locked`), `msrv` (`cargo check --all-targets --all-features --locked` on rust 1.89), `budget` (DIST-004), `bench` (installs oha 1.16, jq 1.8, hyperfine 1.20; runs `scripts/bench.sh`), `install` (`cargo install --path crates/slopmax --locked`), `demo` (`scripts/demo.sh`). rustfmt: edition 2024, field-init shorthand. `mise.toml:1-49`; `rustfmt.toml:1-2`
- **DIST-006** CI (`.github/workflows/ci.yml`): on push to `master` and on pull requests; `CARGO_TERM_COLOR=always`; jobs `Check ({os})` on ubuntu-latest and macos-latest (fail-fast off) running `mise run check`, `Minimum Rust version` (`mise run msrv`), and `Size budget` (`mise run budget`) on ubuntu; each job checks out, runs `jdx/mise-action@v5` and `Swatinem/rust-cache@v2`, then exactly one mise task. `.github/workflows/ci.yml:1-44`
- **DIST-007** Desktop workflow (`desktop.yml`): manual, or on push to `master` touching `crates/slopmax-app/**`, `crates/slopmax-desktop-gpui/**`, `assets/**`, or the workflow; builds `slopmax` and `slopmax-desktop-gpui` release on macos-latest and ubuntu-latest (Linux first installs fontconfig, freetype, xkbcommon(-x11), wayland, x11, x11-xcb, xcb, vulkan, EGL, GL dev packages); appends ``- `{bin}`: {bytes} bytes`` per binary to the job summary; uploads both binaries as artifact `slopmax-desktop-gpui-{os}-{arch}`. `.github/workflows/desktop.yml:1-50`
- **DIST-008** Release workflow (`release.yml`): on a pushed `v*` tag, creates the GitHub release with notes from `CHANGELOG.md` (`taiki-e/create-gh-release-action@v1`, `contents: write`), then builds `slopmax` for `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` (ubuntu-latest), `x86_64-apple-darwin`, `aarch64-apple-darwin` (macos-latest) with the mise-pinned toolchain and uploads `slopmax-{target}.tar.gz` (the `slopmax` binary at the archive root) plus `slopmax-{target}.tar.gz.sha256`; a manual run builds every target as a dry run and publishes nothing. Every version bump gets a tag and a release. `.github/workflows/release.yml:1-50`
- **DIST-009** `install.sh` (POSIX `sh`, `set -eu`), run as `curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/install.sh | sh`: target from `uname -s` (`Linux` → `unknown-linux-musl`, `Darwin` → `apple-darwin`, else fails `no prebuilt binary for {os}; install with: cargo install --locked --git https://github.com/KaBankz/slopmax slopmax`) and `uname -m` (`x86_64`/`amd64` → `x86_64`, `arm64`/`aarch64` → `aarch64`, else `no prebuilt binary for {arch}`); `SLOPMAX_VERSION` picks a tag (`releases/download/{tag}`), else `releases/latest/download`; `SLOPMAX_INSTALL_DIR` (default `~/.local/bin`); needs `curl` (`curl is required`); prints `Downloading slopmax for {target}…`; downloads into a temp dir removed on exit (`could not download {url}` on failure); when the `.sha256` file downloads, compares its first field with `sha256sum` (or `shasum -a 256`), failing `checksum mismatch for {archive}`; extracts, `install -m 0755` to `{dir}/slopmax`, prints `Installed {output of slopmax --version} to {dir}/slopmax`, then ``Run `slopmax` to set it up.`` when the dir is on `PATH`, else ``Add {dir} to your PATH, then run `slopmax` to set it up.``. Errors go to stderr as `slopmax install: {message}` with exit 1. The TS release must keep the archive names, the binary name at the archive root, and the checksum files, or ship an install.sh changed in step. `install.sh:1-59`
- **DIST-010** Docker image: build stage `rust:1-alpine` + `musl-dev`, `cargo build --release --locked -p slopmax --features mimalloc`; runtime `alpine:3` + `ca-certificates`, binary at `/usr/local/bin/slopmax`; `ENV SLOPMAX_HOME=/data SLOPMAX_LISTEN=0.0.0.0:7567`, `VOLUME /data`, `EXPOSE 7567`, `ENTRYPOINT ["slopmax"]`, `CMD ["serve"]`; `.dockerignore` excludes `/target` and `.git`. Documented use: `docker run -d --name slopmax -p 127.0.0.1:7567:7567 -v slopmax:/data slopmax`, `docker exec -it slopmax slopmax login codex --device`, `docker exec slopmax slopmax status`. Because `SLOPMAX_LISTEN` is non-loopback here, the doctor's DOC-007 note applies inside the container. `Dockerfile:1-25`; `.dockerignore:1-2`
- **DIST-011** Other install paths the README promises: `cargo install --locked --git https://github.com/KaBankz/slopmax slopmax` (Rust 1.89+, `--features mimalloc` for a shared proxy); from a checkout `mise install` then `mise run install`; the macOS app via `crates/slopmax-desktop-gpui/macos/bundle.sh` (DESK-166). `README.md:14-36`, `:259`
- **DIST-012** `scripts/bench.sh [rig]` (Linux only; memory from `/proc`): builds release `slopmax` and the `bench` example (or uses a prebuilt rig), ports from `UPSTREAM_PORT` (9100), `PROXY_PORT` (9101), `IDLE_PORT` (9102), duration `DURATION` (8s); runs `bench bodies`, `bench upstream`, `bench proxy` (CLI-220..225), waits for `/healthz`, samples idle `VmRSS`; drives `oha` (`--no-tui --output-format json`) with `authorization: Bearer bench`: Claude (`user-agent: claude-cli/2.1.287 (external, cli)`, `x-claude-code-session-id: bench`, `POST /v1/messages?beta=true`) small one at a time (`-n 300 -c 1`), small 32 at once (`-z DURATION -c 32`), 300 KB one at a time (`-n 200 -c 1`), 300 KB 32 at once; Codex (`session_id: bench`, `POST /codex/responses`) small and 300 KB 32 at once; prints `{name}  {ok}% ok  {n} req/s  p50 {ms} ms  p99 {ms} ms`, then `Memory: {idle} idle, {VmHWM} at peak, {VmRSS} after`; startup with a copied home whose config is `api_key = "bench"`, `poll_mins = 0`, `refresh_tokens = false`, `redeem_expiring_credits = false`: `hyperfine -N --warmup 5 --runs 100` of `slopmax --version` and `slopmax status --json`, and the median of 10 runs of `slopmax serve` until `/healthz` answers; finally `Binary: {bytes} bytes`. It kills only the PIDs it started. `scripts/bench.sh:1-95`
- **DIST-013** `scripts/demo.sh`: a throwaway proxy for working on the app or dashboard, on `UPSTREAM_PORT` (9200) and `DEMO_PORT` (9201); refuses with `something already listens on {addr}; stop it, or set UPSTREAM_PORT and DEMO_PORT` when either answers `/healthz`; config `api_key = "bench"`, `listen`, `poll_mins = 0`, `refresh_tokens = false`, `redeem_expiring_credits = false`; a first `bench proxy` run creates four accounts, then a seeded (Python, `random.seed(7)`) `state.json` (two Claude accounts with 5h/7d windows plus a model-scoped `Fable` 7d window, two ChatGPT accounts with one at 100 % and `blocked_until`, `reset_credits: 2`, Claude Code's UA `claude-cli/2.1.291 (external, cli)` under `agents`), four weeks of `windows.jsonl`, and 30 days of `usage/YYYY-MM.jsonl` (weekday-heavy sessions, model-list housekeeping rows, daily ChatGPT warmups with agent `slopmax`, 1 % `account:""` 429s with `attempts: 0`, 1 % provider errors 500/529/400, 4 % `attempts: 2` failovers), with all-time counters recomputed; restarts the proxy and prints the exports (`SLOPMAX_HOME`, `SLOPMAX_LISTEN`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `SLOPMAX_NO_SERVICE=1`); Ctrl-C (exit 130) deletes it all. The files it writes are the on-disk formats of POOL (state.json), LED-002, and LED-050, so the port's demo/fixture seed must produce files the Rust reads and the other way round. `scripts/demo.sh:1-224`
- **DIST-014** Performance baseline for side-by-side runs (ARCHITECTURE.md "Performance", a 2-vCPU machine shared with oha and the mock, which answers a small request in 0.2 ms alone): small request p50 round trip 1.1 ms, 1,600 req/s at 32 concurrent, 7 MB RSS idle; 300 KB request p50 1.9 ms, 1,050 req/s, 40 MB peak; `slopmax --version` and `slopmax status` about 2 ms; `slopmax serve` answers `/healthz` about 22 ms after it starts. Measured with DIST-012's method; the TS port reports the same rows. `ARCHITECTURE.md:290-301`
- **DIST-015** Hot-path rules the numbers depend on (each owned elsewhere): request bodies are scanned, never parsed whole (PRX-051, rawjson); the stream tap parses only events that mention usage or an error (PRX-081); sockets set `TCP_NODELAY` (NET-030); commands that only talk to the local proxy skip loading the system trust store (CLI-123, BG-001). `ARCHITECTURE.md:303-308`
- **DIST-016** Repository assets: `assets/icon.svg` (the app and README mark), `assets/tray.svg` (the non-macOS tray icon, DESK-105); `LICENSE` (MIT); `CHANGELOG.md` (release notes, DIST-008). `assets/`; `crates/slopmax-desktop-gpui/src/main.rs:71`

---

## Effect port notes

**What fits.**

- _CLI parser._ Keep `args.rs` as a pure table-driven module (plain data and
  functions, no Effect), because the exact error texts, exit code 2, the
  `-1`-is-a-value rule, Rest semantics, help layout, and the completion
  scripts are all contract (CLI-011..038). `effect/cli` produces its own
  help, errors, and completions and would break those byte-for-byte; use it
  only if it can be made to reproduce them, which it cannot cheaply. Run the
  parsed command as an `Effect` program and map errors to exit codes at the
  edge (`2` usage, `1` failure, command code otherwise).
- _Services._ `Daemon` (healthz/status/refresh/sync/redeem/shutdown client,
  plain HTTP, 1 s connect / 30 s total) as a `Context.Service` over
  `HttpClient`, so CLI and app tests can swap a mock. `Terminal` (line queue,
  confirm/ask/choose/secret, sign-in paste forwarding) as a service over a
  single stdin reader that feeds an Effect `Queue<string>`; the sign-in takes
  from it only while it runs (`Effect.raceFirst` with the login's own
  completion), which reproduces CLI-190/199 without threads. `Output` (color
  decision, `bold/dim/…`, `pad`, `visible_width`) as pure functions plus a
  one-time `isTTY && !NO_COLOR` read.
- _Snapshot._ `SubscriptionRef<Snapshot>` replaces the tokio `watch`;
  `SubscriptionRef.update` for `send_modify`; the UI follows
  `SubscriptionRef.changes`. The "look again" `Notify` and `full` flag become a
  `Queue<boolean>` (or `Ref` + `Deferred`) raced against `Effect.sleep("2 seconds")`
  in the watcher; the slow-poll check uses `Clock` so `TestClock` drives
  APP-015..018.
- _Timers._ The watcher (2 s / 15 s), notice expiry (6 s), desktop ticks (1 s,
  60 s history), panel today refresh (60 s), `status --watch` (5 s), `logs -f`
  (500 ms), launch wait (50×100 ms) are `Effect.repeat`/`Schedule.spaced`
  fibers forked into a scope, interrupted on window close or quit.
- _Schema._ The told file (APP-061/062) is a line format: parse by hand,
  lenient as Rust is. `desktop.json` (DESK-150) is a `Schema.Struct` with
  optional-with-default fields, decoded with a whole-file fallback to defaults
  on any error (serde's behavior). `Report`, summary/usage JSON, and the redeem
  answer `{outcome, report}` are core schemas reused here.
- _Resources._ The sign-in fiber is `Effect.forkIn(scope)`; `cancel_sign_in`
  is `Fiber.interrupt`, which must also close the OAuth callback listener
  (acquire it with `acquireRelease`). The detached `serve` child, the tray,
  the panel window, and the global click monitor are scoped resources.
- _View._ `view.rs` and `alerts.rs` are pure; port them as plain functions in
  `@slopmax/app` so the Electron renderer can call them or receive their
  output over IPC. The desktop's own formatting helpers (`axis`, `places`,
  `grouped`, `dollars`, `priced`, `sentence`, `title_case`) are pure too.

**Traps (Rust mechanisms that need a different design).**

- `slopmax run` execs the agent on Unix (CLI-082). Neither Bun nor Node can
  `execve` in place; spawn with inherited stdio, forward SIGINT/SIGTERM/SIGHUP
  and the exit code (or signal → 128+n), and make sure the parent adds no
  output. Note the difference in NOT-PORTED if any.
- Echo-off secret input uses termios (CLI-197). Use raw mode on stdin and
  read until newline without echoing; restore on interruption (scope
  finalizer). Piped stdin must read to EOF instead.
- One stdin reader shared by questions and sign-in (CLI-190): Node's
  `readline` and Bun's stdin iterators must be created once per process, or
  lines get lost between prompts.
- Rust float formatting rounds ties to even (`format!("{:.0}", 2.5)` is `2`);
  JavaScript `toFixed` does not. Every `{:.0}%`, `{:.2}`, `{:>3.0}%` above
  (status cells, gauges, pace, dollars, left on the table) needs a
  ties-to-even formatter to match byte-for-byte. `as u64` truncation and
  `.round()` (half away from zero) also differ from `Math.round` for negatives.
- Widths and edit distance count Unicode scalar values (`chars()`), not
  UTF-16 units: use `Array.from(s)` / `[...s]` for `visible_width`, name
  truncation, model truncation, and Levenshtein.
- `current_exe` for spawning `serve` and for `env`'s output: a
  `bun build --compile` binary's `process.execPath` is right, but under
  `bun run` it is Bun itself; the CLI must know its own entry (argv) in dev.
  Electron's app finds the CLI beside its executable (`Contents/MacOS`) or in
  `../bin` (APP-014); with Electron the CLI binary belongs in
  `Contents/MacOS` or `Contents/Resources` and the lookup must include it.
- Detached `serve` (CLI-121): `spawn(..., { detached: true, stdio: ['ignore', fd, fd] })`
  plus `unref()`, appending to `slopmax.log`; Bun's `Bun.spawn` needs the same.
- Clock formatting uses the local UTC offset at each instant (DST-aware):
  compute it per timestamp (`new Date(ms).getTimezoneOffset()`), not once.
- File locks (`.config.lock`, account locks) are `flock`-style in Rust; Node
  and Bun lack `flock`, so the core's lock design applies to the CLI's
  config-creation race too (`serve_runs_in_the_foreground_until_stopped`
  creates the config first for that reason).
- GPUI specifics that do not carry over: `cmd-…` bindings (map to Electron
  accelerators `Cmd` on macOS; decide and document `Ctrl`/`Super` elsewhere),
  `QuitMode::Explicit` (→ do not quit on `window-all-closed`, reopen on
  `activate`), template menu bar glyph (Electron `Tray` with a template
  `nativeImage`; `setTitle` gives the menu bar text on macOS), popup panel
  hung under the item (frameless transparent `BrowserWindow` positioned from
  `tray.getBounds()`, resized to content), the global outside-click monitor
  (use `blur` plus a short guard, since Rust deliberately did not close on
  focus loss), and UserNotifications replace-by-key (Electron's `Notification`
  has no identifier: keep a key→notification map and `close()` the previous).
  Reduced motion maps to `prefers-reduced-motion`; `tnum` to
  `font-variant-numeric: tabular-nums`; GPUI roles to ARIA roles.
- The app's action runner moves blocking work off the async workers
  (`spawn_blocking`). In TS, synchronous `fs` calls would block Electron's main
  process: use async file APIs throughout `@slopmax/app`.
- `start_with(false)` (screenshot mode) and the `shots` feature have no
  direct Electron equivalent; `webContents.capturePage()` per page covers
  DESK-160 if kept, else list it in NOT-PORTED.
