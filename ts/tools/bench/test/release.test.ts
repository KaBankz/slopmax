import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { releaseNotes, releaseProblems } from "../src/release.ts"

const changelog = `# Changelog

## [Unreleased]

- Something coming.

## [0.4.0] - 2026-11-01

### Added

- The TypeScript slopmax.

## [0.3.0] - 2026-10-04

- Older.
`

describe("releasing", () => {
  test("takes a version's notes from its changelog section, up to the next one", () => {
    expect(releaseNotes(changelog, "0.4.0")).toEqual(Option.some("### Added\n\n- The TypeScript slopmax."))
    expect(releaseNotes(changelog, "0.3.0")).toEqual(Option.some("- Older."))
    expect(releaseNotes(changelog, "0.5.0")).toEqual(Option.none())
  })

  test("releases a tag that names the version and has notes", () => {
    expect(releaseProblems(Option.some("v0.4.0"), "0.4.0", changelog)).toEqual([])
  })

  test("refuses a tag for another version, and a version with no notes", () => {
    expect(releaseProblems(Option.some("v0.3.9"), "0.4.0", changelog)).toEqual([
      "the tag v0.3.9 does not name slopmax 0.4.0; tag v0.4.0, or change the version",
    ])
    expect(releaseProblems(Option.some("v0.5.0"), "0.5.0", changelog)).toEqual([
      'CHANGELOG.md has no notes under "## [0.5.0]"',
    ])
  })

  test("checks the notes on a dry run, where the tag is not known yet", () => {
    expect(releaseProblems(Option.none(), "0.4.0", changelog)).toEqual([])
    expect(releaseProblems(Option.none(), "0.9.0", changelog)).toEqual(['CHANGELOG.md has no notes under "## [0.9.0]"'])
  })
})
