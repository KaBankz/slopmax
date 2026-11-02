// The Rust daemon's answers, as `crates/slopmax-core/tests/contract.rs`
// records them in `contract/fixtures/`, decoded strictly with this
// package's schemas: a key the schema does not know fails, as one it needs
// and is missing does. So the Rust daemon and every client built on this
// package (the web UI, the desktop window) agree on every field.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { ApiErrors, Event, History, KeyInfo, NewKey, Report, SettingsView, Summary } from "../src/index.ts"
import { strict } from "../src/settings.ts"

const dir = join(import.meta.dir, "../../../../contract/fixtures")

/** Each endpoint's success, by `group.endpoint`. */
const successes: Readonly<Record<string, Schema.Top>> = {
  "system.status": Report,
  "system.sync": Report,
  "accounts.update": Report,
  "accounts.pin": Report,
  "accounts.unpinAll": Report,
  "accounts.own": Report,
  "accounts.remove": Report,
  "config.settings": SettingsView,
  "config.change": SettingsView,
  "config.keys": Schema.Array(KeyInfo),
  "config.makeKey": NewKey,
  "config.removeKey": Schema.Array(KeyInfo),
  "usage.summary": Summary,
  "usage.history": History,
  "events.watch": Schema.Array(Event),
}

const decode = (schema: Schema.Top, body: unknown) => Schema.decodeUnknownSync(schema as never, strict)(body)

const fixtures = readdirSync(dir).filter((name) => name.endsWith(".json"))

describe("the Rust daemon's answers", () => {
  test("are all here", () => {
    expect(fixtures.length).toBeGreaterThan(20)
  })

  for (const name of fixtures) {
    const [group, endpoint, outcome] = name.replace(/\.json$/, "").split(".")
    const { status, body } = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status: number; body: unknown }
    test(`${group}.${endpoint} ${outcome} decodes strictly`, () => {
      if (outcome === "ok") {
        const schema = successes[`${group}.${endpoint}`]
        expect(schema).toBeDefined()
        decode(schema!, body)
        return
      }
      const error = decode(Schema.Union(ApiErrors), body) as { readonly _tag: string }
      expect(error._tag.toLowerCase()).toBe(outcome!.toLowerCase())
      expect(status).toBeGreaterThanOrEqual(400)
    })
  }
})
