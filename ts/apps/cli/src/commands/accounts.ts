// The commands that add and change accounts: sign in or add a key, import
// logins other tools have, take over refreshing, pin one for new sessions,
// rename, reorder, turn off, forget, and redeem a banked limit reset.
import {
  Account,
  Accounts,
  Importers,
  type LoginOptions,
  LoginUi,
  Pool,
  PoolModel,
  Providers,
  Quota,
} from "@slopmax/core"
import {
  type AccountAmbiguous,
  type AccountNotFound,
  type Dialect,
  isSubscription,
  type LimitReset,
  LoginEvent,
  providerFacts,
  type ProviderId,
  type RedeemOutcome,
  signsInByDevice,
} from "@slopmax/domain"
import { RedeemRequest } from "@slopmax/domain/api"
import { until } from "@slopmax/domain/format"
import { DateTime, Effect, Layer, Option, Redacted, Result } from "effect"
import { CliFailure } from "../failure.ts"
import { plural, Print } from "../print.ts"
import { onProxyState, syncRunning } from "../reach.ts"
import { Prompter } from "../terminal.ts"

// ---------------------------------------------------------------------------
// Finding an account

/** An account as people named it, or why none matched, pointing at where the names are. */
export const findAccount = (query: string) =>
  Effect.flatMap(Accounts, (accounts) => accounts.find(query)).pipe(
    Effect.mapError(
      (error: AccountNotFound | AccountAmbiguous) =>
        new CliFailure({
          message: error._tag === "AccountNotFound" ? `${error.message} (see \`slopmax status\`)` : error.message,
        }),
    ),
  )

/** Changes one account's file, then has a running proxy read it. */
const change = (account: Account, f: (account: Account) => Account) =>
  Effect.gen(function* () {
    const updated = yield* (yield* Accounts).update(account.id, f)
    yield* syncRunning
    return updated
  })

// ---------------------------------------------------------------------------
// login

export interface LoginInput {
  readonly provider: ProviderId
  readonly device: boolean
  readonly noBrowser: boolean
  readonly label: Option.Option<string>
  readonly url: Option.Option<string>
  readonly dialect: Option.Option<Dialect>
  readonly models: Option.Option<string>
}

/** A list given as `a,b , c`: trimmed, with empty entries dropped. */
export const splitList = (text: string): ReadonlyArray<string> =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")

/** A compatible endpoint's base URL as typed: http(s) only, without trailing slashes. */
export const endpointUrl = (url: string): Result.Result<string, string> => {
  const trimmed = url.trim()
  return /^https?:\/\//.test(trimmed)
    ? Result.succeed(trimmed.replace(/\/+$/, ""))
    : Result.fail(`--url takes an http:// or https:// base URL, got ${JSON.stringify(url)}`)
}

/** Where a sign-in's progress goes at a terminal: stderr, so stdout stays for what was asked. */
export const loginUi = (openBrowser: boolean) =>
  Layer.effect(
    LoginUi,
    Effect.gen(function* () {
      const print = yield* Print
      const prompter = yield* Prompter
      const tell = (event: LoginEvent): Effect.Effect<void> => {
        switch (event._tag) {
          case "Authorize":
            return Effect.forEach(
              [
                "",
                `  ${event.opened ? "Opened" : "Authorize"} your ${event.title} account in the browser:`,
                "",
                `  ${event.url}`,
                "",
                `  Waiting for the redirect to localhost:${event.port}. If the browser runs on another`,
                "  machine, paste the final localhost address from its address bar here.",
                "",
              ],
              (line) => print.err(line),
              { discard: true },
            )
          case "DeviceCode":
            return Effect.forEach(
              ["", `  Open ${event.url}`, `  and enter the code: ${print.paint.bold(event.code)}`, ""],
              (line) => print.err(line),
              { discard: true },
            )
          case "Note":
            return print.err(`  ${event.text}`)
          case "Done":
          case "Failed":
            return Effect.void
        }
      }
      return { tell, pasted: prompter.lines, openBrowser }
    }),
  )

