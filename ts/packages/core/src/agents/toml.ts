// Small, careful edits to a TOML file people also edit by hand (Codex's
// `config.toml`): set or remove one top-level key, and replace or remove one
// table. Everything else stays exactly as written, comments included.
//
// The file is parsed with toml-patch, whose syntax tree says on which lines
// each key and table sits; an edit replaces only those lines. Every result is
// parsed again and compared with the settings it was meant to give. When a
// file is laid out in a way the line edits cannot handle (a table written
// inline, say), toml-patch's own whole-document patch is used instead, and its
// result is checked the same way, so an edit never changes a setting it was
// not asked to.
import { parse, parseDocument, patch, stringify } from "@decimalturn/toml-patch"
import { Result } from "effect"

/** A parsed TOML table, as plain values. */
export type Table = { readonly [key: string]: unknown }

/** A TOML value slopmax writes. */
export type Scalar = string | boolean

type Block = ReturnType<typeof parseDocument>["cst"][number]
type KeyValueBlock = Extract<Block, { readonly type: "KeyValue" }>
type TableBlock = Extract<Block, { readonly type: "Table" }>

/** A parsed file: its lines (without their endings), its syntax tree and its values. */
export interface Doc {
  readonly lines: ReadonlyArray<string>
  readonly eol: string
  readonly blocks: ReadonlyArray<Block>
  readonly table: Table
}

/** Replaces lines `[from, to)` (0-based) with `lines`. An insertion has `from === to`. */
interface Change {
  readonly from: number
  readonly to: number
  readonly lines: ReadonlyArray<string>
}

export const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)

const firstLine = (message: string) => message.split("\n")[0] ?? message

/** Parses a file's text; a missing file is an empty one. Fails with why it is not TOML. */
export const load = (text: string): Result.Result<Doc, string> => {
  try {
    const document = parseDocument(text)
    const table: unknown = document.toJsObject
    const lines = text === "" ? [] : text.split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    return Result.succeed({
      lines,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
      blocks: document.cst,
      table: isTable(table) ? table : {},
    })
  } catch (error) {
    return Result.fail(`it is not valid TOML (${firstLine(error instanceof Error ? error.message : String(error))})`)
  }
}

/** A value as TOML writes it: a basic string with escapes, or `true`/`false`. */
export const render = (value: Scalar): string =>
  typeof value === "boolean" ? String(value) : stringify({ v: value }).trim().slice("v = ".length)

const startsWith = (key: ReadonlyArray<string>, prefix: ReadonlyArray<string>) =>
  prefix.length <= key.length && prefix.every((part, at) => key[at] === part)

const sameKey = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && startsWith(a, b)

/** The key-values before the first table header. */
const rootKeyValues = (doc: Doc): ReadonlyArray<KeyValueBlock> => {
  const out: Array<KeyValueBlock> = []
  for (const block of doc.blocks) {
    if (block.type === "Table" || block.type === "TableArray") break
    if (block.type === "KeyValue") out.push(block)
  }
  return out
}

const tables = (doc: Doc): ReadonlyArray<TableBlock> => doc.blocks.filter((block) => block.type === "Table")

const keyValuesOf = (table: TableBlock): ReadonlyArray<KeyValueBlock> =>
  table.items.filter((item) => item.type === "KeyValue")

/** Sets a top-level key: its value is replaced where it is, or a new line goes after the last top-level key. */
const setRoot = (doc: Doc, key: string, value: Scalar): Change => {
  const roots = rootKeyValues(doc)
  const existing = roots.find((kv) => sameKey(kv.key.value, [key]))
  if (existing !== undefined) {
    const { start, end } = existing.value.loc
    const before = (doc.lines[start.line - 1] ?? "").slice(0, start.column)
    const after = (doc.lines[end.line - 1] ?? "").slice(end.column)
    return { from: start.line - 1, to: end.line, lines: [`${before}${render(value)}${after}`] }
  }
  const last = roots.at(-1)
  const at = last === undefined ? 0 : last.loc.end.line
  return { from: at, to: at, lines: [`${key} = ${render(value)}`] }
}

/** Removes a top-level key's lines. */
const removeRoot = (doc: Doc, key: string): ReadonlyArray<Change> =>
  rootKeyValues(doc)
    .filter((kv) => sameKey(kv.key.value, [key]))
    .map((kv) => ({ from: kv.loc.start.line - 1, to: kv.loc.end.line, lines: [] }))

const isBlank = (line: string | undefined) => line === undefined || line.trim() === ""

/** Lines `[from, to)` of a table: its header through its last key. Comments after the last key are left for what follows. */
const tableLines = (table: TableBlock): { readonly from: number; readonly to: number } => {
  const last = keyValuesOf(table).at(-1)
  return { from: table.loc.start.line - 1, to: last === undefined ? table.key.loc.end.line : last.loc.end.line }
}

/** Drops one blank line before a removed block when a blank line or the end of the file follows it, so removals leave no gaps. */
const tidy = (doc: Doc, range: { readonly from: number; readonly to: number }): Change => {
  const loose = range.from > 0 && isBlank(doc.lines[range.from - 1]) && isBlank(doc.lines[range.to])
  return { from: loose ? range.from - 1 : range.from, to: range.to, lines: [] }
}

/**
 * Everything that defines the table at `path`: its own header and its
 * subtables', and dotted or inline keys for it at the top level or in its
 * parent's table.
 */
