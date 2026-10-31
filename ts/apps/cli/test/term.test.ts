import { describe, expect, it } from "bun:test"

import { parseChoices } from "../src/term.ts"

describe("term", () => {
  it("choices_are_numbers_from_one", () => {
    expect(parseChoices("1", 3)).toEqual([0])
    expect(parseChoices("3, 1 3", 3)).toEqual([2, 0])
    expect(parseChoices("4", 3)).toBeUndefined()
    expect(parseChoices("0", 3)).toBeUndefined()
    expect(parseChoices("two", 3)).toBeUndefined()
    expect(parseChoices(" ", 3)).toBeUndefined()
  })
})
