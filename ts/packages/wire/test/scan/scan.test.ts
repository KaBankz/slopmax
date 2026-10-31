import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import * as fc from "fast-check"
import { scan } from "../../src/index.ts"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const text = (body: Uint8Array): string => new TextDecoder().decode(body)
/** The text at a found range, or undefined. */
const at = (body: Uint8Array, range: scan.Range | undefined): string | undefined =>
  range === undefined ? undefined : text(body.subarray(range.start, range.end))

const parses = (source: string): boolean => {
  try {
    JSON.parse(source)
    return true
  } catch {
    return false
  }
}

describe("scan.isJson", () => {
  it("accepts every kind of JSON document, with whitespace around and inside it", () => {
    for (const valid of [
      '{"model":"m","stream":true}',
      " [1, -2.5e+3, 0, 0.25, 1E9, true, false, null] ",
      '"just a string"',
      "-0",
      "{}",
      "[]",
      '{ "a" : { "b" : [ ] } , "c" : [ {} ] }',
      '"escapes \\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9 \\ud83d\\ude00"',
      '"café and \u{1f600} as raw UTF-8"',
      "\n\t\r 7 \n",
    ]) {
      expect([valid, scan.isJson(bytes(valid))]).toEqual([valid, true])
    }
  })

  it("refuses bodies that are not exactly one JSON document", () => {
    for (const invalid of [
      "",
      "   ",
      '{"a":1}{"b":2}',
      '{"a":1,}',
      "[1,]",
      "[1 2]",
      '{"a" 1}',
      "{a:1}",
      '{"a":1',
      '"unterminated',
      '"bad escape \\x"',
      '"short unicode \\u12"',
      '"raw\ttab"',
      "01",
      "1.",
      ".5",
      "-",
      "1e",
      "+1",
      "tru",
      "nul",
      "NaN",
      "[1]]",
      '{"a":1}}',
    ]) {
      expect([invalid, scan.isJson(bytes(invalid))]).toEqual([invalid, false])
    }
  })

  it("follows nesting of any depth without a stack overflow", () => {
    const depth = 100_000
    expect(scan.isJson(bytes("[".repeat(depth) + "]".repeat(depth)))).toBe(true)
    expect(scan.isJson(bytes("[".repeat(depth) + "]".repeat(depth - 1)))).toBe(false)
    expect(scan.isJson(bytes('{"a":'.repeat(depth) + "1" + "}".repeat(depth)))).toBe(true)
  })

  it("agrees with JSON.parse on generated documents and on every one-character cut of them", () => {
    fc.assert(
      fc.property(fc.json(), fc.nat(), (source, cut) => {
        expect(scan.isJson(bytes(source))).toBe(true)
        const chars = Array.from(source)
        const gone = cut % chars.length
        const damaged = chars.slice(0, gone).join("") + chars.slice(gone + 1).join("")
        expect(scan.isJson(bytes(damaged))).toBe(parses(damaged))
      }),
      { numRuns: 500 },
    )
  })
})

/**
 * The bytes of `source` starting `offset` bytes into their buffer. Strings are
 * checked four bytes at a time from the buffer's 4-byte boundaries, so each
 * case is tried at every alignment.
 */
const aligned = (source: string, offset: number): Uint8Array => {
  const encoded = bytes(source)
  const buffer = new Uint8Array(encoded.length + offset)
  buffer.set(encoded, offset)
  return buffer.subarray(offset)
}

