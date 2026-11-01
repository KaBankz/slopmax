// The proxy in process for its tests: the real daemon without schedules
// (the same composition `Harness.memory` runs), over an account store on an
// in-memory disk and providers answered by scripts. Requests go straight to
// the front door's handler. The accounts and the waits come from the shared
// test support.
import { AccountId, type ProviderId, type Settings } from "@slopmax/domain"
import { DateTime, Duration, Effect, Layer } from "effect"
import { type Account, accountText } from "../../src/account.ts"
import { Events } from "../../src/events.ts"
import { Ledger } from "../../src/ledger.ts"
import { Pool } from "../../src/pool.ts"
import { Proxy } from "../../src/proxy/forward.ts"
import { Quota } from "../../src/quota.ts"
import { Relay, Server, WebApp } from "../../src/server.ts"
import { daemonOver } from "../api/stack.ts"
import { home, noSpawner, storeLayer } from "../providers/support.ts"
import { ownerKey } from "../support/clients.ts"
import { endpointAccount, keyAccount, signedIn } from "../support/fixtures.ts"
import { inDaemon } from "../support/harness.ts"
import { memoryUpstream, type Route } from "../support/memory-upstream.ts"

export const key = ownerKey

/** A signed-in account holding `token`, added at second `1000 + order` so fill-first tries accounts in the order given. */
export const oauth = (provider: ProviderId, name: string, token: string, order: number, refresh = `refresh-${name}`) =>
  signedIn({
    provider,
    id: `${provider}-${name}`,
    name,
    token,
    order,
    refresh,
    // Eight hours past the test clock's start.
    expiresAt: DateTime.makeUnsafe(Duration.toMillis(Duration.hours(8))),
  })

/** A compatible endpoint speaking Chat at `baseUrl`, serving `local-model`. */
export const endpoint = (name: string, baseUrl: string, order: number) =>
  endpointAccount(name, "chat", ["local-model"], { baseUrl, order })

/** An API key account. */
export const apiKey = (provider: ProviderId, name: string, secret: string, order: number) =>
  keyAccount(provider, secret, { name, order })

export interface Options {
  readonly routes: ReadonlyArray<Route>
  readonly accounts: ReadonlyArray<Account>
  readonly settings?: Partial<typeof Settings.Encoded>
  /** More files in the home, by path relative to it. */
  readonly files?: Readonly<Record<string, string>>
  /** Relay Codex's WebSockets (else every handshake hears 426), dialing URLs under each key at its value. */
  readonly sockets?: Readonly<Record<string, string>>
}

/** The proxy over `options`, and the upstream it talks to; `listen` puts it on a real socket. */
export const proxyStack = (options: Options & { readonly listen?: boolean }) => {
  const upstream = memoryUpstream(options.routes, options.sockets)
  const files = Object.fromEntries([
    ...options.accounts.map((account) => [`${home}/accounts/${account.id}.json`, accountText(account)] as const),
    ...Object.entries(options.files ?? {}).map(([path, text]) => [`${home}/${path}`, text] as const),
  ])
  const store = storeLayer(
    upstream.layer,
    { strategy: "fill-first", refreshTokens: false, ...options.settings },
    { files },
  )
  // The real daemon, so these scenarios run through the same composition people do.
  const layer = daemonOver(store, { listen: options.listen === true })
  return { upstream, layer }
}

/**
 * The front door with only the proxy behind it: neither slopmax's API nor
 * the socket relay plugged in, for the front door's own tests of its empty
 * slots. Everything else runs on {@link proxyStack}, the real daemon.
 */
export const frontDoorAlone = (options: Options & { readonly listen?: boolean }) => {
  const upstream = memoryUpstream(options.routes, options.sockets)
  const store = storeLayer(upstream.layer, { strategy: "fill-first", refreshTokens: false, ...options.settings })
  const server = options.listen === true ? Server.layer.pipe(Layer.provide(noSpawner)) : Server.layerMemory
  const layer = server.pipe(
    Layer.provideMerge(Layer.merge(Relay.refuse, WebApp.none)),
    Layer.provideMerge(Proxy.layerWithParts),
    Layer.provideMerge(Quota.layer),
    Layer.provideMerge(Pool.layerMemory()),
    Layer.provideMerge(Ledger.layer),
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(store),
  )
  return { upstream, layer }
}

/** Points the upstream's scripts at the clock the test runs on. */
export const followClock = (upstream: ReturnType<typeof memoryUpstream>) =>
  Effect.clockWith((clock) => Effect.sync(() => upstream.useClock(() => clock.currentTimeMillisUnsafe())))

/** Sends a request to the front door and reads the whole answer. */
export const send = (request: Request) =>
  Effect.gen(function* () {
    const server = yield* Server
    const response = yield* Effect.promise(() => Promise.resolve(server.fetch(request)))
    const text = yield* Effect.promise(() => response.text())
    return { status: response.status, headers: response.headers, text }
  })

/** Waits until every finished answer has been settled into the pool and the ledger. */
export const settled = inDaemon.settled

/** An account's health now. */
export const health = (id: string) => inDaemon.health(AccountId.make(id))

/** Every ledger record written so far. */
export const ledger = inDaemon.ledger

const base = "http://slopmax.test"

/** The body Claude Code sends: a model, a message, a stream. */
export const claudeBody = JSON.stringify({
  model: "claude-opus-5-5",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 100,
  stream: true,
})

/** A request as Claude Code makes one. */
export const claudeCode = (
  options: { readonly body?: string; readonly headers?: Record<string, string>; readonly path?: string } = {},
) =>
  new Request(`${base}${options.path ?? "/claude/v1/messages?beta=true"}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body ?? claudeBody,
  })

/** A request as Codex makes one. */
export const codexRequest = (
  options: { readonly body?: string; readonly headers?: Record<string, string>; readonly path?: string } = {},
) =>
  new Request(`${base}${options.path ?? "/codex/responses"}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "user-agent": "codex_cli_rs/0.160.0 (Linux; x86_64)",
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ model: "gpt-6-sol", input: [], stream: true }),
  })

/** Any other request to the proxy. */
export const request = (
  method: string,
  path: string,
  options: { readonly body?: string; readonly headers?: Record<string, string> } = {},
) =>
  new Request(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...options.headers },
    ...(options.body === undefined ? {} : { body: options.body }),
  })
