import { describe, expect } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect, Schema } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"

import { Account, AccountSchema, forget, pin, Store, Tokens, unpinAll } from "../src/account.ts"
import { Home, PROVIDERS } from "../src/index.ts"
import { tempDir } from "../src/testkit.ts"

const now = Timestamp.fromSecond(1_700_000_000) ?? 0

const claude = (org: string, email: string): Account =>
  Account.assignId({ ...Account.make("claude", Tokens.empty(), now), orgId: org, email })

const tempStore = (name: string): Store => Store.at(join(tempDir(name), "accounts"))

describe("account", () => {
  it("ids_hash_the_identity_as_before", () => {
    expect(PROVIDERS.length).toBe(6)
    // Ids name the account files, so they must never change.
    expect(claude("org-1", "me@x.dev").id).toBe("claude-c24787a7")
    const codex = Account.assignId({ ...Account.make("codex", Tokens.empty(), now), accountId: "ws-9" })
    expect(codex.id).toBe("codex-372c403d")
  })

  it("same_email_in_two_orgs_are_distinct_accounts", () => {
    const a = claude("org-a", "me@x.dev")
    const b = claude("org-b", "me@x.dev")
    expect(a.id).not.toBe(b.id)
    expect(a.id.startsWith("claude-") && a.id.length === "claude-".length + 8).toBe(true)
  })

  it.live("upsert_merges_settings_on_relogin", () =>
    Effect.gen(function* () {
      const store = tempStore("upsert")
      const [first, created] = yield* store.upsert({ ...claude("org-a", "me@x.dev"), label: "work", priority: 5 })
      expect(created).toBe(true)

      const again = claude("org-a", "me@x.dev")
      const [merged, createdAgain] = yield* store.upsert({ ...again, tokens: { ...again.tokens, accessToken: "new" } })
      expect(createdAgain).toBe(false)
      expect(merged.id).toBe(first.id)
      expect(merged.label).toBe("work")
      expect(merged.priority).toBe(5)
      expect((yield* store.get(first.id))?.tokens.accessToken).toBe("new")
      rmSync(join(store.dir, ".."), { recursive: true })
    }),
  )

  it.live("find_resolves_ids_labels_emails_and_positions", () =>
    Effect.gen(function* () {
      const store = tempStore("find")
      const [work] = yield* store.upsert({ ...claude("org-a", "me@x.dev"), label: "work" })
      const [home] = yield* store.upsert(claude("org-b", "home@x.dev"))

      expect((yield* store.find("work")).id).toBe(work.id)
      expect((yield* store.find("home@x.dev")).id).toBe(home.id)
      expect((yield* store.find(work.id.slice(0, 10))).id).toBe(work.id)
      yield* store.find("1")
      // A prefix shared by both is ambiguous.
      const ambiguous = yield* Effect.flip(store.find("claude-"))
      expect(ambiguous.message).toBe(`"claude-" is ambiguous: ${(yield* store.list()).map((a) => a.id).join(", ")}`)
      const none = yield* Effect.flip(store.find("nope"))
      expect(none.message).toBe('no account matches "nope" (see `slopmax status`)')
      rmSync(join(store.dir, ".."), { recursive: true })
    }),
  )

  it("expiry_checks_respect_lead", () => {
    const at = Timestamp.fromSecond(10_000) ?? 0
    const tokens: Tokens = { accessToken: "", expiresAt: Timestamp.fromSecond(10_000 + 1800) ?? 0 }
    expect(Tokens.expiresWithin(tokens, SignedDuration.fromHours(1), at)).toBe(true)
    expect(Tokens.isExpired(tokens, at)).toBe(false)
    // Unknown expiry is not expired.
    expect(Tokens.isExpired(Tokens.empty(), at)).toBe(false)
  })
})

