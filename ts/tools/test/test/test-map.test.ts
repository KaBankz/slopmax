import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"
import { it, MemoryFileSystem } from "../src/index.ts"
import * as TestMap from "../src/test-map.ts"

const rustTests = [
  "file\ttest\tline",
  "crates/core/src/lock.rs\ta_stale_lock_is_taken_over\t10",
  "crates/core/src/lock.rs\ta_live_lock_is_waited_for\t20",
  "crates/slopmax/src/args.rs\tparses_flags\t30",
].join("\n")

const row = (rustFile: string, rustTest: string, tsFile = "", tsTest = "", note = "") =>
  [rustFile, rustTest, tsFile, tsTest, note].join("\t")

const map = (...rows: ReadonlyArray<string>) => [TestMap.header.join("\t"), ...rows].join("\n") + "\n"

const lockTests = `
describe("Lock", () => {
  it.effect("takes over a lock whose holder is gone", () => Effect.void)
  it.live('waits for a lock held by a live process', () => Effect.void)
})
`
const sources = new Map([["packages/core/test/lock.test.ts", lockTests]])

const complete = map(
  row(
    "crates/core/src/lock.rs",
    "a_stale_lock_is_taken_over",
    "packages/core/test/lock.test.ts",
    "takes over a lock whose holder is gone",
  ),
  row(
    "crates/core/src/lock.rs",
    "a_live_lock_is_waited_for",
    "packages/core/test/lock.test.ts",
    "waits for a lock held by a live process",
  ),
  row("crates/slopmax/src/args.rs", "parses_flags", "", "", "effect/cli parses flags (NOT-PORTED.md)"),
)

const messages = (report: TestMap.Report) => report.problems.map((problem) => problem.message)

describe("the test-map check", () => {
  it("passes a map whose every row names a real test or gives a reason", () => {
    const report = TestMap.check(complete, rustTests, sources, { allowPending: false })
    expect(report.problems).toEqual([])
    expect(report).toMatchObject({ rows: 3, mapped: 2, explained: 1, pending: 0 })
    expect(TestMap.summary(report)).toBe("2 mapped to tests, 1 explained, 0 not filled in yet; 3 rows for 3 Rust tests")
  })

  it("reports a row whose title is not a test in its file", () => {
    const report = TestMap.check(
      complete.replace("takes over a lock whose holder is gone", "takes over a stale lock"),
      rustTests,
      sources,
      { allowPending: false },
    )
    expect(messages(report)).toEqual(['no test titled "takes over a stale lock" in packages/core/test/lock.test.ts'])
    expect(report.problems[0]?.line).toBe(2)
  })

  it("reports a row whose file does not exist", () => {
    const report = TestMap.check(complete, rustTests, new Map(), { allowPending: false })
    expect(messages(report)).toEqual([
      "packages/core/test/lock.test.ts does not exist",
      "packages/core/test/lock.test.ts does not exist",
    ])
  })

  it("fails a row with neither a test nor a reason, unless pending rows are allowed", () => {
    const unfinished = map(
      row("crates/core/src/lock.rs", "a_stale_lock_is_taken_over"),
      row("crates/core/src/lock.rs", "a_live_lock_is_waited_for"),
      row("crates/slopmax/src/args.rs", "parses_flags", "", "", "n/a"),
    )
    const strict = TestMap.check(unfinished, rustTests, sources, { allowPending: false })
    expect(messages(strict)).toEqual([
      "a_stale_lock_is_taken_over needs a TypeScript test or a note saying why none applies",
      "a_live_lock_is_waited_for needs a TypeScript test or a note saying why none applies",
    ])
    expect(strict).toMatchObject({ mapped: 0, explained: 1, pending: 2 })
    const lenient = TestMap.check(unfinished, rustTests, sources, { allowPending: true })
    expect(lenient.problems).toEqual([])
    expect(lenient).toMatchObject({ mapped: 0, explained: 1, pending: 2 })
  })

  it("reports Rust tests with no row, rows for tests that do not exist, and duplicates", () => {
    const report = TestMap.check(
      map(
        row("crates/core/src/lock.rs", "a_stale_lock_is_taken_over", "", "", "n/a"),
        row("crates/core/src/lock.rs", "a_stale_lock_is_taken_over", "", "", "n/a"),
        row("crates/core/src/lock.rs", "an_invented_test", "", "", "n/a"),
      ),
      rustTests,
      sources,
      { allowPending: false },
    )
    expect(messages(report)).toEqual([
      "a_stale_lock_is_taken_over is already mapped on line 2",
      "crates/core/src/lock.rs has no Rust test an_invented_test",
      "the Rust test crates/core/src/lock.rs a_live_lock_is_waited_for has no row",
      "the Rust test crates/slopmax/src/args.rs parses_flags has no row",
    ])
    expect(TestMap.summary(report)).toBe("0 mapped to tests, 3 explained, 0 not filled in yet; 3 rows for 3 Rust tests")
  })

  it("reports a wrong header, a short row, and a half-filled mapping", () => {
    const report = TestMap.check(
      [
        "rust_file\trust_test\tts_file\tts_test",
        "crates/core/src/lock.rs\ta_stale_lock_is_taken_over\tpackages/core/test/lock.test.ts",
        row("crates/core/src/lock.rs", "a_live_lock_is_waited_for", "packages/core/test/lock.test.ts"),
        row("crates/slopmax/src/args.rs", "parses_flags", "", "parses flags"),
      ].join("\n"),
      rustTests,
      sources,
      { allowPending: false },
    )
    expect(messages(report)).toEqual([
      "the header must be: rust_file | rust_test | ts_file | ts_test | note",
      "expected 5 tab-separated columns, found 3",
      "ts_file is set but ts_test is empty",
      "ts_test is set but ts_file is empty",
      "the Rust test crates/core/src/lock.rs a_stale_lock_is_taken_over has no row",
    ])
  })

  it("lets one row name several tests across several files", () => {
    const report = TestMap.check(
      map(
        row(
          "crates/core/src/lock.rs",
          "a_stale_lock_is_taken_over",
          "packages/core/test/lock.test.ts | packages/core/test/lock-race.test.ts",
          "takes over a lock whose holder is gone | survives a holder killed mid-write",
        ),
        row("crates/core/src/lock.rs", "a_live_lock_is_waited_for", "", "", "n/a"),
        row("crates/slopmax/src/args.rs", "parses_flags", "", "", "n/a"),
      ),
      rustTests,
      new Map([
        ...sources,
        ["packages/core/test/lock-race.test.ts", `it.live("survives a holder killed mid-write", f)`],
      ]),
      { allowPending: false },
    )
    expect(report.problems).toEqual([])
    expect(report.mapped).toBe(1)
  })
})

