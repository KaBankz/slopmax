// `slopmax --version` is what scripts, installers and the desktop app run to
// see which slopmax is there, so it answers here: main.ts imports this module
// first, and modules run in import order, so a version check prints and exits
// before the engine, effect/cli and Bun's platform layer have even loaded.
// The write is synchronous, so nothing is lost when the process exits at once.
import { writeSync } from "node:fs"
import { slopmaxVersion } from "@slopmax/domain/version"

const [only, ...rest] = process.argv.slice(2)
if (rest.length === 0 && (only === "--version" || only === "-v")) {
  writeSync(1, `slopmax ${slopmaxVersion}\n`)
  process.exit(0)
}