/** What a new account serves, and when, said after it is added. */
const servesNote = (account: Account, all: ReadonlyArray<Account>): string => {
  if (isSubscription(account.provider)) return "Check limits with `slopmax status --refresh`."
  const facts: { readonly backs?: ProviderId; readonly models: ReadonlyArray<string> } = providerFacts[account.provider]
  const credential = account.credential
  const models = credential._tag === "Endpoint" && credential.models.length > 0 ? credential.models : facts.models
  const serves = models.length === 0 ? "the models it lists" : models.join(", ")
  const backs = facts.backs
  if (backs !== undefined && all.some((other) => other.provider === backs)) {
    return `It serves ${serves} when asked for by name (${account.provider}/<model>), or once every ${providerFacts[backs].title} account is limited while paid overflow is on (\`slopmax config paidOverflow on\`).`
  }
  return `It serves ${serves}.`
}

export const login = Effect.fn("cli.login")(function* (input: LoginInput) {
  const print = yield* Print
  const prompter = yield* Prompter
  const facts = providerFacts[input.provider]
  const url = yield* Option.match(input.url, {
    onNone: () => Effect.succeedNone,
    onSome: (typed) =>
      Result.match(endpointUrl(typed), {
        onFailure: (message) => Effect.fail(new CliFailure({ message })),
        onSuccess: Effect.succeedSome,
      }),
  })
  if (facts.signIn !== "endpoint" && Option.isSome(url)) {
    return yield* new CliFailure({ message: "--url, --dialect, and --models are for `slopmax login compat`" })
  }
  if (input.device && !signsInByDevice(input.provider)) {
    return yield* new CliFailure({
      message: `--device works for ChatGPT accounts; ${facts.title} signs in with a browser`,
    })
  }
  const label = Option.getOrUndefined(
    Option.filter(
      Option.map(input.label, (text) => text.trim()),
      (t) => t !== "",
    ),
  )
  const askOptions = Effect.gen(function* () {
    switch (facts.signIn) {
      case "key":
        return { key: Redacted.make(yield* prompter.secret(`${facts.title} key`)), label }
      case "endpoint": {
        if (Option.isNone(url)) {
          return yield* new CliFailure({ message: "a compatible endpoint needs its address: --url <base url>" })
        }
        const key = yield* prompter.secret("API key (leave empty if it needs none)")
        return {
          endpoint: {
            baseUrl: url.value,
            dialect: Option.getOrElse(input.dialect, (): Dialect => "chat"),
            models: Option.match(input.models, { onNone: () => [], onSome: splitList }),
          },
          ...(key === "" ? {} : { key: Redacted.make(key) }),
          label,
        }
      }
      case "browser":
      case "browser-or-device":
        return { device: input.device, label }
    }
  })
  const options: LoginOptions = yield* askOptions
  const saved = yield* Providers.signIn(input.provider, options).pipe(Effect.provide(loginUi(!input.noBrowser)))
  const { account, isNew } = saved
  const plan = account.identity.plan === undefined ? "" : ` (${account.identity.plan})`
  yield* print.out(
    `${isNew ? "Connected" : "Updated"} ${account.provider} account ${print.paint.bold(account.name)}${plan} as ${print.paint.dim(account.id)}`,
  )
  if (isNew) yield* print.out(print.paint.dim(servesNote(account, yield* (yield* Accounts).list)))
  yield* syncRunning
})

// ---------------------------------------------------------------------------
// import

export interface ImportInput {
  readonly source: Importers.Source
  readonly own: boolean
}

const followed = (account: Account): boolean =>
  account.credential._tag === "OAuth" && account.credential.follows !== undefined