describe("scan.isJson on strings", () => {
  const stringBytes = fc.oneof(
    fc.constantFrom('"', "\\", "\n", "\t", "\u0000", "\u001f", "\u007f", "u", "0", "a", "é", "\u{1f600}", " "),
    fc.constantFrom('\\"', "\\\\", "\\n", "\\u00e9", "\\u12", "\\x", "\\/"),
  )

  it("agrees with JSON.parse on strings of quotes, escapes and control characters, at every alignment", () => {
    fc.assert(
      fc.property(fc.array(stringBytes, { maxLength: 40 }), fc.nat(3), fc.boolean(), (pieces, offset, wrapped) => {
        const inner = `"${pieces.join("")}"`
        const source = wrapped ? `{"k":${inner},"n":[${inner}]}` : inner
        expect([source, scan.isJson(aligned(source, offset))]).toEqual([source, parses(source)])
      }),
      { numRuns: 3000 },
    )
  })

  it("finds a control character or a bad escape anywhere in a long string", () => {
    const plain = "abcdefgh".repeat(64)
    for (let k = 0; k < plain.length; k += 7) {
      for (const offset of [0, 1, 2, 3]) {
        const head = plain.slice(0, k)
        const tail = plain.slice(k)
        expect(scan.isJson(aligned(`"${head}${tail}"`, offset))).toBe(true)
        expect(scan.isJson(aligned(`"${head}\u0001${tail}"`, offset))).toBe(false)
        expect(scan.isJson(aligned(`"${head}\\q${tail}"`, offset))).toBe(false)
        expect(scan.isJson(aligned(`"${head}\\"${tail}"`, offset))).toBe(true)
        expect(scan.isJson(aligned(`"${head}`, offset))).toBe(false)
      }
    }
  })
})

