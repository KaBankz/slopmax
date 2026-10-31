// Throwaway directories that a test file removes once its tests are done.
import { afterAll } from "bun:test"
import { rmSync } from "node:fs"

import { tempDir } from "../../src/testkit.ts"

/**
 * `tempDir`, each directory removed after the calling file's tests. Call it
 * at the top level of a test file, where `afterAll` belongs to that file.
 */
export const tempDirs = (): ((name: string) => string) => {
  const made: Array<string> = []
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  return (name) => {
    const dir = tempDir(name)
    made.push(dir)
    return dir
  }
}
