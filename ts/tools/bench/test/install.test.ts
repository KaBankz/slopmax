// ts/install.sh, run with `sh` against a fake GitHub: `uname`, `ldd` and
// `curl` are stubs on PATH, and the "release" is a directory of archives.
import { describe, expect } from "bun:test"
import { Platform } from "@slopmax/core"
import { it } from "@slopmax/test"
import { Effect, FileSystem, Path, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const script = `${import.meta.dir}/../../../install.sh`

interface Machine {
  readonly os?: string
  readonly arch?: string
  readonly libc?: "gnu" | "musl"
  /** Release files by name, under `releases/latest/download` or `releases/download/<tag>`. */
  readonly files?: Readonly<Record<string, Uint8Array | string>>
  readonly env?: Readonly<Record<string, string>>
  readonly withCurl?: boolean
  /** Put the install directory on PATH. */
  readonly onPath?: boolean
  /** An x86-64 CPU without AVX2: /proc/cpuinfo, as grep reads it, lists no avx2. */
  readonly noAvx2?: boolean
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** Makes a release archive holding a `slopmax` (or, to break it, another name) that prints its version. */
const archiveWith = (dir: string, version: string, name = "slopmax") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(dir, "archive-root")
    yield* fs.makeDirectory(root, { recursive: true })
    yield* fs.writeFileString(path.join(root, name), `#!/bin/sh\necho "slopmax ${version}"\n`)
    yield* fs.chmod(path.join(root, name), 0o755)
    const archive = path.join(dir, "slopmax.tar.gz")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* Effect.scoped(
      Effect.flatMap(spawner.spawn(ChildProcess.make("tar", ["-C", root, "-czf", archive, name])), (h) => h.exitCode),
    )
    const bytes = yield* fs.readFile(archive)
    const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    return { bytes, sum }
  })

const install = (machine: Machine) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-install-test-" })
    const bin = path.join(root, "bin")
    const release = path.join(root, "release")
    const home = path.join(root, "home")
    for (const dir of [bin, release, home]) yield* fs.makeDirectory(dir, { recursive: true })
    for (const [name, content] of Object.entries(machine.files ?? {})) {
      const file = path.join(release, name)
      yield* typeof content === "string" ? fs.writeFileString(file, content) : fs.writeFile(file, content)
    }
    const stub = (name: string, body: string) =>
      Effect.andThen(
        fs.writeFileString(path.join(bin, name), `#!/bin/sh\n${body}\n`),
        fs.chmod(path.join(bin, name), 0o755),
      )
    yield* stub(
      "uname",
      `case "$1" in -s) echo "${machine.os ?? "Linux"}" ;; -m) echo "${machine.arch ?? "x86_64"}" ;; esac`,
    )
    yield* stub("ldd", machine.libc === "musl" ? 'echo "musl libc (x86_64)"; exit 1' : 'echo "ldd (GNU libc) 2.40"')
    const grep = Bun.which("grep")
    if (machine.noAvx2 === true && grep !== null) {
      // Finds nothing in /proc/cpuinfo, and is the real grep for everything else.
      yield* stub("grep", `for last; do :; done\n[ "$last" = /proc/cpuinfo ] && exit 1\nexec ${grep} "$@"`)
    }
    if (machine.withCurl !== false) {
      // Serves https://github.com/KaBankz/slopmax/releases/{latest/download,download/<tag>}/<file> from the release directory, logging each URL.
      yield* stub(
        "curl",
        [
          'out=""; url=""',
          'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
          'echo "$url" >> "$CURL_LOG"',
          'file="$RELEASE/$(basename "$url")"',
          '[ -f "$file" ] || exit 22',
          'cp "$file" "$out"',
        ].join("\n"),
      )
    }
    for (const tool of [
      "sh",
      "cat",
      "cut",
      "grep",
      "mktemp",
      "rm",
      "tar",
      "gzip",
      "mkdir",
      "install",
      "sha256sum",
      "shasum",
      "perl",
      "basename",
      "cp",
      "chmod",
      "printf",
    ]) {
      const found = Bun.which(tool)
      if (found !== null && !(yield* fs.exists(path.join(bin, tool)))) yield* fs.symlink(found, path.join(bin, tool))
    }
    const handle = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", [script], {
        env: {
          PATH: machine.onPath === true ? `${bin}:${machine.env?.["SLOPMAX_INSTALL_DIR"] ?? ""}` : bin,
          HOME: home,
          RELEASE: release,
          CURL_LOG: path.join(root, "curl.log"),
          ...machine.env,
        },
        extendEnv: false,
        stdin: "ignore",
      }),
    )
    const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
      concurrency: "unbounded",
    })
    const asked = (yield* fs.exists(path.join(root, "curl.log")))
      ? yield* fs.readFileString(path.join(root, "curl.log"))
      : ""
    const installed = path.join(home, ".local", "bin", "slopmax")
    return {
      code: Number(code),
      stdout,
      stderr,
      asked: asked.split("\n").filter((line) => line !== ""),
      installed: (yield* fs.exists(installed)) ? installed : undefined,
      home,
      root,
    }
  })

