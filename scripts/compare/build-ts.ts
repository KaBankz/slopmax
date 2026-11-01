// Builds the TypeScript rig and raw probe exactly like the AOT CLI (run with Bun canary).
const ts = process.argv[2]!, out = process.argv[3]!
const { aotArgs } = await import(`${ts}/apps/cli/build.ts`)
const { retarget } = await import(`${ts}/tools/bench/src/builds.ts`)
for (const [name, entry] of [["rig", `${ts}/tools/bench/src/rig-main.ts`], ["raw", `${ts}/tools/bench/raw.ts`]]) {
  const args = retarget(aotArgs(`${out}/${name}`, false), entry, `${out}/${name}.meta.json`)
  const p = Bun.spawnSync([process.execPath, ...args], { cwd: `${ts}/tools/bench`, stdio: ["inherit", "inherit", "inherit"] })
  if (p.exitCode !== 0) process.exit(1)
}
