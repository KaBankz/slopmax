# Models, API keys, and translation

slopmax is built to make several accounts of one provider feel like one. It can also do a few things beyond that.

## API keys and other endpoints

A request's model picks who serves it: every provider with an account that serves the model, subscriptions first. Claude models go to Claude accounts, GPT models to ChatGPT accounts, `grok-*` to Grok accounts for Grok Build and to xAI keys for everything else, and a compatible endpoint's models to it.

- **Paid overflow.** API keys that cover a subscription's models (an OpenAI key behind ChatGPT, an Anthropic key behind Claude, an xAI key behind Grok) serve those models only when asked for by name, or when you have no such subscription. With `paid_overflow = true` they also take over once every subscription account is limited.
- **Selectors.** A model name can pick a provider or one account: `openai/gpt-6-sol`, `work/gpt-6-sol`.
- **Aliases and fallbacks.** In the config, `[aliases]` renames models and `[fallbacks]` lists models to try once one is limited everywhere. Only the requested model's list is used (for an alias, the list of the model it stands for when the alias has none); lists don't chain:

  ```toml
  [aliases]
  fast = "gpt-6-sol-mini"

  [fallbacks]
  "claude-opus-5-5" = ["gpt-6-sol", "openai/gpt-6-sol"]   # Claude Code carries on with GPT, then the API key
  "gpt-6-sol" = ["openai/gpt-6-sol"]                      # and Codex on the API key
  ```

Claude subscriptions and Anthropic keys serve Claude Code only: Anthropic allows subscription logins in Claude Code alone, and slopmax applies the same rule to keys. A Claude model requested by any other client is refused with an explanation.

## Other models in Claude Code and Codex

When the account a request is routed to speaks another API format, slopmax translates the request and translates the answer back as it streams. Requests in a format the account speaks are forwarded as the client sent them.

| Client                            | Upstream                                   | For example                                      |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Claude Code (Messages)            | ChatGPT, OpenAI, xAI, compatible endpoints | `slopmax run claude --model gpt-6-sol`           |
| OpenAI clients (Chat Completions) | ChatGPT accounts                           | Cursor, Open WebUI, scripts using the OpenAI SDK |
| Codex (Responses)                 | xAI and Chat-only endpoints                | `slopmax run codex -m grok-4`                    |

Nothing is ever translated into Anthropic's format: Claude models only ever see requests Claude Code wrote.

Running Claude Code on GPT:

```sh
slopmax run claude --model gpt-6-sol
```

or `/model gpt-6-sol` in a running session. Claude Code does not know GPT's context window and assumes 200k tokens; set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's real window to use all of it. Background tasks still use your Claude accounts' small model unless you set `ANTHROPIC_DEFAULT_HAIKU_MODEL` too.

What crosses: text, images, documents, tool definitions and calls, tool results, refusals, the requested reasoning effort, structured output schemas, and token usage. What does not:

- The model's reasoning is not shown in Claude Code. Claude Code would send it back to Anthropic, which rejects thinking it did not sign. slopmax keeps the upstream's encrypted reasoning itself and restores it on the next turn, for the same account only.
- Anthropic's server tools (web search, code execution) run only on Anthropic and are left out.
- Token counts for translated models are estimates.
- Codex compacts long conversations remotely. A model reached by translation cannot, so slopmax asks it for a summary instead and hands that to Codex as the compacted history.
