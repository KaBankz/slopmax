import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Stream } from "effect"
import { isYes, make } from "../src/terminal.ts"
import { pipedTerminal } from "./support.ts"

const piped = (lines: ReadonlyArray<string>) => {
  const { shown, layer } = pipedTerminal(lines)
  return { shown, prompter: make(false).pipe(Effect.provide(layer)) }
}

describe("Prompter", () => {
  it("reads yes only from y or yes, in any case and with spaces", () => {
    expect(["y", "Y", " yes ", "YES"].every(isYes)).toBe(true)
    expect(["", "n", "no", "yep", "ok"].some(isYes)).toBe(false)
  })

  it.effect("answers a yes-or-no question from one line, and with its default once stdin ends", () =>
    Effect.gen(function* () {
      const { shown, prompter } = piped(["yes", "nope", ""])
      const ask = yield* prompter
      expect(yield* ask.confirm("Reset it?", false)).toBe(true)
      expect(yield* ask.confirm("Reset it?", true)).toBe(false)
      expect(yield* ask.confirm("Reset it?", true)).toBe(true)
      expect(yield* ask.confirm("Reset it?", false)).toBe(false)
      expect(shown[0]).toBe("Reset it? [y/N] ")
    }),
  )

  it.effect("reads a secret from the whole of stdin, trimmed, when it is not a terminal", () =>
    Effect.gen(function* () {
      const ask = yield* piped(["  sk-secret-key  ", ""]).prompter
      expect(yield* ask.secret("xAI API key")).toBe("sk-secret-key")
      const empty = yield* piped([]).prompter
      expect(yield* empty.secret("xAI API key")).toBe("")
    }),
  )

  it.effect("takes the defaults for choices when nobody can be asked", () =>
    Effect.gen(function* () {
      const ask = yield* piped(["2"]).prompter
      const choices = [
        { value: "a", title: "a" },
        { value: "b", title: "b" },
      ]
      expect(yield* ask.choose("Which?", choices, "b")).toBe("b")
      expect(yield* ask.chooseMany("Which?", choices, ["a"])).toEqual(["a"])
      expect(yield* ask.text("Base URL:", "chat")).toBe("2")
      expect(yield* ask.text("Base URL:", "chat")).toBe("chat")
    }),
  )

  it.effect("gives a waiting sign-in each line typed or pasted, in order, until stdin ends", () =>
    Effect.gen(function* () {
      const ask = yield* piped(["http://localhost:1455/auth/callback?code=x", "second"]).prompter
      const lines = yield* Stream.runCollect(ask.lines)
      expect([...lines]).toEqual(["http://localhost:1455/auth/callback?code=x", "second"])
      // A question after them finds stdin over and takes its default.
      expect(yield* ask.confirm("Again?", true)).toBe(true)
    }),
  )
})
