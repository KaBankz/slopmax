// A format-preserving TOML document: what slopmax needs of the Rust's
// `toml_edit` to change `config.toml` (and Codex's) without disturbing the
// person's comments and layout.
//
// A document parses into the same tree `toml_edit` builds: tables holding
// key-values and sub-tables in order, each item with its decor (the
// whitespace and comments around it) and its text as written. Unchanged
// items print exactly as they were read. New ones print as `toml_edit`
// prints them: a new key after the last key of its table, a new table after
// the table visited before it (so new top-level tables come after every
// existing one, before the comments that end the file), a blank line before
// a new table header, strings in basic quotes unless a literal string avoids
// escapes. Every document also reads as plain data (`Document.data`), with
// integers as `bigint` so they stay apart from floats, as TOML keeps them.
import { Data, Result, Schema, SchemaGetter } from "effect"

import { fmt } from "@slopmax/common"

/** A TOML date, time, or date-time, kept as written. */
export class Datetime {
  constructor(readonly raw: string) {}
}

/** A TOML value as data: integers are `bigint`, floats `number`. */
export type TomlData = string | bigint | number | boolean | Datetime | Array<TomlData> | TomlTable

export interface TomlTable {
  [key: string]: TomlData
}

/** An `f64` read from TOML: a float, or an integer taken as one (as serde does). */
export const F64: Schema.Codec<number, number | bigint> = Schema.Union([Schema.Number, Schema.BigInt]).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((v: number | bigint) => Number(v)),
    encode: SchemaGetter.transform((v: number): number | bigint => v),
  }),
)

/** A `u64` read from TOML: an integer, not negative (a float is refused, as serde refuses it). */
export const U64: Schema.Codec<number, bigint> = Schema.BigInt.check(
  Schema.makeFilter((n: bigint) => n >= 0n && n <= 2n ** 64n - 1n, { expected: "a non-negative integer" }),
).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((v: bigint) => Number(v)),
    encode: SchemaGetter.transform((v: number) => BigInt(Math.trunc(v))),
  }),
)

/** The text is not TOML. */
export class TomlError extends Data.TaggedError("TomlError")<{ readonly message: string }> {}

/** Whitespace and comments before and after an item; undefined takes the default. */
export interface Decor {
  prefix: string | undefined
  suffix: string | undefined
}

const noDecor = (): Decor => ({ prefix: undefined, suffix: undefined })

/** A key as written, with its decor. */
export interface Key {
  /** The key's text, or the whole dotted path's for a dotted key. */
  readonly repr: string
  readonly decor: Decor
}

/** A value: its data, how it is written, and its decor. */
export class Value {
  readonly _tag = "Value"
  constructor(
    readonly data: TomlData,
    readonly repr: string,
    public decor: Decor,
  ) {}

  /** A new value, written as `toml_edit` writes it. */
  static of(data: TomlData): Value {
    return new Value(data, encodeValue(data), noDecor())
  }

  asStr(): string | undefined {
    return typeof this.data === "string" ? this.data : undefined
  }

  asBool(): boolean | undefined {
    return typeof this.data === "boolean" ? this.data : undefined
  }

  asInteger(): bigint | undefined {
    return typeof this.data === "bigint" ? this.data : undefined
  }
}

/** A list of `[[name]]` tables. */
export class ArrayOfTables {
  readonly _tag = "ArrayOfTables"
  constructor(readonly tables: Array<Table> = []) {}

  get length(): number {
    return this.tables.length
  }

  push(table: Table): void {
    this.tables.push(table)
  }

  /** Keeps the tables `keep` says yes to. */
  retain(keep: (table: Table) => boolean): void {
    const kept = this.tables.filter(keep)
    this.tables.length = 0
    this.tables.push(...kept)
  }
}

export type Item = Value | Table | ArrayOfTables

interface Entry {
  readonly key: Key
  /** The decoded key path: one name, or a dotted key's parts. */
  readonly path: ReadonlyArray<string>
  item: Item
}

