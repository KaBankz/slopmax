// The Rust daemon's answers, as `crates/slopmax-core/tests/contract.rs`
// records them in `contract/fixtures/`, decoded strictly with this
// package's schemas: a key the schema does not know fails, as one it needs
// and is missing does. So the Rust daemon and every client built on this
// package (the web UI, the desktop window) agree on every field.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ApiErrors, Event, History, KeyInfo, NewKey, Report, SettingsView, Summary } from "../src/index.ts"
import { strict } from "../src/settings.ts"

const dir = `${import.meta.dir}/../../../../contract/fixtures`

/** Each endpoint's success, by `group.endpoint`. */
const successes: Readonly<Record<string, Schema.Decoder<unknown>>> = {
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

/** A fixture: the status the daemon answered with, and its body. */
const Fixture = Schema.Struct({ status: Schema.Number, body: Schema.Unknown })

const fixtures = [...new Bun.Glob("*.json").scanSync(dir)].toSorted()

describe("the Rust daemon's answers", () => {
  test("are all here", () => {
    expect(fixtures.length).toBeGreaterThan(20)
  })

  for (const name of fixtures) {
    const [group, endpoint, outcome = ""] = name.replace(/\.json$/, "").split(".")
    test(`${group}.${endpoint} ${outcome} decodes strictly`, async () => {
      const { status, body } = Schema.decodeUnknownSync(Fixture)(await Bun.file(`${dir}/${name}`).json())
      if (outcome === "ok") {
        const schema = successes[`${group}.${endpoint}`]
        if (schema === undefined) throw new Error(`no schema for ${group}.${endpoint}`)
        Schema.decodeUnknownSync(schema, strict)(body)
        return
      }
      const error = Schema.decodeUnknownSync(Schema.Union(ApiErrors), strict)(body)
      expect(error._tag.toLowerCase()).toBe(outcome.toLowerCase())
      expect(status).toBeGreaterThanOrEqual(400)
    })
  }
})
