// The TOML editor against what toml_edit 0.25.15 prints for the same edits
// (fixtures/toml-golden.rs writes fixtures/toml-golden.jsonl).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Result } from "effect"

import { ArrayOfTables, Datetime, Document, type Item, Table, Value } from "../src/toml.ts"

const golden = new Map<string, string>(
  readFileSync(join(import.meta.dir, "fixtures/toml-golden.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const { case: name, out } = JSON.parse(line) as { case: string; out: string }
      return [name, out]
    }),
)

const parse = (text: string): Document => {
  const doc = Document.parse(text)
  if (Result.isFailure(doc)) throw new Error(doc.failure.message)
  return doc.success
}

const want = (name: string): string => {
  const out = golden.get(name)
  if (out === undefined) throw new Error(`no golden case ${name}`)
  return out
}

const keysOf = (doc: Document): ArrayOfTables => {
  let keys = doc.get("keys")
  if (keys === undefined) {
    keys = new ArrayOfTables()
    doc.set("keys", keys)
  }
  if (!(keys instanceof ArrayOfTables)) throw new Error("keys is not an array of tables")
  return keys
}

const table = (pairs: ReadonlyArray<readonly [string, Item]>): Table => {
  const t = Table.make()
  for (const [k, v] of pairs) t.set(k, v)
  return t
}

const nameOf = (t: Table): string | undefined => {
  const name = t.get("name")
  return name instanceof Value ? name.asStr() : undefined
}

const providersOf = (doc: Document): Table => {
  let providers = doc.get("model_providers")
  if (providers === undefined) {
    providers = Table.make()
    providers.implicit = true
    doc.set("model_providers", providers)
  }
  if (!(providers instanceof Table)) throw new Error("model_providers is not a table")
  return providers
}