/** A table: key-values and sub-tables, in order. */
export class Table {
  readonly _tag = "Table"
  /** Map keys: the name, or for a dotted key-value its parts joined by NUL. */
  readonly entries = new Map<string, Entry>()
  /** The header's place in the file; undefined for a table not read from one. */
  position: number | undefined = undefined
  /** No header of its own: it only holds other tables. */
  implicit = false
  decor: Decor = noDecor()
  /** The header's key path as written, between the brackets. */
  headerRepr: string | undefined = undefined

  /** An empty new table. */
  static make(): Table {
    return new Table()
  }

  get(name: string): Item | undefined {
    return this.entries.get(name)?.item
  }

  /**
   * Sets `name`: a new key goes last; an existing one keeps its place and key.
   * toml_edit holds dotted keys (`a.b = 1`) as a table `a` where the first
   * of them is, so a new table `a` goes there, which decides where the
   * tables it holds are written.
   */
  set(name: string, item: Item): void {
    const entry = this.entries.get(name)
    if (entry !== undefined) {
      entry.item = item
      return
    }
    const added: Entry = { key: { repr: keyRepr(name), decor: noDecor() }, path: [name], item }
    const all = item instanceof Table ? [...this.entries] : []
    const at = all.findIndex(([, e]) => e.path.length > 1 && e.path[0] === name)
    if (at < 0) {
      this.entries.set(name, added)
      return
    }
    const after = all.slice(at)
    for (const [k] of after) this.entries.delete(k)
    this.entries.set(name, added)
    for (const [k, e] of after) this.entries.set(k, e)
  }

  remove(name: string): Item | undefined {
    const entry = this.entries.get(name)
    this.entries.delete(name)
    return entry?.item
  }

  /** The key-values, in order. */
  values(): Array<Entry & { readonly item: Value }> {
    const values: Array<Entry & { readonly item: Value }> = []
    for (const entry of this.entries.values()) {
      if (entry.item instanceof Value) values.push({ key: entry.key, path: entry.path, item: entry.item })
    }
    return values
  }
}

/** A whole TOML file. */
export class Document {
  private constructor(
    readonly root: Table,
    /** What follows the last item: comments and blank lines. */
    public trailing: string,
    /** The file read as data, as it was parsed. */
    readonly data: TomlTable,
  ) {}

  static empty(): Document {
    const root = Table.make()
    root.position = 0
    return new Document(root, "", {})
  }

  static parse(text: string): Result.Result<Document, TomlError> {
    try {
      // A byte order mark is read past, and not written back.
      const parsed = new Parser(text.startsWith("\uFEFF") ? text.slice(1) : text).document()
      return Result.succeed(new Document(parsed.root, parsed.trailing, parsed.data))
    } catch (error) {
      if (error instanceof TomlError) return Result.fail(error)
      throw error
    }
  }

  get(name: string): Item | undefined {
    return this.root.get(name)
  }

  set(name: string, item: Item): void {
    this.root.set(name, item)
  }

  remove(name: string): Item | undefined {
    return this.root.remove(name)
  }

  toString(): string {
    return render(this)
  }
}

// ---- printing ---------------------------------------------------------------

const renderKv = (entry: Entry & { readonly item: Value }): string =>
  `${entry.key.decor.prefix ?? ""}${entry.key.repr}${entry.key.decor.suffix ?? " "}=` +
  `${entry.item.decor.prefix ?? " "}${entry.item.repr}${entry.item.decor.suffix ?? ""}\n`

