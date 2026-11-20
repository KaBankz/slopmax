# Setting up and connecting agents

## Guided setup

```sh
slopmax setup       # or just `slopmax`, the first time
```

`slopmax setup` walks through it step by step:

1. It finds the logins Claude Code, Codex, and CLIProxyAPI hold, and offers to bring them over. For CLIProxyAPI's it asks whether you keep using CLIProxyAPI: slopmax then follows them, reading what CLIProxyAPI renews, so both can run; or it takes them over, renewing them itself, which signs CLIProxyAPI's copies out (see [Accounts](accounts.md#imports)).
2. You choose which kinds of accounts to pool (Claude, ChatGPT, Grok, API keys, compatible endpoints), and it signs you in or takes the keys. Without a browser, or over SSH, Codex shows a device code and Claude's page shows a code to paste back.
3. You choose how requests are routed: the [strategy](how-it-works.md#strategies) and whether sessions keep their account.
4. It points Claude Code, Codex, and Grok Build at the proxy, keeping a backup for `slopmax agent disconnect`.
5. It installs the proxy as a service that starts at login, and starts it.

### Unattended

Every question has a flag, and with `--yes`, or without a terminal, it asks nothing. That is the way to have an agent set slopmax up, or a provisioning script:

```sh
slopmax setup --yes --import claude-code,codex --keys-from-env \
  --strategy reset-first --affinity on --agents claude,codex
```

`--import` brings over the logins this machine has (`claude-code`, `codex`, `cliproxyapi`, `all`, or `none`), following CLIProxyAPI's unless `--adopt` takes them over; `--login claude,codex` signs in to more subscriptions (with a device code when there is no browser); `--keys-from-env` adds the keys in `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `XAI_API_KEY`; `--agents none` and `--no-service` leave the agents and the login service alone.

### By hand

```sh
slopmax login claude           # opens the sign-in page; repeat for each account
slopmax login codex            # with no browser here, it shows a code to enter on any device
slopmax login grok             # with a code approved at accounts.x.ai
slopmax agent connect claude   # point Claude Code (and every app that runs it) at slopmax
slopmax agent connect codex
slopmax agent connect grok
slopmax proxy install          # keep the proxy running, from login on
slopmax                        # every account's usage and status
```

`slopmax doctor` checks the setup and says how to fix what's wrong.

## Connecting agents

|                                       | Claude Code                                         | Codex                                                      | Grok Build                                                    |
| ------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `slopmax run <agent> [args…]`         | runs `claude` with the proxy's environment          | runs `codex` with `-c` overrides for a slopmax provider    | runs `grok` with the proxy's environment                      |
| `eval "$(slopmax agent env <agent>)"` | exports that environment in the current shell       | defines a `codex` function that goes through `slopmax run` | exports that environment in the current shell                 |
| `slopmax agent connect <agent>`       | writes the `env` block of `~/.claude/settings.json` | adds and selects a provider in `~/.codex/config.toml`      | sets the chat proxy and auth command in `~/.grok/config.toml` |

`slopmax agent disconnect <agent>` puts back exactly what `connect` replaced. The edited file then holds the slopmax key, so `connect` keeps it private (mode 0600). `slopmax agent` lists the agents and whether each is connected.

- **Claude Code** gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, the slopmax key. Every app that runs Claude Code reads `~/.claude/settings.json`, so `agent connect` covers the CLI, the Agent SDK, IDE extensions, and GUI wrappers such as T3 Code, Conductor, Orca, and Superset. The Claude desktop app is the exception: it starts its bundled Claude Code with its own environment, so it cannot be pointed at a proxy.
- **Codex** gets a model provider at `http://127.0.0.1:7567/codex` with `wire_api = "responses"` and `supports_websockets = true`. It is named `OpenAI`, so Codex keeps first-party behavior such as remote compaction. The Codex desktop app reads the same `config.toml`; restart it after `agent connect`. If it rewrites the file, `slopmax doctor` notices.
- **Grok Build** gets its CLI chat proxy at `http://127.0.0.1:7567/grok/v1` and an external auth provider that hands it the slopmax key (`GROK_CLI_CHAT_PROXY_BASE_URL` and `GROK_AUTH_PROVIDER_COMMAND`, or `[endpoints]` and `[grok_com_config]` in `config.toml`). `run` and `env` keep that token in a file of slopmax's own (`GROK_AUTH_PATH`), so Grok Build's own sign-in is left alone. `agent connect` cannot: the token goes to `~/.grok/auth.json`, so sign Grok Build out of xAI first (`grok logout`) and back in after `agent disconnect`; `slopmax doctor` says when its own sign-in is still there. Only a Grok account serves Grok Build: it reads its settings and models from the CLI chat proxy, so xAI keys are its overflow, never all it has.

## Other clients

Any other client can use the proxy as an OpenAI- or Anthropic-style API at `http://127.0.0.1:7567/v1`, authenticating with `api_key` from the config as a bearer token or `x-api-key`: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and `/v1/models`. Claude accounts serve Claude Code alone; see [Models and API keys](models.md).