const withArchive = (target: string, machine: Omit<Machine, "files"> = {}, sum?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-install-archive-" })
    const archive = yield* archiveWith(dir, "0.4.0")
    return yield* install({
      ...machine,
      files: {
        [`slopmax-${target}.tar.gz`]: archive.bytes,
        [`slopmax-${target}.tar.gz.sha256`]: `${sum ?? archive.sum}  slopmax-${target}.tar.gz\n`,
      },
    })
  })

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope

const live = (name: string, body: () => Effect.Effect<unknown, unknown, Services>) =>
  it.live(name, () => Effect.provide(body(), Platform.layer), 20_000)

describe("install.sh", () => {
  live("downloads the glibc build for Linux on x86-64, checks it, and installs it into ~/.local/bin", () =>
    Effect.gen(function* () {
      const ran = yield* withArchive("x86_64-unknown-linux-gnu")
      expect(ran.stderr).toBe("")
      expect(ran.code).toBe(0)
      expect(ran.asked).toEqual([
        "https://github.com/KaBankz/slopmax/releases/latest/download/slopmax-x86_64-unknown-linux-gnu.tar.gz",
        "https://github.com/KaBankz/slopmax/releases/latest/download/slopmax-x86_64-unknown-linux-gnu.tar.gz.sha256",
      ])
      expect(ran.installed).toBeDefined()
      expect(ran.stdout).toContain("Downloading slopmax for x86_64-unknown-linux-gnu…")
      expect(ran.stdout).toContain(`Installed slopmax 0.4.0 to ${ran.home}/.local/bin/slopmax`)
      expect(ran.stdout).toContain(`Add ${ran.home}/.local/bin to your PATH, then run \`slopmax\` to set it up.`)
    }),
  )

  live("downloads the musl build where the C library is musl", () =>
    Effect.gen(function* () {
      const ran = yield* withArchive("aarch64-unknown-linux-musl", { arch: "aarch64", libc: "musl" })
      expect(ran.code).toBe(0)
      expect(ran.stdout).toContain("Downloading slopmax for aarch64-unknown-linux-musl…")
    }),
  )

  live("names macOS builds apple-darwin, and arm64 aarch64", () =>
    Effect.gen(function* () {
      const ran = yield* withArchive("aarch64-apple-darwin", { os: "Darwin", arch: "arm64" })
      expect(ran.code).toBe(0)
      expect(ran.stdout).toContain("Downloading slopmax for aarch64-apple-darwin…")
    }),
  )

  live("installs a tagged release into the directory asked for, and says to run it when that is on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-install-dir-" })
      const archiveDir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-install-archive-" })
      const archive = yield* archiveWith(archiveDir, "0.4.0")
      const ran = yield* install({
        files: { "slopmax-x86_64-unknown-linux-gnu.tar.gz": archive.bytes },
        env: { SLOPMAX_VERSION: "v0.4.0", SLOPMAX_INSTALL_DIR: dir },
      })
      expect(ran.code).toBe(0)
      expect(ran.asked[0]).toBe(
        "https://github.com/KaBankz/slopmax/releases/download/v0.4.0/slopmax-x86_64-unknown-linux-gnu.tar.gz",
      )
      expect(yield* fs.exists(`${dir}/slopmax`)).toBe(true)
      const onPath = yield* install({
        files: { "slopmax-x86_64-unknown-linux-gnu.tar.gz": archive.bytes },
        env: { SLOPMAX_INSTALL_DIR: dir },
        onPath: true,
      })
      expect(onPath.code).toBe(0)
      expect(onPath.stdout).toContain("Run `slopmax` to set it up.")
    }),
  )

  live("refuses an archive whose checksum does not match", () =>
    Effect.gen(function* () {
      const ran = yield* withArchive("x86_64-unknown-linux-gnu", {}, "0".repeat(64))
      expect(ran.code).toBe(1)
      expect(ran.stderr).toBe("slopmax install: checksum mismatch for slopmax-x86_64-unknown-linux-gnu.tar.gz\n")
      expect(ran.installed).toBeUndefined()
    }),
  )

  live("says which download failed", () =>
    Effect.gen(function* () {
      const ran = yield* install({ files: {} })
      expect(ran.code).toBe(1)
      expect(ran.stderr).toBe(
        "slopmax install: could not download https://github.com/KaBankz/slopmax/releases/latest/download/slopmax-x86_64-unknown-linux-gnu.tar.gz\n",
      )
    }),
  )

  live("has no binary for other systems or processors, and says how to build one", () =>
    Effect.gen(function* () {
      const windows = yield* install({ os: "MINGW64_NT" })
      expect(windows.code).toBe(1)
      expect(windows.stderr).toStartWith("slopmax install: no prebuilt binary for MINGW64_NT; build it from a checkout")
      expect(windows.stderr).toContain("mise run install")
      const riscv = yield* install({ arch: "riscv64" })
      expect(riscv.stderr).toStartWith("slopmax install: no prebuilt binary for riscv64;")
    }),
  )

  // install.sh reads the CPU's flags from /proc/cpuinfo, which only Linux has.
  it.live.skipIf(process.platform !== "linux")(
    "refuses an x86-64 CPU without AVX2, before downloading anything",
    () =>
      Effect.gen(function* () {
        const ran = yield* withArchive("x86_64-unknown-linux-gnu", { noAvx2: true })
        expect(ran.code).toBe(1)
        expect(ran.stderr).toBe("slopmax install: slopmax needs an x86-64 CPU with AVX2\n")
        expect(ran.asked).toEqual([])
        const arm = yield* withArchive("aarch64-unknown-linux-gnu", { arch: "aarch64", noAvx2: true })
        expect(arm.code).toBe(0)
      }).pipe(Effect.provide(Platform.layer)),
    20_000,
  )

  live("refuses an archive with no slopmax at its root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-install-archive-" })
      const archive = yield* archiveWith(dir, "0.4.0", "slopmax-0.4.0")
      const ran = yield* install({ files: { "slopmax-x86_64-unknown-linux-gnu.tar.gz": archive.bytes } })
      expect(ran.code).toBe(1)
      expect(ran.stderr).toBe("slopmax install: slopmax-x86_64-unknown-linux-gnu.tar.gz has no slopmax at its root\n")
      expect(ran.installed).toBeUndefined()
    }),
  )

  live("needs curl", () =>
    Effect.gen(function* () {
      const ran = yield* install({ withCurl: false })
      expect(ran.code).toBe(1)
      expect(ran.stderr).toBe("slopmax install: curl is required\n")
    }),
  )
})