const render = (doc: Document): string => {
  const tables: Array<{
    readonly position: number
    readonly table: Table
    readonly path: string
    readonly array: boolean
  }> = []
  let last = 0
  const visit = (table: Table, path: ReadonlyArray<string>, array: boolean): void => {
    if (table.position !== undefined) last = table.position
    tables.push({ position: last, table, path: table.headerRepr ?? path.join("."), array })
    for (const [, entry] of table.entries) {
      const name = keyReprOf(entry)
      if (entry.item instanceof Table) visit(entry.item, [...path, name], false)
      else if (entry.item instanceof ArrayOfTables) for (const t of entry.item.tables) visit(t, [...path, name], true)
    }
  }
  visit(doc.root, [], false)
  tables.sort((a, b) => a.position - b.position)

  let out = ""
  let first = true
  for (const { table, path, array } of tables) {
    const children = table.values()
    if (table === doc.root) {
      if (children.length > 0) first = false
    } else if (array || !(table.implicit && children.length === 0)) {
      const defaultPrefix = first ? "" : "\n"
      first = false
      const [open, close] = array ? ["[[", "]]"] : ["[", "]"]
      out += `${table.decor.prefix ?? defaultPrefix}${open}${path}${close}${table.decor.suffix ?? ""}\n`
    }
    for (const kv of children) out += renderKv(kv)
  }
  // toml_edit writes line ends as `\n`, whatever the file used.
  return (out + doc.trailing).replaceAll("\r\n", "\n")
}

const keyReprOf = (entry: Entry): string => (entry.path.length === 1 ? entry.key.repr.trim() : entry.key.repr)

// ---- writing new values -------------------------------------------------------

const BARE = /^[A-Za-z0-9_-]+$/

// What a string holds that decides how it can be written (toml_writer's metrics).
interface Metrics {
  maxSingles: number
  maxDoubles: number
  escapeCodes: boolean
  escape: boolean
  newline: boolean
  singles: boolean
  doubles: boolean
}

const metrics = (value: string): Metrics => {
  const m: Metrics = {
    maxSingles: 0,
    maxDoubles: 0,
    escapeCodes: false,
    escape: false,
    newline: false,
    singles: false,
    doubles: false,
  }
  let singles = 0
  let doubles = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    singles = c === 0x27 ? singles + 1 : 0
    doubles = c === 0x22 ? doubles + 1 : 0
    m.maxSingles = Math.max(m.maxSingles, singles)
    m.maxDoubles = Math.max(m.maxDoubles, doubles)
    if (c === 0x27) m.singles = true
    else if (c === 0x22) m.doubles = true
    else if (c === 0x5c) m.escape = true
    else if (c === 0x0a) m.newline = true
    else if (c !== 0x09 && (c <= 0x1f || c === 0x7f)) m.escapeCodes = true
  }
  return m
}

// A basic string's content, escaped; in a multi-line one, newlines and up
// to two quotes in a row stay as they are.
const escapeBasic = (value: string, multiline: boolean): string => {
  let out = ""
  let doubles = 0
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0x22) {
      doubles++
      if (doubles > (multiline ? 2 : 0)) {
        out += '\\"'
        doubles = 0
        continue
      }
      out += ch
      continue
    }
    doubles = 0
    if (c === 0x08) out += "\\b"
    else if (c === 0x09) out += "\\t"
    else if (c === 0x0a) out += multiline ? "\n" : "\\n"
    else if (c === 0x0c) out += "\\f"
    else if (c === 0x0d) out += "\\r"
    else if (c === 0x5c) out += "\\\\"
    else if (c <= 0x1f || c === 0x7f) out += `\\u${c.toString(16).toUpperCase().padStart(4, "0")}`
    else out += ch
  }
  return out
}

/** A key as `toml_edit` writes a new one: bare when it can be, else quoted. */
export const keyRepr = (name: string): string => {
  if (BARE.test(name)) return name
  const m = metrics(name)
  if (!m.escapeCodes && !m.escape && !m.doubles) return `"${escapeBasic(name, false)}"`
  if (!m.escapeCodes && !m.singles) return `'${name}'`
  return `"${escapeBasic(name, false)}"`
}

/**
 * A string as `toml_edit` writes a new one: a basic string when nothing
 * needs escaping, else a literal one, else the multi-line forms, and
 * escapes only when nothing else will do.
 */
