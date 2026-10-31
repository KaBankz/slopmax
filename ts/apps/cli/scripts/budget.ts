// The CLI's budgets (DIST-004), as `mise run budget` keeps them: third-party
// npm packages in the binary's dependency tree (the workspace's own packages
// left out), and the size of the shipped `dist/slopmax`. Either over budget
// fails.
//
//   bun scripts/budget.ts   # after `bun run compile`
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import process from "node:process"

const PACKAGES = 8
const BYTES = 73_400_320

interface Manifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest

// Where `name` resolves from `dir`, as Node looks it up: each `node_modules`
// from `dir` up (Bun's isolated installs put a package's own dependencies
// beside it).
const locate = (name: string, from: string): string | undefined => {
  for (let dir = from; ; dir = dirname(dir)) {
    const inside = join(dir, "node_modules", name)
    if (existsSync(join(inside, "package.json"))) return realpathSync(inside)
    if (basename(dir) === "node_modules" && existsSync(join(dir, name, "package.json"))) {
      return realpathSync(join(dir, name))
    }
    if (dirname(dir) === dir) return undefined
  }
}

const here = join(dirname(new URL(import.meta.url).pathname), "..")
const thirdParty = new Set<string>()
const seen = new Set<string>()
const walk = (dir: string): void => {
  if (seen.has(dir)) return
  seen.add(dir)
  const manifest = read(dir)
  const optional = manifest.peerDependenciesMeta ?? {}
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => optional[name]?.optional !== true),
  ]
  for (const name of names) {
    const found = locate(name, dir)
    if (found === undefined) {
      process.stderr.write(`${manifest.name} needs ${name}, which is not installed; run bun install\n`)
      process.exit(1)
    }
    const spec = manifest.dependencies?.[name] ?? ""
    if (!spec.startsWith("workspace:")) {
      const dependency = read(found)
      thirdParty.add(`${dependency.name}@${dependency.version}`)
    }
    walk(found)
  }
}
walk(here)

let over = false
const packages = [...thirdParty].toSorted()
console.log(`${packages.length} packages for slopmax (budget ${PACKAGES})`)
if (packages.length > PACKAGES) {
  console.log(packages.join("\n"))
  over = true
}

const binary = join(here, "dist/slopmax")
if (!existsSync(binary)) {
  process.stderr.write("no dist/slopmax; run `bun run compile` first\n")
  process.exit(1)
}
const bytes = statSync(binary).size
console.log(`${bytes} bytes (budget ${BYTES})`)
if (bytes > BYTES) over = true
process.exit(over ? 1 : 0)
