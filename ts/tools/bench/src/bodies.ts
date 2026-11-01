// The request bodies the bench sends: a first turn and a long conversation
// of about 300 KB, for Claude Code and for Codex. The long ones are shaped
// like real agent traffic (tools, tool turns with thinking and signatures,
// a long system prompt; Codex's reasoning items and shell calls), since
// what the proxy costs grows with the body it has to peek at and forward.
import { Effect, FileSystem, Path } from "effect"
import { makeWords } from "./words.ts"

/** The four bodies, by file name without `.json`. */
export const bodyNames = ["claude-small", "claude-large", "codex-small", "codex-large"] as const
export type BodyName = (typeof bodyNames)[number]

/** Every body as the JSON text sent, the same bytes on every run. */
export const benchBodies = (): Readonly<Record<BodyName, string>> => {
  const words = makeWords(7n)

  const userId = JSON.stringify({ device_id: "d".repeat(64), account_uuid: "", session_id: "bench" })
  const tools = Array.from({ length: 25 }, (_tool, i) => {
    const properties = Object.fromEntries(
      Array.from({ length: 6 }, (_property, j) => [`p${j}`, { type: "string", description: words.text(15) }] as const),
    )
    return { name: `Tool${i}`, description: words.text(120), input_schema: { type: "object", properties } }
  })
  const turns: Array<unknown> = []
  for (let i = 0; i < 60; i += 1) {
    turns.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: words.text(500) }],
    })
    turns.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: words.text(60), signature: "S".repeat(400) },
        { type: "tool_use", id: `t${i + 1}`, name: "Tool3", input: { p0: words.text(40) } },
      ],
    })
  }
  turns.push({ role: "user", content: "continue" })
  const system = `You are Claude Code. ${words.text(2500)}`
  const claude = (messages: ReadonlyArray<unknown>, withTools: ReadonlyArray<unknown>) =>
    JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      stream: true,
      thinking: { type: "adaptive" },
      metadata: { user_id: userId },
      system: [{ type: "text", text: system }],
      tools: withTools,
      messages,
    })
  const claudeSmall = claude([{ role: "user", content: "hi" }], [])
  const claudeLarge = claude(turns, tools)

  const items: Array<unknown> = []
  for (let i = 0; i < 60; i += 1) {
    const command = JSON.stringify({ command: ["bash", "-lc", words.text(30)] })
    items.push(
      { type: "message", role: "user", content: [{ type: "input_text", text: words.text(200) }] },
      { type: "reasoning", summary: [], encrypted_content: "E".repeat(600) },
      { type: "function_call", name: "shell", arguments: command, call_id: `c${i}` },
      { type: "function_call_output", call_id: `c${i}`, output: words.text(500) },
    )
  }
  const instructions = `You are Codex. ${words.text(1500)}`
  const codex = (input: ReadonlyArray<unknown>) =>
    JSON.stringify({
      model: "gpt-6-sol",
      instructions,
      input,
      tools: [],
      store: false,
      stream: true,
      prompt_cache_key: "bench",
    })
  const hi = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]

  return {
    "claude-small": claudeSmall,
    "claude-large": claudeLarge,
    "codex-small": codex(hi),
    "codex-large": codex(items),
  }
}

/** Writes the bodies into `dir` as `{name}.json`, making it when missing; gives the path of each. */
export const writeBodies = Effect.fn("Bench.writeBodies")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(dir, { recursive: true })
  const fileOf = (name: BodyName) => path.join(dir, `${name}.json`)
  const bodies = benchBodies()
  for (const name of bodyNames) yield* fs.writeFileString(fileOf(name), bodies[name])
  return fileOf
})
