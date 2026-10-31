import { describe, expect } from "bun:test"
import { AccountAmbiguous, AccountGone, AccountId, AccountNotFound } from "@slopmax/domain"
import { it, MemoryFileSystem } from "@slopmax/test"
import {
  Array,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Redacted,
  Stream,
} from "effect"
import { Digest } from "effect/crypto"
import { TestClock } from "effect/testing"
import {
  Account,
  Accounts,
  accountText,
  assignId,
  compareAccounts,
  Credential,
  findAccount,
  Identity,
  identityKey,
  Tokens,
  withAssignedId,
} from "../../src/accounts.ts"
import { Home } from "../../src/home.ts"
import { type Liveness, Lock } from "../../src/lock.ts"
import { SettingsService } from "../../src/settings.ts"
import { Upstream } from "../../src/upstream.ts"

const root = "/home/me/.slopmax"
const dir = `${root}/accounts`
const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)

const liveness: Liveness = {
  alive: () => Effect.succeed(true),
  startedAt: (pid) => Effect.succeed(Option.some(`started-${pid}`)),
}

/** One slopmax process's store on a shared disk. */
const storeOn = (fs: FileSystem.FileSystem, pid = 1001) =>
  Accounts.layer.pipe(
    Layer.provideMerge(Lock.layerWith(liveness, pid)),
    Layer.provideMerge(Home.layerAt(root)),
    Layer.provideMerge(Layer.merge(Layer.succeed(FileSystem.FileSystem)(fs), Path.layer)),
    Layer.provide(Upstream.layerHandler(() => new Response("no", { status: 404 }))),
    Layer.provide(SettingsService.layerValue()),
  )

const accountsOn = (fs: FileSystem.FileSystem, pid = 1001) => Effect.provide(Accounts, storeOn(fs, pid))

const oauth = (access: string, extra: { refresh?: string; expiresAt?: DateTime.Utc } = {}) =>
  Credential.cases.OAuth.make({
    tokens: new Tokens({
      access: Redacted.make(access),
      ...(extra.refresh === undefined ? {} : { refresh: Redacted.make(extra.refresh) }),
      ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
    }),
  })

/** A Claude sign-in for this organization and email, its id not yet assigned. */
const claude = (org: string, email: string, more: Partial<ConstructorParameters<typeof Account>[0]> = {}) =>
  new Account({
    id: AccountId.make("unassigned"),
    provider: "claude",
    credential: oauth("tok"),
    identity: new Identity({ orgId: org, email }),
    addedAt: at(1_000),
    ...more,
  })

const assigned = (account: Account) => Effect.provide(withAssignedId(account), Digest.layerWebCrypto)

const named = (more: Partial<ConstructorParameters<typeof Account>[0]>) =>
  new Account({
    id: AccountId.make("claude-00000000"),
    provider: "claude",
    credential: oauth("tok"),
    addedAt: at(0),
    ...more,
  }).name

