// Checks docs/parity/test-map.tsv, the map from every Rust test to the
// TypeScript test that covers its behavior (or the reason it no longer
// applies). A mapping is only worth something if the test it names exists,
// so every title is looked up in the file it points at.
//
// Format: tab-separated, header `rust_file rust_test ts_file ts_test note`.
// `ts_file` is relative to `ts/`; `ts_test` is the title as written in the
// first argument of `it`, `test`, `it.effect`, `it.live` (or `effect` inside
// `it.layer`). Several files or titles are separated by ` | `; each title must
// be found in one of the row's files. A row with no test needs a note saying
// why it does not apply.
import { Console, Data, Effect, FileSystem, Path, type PlatformError } from "effect"
import { testTitles } from "./test-titles.ts"

export { testTitles }

export const header = ["rust_file", "rust_test", "ts_file", "ts_test", "note"] as const

export interface Row {
  readonly line: number
  readonly rustFile: string
  readonly rustTest: string
  readonly tsFiles: ReadonlyArray<string>
  readonly tsTests: ReadonlyArray<string>
  readonly note: string
}

export interface Problem {
  readonly line: number
  readonly message: string
}

export interface Report {
  readonly rows: number
  /** The tests rust-tests.tsv lists, each of which needs exactly one row. */
  readonly rustTests: number
  /** Rows that name a test which exists. */
  readonly mapped: number
  /** Rows that explain why no test applies. */
  readonly explained: number
  /** Rows with neither a test nor a reason yet (problems too, unless pending rows are allowed). */
  readonly pending: number
  readonly problems: ReadonlyArray<Problem>
}

const split = (cell: string) =>
  cell
    .split(" | ")
    .map((part) => part.trim())
    .filter((part) => part !== "")

const lines = (text: string) => text.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1)

/** Parses the map, reporting malformed lines instead of guessing at them. */
export const parseMap = (
  text: string,
): { readonly rows: ReadonlyArray<Row>; readonly problems: ReadonlyArray<Problem> } => {
  const [first, ...body] = lines(text)
  const problems: Array<Problem> = []
  if (first !== header.join("\t")) problems.push({ line: 1, message: `the header must be: ${header.join(" | ")}` })
  const rows: Array<Row> = []
  body.forEach((content, index) => {
    const line = index + 2
    const cells = content.split("\t")
    if (cells.length !== header.length) {
      problems.push({ line, message: `expected ${header.length} tab-separated columns, found ${cells.length}` })
      return
    }
    const [rustFile = "", rustTest = "", tsFile = "", tsTest = "", note = ""] = cells.map((cell) => cell.trim())
    if (rustFile === "" || rustTest === "") problems.push({ line, message: "rust_file and rust_test are required" })
    rows.push({ line, rustFile, rustTest, tsFiles: split(tsFile), tsTests: split(tsTest), note })
  })
  return { rows, problems }
}

/** The `file<TAB>test` pairs of rust-tests.tsv (its header is skipped). */
export const parseRustTests = (text: string): ReadonlyArray<string> =>
  lines(text)
    .slice(1)
    .map((line) => line.split("\t").slice(0, 2).join("\t"))

/**
 * Checks the map against the Rust test list and the TypeScript sources.
 * `sources` holds the text of every file the map names (absent when the file
 * does not exist). With `allowPending`, rows not yet filled in are counted but
 * are not problems, which suits a port still in progress.
 */
export const check = (
  map: string,
  rustTests: string,
  sources: ReadonlyMap<string, string>,
  options: { readonly allowPending: boolean },
): Report => {
  const parsed = parseMap(map)
  const problems = [...parsed.problems]
  const expected = new Set(parseRustTests(rustTests))
  const seen = new Map<string, number>()
  const titles = new Map<string, ReadonlySet<string>>()
  const titlesOf = (file: string) => {
    const known = titles.get(file)
    if (known !== undefined) return known
    const found = testTitles(sources.get(file) ?? "")
    titles.set(file, found)
    return found
  }
  let mapped = 0
  let explained = 0
  let pending = 0
  for (const row of parsed.rows) {
    const key = `${row.rustFile}\t${row.rustTest}`
    const earlier = seen.get(key)
    if (earlier !== undefined)
      problems.push({ line: row.line, message: `${row.rustTest} is already mapped on line ${earlier}` })
    else seen.set(key, row.line)
    if (!expected.has(key))
      problems.push({ line: row.line, message: `${row.rustFile} has no Rust test ${row.rustTest}` })

    if (row.tsFiles.length === 0 && row.tsTests.length === 0) {
      if (row.note !== "") explained += 1
      else pending += 1
      if (row.note === "" && !options.allowPending)
        problems.push({
          line: row.line,
          message: `${row.rustTest} needs a TypeScript test or a note saying why none applies`,
        })
      continue
    }
    if (row.tsFiles.length === 0) {
      problems.push({ line: row.line, message: "ts_test is set but ts_file is empty" })
      continue
    }
    if (row.tsTests.length === 0) {
      problems.push({ line: row.line, message: "ts_file is set but ts_test is empty" })
      continue
    }
    const missingFiles = row.tsFiles.filter((file) => !sources.has(file))
    for (const file of missingFiles) problems.push({ line: row.line, message: `${file} does not exist` })
    if (missingFiles.length > 0) continue
    const absent = row.tsTests.filter((title) => !row.tsFiles.some((file) => titlesOf(file).has(title)))
    for (const title of absent) {
      problems.push({ line: row.line, message: `no test titled "${title}" in ${row.tsFiles.join(" or ")}` })
    }
    if (absent.length === 0) mapped += 1
  }
  for (const key of expected) {
    if (!seen.has(key)) problems.push({ line: 0, message: `the Rust test ${key.replace("\t", " ")} has no row` })
  }
  return { rows: parsed.rows.length, rustTests: expected.size, mapped, explained, pending, problems }
}

/** The summary line a person reads first. */
export const summary = (report: Report): string =>
  `${report.mapped} mapped to tests, ${report.explained} explained, ${report.pending} not filled in yet; ${report.rows} rows for ${report.rustTests} Rust tests`

export class TestMapInvalid extends Data.TaggedError("TestMapInvalid")<{ readonly report: Report }> {
  override get message() {
    return `test-map.tsv has ${this.report.problems.length} problem(s)`
  }
}

/**
 * Reads the map, the Rust test list and every file the map names from the
 * `ts/` directory at `root`, prints what is wrong, and fails if anything is.
 */
export const run = Effect.fn("TestMap.run")(function* (options: {
  readonly root: string
  readonly allowPending: boolean
}): Effect.fn.Return<Report, TestMapInvalid | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const map = yield* fs.readFileString(path.join(options.root, "docs/parity/test-map.tsv"))
  const rustTests = yield* fs.readFileString(path.join(options.root, "docs/parity/rust-tests.tsv"))
  const sources = new Map<string, string>()
  for (const row of parseMap(map).rows) {
    for (const file of row.tsFiles) {
      if (sources.has(file)) continue
      const at = path.join(options.root, file)
      if (yield* fs.exists(at)) sources.set(file, yield* fs.readFileString(at))
    }
  }
  const report = check(map, rustTests, sources, { allowPending: options.allowPending })
  for (const problem of report.problems) {
    yield* Console.error(`docs/parity/test-map.tsv:${problem.line}: ${problem.message}`)
  }
  yield* Console.log(summary(report))
  if (report.problems.length > 0) return yield* new TestMapInvalid({ report })
  return report
})
