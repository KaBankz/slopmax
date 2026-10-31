// `GET /v1/models` for OpenAI-style clients: every model a connected
// account offers them, read from each provider and kept a while.
//
// Claude Code and Codex list models through their own providers' APIs
// (see `route`); this list is for everything else, so Claude models,
// which serve Claude Code only, are not on it.
import { Clock, Effect } from "effect"
import type { HttpServerResponse } from "effect/http"

import { log } from "@slopmax/common"
import type { json } from "@slopmax/wire"

import type { Account } from "../account.ts"
import { ClientKey } from "../config.ts"
import { chain } from "../error.ts"
import { ProviderId } from "../provider/mod.ts"
import { byteOrder } from "../serde.ts"
import { header } from "./headers.ts"
import { type App, jsonReply } from "./app.ts"

/** How long a provider's list is reused, in milliseconds. */
const FRESH = 600 * 1000
/**
 * The Codex release whose catalog ChatGPT is asked for, until a Codex
 * client says which one it runs.
 */
const CODEX_VERSION = "0.159.3"

/**
 * Whether a `/v1/models` request wants the OpenAI-style list rather than
 * Anthropic's (Claude Code) or Codex's catalog.
 */
export const wantsList = (headers: Headers, query: string): boolean => {
  const claudeCode = header(headers, "user-agent")?.startsWith("claude-cli/") === true
  return !claudeCode && !headers.has("anthropic-version") && !query.includes("client_version=")
}

/** The list, narrowed to what `key` may use when a client key asks. */
export const list = Effect.fn("models.list")(function* (
  app: App,
  key: ClientKey | undefined,
): Effect.fn.Return<HttpServerResponse.HttpServerResponse> {
  const version = app.codexVersion ?? CODEX_VERSION
  const accounts = (yield* app.pool.accounts).filter(
    (a) => !a.disabled && a.authError === undefined && ProviderId.spec(a.provider).agentOnly === undefined,
  )
  // Each id goes to whichever listing finished first.
  const models = new Map<string, string>()
  yield* Effect.forEach(
    accounts,
    (account) =>
      Effect.map(catalog(app, account, version), (listed) => {
        for (const id of listed) if (!models.has(id)) models.set(id, account.provider)
      }),
    { concurrency: "unbounded", discard: true },
  )
  for (const alias of Object.keys((yield* app.config).aliases)) if (!models.has(alias)) models.set(alias, "slopmax")
  const data: Array<json.Json> = [...models.entries()]
    .filter(([id]) => key === undefined || ClientKey.allows(key, id))
    .toSorted(([a], [b]) => byteOrder(a, b))
    .map(([id, owner]) => ({ id, object: "model", created: 0, owned_by: owner }))
  return jsonReply(200, { object: "list", data })
})

/** The account's models, from the cache while fresh. */
const catalog = Effect.fn("models.catalog")(function* (
  app: App,
  account: Account,
  version: string,
): Effect.fn.Return<ReadonlyArray<string>> {
  const cached = app.catalogs.get(account.id)
  if (cached !== undefined && (yield* Clock.currentTimeMillis) - cached.at < FRESH) return cached.models
  const ready = yield* app.ready(account)
  if (ready === undefined) return []
  const listed = yield* Effect.result(ProviderId.get(ready.provider).catalog(app.authHttp, ready, version))
  if (listed._tag === "Failure") {
    log.warn(`${ready.id}: listing its models: ${chain(listed.failure)}`)
    return []
  }
  app.catalogs.set(ready.id, { at: yield* Clock.currentTimeMillis, models: listed.success })
  return listed.success
})
