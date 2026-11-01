import { describe, expect, test } from "bun:test"
import { it, MemoryFileSystem } from "@slopmax/test"
import { Effect, FileSystem } from "effect"
import { benchBodies, bodyNames, writeBodies } from "../src/bodies.ts"

const parsed = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object")
  return Object.fromEntries(Object.entries(value))
}

const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

describe("the bench's request bodies", () => {
  const bodies = benchBodies()

  test("are the same bytes every time they are made", () => {
    expect(benchBodies()).toEqual(bodies)
  })

  test("are a first turn and a conversation of about 300 KB for each agent", () => {
    for (const name of ["claude-large", "codex-large"] as const) {
      expect(bodies[name].length).toBeGreaterThan(270_000)
      expect(bodies[name].length).toBeLessThan(330_000)
    }
    expect(bodies["claude-small"].length).toBeLessThan(20_000)
    expect(bodies["codex-small"].length).toBeLessThan(20_000)
  })

  test("Claude's long one has 25 tools, 60 tool turns with signed thinking, and a long system prompt", () => {
    const body = parsed(bodies["claude-large"])
    expect(body["model"]).toBe("claude-opus-5-5")
    expect(body["stream"]).toBe(true)
    expect(list(body["tools"])).toHaveLength(25)
    const messages = list(body["messages"])
    expect(messages).toHaveLength(121)
    expect(JSON.stringify(messages[1])).toContain(`"signature":"${"S".repeat(400)}"`)
    expect(JSON.stringify(body["system"]).length).toBeGreaterThan(10_000)
    expect(JSON.parse(String(parsed(JSON.stringify(body["metadata"]))["user_id"]))).toEqual({
      device_id: "d".repeat(64),
      account_uuid: "",
      session_id: "bench",
    })
  })

  test("Claude's first turn says hi with no tools", () => {
    const body = parsed(bodies["claude-small"])
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }])
    expect(body["tools"]).toEqual([])
  })

  test("Codex's long one has 60 rounds of a message, reasoning, a shell call and its output", () => {
    const body = parsed(bodies["codex-large"])
    expect(body["model"]).toBe("gpt-6-sol")
    expect(body["prompt_cache_key"]).toBe("bench")
    const input = list(body["input"])
    expect(input).toHaveLength(240)
    expect(input.slice(0, 4).map((item) => parsed(JSON.stringify(item))["type"])).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ])
    expect(list(parsed(bodies["codex-small"])["input"])).toHaveLength(1)
  })

  it.effect("are written as {name}.json, making the directory", () =>
    Effect.gen(function* () {
      const fileOf = yield* writeBodies("/bench/bodies")
      const fs = yield* FileSystem.FileSystem
      for (const name of bodyNames) {
        expect(fileOf(name)).toBe(`/bench/bodies/${name}.json`)
        expect(yield* fs.readFileString(fileOf(name))).toBe(bodies[name])
      }
    }).pipe(Effect.provide(MemoryFileSystem.layer)),
  )
})
