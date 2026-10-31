// Account commands: connecting, importing, and managing accounts. The
// changes themselves are shared with the app and the dashboard.
import { Effect, Result } from "effect"

import {
  Account,
  account,
  auth,
  background,
  type Config,
  error,
  Failure,
  fsx,
  Home,
  human,
  import_ as imports,
  net,
  paths,
  pool,
  ProviderId,
  type Store,
  time,
} from "@slopmax/core"

import * as term from "../term.ts"
import * as ui from "../ui.ts"
import { anyhow } from "./background.ts"

const { fail } = error

export const login: (
  store: Store,
  provider: ProviderId,
  label: string | undefined,
  given: auth.LoginOptions,
) => Effect.Effect<void, Failure, term.Terminal> = Effect.fn("accounts.login")(function* (
  store: Store,
  provider: ProviderId,
  label: string | undefined,
  given: auth.LoginOptions,
) {
  const spec = ProviderId.spec(provider)
  let options = given
  if (options.device && !(spec.credential._tag === "OAuth" && spec.credential.device)) {
    return yield* fail(`--device works for ChatGPT accounts; ${spec.title} signs in with a browser`)
  }
  if (spec.credential._tag === "Key") {
    const prompt = spec.credential.optional ? "API key (leave empty if it needs none)" : `${spec.title} key`
    options = { ...options, key: yield* term.readSecret(prompt) }
  }
  const [connected, created] = yield* Effect.scoped(
    Effect.flatMap(term.signIn, (prompt) => auth.connect(store, provider, label, options, prompt)),
  )
  const plan = connected.plan === undefined ? "" : ` (${connected.plan})`
  yield* ui.println(
    `${created ? "Connected" : "Updated"} ${provider} account ${ui.bold(Account.name(connected))}${plan} as ${ui.dim(connected.id)}`,
  )
  if (!created) return
  let note: string
  if (spec.billing._tag === "Subscription") note = "Check limits with `slopmax status --refresh`."
  else {
    const models = (connected.endpoint !== undefined ? connected.endpoint.models : spec.models).join(", ")
    const sub = spec.billing.backs
    const all = sub === undefined ? undefined : yield* Effect.result(store.list())
    const backed =
      sub !== undefined && all !== undefined && Result.isSuccess(all) && all.success.some((a) => a.provider === sub)
    note =
      sub !== undefined && backed
        ? `It serves ${models} when asked for by name (${provider}/<model>), or once ` +
          `every ${ProviderId.spec(sub).title} account is limited if \`paid_overflow = true\` in config.toml.`
        : `It serves ${models}.`
  }
  yield* ui.println(ui.dim(note))
})

export const importLogins: (store: Store, source: imports.Source, own: boolean) => Effect.Effect<void, Failure> =
  Effect.fn("accounts.import")(function* (store: Store, source: imports.Source, own: boolean) {
    const http = yield* auth.httpClient(new net.Origins())
    const found = yield* imports.discover(http, source)
    if (found.length === 0) {
      yield* ui.println("No logins found to import.")
      return
    }
    let imported = 0
    let linked = 0
    for (const saved of yield* imports.save(store, found, own)) {
      if (Result.isSuccess(saved.account)) {
        const [a, created] = saved.account.success
        imported += 1
        if (a.link !== undefined) linked += 1
        yield* ui.println(
          `  ${created ? ui.green("+") : ui.yellow("~")} ${a.provider} ${ui.bold(Account.name(a))} ${ui.dim(`from ${saved.origin}`)}`,
        )
      } else {
        yield* ui.println(`  ${ui.dim("skipped")} ${saved.origin}: ${error.chain(saved.account.failure)}`)
      }
    }
    if (linked > 0) {
      yield* ui.println(
        `\n${ui.cyan("linked:")} CLIProxyAPI keeps refreshing ${linked} of these, and slopmax follows its files,\n        ` +
          "so both can run while you switch over. Once CLIProxyAPI is stopped, run\n        " +
          "`slopmax own all` so slopmax refreshes them.",
      )
    }
    if (imported > linked) {
      yield* ui.println(
        `\n${ui.yellow("note:")} Imported logins share refresh tokens with their source, and whichever\n      ` +
          "refreshes first invalidates the other's copy. Use the agents through slopmax\n      " +
          "from now on (`slopmax setup claude`, `slopmax setup codex`).",
      )
    }
  })

