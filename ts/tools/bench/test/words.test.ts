import { describe, expect, test } from "bun:test"
import { makeWords } from "../src/words.ts"

describe("filler words", () => {
  test("come from a 64-bit xorshift started at the seed, so every run writes the same text", () => {
    expect(makeWords(7n).text(8)).toBe("dog jumps build fox brown over quick jumps")
    expect(makeWords(7n).text(500)).toBe(makeWords(7n).text(500))
  })

  test("continue where the last call stopped", () => {
    const once = makeWords(7n).text(5)
    const split = makeWords(7n)
    expect(`${split.text(2)} ${split.text(3)}`).toBe(once)
  })

  test("differ from seed to seed", () => {
    expect(makeWords(8n).text(20)).not.toBe(makeWords(7n).text(20))
  })
})
