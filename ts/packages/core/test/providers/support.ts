// Stand-ins for provider APIs: an in-process upstream that answers through a
// handler and records every call, and accounts built the way sign-ins build
// them.
import { AccountId, type LoginEvent, type ProviderId } from "@slopmax/domain"
import { MemoryFileSystem } from "@slopmax/test"
import { DateTime, Effect, Layer, Option, Redacted, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Account, Credential, Identity, type Link, Tokens } from "../../src/account.ts"
import { Accounts } from "../../src/accounts.ts"
import { Home } from "../../src/home.ts"
import { Lock } from "../../src/lock.ts"
import { LoginUi } from "../../src/providers/oauth.ts"
import { SettingsService } from "../../src/settings.ts"
import { Upstream } from "../../src/upstream.ts"

/** One call the upstream saw. */
export interface Seen {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: string
}

/** The body of a call, as JSON. */
export const jsonOf = (seen: Seen | undefined): unknown => (seen === undefined ? undefined : JSON.parse(seen.body))

/** A form-encoded body's fields. */
export const formOf = (seen: Seen | undefined): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(seen?.body ?? ""))

export const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  Response.json(body, { status, ...(headers === undefined ? {} : { headers }) })

export const reply = (status: number, text = "") => new Response(text, { status })

/** An upstream answered by `answer`, recording each call; `answer` may throw to stand for a network failure. */
export const mockUpstream = (answer: (seen: Seen) => Response | Promise<Response>) => {
  const seen: Array<Seen> = []
  const layer = Upstream.layerHandler(async (request) => {
    const call: Seen = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: await request.text(),
    }
    seen.push(call)
    return answer(call)
  })
  return { seen, layer, at: (path: string) => seen.filter((call) => call.url.pathname === path) }
}

/** An upstream nothing can reach. */
export const downUpstream = Upstream.layerHandler(() => {
  throw new Error("connection refused")
})

export const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)

/** An OAuth account as stored, its id fixed so tests can find its file. */
export const oauthAccount = (options: {
  readonly provider?: ProviderId
  readonly id?: string
  readonly access: string
  readonly refresh?: string
  readonly idToken?: string
  readonly expiresAt?: DateTime.Utc
  readonly identity?: Identity
  readonly follows?: Link
  readonly authError?: string
}): Account =>
  new Account({
    id: AccountId.make(options.id ?? `${options.provider ?? "claude"}-0000abcd`),
    provider: options.provider ?? "claude",
    credential: Credential.cases.OAuth.make({
      tokens: new Tokens({
        access: Redacted.make(options.access),
        ...(options.refresh === undefined ? {} : { refresh: Redacted.make(options.refresh) }),
        ...(options.idToken === undefined ? {} : { idToken: Redacted.make(options.idToken) }),
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      }),
      ...(options.follows === undefined ? {} : { follows: options.follows }),
    }),
    identity: options.identity ?? new Identity({}),
    ...(options.authError === undefined ? {} : { authError: options.authError }),
    addedAt: at(0),
  })

/** An API key account. */
export const keyAccount = (provider: ProviderId, key: string): Account =>
  new Account({
    id: AccountId.make(`${provider}-0000abcd`),
    provider,
    credential: Credential.cases.Key.make({ key: Redacted.make(key) }),
    addedAt: at(0),
  })

/** A token whose claims are `claims`, unsigned. */
export const jwt = (claims: Record<string, unknown>): string =>
  `${btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "")}.${Buffer.from(JSON.stringify(claims))
    .toString("base64url")
    .replace(/=+$/, "")}.sig`

/** The person's side of a sign-in: events are kept, and `pasted` lines are offered as pastes. */
export const loginUi = (options: { readonly pasted?: ReadonlyArray<string>; readonly openBrowser?: boolean } = {}) => {
  const events: Array<LoginEvent> = []
  const layer = Layer.succeed(LoginUi)({
    tell: (event) => Effect.sync(() => void events.push(event)),
    pasted: options.pasted === undefined ? Stream.never : Stream.fromIterable(options.pasted),
    openBrowser: options.openBrowser ?? false,
  })
  return { events, layer }
}

export const home = "/home/me/.slopmax"

/** An account store on an in-memory disk, with settings and an upstream. */
export const storeLayer = (
  upstream: Layer.Layer<Upstream>,
  settings: Parameters<typeof SettingsService.layerValue>[0] = {},
  seed: MemoryFileSystem.Options = {},
) =>
  Accounts.layer.pipe(
    Layer.provideMerge(Lock.layerMemory),
    Layer.provideMerge(Home.layerAt(home)),
    Layer.provideMerge(MemoryFileSystem.layerWith(seed)),
    Layer.provideMerge(upstream),
    Layer.provideMerge(SettingsService.layerValue(settings)),
  )

/** Reads an account as stored now. */
export const stored = (id: AccountId) =>
  Effect.flatMap(Accounts, (accounts) => accounts.fresh(id)).pipe(Effect.map(Option.getOrUndefined))

/** No programs run in these tests. */
export const noSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
  ChildProcessSpawner.make(() => Effect.die("no programs run in tests")),
)

/** What a sign-in that needs nobody's input runs in: no pastes, no browser, no programs. */
export const signInServices = Layer.merge(loginUi().layer, noSpawner)
