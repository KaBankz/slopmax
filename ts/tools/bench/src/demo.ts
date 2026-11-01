// `bun tools/bench demo` (`mise run demo`): a throwaway slopmax for working
// on the dashboard or the desktop app. The mock provider and the rig run in
// this process over a fresh home with four fake accounts in varied states
// (one limited, one with a reset about to lapse), a month of history in the
// ledger, and every directory an app could touch (Claude Code's, Codex's,
// the login services') pointed inside the demo, so nothing reaches a real
// account, a real setting, or launchd and systemd. Ctrl-C stops it and
// deletes it all.
//
// The history is drawn from a fixed seed, so every demo shows the same
// month, ending at the moment it starts.
import { type Account, Accounts, currentZone, Health, Home, Ledger, prettyJson, SavedState } from "@slopmax/core"
import { type AccountId, type AgentId, LedgerRecord, Limits, type ProviderId, Usage, Window } from "@slopmax/domain"
import { TestHome } from "@slopmax/test"
import { Config, Console, Data, DateTime, Effect, FileSystem, Option, Random, Schema } from "effect"
import { HttpClient } from "effect/http"
import { serveMock } from "./mock.ts"
import { prepareHome, rigBase, servePrepared } from "./rig.ts"
import { usablePort } from "./workbench.ts"

/** The user agent Claude Code was last seen with: Claude lists limit resets to Claude Code alone. */
export const demoClaudeAgent = "claude-cli/2.1.291 (external, cli)"

type Shape = ReadonlyArray<Window>

const windowsOf = (now: DateTime.Utc, five: number, fiveIn: number, week: number, weekIn: number): Shape => [
  new Window({ span: "5h", used: five, resetsAt: DateTime.add(now, { seconds: fiveIn }) }),
  new Window({ span: "7d", used: week, resetsAt: DateTime.add(now, { seconds: weekIn }) }),
]

/** A weekly limit on one model, as Claude reports for Fable. */
const fable = (now: DateTime.Utc, used: number, resetsIn: number): Shape => [
  new Window({ span: "7d", model: "Fable", used, resetsAt: DateTime.add(now, { seconds: resetsIn }) }),
]

/**
 * How each account looks: the first Claude account busy, the second
 * barely used; the first ChatGPT account spent, the second with its week
 * resetting within the day mostly unused, worth a nudge.
 */
const looks = (now: DateTime.Utc): Readonly<Record<"claude" | "codex", readonly [Shape, Shape]>> => ({
  claude: [
    [...windowsOf(now, 82, 7_500, 47, 259_200), ...fable(now, 64, 259_200)],
    [...windowsOf(now, 12, 14_400, 30, 432_000), ...fable(now, 18, 432_000)],
  ],
  codex: [windowsOf(now, 100, 4_800, 64, 172_800), windowsOf(now, 35, 10_800, 21, 72_000)],
})

/** When each account last answered, in seconds ago: the limited one before its limit, the others lately. */
const lastAnswered: Readonly<Record<"claude" | "codex", readonly [number, number]>> = {
  claude: [180, 2_460],
  codex: [7_500, 720],
}

/** Four weeks of weekly windows that reset, and how much of each was used: what was left on the table. */
const weeksUsed: Readonly<Record<"claude" | "codex", readonly [ReadonlyArray<number>, ReadonlyArray<number>]>> = {
  claude: [
    [62, 88, 100, 45],
    [97, 100, 93, 100],
  ],
  codex: [
    [100, 100, 96, 100],
    [38, 55, 71, 40],
  ],
}

const models: Readonly<Record<"claude" | "codex", ReadonlyArray<readonly [string, number]>>> = {
  claude: [
    ["claude-opus-5-5", 7],
    ["claude-sonnet-5-5", 2],
    ["claude-fable-5-1", 1],
  ],
  codex: [["gpt-6-sol", 1]],
}