const tableParts = (doc: Doc, path: ReadonlyArray<string>) => {
  const own = tables(doc).filter((table) => startsWith(table.key.item.value, path))
  const parents = tables(doc).filter((table) => {
    const key = table.key.item.value
    return key.length < path.length && startsWith(path, key)
  })
  const loose = [
    ...rootKeyValues(doc).filter((kv) => startsWith(kv.key.value, path)),
    ...parents.flatMap((parent) =>
      keyValuesOf(parent).filter((kv) => startsWith([...parent.key.item.value, ...kv.key.value], path)),
    ),
  ]
  return { own, loose }
}

/** Removes the table at `path` wherever it is defined. */
const removeTable = (doc: Doc, path: ReadonlyArray<string>): ReadonlyArray<Change> => {
  const { own, loose } = tableParts(doc, path)
  return [
    ...own.map((table) => tidy(doc, tableLines(table))),
    ...loose.map((kv) => ({ from: kv.loc.start.line - 1, to: kv.loc.end.line, lines: [] })),
  ]
}

/** Writes the table at `path` with exactly `entries`, where it was, or at the end of the file. */
const putTable = (doc: Doc, path: ReadonlyArray<string>, entries: ReadonlyArray<readonly [string, Scalar]>) => {
  const body = [`[${path.join(".")}]`, ...entries.map(([key, value]) => `${key} = ${render(value)}`)]
  const { own, loose } = tableParts(doc, path)
  const exact = own.find((table) => sameKey(table.key.item.value, path))
  const removals = [
    ...own.filter((table) => table !== exact).map((table) => tidy(doc, tableLines(table))),
    ...loose.map((kv) => ({ from: kv.loc.start.line - 1, to: kv.loc.end.line, lines: [] })),
  ]
  if (exact !== undefined) return [...removals, { ...tableLines(exact), lines: body }]
  const end = doc.lines.length
  // A blank line before the table; on an empty file it parts the table from the keys added above it.
  const spaced = end === 0 || !isBlank(doc.lines[end - 1]) ? ["", ...body] : body
  return [...removals, { from: end, to: end, lines: spaced }]
}

/**
 * Applies non-overlapping changes, last first, so earlier line numbers still
 * hold. Insertions at the same line keep the order they were listed in. A file
 * that did not start with blank lines does not start with them afterwards.
 */
const apply = (doc: Doc, changes: ReadonlyArray<Change>): string => {
  const lines = [...doc.lines]
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .toSorted((a, b) => b.change.from - a.change.from || b.change.to - a.change.to || b.index - a.index)
  for (const { change } of ordered) lines.splice(change.from, change.to - change.from, ...change.lines)
  if (!isBlank(doc.lines[0]) || doc.lines.length === 0) {
    while (lines.length > 0 && isBlank(lines[0])) lines.shift()
  }
  return lines.length === 0 ? "" : `${lines.join(doc.eol)}${doc.eol}`
}

/** A value in a form two equal TOML values share: keys sorted, empty tables gone, dates as text. */
const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return `date:${value.toISOString()}`
  if (typeof value === "bigint") return `int:${value}`
  if (Array.isArray(value)) return value.map(canonical)
  if (isTable(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).toSorted()) {
      const inner = canonical(value[key])
      if (!(isTable(inner) && Object.keys(inner).length === 0)) out[key] = inner
    }
    return out
  }
  return value
}

const sameValues = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

const gives = (text: string, expected: Table): boolean => {
  try {
    return sameValues(parse(text), expected)
  } catch {
    return false
  }
}

/** What an edit is to do to a file. */
export interface Edit {
  /** Top-level keys to set, or to remove (undefined). */
  readonly root?: ReadonlyArray<readonly [string, Scalar | undefined]>
  /** Tables to write with exactly these entries, or to remove (undefined). */
  readonly tables?: ReadonlyArray<
    readonly [ReadonlyArray<string>, ReadonlyArray<readonly [string, Scalar]> | undefined]
  >
}

const withPath = (table: Table, path: ReadonlyArray<string>, value: Table | undefined): Table => {
  const [head, ...rest] = path
  if (head === undefined) return value ?? {}
  const inner = table[head]
  const next = rest.length === 0 ? value : withPath(isTable(inner) ? inner : {}, rest, value)
  const { [head]: _old, ...others } = table
  return next === undefined ? others : { ...others, [head]: next }
}

/** The values an edit should leave. */
const expectedOf = (table: Table, edit: Edit): Table => {
  let out = table
  for (const [key, value] of edit.root ?? []) {
    const { [key]: _old, ...others } = out
    out = value === undefined ? others : { ...others, [key]: value }
  }
  for (const [path, entries] of edit.tables ?? []) {
    out = withPath(out, path, entries === undefined ? undefined : Object.fromEntries(entries))
  }
  return out
}

/**
 * Makes the edit, keeping every other line as it was. Fails only when the
 * edit cannot be made without changing something else.
 */
export const edit = (doc: Doc, wanted: Edit): Result.Result<string, string> => {
  const changes = [
    ...(wanted.root ?? []).flatMap(([key, value]) =>
      value === undefined ? removeRoot(doc, key) : [setRoot(doc, key, value)],
    ),
    ...(wanted.tables ?? []).flatMap(([path, entries]) =>
      entries === undefined ? removeTable(doc, path) : putTable(doc, path, entries),
    ),
  ]
  const expected = expectedOf(doc.table, wanted)
  const text = apply(doc, changes)
  if (gives(text, expected)) return Result.succeed(text)
  const original = doc.lines.length === 0 ? "" : `${doc.lines.join(doc.eol)}${doc.eol}`
  try {
    const patched = patch(original, expected)
    const ended = patched === "" || patched.endsWith("\n") ? patched : `${patched}${doc.eol}`
    if (gives(ended, expected)) return Result.succeed(ended)
  } catch {
    // Reported below.
  }
  return Result.fail("its layout cannot be edited without changing other settings")
}