describe("Accounts", () => {
  it.effect("names accounts by a hash of who they are, the same as ever", () =>
    Effect.gen(function* () {
      expect((yield* assigned(claude("org-1", "me@x.dev"))).id).toBe(AccountId.make("claude-c24787a7"))
      const codex = new Account({
        id: AccountId.make("unassigned"),
        provider: "codex",
        credential: oauth("tok"),
        identity: new Identity({ accountId: "ws-9" }),
        addedAt: at(1_000),
      })
      expect((yield* assigned(codex)).id).toBe(AccountId.make("codex-372c403d"))
    }),
  )

  it.effect("keeps the same email in two organizations apart", () =>
    Effect.gen(function* () {
      const a = yield* assigned(claude("org-a", "me@x.dev"))
      const b = yield* assigned(claude("org-b", "me@x.dev"))
      expect(a.id).not.toBe(b.id)
      expect(a.id).toMatch(/^claude-[0-9a-f]{8}$/)
    }),
  )

  it("tells accounts apart by their organization, workspace, key or endpoint, else email, else refresh token", () => {
    const base = { credential: oauth("tok", { refresh: "rt" }), identity: new Identity({}) }
    expect(identityKey({ ...base, provider: "claude", identity: new Identity({ orgId: "o", accountId: "a" }) })).toBe(
      "o",
    )
    expect(identityKey({ ...base, provider: "claude", identity: new Identity({ accountId: "a" }) })).toBe("a")
    expect(identityKey({ ...base, provider: "codex", identity: new Identity({ accountId: "ws", email: "e" }) })).toBe(
      "ws",
    )
    expect(
      identityKey({
        provider: "openai",
        credential: Credential.cases.Key.make({ key: Redacted.make("sk-1") }),
        identity: new Identity({}),
      }),
    ).toBe("sk-1")
    const endpoint = Credential.cases.Endpoint.make({
      baseUrl: "http://gpu:8000/v1",
      dialect: "chat",
      models: [],
      key: Redacted.make("k"),
    })
    expect(identityKey({ provider: "compat", credential: endpoint, identity: new Identity({}) })).toBe(
      "http://gpu:8000/v1 k",
    )
    expect(identityKey({ ...base, provider: "codex", identity: new Identity({ email: "me@x.dev" }) })).toBe("me@x.dev")
    expect(identityKey({ ...base, provider: "codex" })).toBe("rt")
    expect(identityKey({ provider: "codex", credential: oauth("tok"), identity: new Identity({}) })).toBe("")
  })

  it("names an account by its label, endpoint host, key ending, or email and organization", () => {
    expect(named({ label: "work", identity: new Identity({ email: "me@x.dev" }) })).toBe("work")
    expect(
      named({
        provider: "compat",
        credential: Credential.cases.Endpoint.make({ baseUrl: "http://gpu.lan:8000/v1", dialect: "chat", models: [] }),
      }),
    ).toBe("gpu.lan:8000")
    expect(
      named({ provider: "openai", credential: Credential.cases.Key.make({ key: Redacted.make("sk-abcd1234") }) }),
    ).toBe("OpenAI API key …1234")
    expect(named({ identity: new Identity({ email: "me@x.dev", orgName: "Acme" }) })).toBe("me@x.dev (Acme)")
    expect(named({ identity: new Identity({ email: "me@x.dev", orgName: "me@x.dev's Organization" }) })).toBe(
      "me@x.dev",
    )
    expect(named({})).toBe("claude-00000000")
  })

  it("counts a token as expiring within the lead, and one with no known expiry as never expiring", () => {
    const now = at(10_000)
    const tokens = new Tokens({ access: Redacted.make("t"), expiresAt: at(10_000 + 1800) })
    expect(tokens.expiresWithin(Duration.hours(1), now)).toBe(true)
    expect(tokens.expiresWithin(Duration.minutes(29), now)).toBe(false)
    expect(tokens.isExpired(now)).toBe(false)
    expect(new Tokens({ access: Redacted.make("t"), expiresAt: now }).isExpired(now)).toBe(true)
    expect(new Tokens({ access: Redacted.make("t") }).isExpired(now)).toBe(false)
    const key = new Account({
      id: AccountId.make("openai-1"),
      provider: "openai",
      credential: Credential.cases.Key.make({ key: Redacted.make("sk") }),
      addedAt: now,
    })
    expect(key.expiresWithin(Duration.days(365), now)).toBe(false)
  })

  it("writes account files with what is set and reads them back, ignoring fields it does not know", () => {
    const account = claude("org-1", "me@x.dev", { id: AccountId.make("claude-c24787a7") })
    const json: unknown = JSON.parse(accountText(account))
    expect(json).toEqual({
      id: "claude-c24787a7",
      provider: "claude",
      credential: { _tag: "OAuth", tokens: { access: "tok" } },
      identity: { orgId: "org-1", email: "me@x.dev" },
      disabled: false,
      priority: 0,
      addedAt: "1970-01-01T00:16:40Z",
    })
    expect(accountText(account).endsWith("}\n")).toBe(true)
  })

  it.effect("merges what people set on an account when it signs in again", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make()
      const accounts = yield* accountsOn(fs)
      const first = yield* accounts.upsert(claude("org-a", "me@x.dev", { label: "work", priority: 5 }))
      expect(first.isNew).toBe(true)
      const again = yield* accounts.upsert(
        claude("org-a", "me@x.dev", { credential: oauth("new"), addedAt: at(9_000) }),
      )
      expect(again.isNew).toBe(false)
      expect(again.account.id).toBe(first.account.id)
      expect([again.account.label, again.account.priority]).toEqual(["work", 5])
      expect(DateTime.toEpochMillis(again.account.addedAt)).toBe(1_000_000)
      const stored = yield* accounts.fresh(first.account.id)
      expect(Option.map(stored, (a) => a.secret)).toEqual(Option.some("new"))
      expect((yield* fs.stat(`${dir}/${first.account.id}.json`)).mode & 0o777).toBe(0o600)
      // A label given on the new sign-in wins.
      const relabeled = yield* accounts.upsert(claude("org-a", "me@x.dev", { label: "home" }))
      expect(relabeled.account.label).toBe("home")
    }),
  )

  it.effect("finds accounts by position, id, label, email and id prefix", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make()
      const accounts = yield* accountsOn(fs)
      const work = (yield* accounts.upsert(claude("org-a", "me@x.dev", { label: "work" }))).account
      const home = (yield* accounts.upsert(claude("org-b", "home@x.dev", { addedAt: at(2_000) }))).account
      expect((yield* accounts.find("work")).id).toBe(work.id)
      expect((yield* accounts.find("home@x.dev")).id).toBe(home.id)
      expect((yield* accounts.find(work.id.slice(0, 10))).id).toBe(work.id)
      expect((yield* accounts.find(work.id)).id).toBe(work.id)
      expect((yield* accounts.find("1")).id).toBe(work.id)
      expect((yield* accounts.find("2")).id).toBe(home.id)
      const shared = yield* Effect.flip(accounts.find("claude-"))
      expect(shared).toBeInstanceOf(AccountAmbiguous)
      expect(yield* Effect.flip(accounts.find("nope"))).toBeInstanceOf(AccountNotFound)
      expect(yield* Effect.flip(accounts.find("3"))).toBeInstanceOf(AccountNotFound)
      // A number past the end is read as a label.
      const seven = (yield* accounts.upsert(claude("org-c", "seven@x.dev", { label: "7", addedAt: at(3_000) }))).account
      expect((yield* accounts.find("7")).id).toBe(seven.id)
      expect((yield* accounts.find("3")).id).toBe(seven.id)
      expect(yield* Effect.flip(findAccount([], ""))).toBeInstanceOf(AccountNotFound)
    }),
  )

  it.effect("lists accounts by provider, then priority, then oldest first", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make()
      const accounts = yield* accountsOn(fs)
      const key = new Account({
        id: AccountId.make("x"),
        provider: "openai",
        credential: Credential.cases.Key.make({ key: Redacted.make("sk-1") }),
        addedAt: at(1),
      })
      yield* accounts.upsert(key)
      yield* accounts.upsert(claude("org-old", "a@x.dev", { addedAt: at(100) }))
      yield* accounts.upsert(claude("org-new", "b@x.dev", { addedAt: at(200) }))
      yield* accounts.upsert(claude("org-top", "c@x.dev", { addedAt: at(300), priority: 9 }))
      const listed = yield* accounts.list
      expect(listed.map((a) => a.identity.email ?? a.provider)).toEqual(["c@x.dev", "a@x.dev", "b@x.dev", "openai"])
      expect([...listed].toSorted(compareAccounts)).toEqual([...listed])
    }),
  )

  it.effect("skips account files that do not load, warning once, and ignores everything that is not one", () =>
    Effect.gen(function* () {
      const good = claude("org-1", "me@x.dev", { id: AccountId.make("claude-c24787a7") })
      const fs = yield* MemoryFileSystem.make({
        files: {
          [`${dir}/claude-c24787a7.json`]: accountText(good),
          [`${dir}/broken.json`]: '{ "id": "x" }',
          [`${dir}/renamed.json`]: accountText(new Account({ ...good, id: AccountId.make("claude-0badf00d") })),
          [`${dir}/notes.txt`]: "hello",
          [`${dir}/.claude-c24787a7.json.1.1.tmp`]: "{",
        },
      })
      const warnings: Array<string> = []
      const capture = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(Array.ensure(message).map(String).join(" "))
        }),
      ])
      const accounts = yield* accountsOn(fs).pipe(Effect.provide(capture))
      expect((yield* accounts.list).map((a) => a.id)).toEqual([good.id])
      yield* accounts.rescan.pipe(Effect.provide(capture))
      expect(warnings.length).toBe(2)
      expect(warnings[0]).toStartWith(`skipping ${dir}/broken.json: `)
      expect(warnings[1]).toBe(
        `skipping ${dir}/renamed.json: it holds claude-0badf00d, whose file is claude-0badf00d.json`,
      )
    }),
  )

  it.effect("reads a missing accounts directory as empty, and fails when one cannot be read", () =>
    Effect.gen(function* () {
      const accounts = yield* accountsOn(yield* MemoryFileSystem.make())
      expect(yield* accounts.list).toEqual([])
      const unreadable = yield* MemoryFileSystem.make({
        directories: [dir],
        fault: ({ method, path }) => (method === "readDirectory" && path === dir ? "PermissionDenied" : undefined),
      })
      const error = yield* Effect.flip(accountsOn(unreadable))
      expect(error.action).toBe("list")
    }),
  )

  it.effect("never reaches past accounts/ for an id that cannot name an account file", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make({ files: { [`${root}/config.json`]: "{}\n" } })
      const accounts = yield* accountsOn(fs)
      const outside = AccountId.make("../config")
      expect(yield* Effect.flip(accounts.remove(outside))).toBeInstanceOf(AccountGone)
      expect(yield* Effect.flip(accounts.update(outside, (account) => account))).toBeInstanceOf(AccountGone)
      expect(yield* accounts.fresh(outside)).toEqual(Option.none())
      expect(yield* fs.exists(`${root}/config.json`)).toBe(true)
    }),
  )

  it.effect("changes an account under its lock from what is on disk, and says when it is gone", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make()
      const mine = yield* accountsOn(fs, 1001)
      const theirs = yield* accountsOn(fs, 1002)
      const { account } = yield* mine.upsert(claude("org-a", "me@x.dev"))
      // Another process relabels it; this one disables it without losing the label.
      yield* theirs.update(account.id, (a) => new Account({ ...a, label: "shared" }))
      const disabled = yield* mine.update(account.id, (a) => new Account({ ...a, disabled: true }))
      expect([disabled.label, disabled.disabled]).toEqual(["shared", true])
      yield* theirs.remove(account.id)
      expect(yield* Effect.flip(mine.update(account.id, (a) => a))).toBeInstanceOf(AccountGone)
      expect(yield* Effect.flip(mine.remove(account.id))).toBeInstanceOf(AccountGone)
      expect(yield* mine.get(account.id)).toEqual(Option.none())
    }),
  )

  it.effect("sees another process's changes when it reads the directory again, and signals them", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make()
      const mine = yield* accountsOn(fs, 1001)
      const theirs = yield* accountsOn(fs, 1002)
      const signalled = yield* mine.changes.pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped)
      yield* TestClock.adjust("1 millis")
      const { account } = yield* theirs.upsert(claude("org-a", "me@x.dev"))
      expect(yield* mine.get(account.id)).toEqual(Option.none())
      expect(yield* mine.rescan).toBe(true)
      expect(yield* mine.rescan).toBe(false)
      expect(Option.map(yield* mine.get(account.id), (a) => a.id)).toEqual(Option.some(account.id))
      yield* Fiber.join(signalled)
    }),
  )

  it.effect("follows the directory, seeing a new sign-in within moments", () =>
    Effect.gen(function* () {
      const fs = yield* MemoryFileSystem.make()
      const mine = yield* accountsOn(fs, 1001)
      const theirs = yield* accountsOn(fs, 1002)
      yield* mine.follow
      for (let turn = 0; turn < 5; turn++) yield* TestClock.adjust("10 millis")
      const { account } = yield* theirs.upsert(claude("org-a", "me@x.dev"))
      yield* TestClock.adjust("150 millis")
      expect(Option.isSome(yield* mine.get(account.id))).toBe(true)
    }),
  )

  it.effect("hashes an identity with SHA-256", () =>
    Effect.gen(function* () {
      // SHA-256("abc") starts ba7816bf.
      expect(yield* assignId("xai", "abc")).toBe(AccountId.make("xai-ba7816bf"))
    }).pipe(Effect.provide(Digest.layerWebCrypto)),
  )
})
