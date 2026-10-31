// Test support for what goes through the provider registry: loading the
// registry (so `ProviderId.get` finds every real provider), and putting a
// stand-in provider in it for one test file.
import { afterAll, beforeAll } from "bun:test"

import { install, type Provider } from "../../src/provider/mod.ts"
// Loading the registry installs every provider where `ProviderId.get` finds it.
export { PROVIDERS } from "../../src/provider/registry.ts"

/** Puts `providers` in the registry for the test file, and the real ones back after. */
export const installForFile = (providers: ReadonlyArray<Provider>): void => {
  const previous: Array<Provider> = []
  beforeAll(() => {
    for (const provider of providers) {
      const was = install(provider)
      if (was !== undefined) previous.push(was)
    }
  })
  afterAll(() => {
    for (const provider of previous) install(provider)
  })
}