const pickWeighted = (choices: ReadonlyArray<readonly [string, number]>) =>
  Effect.map(
    Random.nextBetween(
      0,
      choices.reduce((sum, [, weight]) => sum + weight, 0),
    ),
    (roll) => {
      let left = roll
      for (const [name, weight] of choices) {
        if (left < weight) return name
        left -= weight
      }
      return choices.at(-1)?.[0] ?? ""
    },
  )

const int = (min: number, max: number) => Random.nextIntBetween(min, max)

const hex16 = Effect.map(Effect.all(Array.from({ length: 4 }, () => int(0, 0xffff))), (parts) =>
  parts.map((part) => part.toString(16).padStart(4, "0")).join(""),
)

/** The accounts of one provider, oldest first, as the demo's shapes are given out. */
const ofProvider = (accounts: ReadonlyArray<Account>, provider: ProviderId) =>
  accounts
    .filter((account) => account.provider === provider)
    .toSorted((a, b) => DateTime.toEpochMillis(a.addedAt) - DateTime.toEpochMillis(b.addedAt))

const agentOf = (provider: "claude" | "codex"): AgentId => (provider === "claude" ? "claude-code" : "codex")

/**
 * Thirty days of requests as the proxy records them: agents' sessions,
 * busier on weekdays and in working hours, mostly cached and growing over
 * the month; each session opening with a model listing (no tokens, so no
 * answer); the odd request no account could take, the odd provider error
 * and the odd failover; and a daily warmup on each ChatGPT account.
 */
export const demoRequests = Effect.fn("Bench.demoRequests")(function* (
  accounts: ReadonlyArray<Account>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
) {
  const records: Array<LedgerRecord> = []
  const midnight = DateTime.toUtc(DateTime.startOf(DateTime.setZone(now, zone), "day"))
  const isPast = (at: DateTime.Utc) => DateTime.isLessThanOrEqualTo(at, now)
  for (let back = 29; back >= 0; back -= 1) {
    const day = DateTime.subtract(midnight, { days: back })
    const weekDay = DateTime.getPart(DateTime.setZone(DateTime.add(day, { hours: 12 }), zone), "weekDay")
    const weekday = weekDay >= 1 && weekDay <= 5
    for (const provider of ["claude", "codex"] as const) {
      for (const account of ofProvider(accounts, provider)) {
        const warmAt = DateTime.add(day, { hours: 7 })
        if (provider === "codex" && isPast(warmAt)) {
          records.push(
            LedgerRecord.cases.Request.make({
              at: warmAt,
              account: account.id,
              provider,
              model: "gpt-6-sol",
              status: 200,
              usage: new Usage({ requests: 1, input: 9, output: 1, cacheRead: 0, cacheWrite: 0 }),
              ms: 900,
              attempts: 1,
              agent: "slopmax",
              via: "http",
            }),
          )
        }
        const scale = (weekday ? 70 : 25) * (0.6 + (0.4 * (30 - back)) / 30)
        let busy = Math.floor(scale * (yield* Random.nextBetween(0.6, 1.4)))
        while (busy > 0) {
          const size = Math.min(busy, yield* int(8, 40))
          busy -= size
          const session = yield* hex16
          let at = DateTime.add(day, { hours: yield* int(8, 22), seconds: yield* int(0, 3599) })
          if (!isPast(at)) continue
          const agent = agentOf(provider)
          records.push(
            LedgerRecord.cases.Request.make({
              at,
              account: account.id,
              provider,
              status: 200,
              usage: Usage.zero,
              ms: yield* int(80, 400),
              attempts: 1,
              agent,
              session,
              via: "http",
            }),
          )
          for (let i = 0; i < size; i += 1) {
            at = DateTime.add(at, { seconds: yield* int(20, 240) })
            if (!isPast(at)) break
            const model = yield* pickWeighted(models[provider])
            const roll = yield* Random.next
            const origin = { at, provider, model, agent, session, via: "http" as const }
            if (roll < 0.01) {
              // Every account was spent: none could be tried.
              records.push(
                LedgerRecord.cases.Request.make({
                  ...origin,
                  status: 429,
                  usage: Usage.zero,
                  ms: yield* int(5, 60),
                  attempts: 0,
                }),
              )
            } else if (roll < 0.02) {
              const status = [500, 529, 400][yield* int(0, 2)] ?? 500
              records.push(
                LedgerRecord.cases.Request.make({
                  ...origin,
                  account: account.id,
                  status,
                  usage: Usage.zero,
                  ms: yield* int(300, 4_000),
                  attempts: 1,
                }),
              )
            } else {
              const usage = new Usage({
                requests: 1,
                input: yield* int(20, 900),
                output: yield* int(150, 2_500),
                cacheRead: yield* int(20_000, 180_000),
                cacheWrite: yield* int(0, 12_000),
              })
              const ms = yield* int(4_000, 45_000)
              const firstByteMs = (yield* int(350, 1_400)) + (provider === "codex" ? 300 : 0)
              records.push(
                LedgerRecord.cases.Request.make({
                  ...origin,
                  account: account.id,
                  status: 200,
                  usage,
                  ms,
                  firstByteMs,
                  // Another account was limited first.
                  attempts: roll > 0.96 ? 2 : 1,
                }),
              )
            }
          }
        }
      }
    }
  }
  return records.toSorted((a, b) => DateTime.toEpochMillis(a.at) - DateTime.toEpochMillis(b.at))
}, Random.withSeed(7))