describe("toml", () => {
  it("prints unchanged documents as they were read", () => {
    for (const text of [
      "",
      "# only a comment",
      "a = 1\r\n",
      "  a  =  1   # one\n[ t . u ]  # hdr\n  b = 2\n\n\n# end",
      'x = [\n  1, # one\n  2,\n]\ny = """\nz\n[not]\n"""\n[[a.b]]\nc = { d = 1, e = [ 2 ] }\n',
    ]) {
      const expected = text.endsWith("a = 1\r\n") ? "a = 1\n" : text
      expect(parse(text).toString()).toBe(expected)
    }
  })

  it("adds root keys where toml_edit does", () => {
    for (const [name, text] of [
      ["append_root_key", '# my setup\nstrategy = "fill-first" # drain in order\n'],
      ["root_key_before_tables", '# head\n\n[aliases]\nfast = "x"\n\n# end\n'],
      ["no_final_newline", 'strategy = "x"'],
    ] as const) {
      const doc = parse(text)
      doc.set("api_key", Value.of("sm-KEY"))
      expect(doc.toString()).toBe(want(name))
    }
    const crlf = parse("a = 1\r\n# c\r\nb = 2\r\n")
    crlf.set("c", Value.of(3n))
    expect(crlf.toString()).toBe(want("crlf"))
    const replaced = parse('api_key = ""  # fill me\nx = 1\n')
    replaced.set("api_key", Value.of("sm-KEY"))
    expect(replaced.toString()).toBe(want("replace_drops_decor"))
  })

  it("sets values keeping the old decor", () => {
    const doc = parse('# top\nstrategy = "fill-first"   # mine\npoll_mins = 5\n\n[notify]\ncommand = "x"\n')
    for (const [key, data] of [
      ["strategy", "round-robin"],
      ["poll_mins", 0n],
      ["warm_windows", true],
    ] as const) {
      const value = Value.of(data)
      const old = doc.get(key)
      if (old instanceof Value) value.decor = { ...old.decor }
      doc.set(key, value)
    }
    expect(doc.toString()).toBe(want("set_keeps_decor"))
    const empty = Document.empty()
    empty.set("strategy", Value.of("fill-first"))
    expect(empty.toString()).toBe(want("set_on_empty"))
  })

  it("appends and removes arrays of tables", () => {
    const doc = parse('# head\napi_key = "k"\n\n# Address.\n# listen = "x"\n')
    keysOf(doc).push(
      table([
        ["name", Value.of("laptop")],
        ["key", Value.of("sm-1")],
        ["models", Value.of(["gpt-*", "claude-*"])],
      ]),
    )
    expect(doc.toString()).toBe(want("add_key_first"))
    const second = parse(doc.toString())
    keysOf(second).push(
      table([
        ["name", Value.of("ci")],
        ["key", Value.of("sm-2")],
      ]),
    )
    expect(second.toString()).toBe(want("add_key_second"))
    const one = parse(second.toString())
    keysOf(one).retain((t) => nameOf(t) !== "laptop")
    expect(one.toString()).toBe(want("remove_key_one"))
    const last = parse(one.toString())
    const keys = keysOf(last)
    keys.retain((t) => nameOf(t) !== "ci")
    if (keys.length === 0) last.remove("keys")
    expect(last.toString()).toBe(want("remove_key_last"))

    for (const [name, text] of [
      ["add_key_after_tables", 'api_key = "k"\n\n[aliases]\nfast = "m"\n\n# tail\n'],
      ["add_key_table_only", '[aliases]\nfast = "m"\n'],
      ["add_key_empty_doc", ""],
    ] as const) {
      const d = parse(text)
      keysOf(d).push(table([["name", Value.of("x")]]))
      expect(d.toString()).toBe(want(name))
    }

    const aot = parse('[[keys]]\nname = "a"\n\n# about b\n[[keys]]\nname = "b"\n\n[notify]\nevents = []\n')
    keysOf(aot).retain((t) => nameOf(t) !== "a")
    expect(aot.toString()).toBe(want("aot_remove_first"))
  })

  it("adds and replaces nested tables as Codex's setup does", () => {
    const codex = 'model = "gpt"\n\n[model_providers.other]\nname = "x"\n\n[profiles.p]\nmodel = "y"\n'
    const doc = parse(codex)
    doc.set("model_provider", Value.of("slopmax"))
    providersOf(doc).set(
      "slopmax",
      table([
        ["name", Value.of("OpenAI")],
        ["base_url", Value.of("http://127.0.0.1:7567/codex")],
        ["supports_websockets", Value.of(true)],
      ]),
    )
    const setup = doc.toString()
    expect(setup).toBe(want("codex_setup_existing"))
    const undo = parse(setup)
    undo.remove("model_provider")
    providersOf(undo).remove("slopmax")
    expect(undo.toString()).toBe(want("codex_undo"))
    const again = parse(setup)
    providersOf(again).set("slopmax", table([["name", Value.of("OpenAI")]]))
    expect(again.toString()).toBe(want("codex_setup_again"))
    const fresh = parse("# just a comment\n")
    fresh.set("model_provider", Value.of("slopmax"))
    providersOf(fresh).set("slopmax", table([["name", Value.of("OpenAI")]]))
    expect(fresh.toString()).toBe(want("codex_setup_fresh"))
  })

  it("writes new strings, keys, and floats as toml_edit does", () => {
    const doc = Document.empty()
    const strings = [
      "plain",
      "back\\slash",
      'q"uote',
      "it's",
      "it's \\ both",
      "line\nbreak",
      "tab\there",
      "ctl\u0001x",
      "trail'",
      "a'''b\\",
      "üñí",
      "del\u007f",
      "new\nline\\",
    ]
    strings.forEach((s, i) => doc.set(`s${i}`, Value.of(s)))
    ;["my model", "a.b", "", "k'ey", "ba\\ck"].forEach((k, i) => doc.set(k, Value.of(BigInt(i))))
    ;[1.0, 0.5, 1e20, -0.0, 2.5e-7, 100.0].forEach((f, i) => doc.set(`f${i}`, Value.of(f)))
    expect(doc.toString()).toBe(want("reprs"))
    // And they read back as written.
    const data = parse(doc.toString()).data
    strings.forEach((s, i) => expect(data[`s${i}`]).toBe(s))
    expect(data["ba\\ck"]).toBe(4n)
  })

  it("keeps odd spacing, implicit parents, and multi-line values", () => {
    const implicit = parse('[prices."my-model"]\ninput = 2.0\noutput = 8\n')
    implicit.set("api_key", Value.of("k"))
    expect(implicit.toString()).toBe(want("implicit_parent"))
    const odd = parse("  a  =  1   # one\n[ t . u ]  # hdr\n  b = 2\n")
    odd.set("z", Value.of(1n))
    expect(odd.toString()).toBe(want("odd_spacing"))
    const multi = parse('a = [\n  1, # one\n  2,\n]\nb = """\nx\n[not]\n"""\n')
    multi.set("c", Value.of(true))
    expect(multi.toString()).toBe(want("multiline_values"))
  })

  it("reads TOML as data", () => {
    const data = parse(
      [
        'a = "x\\u00e9\\n"',
        "b = 'lit\\'",
        "c = 1_000",
        "d = 0x1F",
        "e = -2.5e3",
        "f = inf",
        "g = 1979-05-27T07:32:00Z",
        "h = [1, [2, 3], { i = true }]",
        "j.k = 1",
        'l = "\\e\\x41"',
        "m = {\n  n = 1, # TOML 1.1\n  o = 2,\n}",
        "[t]",
        "x = 1",
        "[t.u]",
        "y = 2",
        "[[arr]]",
        "n = 1",
        "[[arr]]",
        "n = 2",
        '"quoted key" = """',
        "one\\",
        '   two"""',
      ].join("\n"),
    ).data
    expect(data.a).toBe("xé\n")
    expect(data.b).toBe("lit\\")
    expect(data.c).toBe(1000n)
    expect(data.d).toBe(31n)
    expect(data.e).toBe(-2500)
    expect(data.f).toBe(Number.POSITIVE_INFINITY)
    expect(data.g).toEqual(new Datetime("1979-05-27T07:32:00Z"))
    expect(data.h).toEqual([1n, [2n, 3n], { i: true }])
    expect(data.j).toEqual({ k: 1n })
    expect(data.l).toBe("\u001bA")
    expect(data.m).toEqual({ n: 1n, o: 2n })
    expect(data.t).toEqual({ x: 1n, u: { y: 2n } })
    expect(data.arr).toEqual([{ n: 1n }, { n: 2n, "quoted key": "onetwo" }])
  })

  it("refuses what is not TOML", () => {
    for (const text of [
      "a = ",
      "a = 1\na = 2",
      "[t]\n[t]",
      "a = 1 b = 2",
      'a = "open',
      "a = 01",
      "a = 1__0",
      "[t]\nx = 1\n[t.x]",
      "a = { b = 1 }\n[a]",
      "= 1",
      // As toml_edit: past an f64, and a table dotted keys made opened again.
      "x = 1e+400",
      "x = -1e400",
      'aliases.a = "b"\n[aliases]\nc = "d"',
      "[fruit]\napple.color = 1\n[fruit.apple]",
      "[fruit]\napple.taste.sweet = true\n[fruit.apple.taste]",
    ]) {
      expect([text, Result.isFailure(Document.parse(text))]).toEqual([text, true])
    }
  })

  it("reads past a byte order mark, and sub-tables of dotted tables, as toml_edit does", () => {
    const doc = Document.parse('\uFEFFapi_key = "k"\n')
    if (Result.isFailure(doc)) throw doc.failure
    expect(doc.success.data.api_key).toBe("k")
    expect(doc.success.toString()).toBe('api_key = "k"\n')
    const fruit = Document.parse("[fruit]\napple.color = 1\n[fruit.apple.texture]\nsmooth = true\n")
    if (Result.isFailure(fruit)) throw fruit.failure
    expect(fruit.success.data.fruit).toEqual({ apple: { color: 1n, texture: { smooth: true } } })
    const big = Document.parse("x = 1.7976931348623157e308\n")
    if (Result.isFailure(big)) throw big.failure
    expect(big.success.data.x).toBe(Number.MAX_VALUE)
  })
})