describe("account, beyond the Rust tests", () => {
  it("account files keep the Rust's shape", () => {
    const account: Account = {
      ...claude("org", "me@x.dev"),
      tokens: { accessToken: "a", refreshToken: "r", expiresAt: now },
      endpoint: { baseUrl: "http://x/v1", dialect: "chat", models: [] },
    }
    expect(JSON.stringify(Schema.encodeSync(AccountSchema)(account), null, 2)).toBe(`{
  "id": "${account.id}",
  "provider": "claude",
  "email": "me@x.dev",
  "org_id": "org",
  "disabled": false,
  "priority": 0,
  "tokens": {
    "access_token": "a",
    "refresh_token": "r",
    "expires_at": "2023-11-14T22:13:20Z"
  },
  "endpoint": {
    "base_url": "http://x/v1",
    "dialect": "chat"
  },
  "added_at": "2023-11-14T22:13:20Z"
}`)
    // Unknown fields and nulls are tolerated; missing settings take their defaults.
    const read = Schema.decodeUnknownSync(AccountSchema)({
      id: "x",
      provider: "openai",
      label: null,
      future: 1,
      tokens: { access_token: "sk-abcdef" },
      added_at: "2026-01-01T00:00:00Z",
    })
    expect(read.disabled).toBe(false)
    expect(read.priority).toBe(0)
    expect(read.label).toBeUndefined()
    expect(Account.name(read)).toBe("OpenAI API key …cdef")
  })

  it("names come from the label, the endpoint, the key, or the email", () => {
    const base = claude("org", "me@x.dev")
    expect(Account.name({ ...base, label: "work" })).toBe("work")
    expect(Account.name({ ...base, orgName: "Acme" })).toBe("me@x.dev (Acme)")
    expect(Account.name({ ...base, orgName: "me@x.dev's Organization" })).toBe("me@x.dev")
    const { email: _, ...noEmail } = base
    expect(Account.name(noEmail)).toBe(base.id)
    const compat = Account.make("compat", { accessToken: "k" }, now)
    expect(
      Account.name({ ...compat, endpoint: { baseUrl: "http://gpu.local:8000/v1", dialect: "chat", models: [] } }),
    ).toBe("gpu.local:8000")
    // A key whose last bytes split a character shows no tail.
    expect(Account.name(Account.make("xai", { accessToken: "é€" }, now))).toBe("xAI API key …")
    const old = { ...base, label: "old", disabled: true, priority: 3, addedAt: 5 }
    expect(Account.inheritSettings(base, old)).toEqual({
      ...base,
      label: "old",
      disabled: true,
      priority: 3,
      addedAt: 5,
    })
    expect(Account.inheritSettings({ ...base, label: "new" }, old).label).toBe("new")
  })

  it.live("the store lists in order, skips bad files, and keeps pins in step", () =>
    Effect.gen(function* () {
      const dir = tempDir("store")
      const store = Store.at(join(dir, "accounts"))
      expect(yield* store.list()).toEqual([])
      const [a] = yield* store.upsert({ ...Account.make("codex", { accessToken: "x" }, 3), accountId: "w1" })
      const [b] = yield* store.upsert({ ...claude("o1", "b@x"), addedAt: 2 })
      const [c] = yield* store.upsert({ ...claude("o2", "c@x"), addedAt: 1, priority: -1 })
      const [d] = yield* store.upsert({ ...claude("o3", "d@x"), addedAt: 9, priority: 4 })
      writeFileSync(join(store.dir, "broken.json"), "{")
      writeFileSync(join(store.dir, "notes.txt"), "x")
      expect((yield* store.list()).map((x) => x.id)).toEqual([d.id, b.id, c.id, a.id])

      const home = Home.at(dir)
      yield* pin(home, b)
      yield* pin(home, a)
      expect(readFileSync(home.pins(), "utf8")).toBe(`{\n  "claude": "${b.id}",\n  "codex": "${a.id}"\n}\n`)
      yield* forget(store, home, b)
      expect(readFileSync(home.pins(), "utf8")).toBe(`{\n  "codex": "${a.id}"\n}\n`)
      expect(yield* store.get(b.id)).toBeUndefined()
      const gone = yield* Effect.flip(store.remove(b.id))
      expect(gone.message).toBe(`removing account ${b.id}`)
      const updated = yield* store.update(c.id, (x) => ({ ...x, disabled: true }))
      expect((yield* store.get(c.id))?.disabled).toBe(updated.disabled)
      const missing = yield* Effect.flip(store.update("claude-00000000", (x) => x))
      expect(missing.message).toBe("account claude-00000000 no longer exists")
      yield* unpinAll(home)
      expect(readFileSync(home.pins(), "utf8")).toBe("{}\n")
      rmSync(dir, { recursive: true })
    }),
  )
})