/** The weekly windows that ended over the last four weeks, with how much of each was used. */
export const demoWindowsEnded = (accounts: ReadonlyArray<Account>, now: DateTime.Utc): ReadonlyArray<LedgerRecord> =>
  (["claude", "codex"] as const).flatMap((provider) =>
    ofProvider(accounts, provider).flatMap((account, n) =>
      (weeksUsed[provider][n] ?? []).map((used, back) =>
        LedgerRecord.cases.WindowEnded.make({
          // The latest ended a few days ago, inside a week's range.
          at: DateTime.subtract(now, { days: back * 7 + n + 2 }),
          account: account.id,
          provider,
          ...(account.identity.plan === undefined ? {} : { plan: account.identity.plan }),
          span: "7d",
          used,
        }),
      ),
    ),
  )

/** What each account served over `records`: the answers' usage, summed. */
export const servedBy = (records: ReadonlyArray<LedgerRecord>): ReadonlyMap<AccountId, Usage> => {
  const served = new Map<AccountId, Usage>()
  for (const record of records) {
    if (record._tag !== "Request" || record.account === undefined || record.status !== 200) continue
    if (record.usage.input === 0) continue
    served.set(record.account, (served.get(record.account) ?? Usage.zero).plus(record.usage))
  }
  return served
}

/** `state.json` for the demo: each account's windows, blocks, resets and last answer, with all-time counters from `records`. */
export const demoState = (
  accounts: ReadonlyArray<Account>,
  now: DateTime.Utc,
  records: ReadonlyArray<LedgerRecord>,
): SavedState => {
  const served = servedBy(records)
  const shapes = looks(now)
  const health: Record<string, Health> = {}
  for (const provider of ["claude", "codex"] as const) {
    ofProvider(accounts, provider).forEach((account, n) => {
      const windows = shapes[provider][n] ?? []
      const first = windows[0]
      const spent = first !== undefined && first.used >= 100
      health[account.id] = new Health({
        limits: new Limits({
          windows,
          observedAt: now,
          ...(provider === "codex" ? { resetCredits: 2 } : {}),
        }),
        ...(spent && first.resetsAt !== undefined ? { blockedUntil: first.resetsAt } : {}),
        modelBlocks: {},
        lastUsed: DateTime.subtract(now, { seconds: lastAnswered[provider][n] ?? 0 }),
        served: served.get(account.id) ?? Usage.zero,
      })
    })
  }
  return new SavedState({ ...SavedState.empty, health, agents: { claude: demoClaudeAgent } })
}