/** Stops following another tool's copy of an account's tokens. */
export const own: (store: Store, query: string) => Effect.Effect<void, Failure> = Effect.fn("accounts.own")(function* (
  store: Store,
  query: string,
) {
  const accounts =
    query === "all" ? (yield* store.list()).filter((a) => a.link !== undefined) : [yield* store.find(query)]
  if (accounts.length === 0) {
    yield* ui.println("No accounts follow another tool.")
    return
  }
  for (const a of accounts) {
    const link = a.link
    if (link === undefined) {
      yield* ui.println(`${ui.bold(Account.name(a))} already refreshes here.`)
      continue
    }
    yield* store.update(a.id, (current) => account.without(current, "link"))
    yield* ui.println(`slopmax now refreshes ${ui.bold(Account.name(a))} ${ui.dim(`(was following ${link.tool})`)}`)
  }
  yield* ui.println(ui.dim("Its first refresh signs the old copy out, so keep the other tool stopped."))
})

export const useAccount: (store: Store, query: string) => Effect.Effect<void, Failure> = Effect.fn(
  "accounts.useAccount",
)(function* (store: Store, query: string) {
  const home = yield* Home.current
  if (query === "auto") {
    yield* account.unpinAll(home)
    yield* ui.println("slopmax will choose accounts automatically.")
    return
  }
  const a = yield* store.find(query)
  yield* account.pin(home, a)
  yield* ui.println(`New ${a.provider} sessions will use ${ui.bold(Account.name(a))} while it has quota.`)
})

export const setDisabled: (store: Store, query: string, disabled: boolean) => Effect.Effect<void, Failure> = Effect.fn(
  "accounts.setDisabled",
)(function* (store: Store, query: string, disabled: boolean) {
  const id = (yield* store.find(query)).id
  const a = yield* store.update(id, (current) => ({ ...current, disabled }))
  yield* ui.println(`${disabled ? "Disabled" : "Enabled"} ${ui.bold(Account.name(a))}`)
})

export const remove: (store: Store, query: string) => Effect.Effect<void, Failure> = Effect.fn("accounts.remove")(
  function* (store: Store, query: string) {
    const a = yield* store.find(query)
    yield* account.forget(store, yield* Home.current, a)
    yield* ui.println(`Removed ${ui.bold(Account.name(a))}`)
  },
)

export const redeem: (
  config: Config,
  store: Store,
  query: string,
  yes: boolean,
) => Effect.Effect<void, Failure, term.Terminal> = Effect.fn("accounts.redeem")(function* (
  config: Config,
  store: Store,
  query: string,
  yes: boolean,
) {
  const found = yield* store.find(query)
  const credits = ProviderId.get(found.provider).credits()
  if (credits === undefined) {
    return yield* fail(
      `${Account.name(found)} is a ${ProviderId.spec(found.provider).title} account, which has no limit resets`,
    )
  }
  const http = yield* auth.httpClient(new net.Origins())
  const a = config.refreshTokens
    ? yield* auth.ensureFresh(http, store, found, false).pipe(Effect.mapError(anyhow))
    : found
  // As the proxy last saw the provider's own client, which some answer
  // alone.
  const state =
    (yield* fsx.readJson(yield* paths.stateFile, pool.StateSchema).pipe(Effect.mapError(anyhow))) ?? pool.State.empty()
  const agent = state.agents[a.provider]
  const available = yield* credits.list(http, a, agent)
  const next = available[0]
  if (next === undefined) {
    yield* ui.println(`${ui.bold(Account.name(a))} has no limit resets.`)
    return
  }
  const now = yield* time.Timestamp.now
  const expiry = next.expiresAt === undefined ? "" : `; the next expires in ${human.until(next.expiresAt, now)}`
  const s = available.length === 1 ? "" : "s"
  yield* ui.println(`${ui.bold(Account.name(a))} has ${available.length} limit reset${s}${expiry}.`)
  if (!yes && !(yield* term.confirm("Reset its usage windows now?", false))) return
  const outcome = yield* credits.redeem(http, a, agent, next.id)
  switch (outcome) {
    case "reset":
      yield* ui.println(`Reset the usage windows on ${ui.bold(Account.name(a))}.`)
      // Let a running proxy pick up the fresh windows right away.
      yield* (yield* background.Daemon.make(config)).report(true)
      return
    case "nothing_to_reset":
      return yield* ui.println("Nothing to reset yet; the limit reset was kept.")
    case "no_credit":
      return yield* ui.println("No limit reset was available.")
    case "already_redeemed":
      return yield* ui.println("That limit reset was already used.")
    case "declined":
      return yield* ui.println(`${ProviderId.spec(a.provider).title} would not use one right now, so it was kept.`)
  }
})
