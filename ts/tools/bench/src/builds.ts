// The binaries the bench measures, built the way slopmax ships: the CLI
// through its own build script (ahead of time, and the --no-aot fallback),
// and the rig and the raw probe with exactly the flags the CLI's
// ahead-of-time build uses, so the three compare like with like.
import { Effect, FileSystem, Path } from "effect"
import { aotArgs } from "slopmax/build"
import { run } from "./programs.ts"

const benchRoot = `${import.meta.dir}/..`
const cliRoot = `${import.meta.dir}/../../../apps/cli`

/** The rig's entry point and the raw probe's. */
export const entries = {
  rig: `${import.meta.dir}/rig-main.ts`,
  raw: `${benchRoot}/raw.ts`,
} as const

/**
 * The CLI's ahead-of-time arguments for another program: the same flags,
 * the entry swapped for `entry`, and the build's metadata written to
 * `metafile` rather than over the CLI's.
 */
export const retarget = (args: ReadonlyArray<string>, entry: string, metafile: string): ReadonlyArray<string> => [
  ...args.slice(0, -1).map((arg) => (arg.startsWith("--metafile=") ? `--metafile=${metafile}` : arg)),
  entry,
]

/** Builds `entry` ahead of time into `outfile` with the CLI's flags, using the canary Bun `canary`. */
export const compileLikeCli = Effect.fn("Bench.compileLikeCli")(function* (
  canary: ReadonlyArray<string>,
  entry: string,
  outfile: string,
) {
  const fs = yield* FileSystem.FileSystem
  const metafile = `${outfile}.meta.json`
  yield* run([...canary, ...retarget(aotArgs(outfile, false), entry, metafile)], {
    cwd: benchRoot,
    inherit: true,
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(metafile, { force: true }))))
  return outfile
})

/** Where a directory waits while a build writes its own: beside it, so moving it is a rename on one file system. */
const aside = (dir: string) => `${dir}.bench-found`

/**
 * Runs `build`, which writes into `dirs`, and then leaves each as it found
 * it, also when the build fails or is interrupted: one that was there is
 * moved aside meanwhile and moved back, one that was missing is removed.
 * A binary someone built in apps/cli/dist (`mise run compile` before
 * `mise run gates`) is therefore still there, untouched, after the bench
 * has built another in its place.
 */
export const leavingAsFound = <A, E, R>(dirs: ReadonlyArray<string>, build: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.acquireUseRelease(
      Effect.forEach(dirs, (dir) =>
        Effect.gen(function* () {
          // One still aside is a run killed before it could move it back: it is what was found then.
          if (yield* fs.exists(aside(dir))) {
            yield* fs.remove(dir, { recursive: true, force: true })
            yield* fs.rename(aside(dir), dir)
          }
          const found = yield* fs.exists(dir)
          if (found) yield* fs.rename(dir, aside(dir))
          return found
        }),
      ),
      () => build,
      (found) =>
        Effect.forEach(dirs, (dir, i) =>
          Effect.gen(function* () {
            yield* fs.remove(dir, { recursive: true, force: true })
            if (found[i] === true) yield* fs.rename(aside(dir), dir)
          }),
        ).pipe(Effect.orDie),
    )
  })

/** Which of the CLI's builds: `compile` (ahead of time, the shipped one) or `build` (the --no-aot fallback). */
export type CliBuild = "compile" | "build"

/**
 * Builds the CLI with its own script and copies the binary to `outfile`.
 * The script writes `apps/cli/dist` and, for the web UI, `apps/ui/dist`;
 * both are left as they were.
 */
export const buildCli = Effect.fn("Bench.buildCli")(function* (
  canary: ReadonlyArray<string>,
  kind: CliBuild,
  outfile: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dist = path.join(cliRoot, "dist")
  yield* leavingAsFound(
    [dist, path.join(cliRoot, "..", "ui", "dist")],
    Effect.gen(function* () {
      yield* run([...canary, "build.ts", kind], { cwd: cliRoot, inherit: true })
      yield* fs.copyFile(path.join(dist, "slopmax"), outfile)
      yield* fs.chmod(outfile, 0o755)
    }),
  )
  return outfile
})
