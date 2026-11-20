# Accounts

Each account is a private TOML file in `~/.slopmax/accounts/`, named after a hash of the account's identity, so signing in again or re-importing updates the account instead of adding a copy.

## Subscriptions

`slopmax login claude` and `slopmax login codex` run the same OAuth flow as the official clients: PKCE with a localhost callback. On a machine without a browser, Claude's page shows a code to paste back and Codex shows a device code to enter on any device (`--device` asks for one anywhere). `slopmax login grok` signs in to Grok with Grok Build's device code, approved in any browser.

The proxy refreshes tokens ahead of expiry (an hour early for Claude; four days for Codex, whose sign-ins ChatGPT ends early; half an hour for Grok's six-hour tokens) under a file lock, so no two processes spend the same refresh token. When a provider rejects a refresh, the account is flagged for re-login and leaves the rotation.

## API keys

`slopmax login anthropic`, `openai`, or `xai` asks for the key at a hidden prompt, or reads it from stdin (`slopmax login xai < key.txt`), so it never lands in your shell history. It is checked against the provider's model list before it is saved. See [Models and API keys](models.md) for how keys are used.

## Compatible endpoints

`slopmax login compat --url http://localhost:11434/v1` adds any API that speaks OpenAI Chat Completions (the default), Responses (`--dialect responses`), or Anthropic Messages (`--dialect messages`). Its models are read from the endpoint, or named with `--models 'qwen3-*,llama4'`.

## Imports

`slopmax account import` reads Claude Code's `~/.claude/.credentials.json` (or the macOS keychain), Codex's `~/.codex/auth.json`, and CLIProxyAPI's `~/.cli-proxy-api/*.json` (its xAI sign-ins become Grok accounts).

An imported login shares its refresh token with the tool it came from, and refresh tokens rotate on use, so whichever refreshes first signs the other out. Logins from CLIProxyAPI are therefore *linked*: slopmax follows the file CLIProxyAPI keeps refreshing and never refreshes them itself, so both can run while you switch over. `slopmax status` says which accounts it follows. Once CLIProxyAPI is stopped, `slopmax account adopt all` hands refreshing to slopmax.

## Managing accounts

`slopmax account` lists the accounts, numbered. `<account>` in any command is that number, or the account's id, email, or label.

```sh
slopmax account use 2          # prefer account 2 for new sessions (--auto lets slopmax choose again)
slopmax account order 3 1      # account 3 first, then 1, then the rest as they were
slopmax account priority 3 -1  # a lower tier, used only when the higher ones are limited
slopmax account disable 2      # out of rotation; its sign-in is still kept fresh
slopmax account check 2        # lift slopmax's hold and read its usage again
slopmax account redeem 2       # spend a limit reset
```
