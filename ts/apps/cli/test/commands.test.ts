import { describe, expect, it } from "bun:test"

import { Result } from "effect"

import { agent, ProviderId } from "@slopmax/core"

import { parse } from "../src/args.ts"
import { AGENTS, APP, endpoint, onOff, PROVIDERS } from "../src/commands.ts"

describe("commands", () => {
  it("agent_choices_match_the_registry", () => {
    expect(AGENTS.map((c) => c.value)).toEqual(agent.AGENTS.map((a) => a.id))
    expect(PROVIDERS.map((c) => c.value)).toEqual([...ProviderId.ALL])
  })

  it("every_command_parses_a_typical_invocation", () => {
    const lines = [
      "init --yes",
      "status --refresh",
      "ls -w",
      "login claude --label work",
      "login codex --device --no-browser",
      "login compat --url http://localhost:11434/v1 --models qwen3-coder,llama4",
      "import cliproxyapi --own",
      "own all",
      "use auto",
      "label 1 work",
      "priority 3 -1",
      "enable 1",
      "disable work",
      "remove me@x.dev",
      "redeem 3 --yes",
      "serve",
      "start",
      "stop",
      "service status",
      "run codex exec -c model=m hi",
      "env claude",
      "setup codex --undo",
      "usage 30d --by model",
      "config strategy round-robin",
      "setup --yes --import none --strategy fill-first --affinity off --agents none",
      "notify",
      "key add laptop --models gpt-*",
      "logs -f -n 100",
      "dashboard --print",
      "doctor",
      "completions fish",
    ]
    for (const line of lines) {
      const parsed = parse(APP, line.split(" "))
      expect(Result.isSuccess(parsed) && parsed.success._tag === "Run", line).toBe(true)
    }
    for (const command of APP.commands) {
      const typical = lines.some((l) => {
        const first = l.split(" ")[0]
        return first === command.name || first === command.alias
      })
      expect(typical, `add a typical \`${command.name}\` invocation above`).toBe(true)
    }
  })
})

describe("commands, beyond the Rust tests", () => {
  it("lists the commands in the Rust's order", () => {
    expect(APP.commands.map((c) => c.name)).toEqual([
      "setup",
      "status",
      "login",
      "import",
      "own",
      "use",
      "label",
      "priority",
      "enable",
      "disable",
      "remove",
      "redeem",
      "serve",
      "start",
      "stop",
      "service",
      "run",
      "env",
      "config",
      "usage",
      "key",
      "logs",
      "notify",
      "dashboard",
      "doctor",
      "completions",
    ])
  })

  it("reads endpoints and switches", () => {
    const e = endpoint("http://h:1/v1//", undefined, " a, ,b ")
    expect(Result.isSuccess(e) && e.success).toEqual({ baseUrl: "http://h:1/v1", dialect: "chat", models: ["a", "b"] })
    const bad = endpoint("ftp://h", undefined, undefined)
    expect(Result.isFailure(bad) && bad.failure.message).toBe(
      '--url takes an http:// or https:// base URL, got "ftp://h"',
    )
    const soap = endpoint("http://h", "soap", undefined)
    expect(Result.isFailure(soap) && soap.failure.message).toBe(
      '--dialect takes chat, responses, or messages, got "soap"',
    )
    expect(onOff("yes")).toEqual(Result.succeed(true))
    expect(onOff("no")).toEqual(Result.succeed(false))
    const maybe = onOff("maybe")
    expect(Result.isFailure(maybe) && maybe.failure.message).toBe('expected on or off, got "maybe"')
  })
})
