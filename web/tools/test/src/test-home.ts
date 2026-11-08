// A throwaway home directory on the real disk, for the few tests that need a
// real file system: locks shared with another process, watching files, and
// file modes. Each one is a fresh `slopmax-<name>-<random>` directory under
// the OS temp directory and is deleted when its scope closes, so no test ever
// touches the user's own ~/.slopmax, ~/.claude or ~/.codex.
import { Context, Effect, FileSystem, Layer, Path, type PlatformError, type Scope } from "effect"

export interface Shape {
  /** The temp directory itself. It stands in for `$HOME`, with symlinks resolved. */
  readonly root: string
  /** Where slopmax keeps its files (`$SLOPMAX_HOME`). Not created: slopmax makes it, private. */
  readonly slopmax: string
  /** Claude Code's config directory (`$CLAUDE_CONFIG_DIR`). Not created. */
  readonly claude: string
  /** Codex's home (`$CODEX_HOME`). Not created. */
  readonly codex: string
  /** `$XDG_CONFIG_HOME`, where login services are installed. Not created. */
  readonly config: string
  /** The environment a child process needs to see only this home. */
  readonly env: Readonly<
    Record<"HOME" | "SLOPMAX_HOME" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "XDG_CONFIG_HOME", string>
  >
  /** A path inside the home. */
  readonly path: (...segments: ReadonlyArray<string>) => string
}

/** Keeps the name to characters that are safe in a directory name. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-") || "home"

/** Creates a home that lasts as long as the surrounding scope. */
export const make = (
  name: string,
): Effect.Effect<Shape, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const made = yield* fs.makeTempDirectoryScoped({ prefix: `slopmax-${safeName(name)}-` })
    // macOS puts the temp directory behind a symlink; paths compare equal only once resolved.
    const root = yield* fs.realPath(made)
    const at = (...segments: ReadonlyArray<string>) => path.join(root, ...segments)
    const slopmax = at(".slopmax")
    const claude = at(".claude")
    const codex = at(".codex")
    const config = at(".config")
    return {
      root,
      slopmax,
      claude,
      codex,
      config,
      env: { HOME: root, SLOPMAX_HOME: slopmax, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, XDG_CONFIG_HOME: config },
      path: at,
    }
  })

export class TestHome extends Context.Service<TestHome, Shape>()("@slopmax/test/TestHome") {
  /** A home named `name` that lasts as long as the surrounding scope. */
  static readonly make = make

  /** A home named `name`, removed when the layer is released. */
  static readonly layer = (
    name = "home",
  ): Layer.Layer<TestHome, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(TestHome, make(name))
}