describe("scan.find", () => {
  it("finds a value nested inside objects and arrays", () => {
    const body = bytes('{"a":{"b":[10,{"c":"x\\"y"}]},"d":true}')
    expect(at(body, scan.find(body, "a", "b", 1, "c"))).toBe('"x\\"y"')
    expect(scan.findString(body, "a", "b", 1, "c")).toBe('x"y')
    expect(at(body, scan.find(body, "a", "b", 0))).toBe("10")
    expect(at(body, scan.find(body, "d"))).toBe("true")
    expect(scan.find(body, "missing")).toBeUndefined()
    expect(scan.find(body, "a", "b", 9)).toBeUndefined()
    expect(scan.find(body, "a", "b", "c")).toBeUndefined()
    expect(scan.find(body, "d", "e")).toBeUndefined()
  })

  it("ends strings only at an unescaped quote", () => {
    const body = bytes('{"a":"x\\\\\\"y\\\\","b":[1,"]",{"c":"}"}],"model":"m","model":"later"}')
    expect(at(body, scan.find(body, "model"))).toBe('"m"')
    expect(at(body, scan.find(body, "b", 2, "c"))).toBe('"}"')
    expect(scan.find(bytes('{"a":"open\\"}'), "b")).toBeUndefined()
    expect(scan.find(bytes('{"a":"x\\'), "a")).toBeUndefined()
    expect(scan.find(bytes('{"a":"x\\\\'), "a")).toBeUndefined()
  })

  it("takes the first member with a name, matching names byte for byte", () => {
    const body = bytes('{"mod\\u0065l":"escaped","model":"first","model":"second"}')
    expect(scan.findString(body, "model")).toBe("first")
    const unicode = bytes('{"café":"yes"}')
    expect(scan.findString(unicode, "café")).toBe("yes")
  })

  it("gives the whole document for an empty path, and nothing for a malformed one", () => {
    const body = bytes('  {"a":1}  ')
    expect(at(body, scan.find(body))).toBe('{"a":1}')
    expect(scan.find(bytes('{"a":'), "a")).toBeUndefined()
    expect(scan.find(bytes('{"a" 1}'), "a")).toBeUndefined()
    expect(scan.find(bytes("[1"), 1)).toBeUndefined()
    expect(scan.find(bytes(""))).toBeUndefined()
  })

  it("finds every member of a generated object as JSON.parse reads it", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.boolean(), (object, spaced) => {
        const source = spaced ? JSON.stringify(object, null, 2) : JSON.stringify(object)
        const body = bytes(source)
        for (const [name, value] of Object.entries(object)) {
          // Names are matched as written; one JSON has to escape is written differently.
          if (JSON.stringify(name) !== `"${name}"`) continue
          const found = at(body, scan.find(body, name))
          expect(found).toBeDefined()
          expect(JSON.parse(found ?? "")).toEqual(JSON.parse(JSON.stringify(value)))
          if (typeof value === "string") expect(scan.findString(body, name)).toBe(value)
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe("scan.findString", () => {
  it("decodes the string at a path, escapes included", () => {
    const body = bytes('{"metadata":{"user_id":"{\\"session_id\\":\\"s-1\\"}"},"plain":"café","n":3}')
    const inner = scan.findString(body, "metadata", "user_id")
    expect(inner).toBe('{"session_id":"s-1"}')
    expect(scan.findString(bytes(inner ?? ""), "session_id")).toBe("s-1")
    expect(scan.findString(body, "plain")).toBe("café")
  })

  it("gives nothing for values that are not strings or hold no text", () => {
    const body = bytes('{"n":3,"o":{},"lone":"\\ud800","pair":"\\ud83d\\ude00"}')
    expect(scan.findString(body, "n")).toBeUndefined()
    expect(scan.findString(body, "o")).toBeUndefined()
    expect(scan.findString(body, "lone")).toBeUndefined()
    expect(scan.findString(body, "pair")).toBe("\u{1f600}")
    expect(scan.findString(new Uint8Array([0x22, 0xff, 0x22]))).toBeUndefined()
  })
})

describe("scan.isTrue", () => {
  it("reads only the literal true", () => {
    expect(scan.isTrue(bytes('{"stream":true}'), "stream")).toBe(true)
    expect(scan.isTrue(bytes('{"stream" : true }'), "stream")).toBe(true)
    expect(scan.isTrue(bytes('{"stream":false}'), "stream")).toBe(false)
    expect(scan.isTrue(bytes('{"stream":"true"}'), "stream")).toBe(false)
    expect(scan.isTrue(bytes('{"other":true}'), "stream")).toBe(false)
  })
})

describe("scan.countTopLevel", () => {
  it("counts how often the top level names a member, escaped spellings included", () => {
    expect(scan.countTopLevel(bytes('{"model":"a","x":1}'), "model")).toBe(1)
    expect(scan.countTopLevel(bytes('{"model":"a","model":"b"}'), "model")).toBe(2)
    expect(scan.countTopLevel(bytes('{"model":"a","mod\\u0065l":"b"}'), "model")).toBe(2)
    expect(scan.countTopLevel(bytes('{"nested":{"model":"a"},"list":[{"model":"b"}]}'), "model")).toBe(0)
    expect(scan.countTopLevel(bytes("{}"), "model")).toBe(0)
    expect(scan.countTopLevel(bytes('["model"]'), "model")).toBe(0)
  })
})

describe("scan.splice", () => {
  it("replaces a value in place, leaving every other byte as it was", () => {
    const body = bytes('{"model":"a","keep":1}')
    const range = scan.find(body, "model")
    if (range === undefined) throw new Error("expected the model")
    expect(text(scan.splice(body, range, JSON.stringify("bb")))).toBe('{"model":"bb","keep":1}')
    expect(text(scan.splice(body, range, bytes('"c"')))).toBe('{"model":"c","keep":1}')
  })

  it("renames the model of any generated request without touching the rest", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.string(), fc.string(), (rest, model, renamed) => {
        const members = JSON.stringify(rest).slice(1, -1)
        const body = bytes(`{"model":${JSON.stringify(model)}${members === "" ? "" : `,${members}`}}`)
        const range = scan.find(body, "model")
        if (range === undefined) throw new Error("expected the model")
        const spliced = scan.splice(body, range, JSON.stringify(renamed))
        const tail = body.subarray(range.end)
        expect(text(spliced.subarray(0, range.start))).toBe('{"model":')
        expect(spliced.subarray(spliced.length - tail.length)).toEqual(tail)
        expect(scan.findString(spliced, "model")).toBe(renamed)
        expect(scan.isJson(spliced)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})
