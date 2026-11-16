// A host for tests: the web dashboard's, with storage in memory and every
// link opened, text copied, notification posted and preference saved
// recorded, so a test can check what the app did outside the page.
import { Effect, Option } from "effect"
import { type HostShape, type Permission, UiPrefs } from "../../src/host.ts"

export interface Recorded {
  readonly opened: Array<string>
  readonly copied: Array<string>
  /** Files offered to save. */
  readonly files: Array<{ readonly name: string; readonly text: string }>
  readonly notified: Array<{ readonly title: string; readonly body: string; readonly tag: string }>
  /** Each time the preferences were saved, in order. */
  readonly saved: Array<UiPrefs>
}

export interface TestHost {
  readonly host: HostShape
  readonly recorded: Recorded
}

export interface TestHostOptions {
  readonly key?: string
  readonly permission?: Permission
  /** The dashboard's preferences as saved before it opened. */
  readonly prefs?: UiPrefs
}

export const testHost = (options: TestHostOptions = {}): TestHost => {
  const recorded: Recorded = {
    opened: [],
    copied: [],
    files: [],
    notified: [],
    saved: [],
  }
  let key = Option.fromUndefinedOr(options.key)
  let told: ReadonlyArray<string> = []
  let prefs = options.prefs ?? UiPrefs.defaults
  const host: HostShape = {
    origin: "http://slopmax.test",
    key: Effect.sync(() => key),
    saveKey: (next) =>
      Effect.sync(() => {
        key = Option.some(next)
      }),
    forgetKey: Effect.sync(() => {
      key = Option.none()
    }),
    openExternal: (url) => Effect.sync(() => (recorded.opened.push(url), true)),
    copy: (text) => Effect.sync(() => (recorded.copied.push(text), true)),
    save: (name, text) => Effect.sync(() => (recorded.files.push({ name, text }), true)),
    permission: Effect.succeed(options.permission ?? "default"),
    askPermission: Effect.succeed("granted"),
    notify: (title, body, tag) => Effect.sync(() => void recorded.notified.push({ title, body, tag })),
    told: Effect.sync(() => told),
    saveTold: (next) =>
      Effect.sync(() => {
        told = next
      }),
    prefs: Effect.sync(() => prefs),
    savePrefs: (next) =>
      Effect.sync(() => {
        prefs = next
        recorded.saved.push(next)
      }),
  }
  return { host, recorded }
}
