// The app's state against the stub API, without React: a registry holding
// the host, the key and the stub as the page's transport, the way the app
// starts in a browser or in the desktop window.
import { Effect, Option } from "effect"
import { type Atom, AtomRegistry } from "effect/reactivity"
import { hostAtom, ownerKeyAtom, transportAtom } from "../../src/api.ts"
import { prefsAtom } from "../../src/atoms.ts"
import { type TestHost, testHost, type TestHostOptions } from "./host.ts"
import { makeStub, type Stub, type StubOptions, stubTransport } from "./stub-api.ts"

export interface Harness {
  readonly registry: AtomRegistry.AtomRegistry
  readonly stub: Stub
  readonly host: TestHost
  /** Runs an action atom as a control would, keeping it mounted until it settles. */
  readonly run: <W>(atom: Atom.Writable<unknown, W>, value: W) => void
  readonly close: () => Promise<void>
}

/** Gives a registry the values the app starts from, as main.tsx does, with the stub as its way out. */
export const start = (registry: AtomRegistry.AtomRegistry, host: TestHost, stub: Stub, key: Option.Option<string>) => {
  registry.set(hostAtom, Option.some(host.host))
  registry.set(ownerKeyAtom, key)
  registry.set(transportAtom, stubTransport(stub))
  registry.set(prefsAtom, Effect.runSync(host.host.prefs))
}

export const harness = (options: { readonly stub?: StubOptions; readonly host?: TestHostOptions } = {}): Harness => {
  const stub = makeStub(options.stub)
  const host = testHost(options.host)
  const registry = AtomRegistry.make()
  const mounted: Array<() => void> = []
  start(registry, host, stub, Option.fromUndefinedOr(options.host?.key))
  return {
    registry,
    stub,
    host,
    run: (atom, value) => {
      mounted.push(registry.mount(atom))
      registry.set(atom, value)
    },
    close: async () => {
      for (const unmount of mounted) unmount()
      registry.dispose()
      await stub.dispose()
    },
  }
}

/** Waits until `check` holds, for as long as an answer through the stub could take. */
export const until = async (check: () => boolean, what: string, timeout = 3_000): Promise<void> => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)))
    await Bun.sleep(5)
  }
}