export const stringRepr = (value: string): string => {
  const m = metrics(value)
  const lead = m.newline ? "\n" : ""
  if (!m.escapeCodes && !m.escape && m.maxDoubles === 0 && !m.newline) return `"${escapeBasic(value, false)}"`
  if (!m.escapeCodes && m.maxSingles === 0 && !m.newline) return `'${value}'`
  if (!m.escapeCodes && !m.escape && m.maxDoubles <= 2) return `"""${lead}${escapeBasic(value, true)}"""`
  if (!m.escapeCodes && m.maxSingles <= 2) return `'''${lead}${value}'''`
  return m.newline ? `"""${lead}${escapeBasic(value, true)}"""` : `"${escapeBasic(value, false)}"`
}

const floatRepr = (f: number): string => {
  // JavaScript cannot tell a NaN's sign, so a new NaN is written unsigned.
  if (f !== f) return "nan"
  if (f === 0) return Object.is(f, -0) ? "-0.0" : "0.0"
  if (!Number.isFinite(f)) return f < 0 ? "-inf" : "inf"
  const text = fmt.display(f)
  return f % 1 === 0 ? `${text}.0` : text
}

const encodeValue = (data: TomlData): string => {
  if (typeof data === "string") return stringRepr(data)
  if (typeof data === "bigint") return data.toString()
  if (typeof data === "number") return floatRepr(data)
  if (typeof data === "boolean") return String(data)
  if (data instanceof Datetime) return data.raw
  if (Array.isArray(data)) return `[${data.map((v, i) => (i === 0 ? "" : " ") + encodeValue(v)).join(",")}]`
  const pairs = Object.entries(data).map(([k, v]) => ` ${keyRepr(k)} = ${encodeValue(v)}`)
  return pairs.length === 0 ? "{}" : `{${pairs.join(",")} }`
}

// ---- reading ------------------------------------------------------------------

const isWs = (c: string | undefined): boolean => c === " " || c === "\t"
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9"
const isBareChar = (c: string | undefined): boolean =>
  c !== undefined &&
  ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_" || c === "-")

// Tables read from `[headers]`, and arrays made by `[[headers]]`, apart
// from those made implicitly or by values.
interface Defined {
  readonly explicit: WeakSet<TomlTable>
  readonly arrays: WeakSet<Array<TomlData>>
  readonly inline: WeakSet<TomlTable | Array<TomlData>>
  /** Tables made by dotted keys, which no header may open again. */
  readonly dotted: WeakSet<TomlTable>
}

class Parser {
  private pos = 0
  private position = 0
  private readonly defined: Defined = {
    explicit: new WeakSet(),
    arrays: new WeakSet(),
    inline: new WeakSet(),
    dotted: new WeakSet(),
  }

  constructor(private readonly text: string) {}

  private fail(what: string, at = this.pos): never {
    const before = this.text.slice(0, at)
    const line = before.split("\n").length
    const column = at - before.lastIndexOf("\n")
    throw new TomlError({ message: `TOML parse error at line ${line}, column ${column}: ${what}` })
  }

  private peek(offset = 0): string | undefined {
    return this.text[this.pos + offset]
  }

