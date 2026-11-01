// The files that ship slopmax, checked against each other: CI runs the
// tasks that exist, the release builds every archive install.sh can ask
// for, and the image is what the docs say it is.
import { describe, expect, test } from "bun:test"

const ts = `${import.meta.dir}/../../..`
const repo = `${ts}/..`

const read = (path: string) => Bun.file(path).text()

/** A YAML or TOML value's field, when it is an object; nothing otherwise. */
const at = (value: unknown, ...keys: ReadonlyArray<string>): unknown =>
  keys.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? Reflect.get(current, key)
        : undefined,
    value,
  )
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])
const keysOf = (value: unknown): ReadonlyArray<string> =>
  typeof value === "object" && value !== null ? Object.keys(value) : []

/** Every `run:` of a job, joined. */
const runsOf = (workflow: unknown, job: string): string =>
  list(at(workflow, "jobs", job, "steps"))
    .map((step) => at(step, "run"))
    .filter((run): run is string => typeof run === "string")
    .join("\n")

const ci = Bun.YAML.parse(await read(`${repo}/.github/workflows/ts-ci.yml`))
const release = Bun.YAML.parse(await read(`${repo}/.github/workflows/ts-release.yml`))
const earlierRelease = Bun.YAML.parse(await read(`${repo}/.github/workflows/release.yml`))
const mise = Bun.TOML.parse(await read(`${ts}/mise.toml`))
const install = await read(`${ts}/install.sh`)
const dockerfile = await read(`${ts}/Dockerfile`)

describe("CI", () => {
  test("runs only mise tasks that exist", () => {
    const tasks = new Set(keysOf(at(mise, "tasks")))
    for (const workflow of [ci, release]) {
      for (const job of keysOf(at(workflow, "jobs"))) {
        for (const [, task] of runsOf(workflow, job).matchAll(/mise run ([\w-]+)/g)) {
          if (task !== undefined && !task.startsWith("$")) expect(tasks.has(task)).toBe(true)
        }
      }
    }
  })

  test("checks every change on Linux and macOS, and on Bun canary", () => {
    expect(list(at(ci, "jobs", "check", "strategy", "matrix", "os"))).toEqual(["ubuntu-latest", "macos-latest"])
    expect(runsOf(ci, "check")).toBe("mise run check")
    expect(runsOf(ci, "canary")).toBe("mise run canary")
  })

  test("holds the binary to its size budget in a job of its own", () => {
    expect(at(ci, "jobs", "budget", "name")).toBe("Size budget")
    expect(runsOf(ci, "budget")).toBe("mise run budget")
  })

  test("runs the CLI tests on both the ahead-of-time binary and the fallback, explaining the AOT build", () => {
    const builds = list(at(ci, "jobs", "binary", "strategy", "matrix", "include"))
    expect(builds.map((build) => at(build, "task"))).toEqual(["compile", "build"])
    expect(at(builds[0], "args")).toBe("--explain")
    expect(runsOf(ci, "binary")).toContain("bun test apps/cli/test")
    const steps = list(at(ci, "jobs", "binary", "steps"))
    expect(steps.some((step) => String(at(step, "env", "SLOPMAX_BIN")).endsWith("ts/apps/cli/dist/slopmax"))).toBe(true)
  })

  test("runs the performance gates, keeping their figures as JSON", () => {
    expect(runsOf(ci, "gates")).toContain('mise run gates -- --json "$RUNNER_TEMP/gates.json"')
    expect(at(ci, "defaults", "run", "shell")).toBe("bash")
    // Known failing until the daemon meets §16; no other job may be let off.
    for (const job of keysOf(at(ci, "jobs"))) {
      expect(at(ci, "jobs", job, "continue-on-error") === true).toBe(job === "gates")
    }
  })
})

describe("the release", () => {
  /** Every archive install.sh can ask for. */
  const installable = ["x86_64", "aarch64"].flatMap((arch) =>
    ["unknown-linux-gnu", "unknown-linux-musl", "apple-darwin"].map((os) => `${arch}-${os}`),
  )

  test("runs only by hand until the TypeScript slopmax is chosen to ship, checking a tag when it has one", () => {
    expect(keysOf(at(release, "on"))).toEqual(["workflow_dispatch"])
    expect(runsOf(release, "check")).toContain('release-check --tag "$GITHUB_REF_NAME"')
  })

  test("leaves every v* tag to the earlier slopmax's release.yml meanwhile", () => {
    // Both would create the release and upload archives of the same names.
    expect(at(earlierRelease, "on", "push", "tags")).toEqual(["v*"])
  })

  test("takes its notes from CHANGELOG.md", () => {
    const steps = list(at(release, "jobs", "release", "steps"))
    const notes = steps.find((step) => String(at(step, "uses")).startsWith("taiki-e/create-gh-release-action"))
    expect(at(notes, "with", "changelog")).toBe("CHANGELOG.md")
  })

  test("builds every archive install.sh can ask for, with the binary at its root and a checksum", () => {
    const targets = list(at(release, "jobs", "binaries", "strategy", "matrix", "include")).map((entry) =>
      at(entry, "target"),
    )
    expect(targets.toSorted()).toEqual(installable.toSorted())
    const packaging = runsOf(release, "binaries")
    expect(packaging).toContain('archive="slopmax-${{ matrix.target }}.tar.gz"')
    expect(packaging).toContain('tar -C "$out/root" -czf "$out/$archive" slopmax')
    expect(packaging).toContain('shasum -a 256 "$archive" > "$archive.sha256"')
  })

  test("tries each binary where it can run: on the host, or the musl one in its Alpine image", () => {
    const packaging = runsOf(release, "binaries")
    expect(packaging).toContain('if [ "${{ matrix.via }}" = mise ]; then "$out/root/slopmax" --version; fi')
    expect(packaging).toContain("docker run --rm slopmax --version")
    const docker = list(at(release, "jobs", "binaries", "strategy", "matrix", "include")).filter(
      (entry) => at(entry, "via") === "docker",
    )
    expect(docker.map((entry) => at(entry, "target"))).toEqual([
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
    ])
  })

  test("downloads, in install.sh, the archive names the release uploads", () => {
    expect(install).toContain('archive="slopmax-$target.tar.gz"')
    expect(install).toContain('"$base/$archive.sha256"')
  })
})

describe("the container image", () => {
  test("builds on Alpine in a stage the release reuses, and runs serve from /usr/local/bin with its data in /data", () => {
    expect(dockerfile).toMatch(/^FROM oven\/bun:canary-alpine AS build$/m)
    expect(runsOf(release, "binaries")).toContain("docker build --target build")
    expect(dockerfile).toMatch(/^FROM alpine:3$/m)
    expect(dockerfile).toContain("COPY --from=build /src/apps/cli/dist/slopmax /usr/local/bin/slopmax")
    expect(dockerfile).toContain("SLOPMAX_HOME=/data")
    expect(dockerfile).toContain("SLOPMAX_LISTEN=0.0.0.0:7567")
    expect(dockerfile).toMatch(/^VOLUME \/data$/m)
    expect(dockerfile).toMatch(/^EXPOSE 7567$/m)
    expect(dockerfile).toMatch(/^ENTRYPOINT \["slopmax"\]$/m)
    expect(dockerfile).toMatch(/^CMD \["serve"\]$/m)
  })
})
