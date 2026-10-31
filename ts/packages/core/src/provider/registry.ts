// The one place that lists the providers (`ProviderId::get` in the Rust):
// importing this module installs each implementation where
// `ProviderId.get` finds it. The package's index imports it, so anything
// that goes through `@slopmax/core` has every provider.
import { Claude } from "./claude/mod.ts"
import { Codex } from "./codex/mod.ts"
import { Compat } from "./compat.ts"
import { ANTHROPIC, OPENAI, XAI } from "./keys.ts"
import { install, type Provider } from "./mod.ts"

/** Every implementation, in `ProviderId.ALL` order. */
export const PROVIDERS: ReadonlyArray<Provider> = [Claude, Codex, ANTHROPIC, OPENAI, XAI, Compat]

for (const provider of PROVIDERS) install(provider)
