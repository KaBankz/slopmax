// Accounts, readings and a small driver for the pool's pure rules, shared by
// the pool, report and quota tests.
import { AccountId, Limits, type ProviderId, type Span, type Strategy, Window } from "@slopmax/domain"
import { DateTime, Duration, Option, Redacted } from "effect"
import { Account, Credential, Identity, Tokens } from "../../src/account.ts"
import { emptyModel, pick, type Pick, type PickRequest, type PoolModel, sync } from "../../src/pool.ts"

/** A moment, in seconds since the epoch (where the test clock starts). */
export const ts = (seconds: number): DateTime.Utc => DateTime.makeUnsafe(seconds * 1000)

export const id = (text: string): AccountId => AccountId.make(text)

/** A signed-in subscription account named `name`, added at second `added`. */
export const subscription = (
  provider: ProviderId,
  name: string,
  added = 0,
  more: {
    readonly priority?: number
    readonly disabled?: boolean
    readonly authError?: string
    readonly plan?: string
  } = {},
): Account =>
  new Account({
    id: id(`${provider}-${name}`),
    provider,
    credential: Credential.cases.OAuth.make({ tokens: new Tokens({ access: Redacted.make(`token-${name}`) }) }),
    identity: new Identity({
      email: `${name}@x.dev`,
      accountId: name,
      ...(more.plan === undefined ? {} : { plan: more.plan }),
    }),
    addedAt: ts(added),
    priority: more.priority ?? 0,
    disabled: more.disabled ?? false,
    ...(more.authError === undefined ? {} : { authError: more.authError }),
  })

/** A Claude subscription. */
export const claude = (name: string, added = 0, more: Parameters<typeof subscription>[3] = {}) =>
  subscription("claude", name, added, more)

/** A usage window resetting at second `resets`, if given. */
export const window = (span: Span, used: number, resets?: number, model?: string): Window =>
  Window.of(span, used, resets === undefined ? undefined : ts(resets), model)

/** A reading of `windows` taken at second `at`. */
export const limits = (windows: ReadonlyArray<Window>, at = 1000, more: Partial<Limits> = {}): Limits =>
  new Limits({ windows, observedAt: ts(at), ...more })

/**
 * A pool model over `accounts`, changed by pure functions as a test goes. It
 * keeps the model between steps so a test reads like the requests it makes.
 */
export class Driver {
  m: PoolModel

  constructor(
    accounts: ReadonlyArray<Account>,
    public strategy: Strategy = "fill-first",
    public ttl: Duration.Duration = Duration.hours(1),
    public affinity = true,
  ) {
    this.m = sync(emptyModel, accounts)
  }

  /** Applies a pure change. */
  apply(f: (m: PoolModel) => PoolModel): this {
    this.m = f(this.m)
    return this
  }

  /** The full answer of a pick. */
  choose(at: number, request: Partial<PickRequest> = {}): Pick {
    const [answer, m] = pick(
      this.m,
      {
        provider: "claude",
        housekeeping: false,
        exclude: new Set(),
        strategy: this.strategy,
        ttl: this.ttl,
        affinity: this.affinity,
        ...request,
      },
      ts(at),
    )
    this.m = m
    return answer
  }

  /** The account a pick chose, or why none could serve. */
  pick(at: number, session?: string, request: Partial<PickRequest> = {}): string {
    const answer = this.choose(at, { ...(session === undefined ? {} : { session }), ...request })
    return answer._tag === "Chosen" ? answer.account.id : `none: ${answer.reason}`
  }
}

/** The value of an Option, or undefined. */
export const some = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option)
