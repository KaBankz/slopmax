// Filler text from a fixed seed, so every bench run sends the same bytes
// and two runs (or two machines) measure the same requests.

const vocabulary: ReadonlyArray<string> = [
  "the",
  "quick",
  "brown",
  "fox",
  "jumps",
  "over",
  "lazy",
  "dog",
  "file",
  "path",
  "function",
  "return",
  "value",
  "error",
  "test",
  "build",
]

/** A source of filler words: each call to `text` continues where the last one stopped. */
export interface Words {
  /** `count` words, separated by single spaces. */
  readonly text: (count: number) => string
}

/** Words picked by a 64-bit xorshift generator started at `seed` (7 for the bench's bodies). */
export const makeWords = (seed: bigint): Words => {
  let state = BigInt.asUintN(64, seed)
  const size = BigInt(vocabulary.length)
  const next = (): string => {
    state = BigInt.asUintN(64, state ^ (state << 13n))
    state ^= state >> 7n
    state = BigInt.asUintN(64, state ^ (state << 17n))
    return vocabulary[Number(state % size)] ?? ""
  }
  return {
    text: (count) => {
      const out: Array<string> = []
      for (let i = 0; i < count; i += 1) out.push(next())
      return out.join(" ")
    },
  }
}
