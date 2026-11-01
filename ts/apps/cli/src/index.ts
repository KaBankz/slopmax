// The slopmax CLI as a library: its command tree over any actions, the
// program that runs it to an exit status, and the real actions. The binary
// is `main.ts`.
export { liveActions } from "./actions.ts"
export { about, type Actions, argsFor, makeCli } from "./cli.ts"
export { exitCode, program } from "./program.ts"
