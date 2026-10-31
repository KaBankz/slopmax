// Every provider, by id. The record's type lists every `ProviderId`, so a
// new provider fails the type check until it has an entry here.
import type { ProviderId } from "@slopmax/domain"
import type { Account } from "../account.ts"
import { claude } from "./claude.ts"
import { codex } from "./codex.ts"
import { compat } from "./compat.ts"
import { anthropic, openai, xai } from "./keys.ts"
import type { Provider } from "./provider.ts"

export const providers: { readonly [K in ProviderId]: Provider } = { claude, codex, anthropic, openai, xai, compat }

/** The provider an account belongs to. */
export const providerOf = (account: Account): Provider => providers[account.provider]
