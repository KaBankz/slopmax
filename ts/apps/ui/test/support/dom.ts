// A browser's window for component tests: happy-dom's, put on globalThis
// before React loads, with React told it runs under a test's `act`.
//
// `bun test` runs every package's files in one process, so the window must not
// outlive the file that drew in it: happy-dom swaps in its own fetch,
// AbortSignal, Request and the like, which the daemon's and the CLI's tests
// would otherwise meet. A file that draws calls `useBrowser()` once.
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll } from "bun:test"

declare global {
  // React reads this to know a test drives it.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const open = () => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "http://slopmax.test/slopmax/" })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
}

// Open at once, so react-dom finds a document when it first loads.
if (typeof window === "undefined") open()

/**
 * The window the app is drawn in. happy-dom makes `window` the global object
 * itself, so this stays the live window each time `useBrowser` reopens it.
 */
export const browser: Window = window

/** Opens the window for this file's tests and takes it away after them. */
export const useBrowser = () => {
  beforeAll(open)
  afterAll(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()
  })
}
