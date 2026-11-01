// @slopmax/bench is a set of commands, not a library: `src/main.ts` is the
// command line (mock, bodies, rig, run, demo, gates, release-check), and
// its modules are imported by path by the bench's own tests.
export { benchCli } from "./main.ts"