export const importLogins = Effect.fn("cli.import")(function* (input: ImportInput) {
  const print = yield* Print
  const { bold, dim, green, yellow, cyan } = print.paint
  const found = yield* Importers.discover(input.source)
  if (found.length === 0) {
    yield* print.out("No logins found to import.")
    return
  }
  const saved = yield* Importers.save(found, input.own)
  let imported = 0
  let linked = 0
  for (const item of saved) {
    if (Result.isFailure(item.account)) {
      yield* print.out(`  ${dim("skipped")} ${item.origin}: ${item.account.failure.message}`)
      continue
    }
    const { account, isNew } = item.account.success
    imported += 1
    if (followed(account)) linked += 1
    const mark = isNew ? green("+") : yellow("~")
    yield* print.out(`  ${mark} ${account.provider} ${bold(account.name)} ${dim(`from ${item.origin}`)}`)
  }
  if (linked > 0) {
    yield* print.out()
    yield* print.out(
      `${cyan("linked:")} CLIProxyAPI keeps refreshing ${linked} of these, and slopmax follows its files,\n        so both can run while you switch over. Once CLIProxyAPI is stopped, run\n        \`slopmax own all\` so slopmax refreshes them.`,
    )
  }
  if (imported > linked) {
    yield* print.out()
    yield* print.out(
      `${yellow("note:")} Imported logins share refresh tokens with their source, and whichever\n      refreshes first signs the other's copy out. Use the agents through slopmax\n      from now on (\`slopmax setup claude\`, \`slopmax setup codex\`).`,
    )
  }
  if (imported > 0) yield* syncRunning
})

// ---------------------------------------------------------------------------
// own

export const own = Effect.fn("cli.own")(function* (query: string) {
  const print = yield* Print
  const { bold, dim } = print.paint
  const accounts = yield* Accounts
  const targets = query.trim() === "all" ? (yield* accounts.list).filter(followed) : [yield* findAccount(query)]
  if (targets.length === 0) {
    yield* print.out("No accounts follow another tool.")
    return
  }
  let taken = 0
  for (const account of targets) {
    if (account.credential._tag !== "OAuth" || account.credential.follows === undefined) {
      yield* print.out(`${bold(account.name)} already refreshes here.`)
      continue
    }
    const tool = account.credential.follows.tool === "cliproxyapi" ? "CLIProxyAPI" : account.credential.follows.tool
    yield* accounts.update(account.id, Importers.owned)
    taken += 1
    yield* print.out(`slopmax now refreshes ${bold(account.name)} ${dim(`(was following ${tool})`)}`)
  }
  if (taken > 0) {
    yield* print.out(dim("Its first refresh signs the old copy out, so keep the other tool stopped."))
    yield* syncRunning
  }
})

// ---------------------------------------------------------------------------
// use

export const use = Effect.fn("cli.use")(function* (query: string) {
  const print = yield* Print
  const pool = yield* Pool
  if (query.trim() === "auto") {
    yield* onProxyState(
      (client) => Effect.asVoid(client.accounts.unpinAll()),
      Effect.andThen(pool.update(PoolModel.unpinAll), pool.save),
    )
    yield* print.out("slopmax will choose accounts automatically.")
    return
  }
  const account = yield* findAccount(query)
  yield* onProxyState(
    (client) => Effect.asVoid(client.accounts.pin({ params: { id: account.id } })),
    Effect.andThen(
      pool.update((m) => PoolModel.pin(m, account.provider, account.id)),
      pool.save,
    ),
  )
  yield* print.out(`New ${account.provider} sessions will use ${print.paint.bold(account.name)} while it has quota.`)
})

// ---------------------------------------------------------------------------
// label, priority, enable, disable, remove

export const label = Effect.fn("cli.label")(function* (query: string, name: Option.Option<string>) {
  const print = yield* Print
  const account = yield* findAccount(query)
  const given = Option.filter(
    Option.map(name, (text) => text.trim()),
    (text) => text !== "",
  )
  const updated = yield* change(account, (current) => {
    const { label: _old, ...rest } = current
    return new Account(Option.match(given, { onNone: () => rest, onSome: (text) => ({ ...rest, label: text }) }))
  })
  yield* print.out(
    Option.isSome(given)
      ? `Renamed ${account.id} to ${print.paint.bold(updated.name)}`
      : `Cleared ${account.id}'s label; it shows as ${print.paint.bold(updated.name)}`,
  )
})

export const priority = Effect.fn("cli.priority")(function* (query: string, value: number) {
  const print = yield* Print
  const account = yield* findAccount(query)
  const updated = yield* change(account, (current) => new Account({ ...current, priority: value }))
  yield* print.out(`${print.paint.bold(updated.name)} now has priority ${value}`)
})