describe("test titles", () => {
  it("are read from it, test, it.effect, it.live and the testers of it.layer, with bun's modifiers", () => {
    const source = `
      it("plain", () => {})
      test("bun test", () => {})
      it.effect("effect test", () => Effect.void)
      it.live(\`live test\`, () => Effect.void)
      it.effect.skipIf(process.platform !== "linux")("linux only", () => Effect.void)
      test.skip('skipped', () => {})
      it.layer(Accounts.layer)("Accounts", ({ effect }) => {
        effect("inside a layer", () => Effect.void)
      })
      it.layer(Pool.layer)("Pool", (it) => {
        it.effect(
          "split over lines",
          () => Effect.void,
        )
      })
    `
    expect([...TestMap.testTitles(source)].toSorted()).toEqual(
      [
        "plain",
        "bun test",
        "effect test",
        "live test",
        "linux only",
        "skipped",
        "inside a layer",
        "split over lines",
      ].toSorted(),
    )
  })

  it("unescape quotes and keep describe blocks and computed names out", () => {
    const source = `
      describe("not a test", () => {})
      it("says \\"hello\\" and it\\'s fine", () => {})
      it(\`made from \${name}\`, () => {})
      Effect.fn("Service.method")
    `
    expect([...TestMap.testTitles(source)]).toEqual([`says "hello" and it's fine`])
  })
})

describe("test titles in real code only", () => {
  it("leave out tests that are commented out or only quoted in a string", () => {
    const source = `
      // it("commented out", () => {})
      /* test("block comment", () => {})
         it("still in it", () => {}) */
      const example = "it('in a string', () => {})"
      const pattern = /it\\("in a regex"/
      const snippet = \`it("in a template", () => {})\`
      it("real", () => {})
    `
    expect([...TestMap.testTitles(source)]).toEqual(["real"])
  })

  it("follow modifiers with nested arguments, .each, and templates holding a bare $", () => {
    const source = `
      it.effect.skipIf(isMac(process.platform))("not on macOS", () => Effect.void)
      test.each([[1, 2], [3, 4]])("adds %i and %i", (a, b) => {})
      it(\`costs $5 at most\`, () => {})
      it(\`after \${\`nested \${1}\`} a template\`, () => {})
      test("after the template", () => {})
    `
    expect([...TestMap.testTitles(source)].toSorted()).toEqual(
      ["not on macOS", "adds %i and %i", "costs $5 at most", "after the template"].toSorted(),
    )
  })

  it("count a bare effect or live call only when a test body follows", () => {
    const source = `
      const effect = (name: string, n: number) => n
      effect("not a test", 1)
      live("not one either")
      it.layer(Pool.layer)("Pool", ({ effect, live }) => {
        effect("a layer test", () => Effect.void)
        live("a live layer test", async () => {})
      })
    `
    expect([...TestMap.testTitles(source)].toSorted()).toEqual(["a layer test", "a live layer test"])
  })
})

describe("the test-map command", () => {
  const files = {
    "/repo/ts/docs/parity/test-map.tsv": complete,
    "/repo/ts/docs/parity/rust-tests.tsv": rustTests,
    "/repo/ts/packages/core/test/lock.test.ts": lockTests,
  }

  it.effect("reads the map, the Rust tests and the named files, and prints a summary", () =>
    Effect.gen(function* () {
      const report = yield* TestMap.run({ root: "/repo/ts", allowPending: false })
      expect(report.mapped).toBe(2)
      expect(yield* TestConsole.logLines).toEqual([
        "2 mapped to tests, 1 explained, 0 not filled in yet; 3 rows for 3 Rust tests",
      ])
    }).pipe(Effect.provide(MemoryFileSystem.layerWith({ files }))),
  )

  it.effect("prints each problem with its line and fails", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(TestMap.run({ root: "/repo/ts", allowPending: false }))
      expect(error).toBeInstanceOf(TestMap.TestMapInvalid)
      expect(error instanceof TestMap.TestMapInvalid ? error.report.problems : []).toHaveLength(2)
      expect(yield* TestConsole.errorLines).toEqual([
        "docs/parity/test-map.tsv:2: packages/core/test/lock.test.ts does not exist",
        "docs/parity/test-map.tsv:3: packages/core/test/lock.test.ts does not exist",
      ])
    }).pipe(
      Effect.provide(
        MemoryFileSystem.layerWith({
          files: {
            "/repo/ts/docs/parity/test-map.tsv": complete,
            "/repo/ts/docs/parity/rust-tests.tsv": rustTests,
          },
        }),
      ),
    ),
  )
})