/** Writes the demo's state and history into the prepared home at `root`; the services come from the home, below. */
export const seedDemo = Effect.fn("Bench.seedDemo")(
  function* (_root: string, _upstream: string) {
    const home = yield* Home
    const accounts = yield* (yield* Accounts).list
    const ledger = yield* Ledger
    const now = yield* DateTime.now
    const zone = yield* currentZone
    const requests = yield* demoRequests(accounts, now, zone)
    const history = [...demoWindowsEnded(accounts, now), ...requests]
    yield* ledger.append(history)
    const state = yield* Schema.encodeEffect(SavedState)(demoState(accounts, now, requests))
    yield* home.writeText(home.paths.state, prettyJson(state))
    return { accounts: accounts.length, records: history.length }
  },
  (effect, root, upstream) => Effect.provide(effect, rigBase(root, upstream)),
)

/** Something already answers on a port the demo wants. */
export class PortBusy extends Data.TaggedError("PortBusy")<{ readonly address: string }> {
  override get message(): string {
    return `something already listens on ${this.address}; stop it, or set UPSTREAM_PORT and DEMO_PORT`
  }
}

/** A port the bench refuses: CLIProxyAPI's. */
export class PortRefused extends Data.TaggedError("PortRefused")<{ readonly port: number }> {
  override get message(): string {
    return `port ${this.port} is CLIProxyAPI's; the bench never uses it`
  }
}

/** The demo's ports: `UPSTREAM_PORT` (9200) for the mock, `DEMO_PORT` (9201) for slopmax. */
export const demoPorts = Config.all({
  upstream: Config.Int("UPSTREAM_PORT").pipe(Config.withDefault(9200)),
  demo: Config.Int("DEMO_PORT").pipe(Config.withDefault(9201)),
})

/** Fails when something answers `/healthz` at `address`: a proxy left there would answer for the demo. */
const ensureFree = (address: string) =>
  HttpClient.get(`http://${address}/healthz`).pipe(
    Effect.option,
    Effect.flatMap((answer) =>
      Option.isSome(answer) && answer.value.status === 200 ? Effect.fail(new PortBusy({ address })) : Effect.void,
    ),
    Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
  )

/** The lines a person exports in another shell to use the demo. */
export const exportsText = (env: Readonly<Record<string, string>>, listen: string): string =>
  [
    `The demo proxy runs on ${listen} with four fake accounts. In another shell:`,
    "",
    `  export SLOPMAX_HOME=${env["SLOPMAX_HOME"] ?? ""} SLOPMAX_LISTEN=${listen}`,
    `  export CLAUDE_CONFIG_DIR=${env["CLAUDE_CONFIG_DIR"] ?? ""} CODEX_HOME=${env["CODEX_HOME"] ?? ""} XDG_CONFIG_HOME=${env["XDG_CONFIG_HOME"] ?? ""}`,
    "  export SLOPMAX_NO_SERVICE=1",
    "",
    "Then run the desktop app, the web UI's dev server, or the CLI against it.",
    "",
    "Ctrl-C stops it and deletes the demo.",
  ].join("\n")

/** Runs the demo until interrupted; its home is deleted when it stops. */
export const demo = Effect.gen(function* () {
  const ports = yield* demoPorts
  for (const port of [ports.upstream, ports.demo]) if (!usablePort(port)) return yield* new PortRefused({ port })
  const upstreamAddress = `127.0.0.1:${ports.upstream}`
  const listen = `127.0.0.1:${ports.demo}`
  yield* ensureFree(upstreamAddress)
  yield* ensureFree(listen)
  const home = yield* TestHome.make("demo")
  yield* (yield* FileSystem.FileSystem).makeDirectory(home.claude, { recursive: true })
  const upstream = yield* serveMock({ hostname: "127.0.0.1", port: ports.upstream })
  const options = { listen, upstream, root: home.slopmax, keepExpiring: true }
  yield* prepareHome(options)
  yield* seedDemo(home.slopmax, upstream)
  yield* Console.log(exportsText(home.env, listen))
  // Served as prepared and seeded: preparing the home again would save the accounts a second time for nothing.
  yield* servePrepared(options)
})
