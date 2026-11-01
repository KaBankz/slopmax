// What the CLI's in-process tests share: a terminal that is not one.
import { Effect, FileSystem, Layer, Path, Terminal } from "effect"

/** A terminal that is not one: these lines on stdin, then its end; what is shown is kept in `shown`. */
export const pipedTerminal = (lines: ReadonlyArray<string>) => {
  const left = [...lines]
  const shown: Array<string> = []
  const terminal = Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    size: Effect.die("unused"),
    readInput: Effect.die("unused"),
    readLine: Effect.suspend(() => {
      const next = left.shift()
      return next === undefined ? Effect.fail(new Terminal.QuitError({})) : Effect.succeed(next)
    }),
    display: (text) => Effect.sync(() => void shown.push(text)),
  })
  const layer = Layer.mergeAll(Layer.succeed(Terminal.Terminal, terminal), FileSystem.layerNoop({}), Path.layer)
  return { shown, layer }
}
