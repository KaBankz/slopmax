// Before a release is published: the tag must name the version slopmax
// reports (`slopmax --version`, `/healthz`), and CHANGELOG.md must have
// that version's section, since the release's notes are taken from it.
import { slopmaxVersion } from "@slopmax/domain"
import { Console, Data, Effect, FileSystem, Option } from "effect"

/** The notes under a version's heading, up to the next one; none when the version has no section. */
export const releaseNotes = (changelog: string, version: string): Option.Option<string> => {
  const lines = changelog.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start < 0) return Option.none()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith("## "))
  return Option.some((end < 0 ? rest : rest.slice(0, end)).join("\n").trim())
}

/**
 * What keeps `tag` from being released as `version` with notes from
 * `changelog`. With no tag (a dry run) only the notes are checked: the tag
 * is not known yet, but a tag of this version would need them.
 */
export const releaseProblems = (
  tag: Option.Option<string>,
  version: string,
  changelog: string,
): ReadonlyArray<string> => [
  ...(Option.isSome(tag) && tag.value !== `v${version}`
    ? [`the tag ${tag.value} does not name slopmax ${version}; tag v${version}, or change the version`]
    : []),
  ...(Option.match(releaseNotes(changelog, version), { onNone: () => true, onSome: (n) => n === "" })
    ? [`CHANGELOG.md has no notes under "## [${version}]"`]
    : []),
]

/** The release cannot go out as tagged. */
export class NotReleasable extends Data.TaggedError("NotReleasable")<{ readonly problems: ReadonlyArray<string> }> {
  override get message(): string {
    return this.problems.join("\n")
  }
}

/**
 * Checks `tag` against slopmax's version and the changelog at
 * `changelogPath`, failing on any problem. A dry run (no tag) reports what
 * would refuse a tag of this version and passes, so the builds can be
 * rehearsed before the notes are written.
 */
export const releaseCheck = Effect.fn("Bench.releaseCheck")(function* (
  tag: Option.Option<string>,
  changelogPath: string,
) {
  const changelog = yield* (yield* FileSystem.FileSystem).readFileString(changelogPath)
  const problems = releaseProblems(tag, slopmaxVersion, changelog)
  if (Option.isSome(tag)) {
    if (problems.length > 0) return yield* new NotReleasable({ problems })
    return yield* Console.log(`${tag.value} releases slopmax ${slopmaxVersion}`)
  }
  yield* Console.log(`slopmax ${slopmaxVersion}, dry run`)
  for (const problem of problems) yield* Console.error(`a v${slopmaxVersion} tag would be refused: ${problem}`)
})