  private startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos)
  }

  private skipWs(): void {
    while (isWs(this.peek())) this.pos++
  }

  // A comment through the end of its line (not the newline).
  private skipComment(): void {
    if (this.peek() !== "#") return
    while (this.pos < this.text.length && this.peek() !== "\n" && !this.startsWith("\r\n")) {
      const c = this.text.charCodeAt(this.pos)
      if ((c < 0x20 && c !== 0x09) || c === 0x7f) this.fail("invalid comment character")
      this.pos++
    }
  }

  private newline(): boolean {
    if (this.peek() === "\n") {
      this.pos++
      return true
    }
    if (this.startsWith("\r\n")) {
      this.pos += 2
      return true
    }
    return false
  }

  // Blank and comment lines, through the indentation of the next item.
  private decorBefore(): string {
    const start = this.pos
    for (;;) {
      const lineStart = this.pos
      this.skipWs()
      this.skipComment()
      if (this.newline()) continue
      if (this.pos >= this.text.length) return this.text.slice(start)
      // Something on this line: keep its indentation in the decor.
      this.pos = lineStart
      this.skipWs()
      return this.text.slice(start, this.pos)
    }
  }

  // Whitespace and a comment after an item, then the end of its line.
  private decorAfter(): string {
    const start = this.pos
    this.skipWs()
    this.skipComment()
    const end = this.pos
    if (!this.newline() && this.pos < this.text.length) this.fail("expected newline")
    return this.text.slice(start, end)
  }

  document(): { root: Table; trailing: string; data: TomlTable } {
    const root = Table.make()
    root.position = 0
    const data: TomlTable = {}
    let table = root
    let current = data
    for (;;) {
      const prefix = this.decorBefore()
      if (this.pos >= this.text.length) return { root, trailing: prefix, data }
      if (this.peek() === "[") {
        const array = this.peek(1) === "["
        this.pos += array ? 2 : 1
        const headerStart = this.pos
        const path = this.keyPath()
        const headerRepr = this.text.slice(headerStart, this.pos)
        if (array) {
          if (!this.startsWith("]]")) this.fail("expected `]]`")
          this.pos += 2
        } else {
          if (this.peek() !== "]") this.fail("expected `]`")
          this.pos++
        }
        const suffix = this.decorAfter()
        this.position++
        const next = new Table()
        next.position = this.position
        next.decor = { prefix, suffix }
        next.headerRepr = headerRepr
        table = this.placeTable(root, path, next, array)
        current = this.placeData(data, path, array)
        continue
      }
      // A key-value.
      const keyStart = this.pos
      const path = this.keyPath()
      const keyEnd = this.pos
      const keyRaw = this.text.slice(keyStart, keyEnd).replace(/[ \t]+$/, "")
      const keySuffix = this.text.slice(keyStart + keyRaw.length, keyEnd)
      if (this.peek() !== "=") this.fail("expected `=`")
      this.pos++
      const valueStart = this.pos
      this.skipWs()
      const valuePrefix = this.text.slice(valueStart, this.pos)
      const reprStart = this.pos
      const value = this.value()
      const repr = this.text.slice(reprStart, this.pos)
      const suffix = this.decorAfter()
      const name = path.length === 1 ? (path[0] ?? "") : path.join("\u0000")
      if (table.entries.has(name)) this.fail(`duplicate key \`${path.join(".")}\``, keyStart)
      table.entries.set(name, {
        key: { repr: keyRaw, decor: { prefix, suffix: keySuffix } },
        path,
        item: new Value(value, repr, { prefix: valuePrefix, suffix }),
      })
      this.assign(current, path, value, keyStart)
    }
  }

  // Finds or makes the editing tree's table for a header.
  private placeTable(root: Table, path: ReadonlyArray<string>, next: Table, array: boolean): Table {
    let table = root
    for (const [i, name] of path.entries()) {
      const last = i === path.length - 1
      const entry = table.entries.get(name)
      if (last) {
        if (array) {
          if (entry === undefined) {
            table.entries.set(name, {
              key: { repr: keyRepr(name), decor: noDecor() },
              path: [name],
              item: new ArrayOfTables([next]),
            })
          } else if (entry.item instanceof ArrayOfTables) entry.item.push(next)
          else this.fail(`duplicate key \`${name}\``)
          return next
        }
        if (entry === undefined) {
          table.entries.set(name, { key: { repr: keyRepr(name), decor: noDecor() }, path: [name], item: next })
          return next
        }
        if (entry.item instanceof Table && entry.item.implicit) {
          // A header for a table so far only implied: it takes its place here.
          const implied = entry.item
          for (const [k, v] of implied.entries) next.entries.set(k, v)
          entry.item = next
          return next
        }
        return this.fail(`duplicate key \`${name}\``)
      }
      if (entry === undefined) {
        const implied = new Table()
        implied.implicit = true
        table.entries.set(name, { key: { repr: keyRepr(name), decor: noDecor() }, path: [name], item: implied })
        table = implied
      } else if (entry.item instanceof Table) table = entry.item
      else if (entry.item instanceof ArrayOfTables) {
        const lastTable = entry.item.tables.at(-1)
        if (lastTable === undefined) this.fail(`invalid table \`${name}\``)
        table = lastTable
      } else this.fail(`duplicate key \`${name}\``)
    }
    return table
  }

  // Finds or makes the data's table for a header.
  private placeData(root: TomlTable, path: ReadonlyArray<string>, array: boolean): TomlTable {
    let table = root
    for (const [i, name] of path.entries()) {
      const last = i === path.length - 1
      const existing = Object.hasOwn(table, name) ? table[name] : undefined
      if (last) {
        if (array) {
          if (existing === undefined) {
            const made: TomlTable = {}
            const list: Array<TomlData> = [made]
            this.defined.arrays.add(list)
            table[name] = list
            return made
          }
          if (Array.isArray(existing) && this.defined.arrays.has(existing)) {
            const made: TomlTable = {}
            existing.push(made)
            return made
          }
          return this.fail(`duplicate key \`${name}\``)
        }
        if (existing === undefined) {
          const made: TomlTable = {}
          this.defined.explicit.add(made)
          table[name] = made
          return made
        }
        if (
          isTable(existing) &&
          !this.defined.explicit.has(existing) &&
          !this.defined.inline.has(existing) &&
          !this.defined.dotted.has(existing)
        ) {
          this.defined.explicit.add(existing)
          return existing
        }
        return this.fail(`duplicate key \`${name}\``)
      }
      if (existing === undefined) {
        const made: TomlTable = {}
        table[name] = made
        table = made
      } else if (isTable(existing) && !this.defined.inline.has(existing)) table = existing
      else if (Array.isArray(existing) && this.defined.arrays.has(existing)) {
        const lastTable = existing.at(-1)
        if (lastTable === undefined || !isTable(lastTable)) this.fail(`invalid table \`${name}\``)
        table = lastTable
      } else this.fail(`duplicate key \`${name}\``)
    }
    return table
  }

  // Sets a (dotted) key's value in the data.
  private assign(table: TomlTable, path: ReadonlyArray<string>, value: TomlData, at: number): void {
    let target = table
    for (const [i, name] of path.entries()) {
      const existing = Object.hasOwn(target, name) ? target[name] : undefined
      if (i === path.length - 1) {
        if (existing !== undefined) this.fail(`duplicate key \`${path.join(".")}\``, at)
        target[name] = value
        return
      }
      if (existing === undefined) {
        const made: TomlTable = {}
        this.defined.dotted.add(made)
        target[name] = made
        target = made
      } else if (isTable(existing) && !this.defined.explicit.has(existing) && !this.defined.inline.has(existing)) {
        target = existing
      } else this.fail(`duplicate key \`${path.join(".")}\``, at)
    }
  }

  private keyPath(): Array<string> {
    const path: Array<string> = []
    this.skipWs()
    for (;;) {
      path.push(this.simpleKey())
      this.skipWs()
      if (this.peek() !== ".") return path
      this.pos++
      this.skipWs()
    }
  }

  private simpleKey(): string {
    const c = this.peek()
    if (c === '"') return this.basicString()
    if (c === "'") return this.literalString()
    const start = this.pos
    while (isBareChar(this.peek())) this.pos++
    if (this.pos === start) this.fail("invalid key")
    return this.text.slice(start, this.pos)
  }

  private value(): TomlData {
    const c = this.peek()
    if (c === undefined) return this.fail("expected a value")
    if (this.startsWith('"""')) return this.multilineBasic()
    if (c === '"') return this.basicString()
    if (this.startsWith("'''")) return this.multilineLiteral()
    if (c === "'") return this.literalString()
    if (c === "[") return this.array()
    if (c === "{") return this.inlineTable()
    if (this.startsWith("true") && !isBareChar(this.peek(4))) {
      this.pos += 4
      return true
    }
    if (this.startsWith("false") && !isBareChar(this.peek(5))) {
      this.pos += 5
      return false
    }
    return this.scalar()
  }

  private array(): Array<TomlData> {
    this.pos++
    const items: Array<TomlData> = []
    for (;;) {
      this.skipArrayWs()
      if (this.peek() === "]") {
        this.pos++
        return items
      }
      items.push(this.value())
      this.skipArrayWs()
      if (this.peek() === ",") {
        this.pos++
        continue
      }
      if (this.peek() === "]") {
        this.pos++
        return items
      }
      this.fail("expected `,` or `]`")
    }
  }

  private skipArrayWs(): void {
    for (;;) {
      this.skipWs()
      this.skipComment()
      if (!this.newline()) return
    }
  }

  // TOML 1.1 lets inline tables span lines, with comments and a trailing comma.
  private inlineTable(): TomlTable {
    this.pos++
    const table: TomlTable = {}
    this.defined.inline.add(table)
    for (;;) {
      this.skipArrayWs()
      if (this.peek() === "}") {
        this.pos++
        return table
      }
      const at = this.pos
      const path = this.keyPath()
      if (this.peek() !== "=") this.fail("expected `=`")
      this.pos++
      this.skipWs()
      const value = this.value()
      this.assign(table, path, value, at)
      this.skipArrayWs()
      if (this.peek() === ",") {
        this.pos++
        continue
      }
      if (this.peek() === "}") {
        this.pos++
        return table
      }
      this.fail("expected `,` or `}`")
    }
  }

  private escape(): string {
    const c = this.peek()
    this.pos++
    switch (c) {
      case "b":
        return "\b"
      case "t":
        return "\t"
      case "n":
        return "\n"
      case "f":
        return "\f"
      case "r":
        return "\r"
      case '"':
        return '"'
      case "\\":
        return "\\"
      // TOML 1.1, which toml_edit 0.25 reads.
      case "e":
        return "\u001b"
      case "x": {
        const hex = this.text.slice(this.pos, this.pos + 2)
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) this.fail("invalid hex escape")
        this.pos += 2
        return String.fromCharCode(Number.parseInt(hex, 16))
      }
      case "u":
      case "U": {
        const n = c === "u" ? 4 : 8
        const hex = this.text.slice(this.pos, this.pos + n)
        if (!(c === "u" ? HEX4 : HEX8).test(hex)) this.fail("invalid unicode escape")
        const code = Number.parseInt(hex, 16)
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail("invalid unicode scalar")
        this.pos += n
        return String.fromCodePoint(code)
      }
      default:
        return this.fail("invalid escape", this.pos - 1)
    }
  }

  private checkChar(c: string): void {
    const code = c.charCodeAt(0)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) this.fail("invalid string character")
  }

  private basicString(): string {
    this.pos++
    let out = ""
    for (;;) {
      const c = this.peek()
      if (c === undefined || c === "\n" || c === "\r") this.fail("unterminated string")
      this.pos++
      if (c === '"') return out
      if (c === "\\") out += this.escape()
      else {
        this.checkChar(c)
        out += c
      }
    }
  }

  private literalString(): string {
    this.pos++
    const start = this.pos
    for (;;) {
      const c = this.peek()
      if (c === undefined || c === "\n" || c === "\r") this.fail("unterminated string")
      if (c === "'") {
        const out = this.text.slice(start, this.pos)
        this.pos++
        return out
      }
      this.checkChar(c)
      this.pos++
    }
  }

  private multilineBasic(): string {
    this.pos += 3
    this.newline()
    let out = ""
    for (;;) {
      if (this.startsWith('"""')) {
        // Up to two quotes may end the content.
        let quotes = 3
        while (quotes < 5 && this.peek(quotes) === '"') quotes++
        out += '"'.repeat(quotes - 3)
        this.pos += quotes
        return out
      }
      const c = this.peek()
      if (c === undefined) this.fail("unterminated string")
      if (c === "\\") {
        // A line-ending backslash trims the whitespace that follows.
        let at = this.pos + 1
        while (isWs(this.text[at])) at++
        if (this.text[at] === "\n" || this.text.startsWith("\r\n", at)) {
          this.pos = at
          while (isWs(this.peek()) || this.peek() === "\n" || this.startsWith("\r\n")) {
            this.pos += this.startsWith("\r\n") ? 2 : 1
          }
          continue
        }
        this.pos++
        out += this.escape()
        continue
      }
      if (this.newline()) {
        out += "\n"
        continue
      }
      this.checkChar(c)
      out += c
      this.pos++
    }
  }

  private multilineLiteral(): string {
    this.pos += 3
    this.newline()
    let out = ""
    for (;;) {
      if (this.startsWith("'''")) {
        let quotes = 3
        while (quotes < 5 && this.peek(quotes) === "'") quotes++
        out += "'".repeat(quotes - 3)
        this.pos += quotes
        return out
      }
      const c = this.peek()
      if (c === undefined) this.fail("unterminated string")
      if (this.newline()) {
        out += "\n"
        continue
      }
      this.checkChar(c)
      out += c
      this.pos++
    }
  }

  // Numbers, dates and times: a run up to whitespace or punctuation.
  private scalar(): TomlData {
    const start = this.pos
    while (this.pos < this.text.length && !endsScalar(this.text.charCodeAt(this.pos))) this.pos++
    let raw = this.text.slice(start, this.pos)
    // A date and a time may be joined by a space.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && this.peek() === " " && isDigit(this.peek(1))) {
      const save = this.pos
      this.pos++
      while (this.pos < this.text.length && !endsScalar(this.text.charCodeAt(this.pos))) this.pos++
      const joined = this.text.slice(start, this.pos)
      if (DATETIME.test(joined)) raw = joined
      else this.pos = save
    }
    if (raw === "") return this.fail("expected a value", start)
    const data = scalarData(raw)
    if (data === undefined) return this.fail(`invalid value \`${raw}\``, start)
    return data
  }
}

