// The window's preferences: its size and place, the sidebar, the appearance,
// and whether notices are posted. They live in Electron's user data
// (`prefs.json`), apart from slopmax's own home, since they belong to this
// app on this machine rather than to the proxy. A missing, unreadable or
// invalid file reads as the defaults; the app never fails to open over it.
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { DesktopPrefs } from "@slopmax/domain/desktop"

const PrefsJson = Schema.fromJsonString(DesktopPrefs)

/** The preferences a file's text holds; the defaults when it does not decode. */
export const readPrefs = (text: string): DesktopPrefs =>
  Option.getOrElse(Schema.decodeUnknownOption(PrefsJson)(text), () => DesktopPrefs.defaults)

/** The file's text for `prefs`: indented, so it reads well if someone opens it. */
export const writePrefs = (prefs: DesktopPrefs): string =>
  `${JSON.stringify(Schema.encodeSync(DesktopPrefs)(prefs), null, 2)}\n`

export interface Shape {
  readonly get: Effect.Effect<DesktopPrefs>
  /** The preferences now, then each change. */
  readonly changes: Stream.Stream<DesktopPrefs>
  /** Changes them now and keeps them for next time; a save that fails is logged, and the change still holds. */
  readonly set: (prefs: DesktopPrefs) => Effect.Effect<void>
  readonly update: (change: (prefs: DesktopPrefs) => DesktopPrefs) => Effect.Effect<void>
}

const make = Effect.fn("Prefs.make")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const loaded = yield* fs.readFileString(file).pipe(
    Effect.map(readPrefs),
    Effect.orElseSucceed(() => DesktopPrefs.defaults),
  )
  const current = yield* SubscriptionRef.make(loaded)
  // Saves never interleave, so the file always holds one whole save.
  const saving = yield* Semaphore.make(1)

  // Each save writes what is held when its turn comes, so two changes racing for the
  // file can never leave it older than the preferences in memory.
  const save = saving
    .withPermit(
      Effect.gen(function* () {
        const temp = `${file}.${process.pid}.tmp`
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(temp, writePrefs(yield* SubscriptionRef.get(current)))
        yield* fs.rename(temp, file)
      }),
    )
    .pipe(Effect.catch((error) => Effect.logWarning(`could not save ${file}: ${error.message}`)))

  return {
    get: SubscriptionRef.get(current),
    changes: SubscriptionRef.changes(current),
    set: (prefs) => Effect.andThen(SubscriptionRef.set(current, prefs), save),
    update: (change) => Effect.andThen(SubscriptionRef.update(current, change), save),
  } satisfies Shape
})

export class Prefs extends Context.Service<Prefs, Shape>()("slopmax-desktop/Prefs") {
  /** Preferences kept in `file`. */
  static readonly layer = (file: string): Layer.Layer<Prefs, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(Prefs, make(file))
}