export const setDisabled = Effect.fn("cli.setDisabled")(function* (query: string, disabled: boolean) {
  const print = yield* Print
  const account = yield* findAccount(query)
  const updated = yield* change(account, (current) => new Account({ ...current, disabled }))
  yield* print.out(`${disabled ? "Disabled" : "Enabled"} ${print.paint.bold(updated.name)}`)
})

export const remove = Effect.fn("cli.remove")(function* (query: string) {
  const print = yield* Print
  const accounts = yield* Accounts
  const pool = yield* Pool
  const account = yield* findAccount(query)
  yield* onProxyState(
    (client) => Effect.asVoid(client.accounts.remove({ params: { id: account.id } })),
    Effect.gen(function* () {
      yield* accounts.remove(account.id)
      // Its pin goes with it.
      yield* pool.update((m) =>
        m.pins[account.provider] === account.id ? PoolModel.pin(m, account.provider, undefined) : m,
      )
      yield* pool.save
    }),
  )
  yield* print.out(`Removed ${print.paint.bold(account.name)}`)
})

// ---------------------------------------------------------------------------
// redeem

export interface RedeemInput {
  readonly account: string
  readonly reset: Option.Option<string>
  readonly yes: boolean
}

const outcomeText = (outcome: RedeemOutcome, account: Account, bold: (text: string) => string): string => {
  switch (outcome) {
    case "reset":
      return `Reset the usage windows on ${bold(account.name)}.`
    case "nothing-to-reset":
      return "Nothing to reset yet; the limit reset was kept."
    case "no-credit":
      return "No limit reset was available."
    case "already-redeemed":
      return "That limit reset was already used."
    case "declined":
      return `${providerFacts[account.provider].title} would not use one right now, so it was kept.`
  }
}

/**
 * The resets an account holds: as a running proxy last listed them (it
 * lists them again every few minutes, and redeeming the soonest reads the
 * list afresh), else as the provider lists them now.
 */
const resetsOf = (account: Account) =>
  Effect.gen(function* () {
    const quota = yield* Quota
    return yield* onProxyState(
      (client) =>
        Effect.map(
          client.system.status(),
          (report): ReadonlyArray<LimitReset> => report.accounts.find((view) => view.id === account.id)?.resets ?? [],
        ),
      quota.listResets(account),
    )
  })

export const redeem = Effect.fn("cli.redeem")(function* (input: RedeemInput) {
  const print = yield* Print
  const prompter = yield* Prompter
  const quota = yield* Quota
  const pool = yield* Pool
  const { bold } = print.paint
  const account = yield* findAccount(input.account)
  const facts = providerFacts[account.provider]
  if (!facts.hasResets) {
    return yield* new CliFailure({
      message: `${account.name} is a ${facts.title} account, which has no limit resets`,
    })
  }
  const resets = yield* resetsOf(account)
  if (resets.length === 0) {
    yield* print.out(`${bold(account.name)} has no limit resets.`)
    return
  }
  const reset = Option.getOrUndefined(input.reset)
  const chosen = reset === undefined ? resets[0] : resets.find((held) => held.id === reset)
  if (chosen === undefined) {
    return yield* new CliFailure({
      message: `${account.name} holds no limit reset "${reset}"; it holds ${resets.map((held) => held.id).join(", ")}`,
    })
  }
  const now = yield* DateTime.now
  const which = reset === undefined ? "the next" : `"${reset}"`
  const expires = chosen.expiresAt === undefined ? "" : `; ${which} expires in ${until(chosen.expiresAt, now)}`
  yield* print.out(`${bold(account.name)} has ${plural(resets.length, "limit reset")}${expires}.`)
  if (!input.yes && !(yield* prompter.confirm("Reset its usage windows now?", false))) return
  const outcome = yield* onProxyState(
    (client) =>
      Effect.map(
        client.accounts.redeem({
          params: { id: account.id },
          payload: new RedeemRequest(reset === undefined ? {} : { reset }),
        }),
        (result) => result.outcome,
      ),
    Effect.tap(quota.redeem(account, reset), () => pool.save),
  )
  yield* print.out(outcomeText(outcome, account, bold))
})