/** Whether a parsed value is a table. */
export const isTable = (value: TomlData | undefined): value is TomlTable =>
  typeof value === "object" && !Array.isArray(value) && !(value instanceof Datetime)

const HEX4 = /^[0-9A-Fa-f]{4}$/
const HEX8 = /^[0-9A-Fa-f]{8}$/

// Where a number, date, or time ends: `,`, `]`, `}`, `#`, or whitespace
// (any that JavaScript's `\s` matches, so others fail as part of the value).
const endsScalar = (c: number): boolean => {
  if (c === 0x2c || c === 0x5d || c === 0x7d || c === 0x23 || c === 0x20 || (c >= 0x09 && c <= 0x0d)) return true
  if (c < 0xa0) return false
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  )
}

// Decimal digits may be split by single underscores; no leading zeros.
const INTEGER = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/
const FLOAT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/
const DATETIME =
  /^(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

const scalarData = (raw: string): TomlData | undefined => {
  const special = /^([+-]?)(inf|nan)$/.exec(raw)
  if (special !== null) {
    if (special[2] === "nan") return special[1] === "-" ? -Number.NaN : Number.NaN
    return special[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  const radix = /^0([xob])([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)$/.exec(raw)
  if (radix !== null) {
    const digits = (radix[2] ?? "").replaceAll("_", "")
    const valid = radix[1] === "x" ? /^[0-9A-Fa-f]+$/ : radix[1] === "o" ? /^[0-7]+$/ : /^[01]+$/
    if (!valid.test(digits)) return undefined
    const n = BigInt(`0${radix[1]}${digits}`)
    return n <= I64_MAX ? n : undefined
  }
  if (INTEGER.test(raw)) {
    const n = BigInt(raw.replaceAll("_", ""))
    return n >= I64_MIN && n <= I64_MAX ? n : undefined
  }
  if (FLOAT.test(raw)) {
    // Too large for an f64 is an error, not infinity.
    const f = Number(raw.replaceAll("_", ""))
    return Number.isFinite(f) ? f : undefined
  }
  if (DATETIME.test(raw)) return new Datetime(raw)
  return undefined
}
