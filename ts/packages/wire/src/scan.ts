// Reading a request body for the few values routing needs, without parsing it.
//
// slopmax forwards a client's body as the client wrote it: re-serializing it
// would reorder keys, reformat numbers and cost a full parse of what is mostly
// conversation text. So the proxy validates the bytes once, then finds the
// model, the stream flag or the session by walking only what lies before them,
// and swaps a value in place when routing renames the model.
//
// Everything here is a plain function over a `Uint8Array`, allocation-free on
// the walk itself. The walkers after `isJson` assume a body `isJson` accepted:
// on anything else they answer "not found" rather than guess.

/** One step of a path into a document: an object member's name, or an array index. */
export type Step = string | number

/** Where a value lies in a body: from `start` up to, not including, `end`. */
export interface Range {
  readonly start: number
  readonly end: number
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_OBJECT = 0x7b
const CLOSE_OBJECT = 0x7d
const OPEN_ARRAY = 0x5b
const CLOSE_ARRAY = 0x5d
const MINUS = 0x2d
const PLUS = 0x2b
const DOT = 0x2e
const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

const isSpace = (b: number | undefined): boolean => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09

const isDigit = (b: number | undefined): boolean => b !== undefined && b >= DIGIT_0 && b <= DIGIT_9

const isHex = (b: number | undefined): boolean =>
  b !== undefined && ((b >= DIGIT_0 && b <= DIGIT_9) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66))

const skipSpace = (bytes: Uint8Array, at: number): number => {
  let i = at
  while (isSpace(bytes[i])) i++
  return i
}

// ---------------------------------------------------------------------------
// Validation

const IN_OBJECT = 1
const IN_ARRAY = 2

/** The bytes after `\` that JSON allows besides `u`: `" \ / b f n r t`. */
const isShortEscape = (b: number | undefined): boolean =>
  b === QUOTE || b === BACKSLASH || b === 0x2f || b === 0x62 || b === 0x66 || b === 0x6e || b === 0x72 || b === 0x74

/**
 * Whether any of the four bytes packed in `word` is a quote, a backslash or a
 * control character: the bytes a string's scan must stop at. A word with none
 * of them is passed over whole. (Each test sets a byte's high bit when that
 * byte matches; a borrow can only add a match above a real one, so a word
 * never passes wrongly, and a wrong stop is settled byte by byte.)
 */
const stopsIn = (word: number): boolean => {
  const quote = word ^ 0x22222222
  const backslash = word ^ 0x5c5c5c5c
  const marks =
    ((word - 0x20202020) & ~word) | ((quote - 0x01010101) & ~quote) | ((backslash - 0x01010101) & ~backslash)
  return (marks & 0x80808080) !== 0
}

/**
 * Where the string opening at `at` ends, checking it on the way: no raw
 * control characters, and only JSON's escapes. -1 when it is not a
 * well-formed string. `words` is the body read four bytes at a time, starting
 * at byte `base`.
 *
 * Bytes above 0x7f are taken as they are, so a string that is not valid UTF-8
 * passes here. Such a body is still forwarded exactly as sent (its provider
 * refuses it), and `findString` decodes strictly, so no value routing reads
 * from it can carry broken text.
 *
 * Strings are nearly all of a request body, and every POST is validated, so
 * this is the proxy's hottest loop. Most of a string's bytes are plain text,
 * so it passes over four at a time and looks at single bytes only around a
 * quote, an escape or a control character. On 300 KB conversations this
 * validated a body in about half the time of a byte-at-a-time loop, under
 * both the JIT and the ahead-of-time compiler, and well ahead of searching
 * with `indexOf`, whose fixed cost per call adds up over the escaped newlines
 * common in conversation text.
 */
const checkString = (bytes: Uint8Array, words: Int32Array, base: number, at: number): number => {
  const length = bytes.length
  const wordCount = words.length
  let i = at + 1
  for (;;) {
    if (((i - base) & 3) === 0) {
      let w = (i - base) >> 2
      while (w < wordCount && !stopsIn(words[w] ?? 0)) w++
      i = base + (w << 2)
    }
    if (i >= length) return -1
    const b = bytes[i] ?? 0
    if (b === QUOTE) return i + 1
    if (b === BACKSLASH) {
      const escaped = bytes[i + 1]
      if (escaped === 0x75) {
        if (!isHex(bytes[i + 2]) || !isHex(bytes[i + 3]) || !isHex(bytes[i + 4]) || !isHex(bytes[i + 5])) return -1
        i += 6
      } else if (isShortEscape(escaped)) {
        i += 2
      } else {
        return -1
      }
    } else if (b < 0x20) {
      return -1
    } else {
      i++
    }
  }
}

const noWords = new Int32Array(0)

/** Where the number starting at `at` ends, by JSON's grammar; -1 when it is not one. */
const checkNumber = (bytes: Uint8Array, at: number): number => {
  let i = bytes[at] === MINUS ? at + 1 : at
  if (bytes[i] === DIGIT_0) i++
  else if (isDigit(bytes[i])) while (isDigit(bytes[i])) i++
  else return -1
  if (bytes[i] === DOT) {
    i++
    if (!isDigit(bytes[i])) return -1
    while (isDigit(bytes[i])) i++
  }
  if (bytes[i] === 0x65 || bytes[i] === 0x45) {
    i++
    if (bytes[i] === PLUS || bytes[i] === MINUS) i++
    if (!isDigit(bytes[i])) return -1
    while (isDigit(bytes[i])) i++
  }
  return i
}

const TRUE = [0x74, 0x72, 0x75, 0x65]
const FALSE = [0x66, 0x61, 0x6c, 0x73, 0x65]
const NULL = [0x6e, 0x75, 0x6c, 0x6c]

const checkWord = (bytes: Uint8Array, at: number, word: ReadonlyArray<number>): number => {
  for (let k = 0; k < word.length; k++) if (bytes[at + k] !== word[k]) return -1
  return at + word.length
}

/** Where a member's value starts, after its name and colon at `at`; -1 when there is no such member. */
const checkName = (bytes: Uint8Array, words: Int32Array, base: number, at: number): number => {
  if (bytes[at] !== QUOTE) return -1
  const end = checkString(bytes, words, base, at)
  if (end < 0) return -1
  const colon = skipSpace(bytes, end)
  return bytes[colon] === COLON ? skipSpace(bytes, colon + 1) : -1
}

/**
 * Whether the bytes are exactly one JSON document (with surrounding
 * whitespace). Only a valid body is inspected: anything else is forwarded as
 * it came, with no model or session read from it. Nesting has no depth
 * limit, and numbers are checked for their grammar, never converted.
 */
export const isJson = (bytes: Uint8Array): boolean => {
  // The body as whole 32-bit words, from its first byte at a 4-byte boundary.
  const base = (4 - (bytes.byteOffset & 3)) & 3
  const words =
    bytes.length >= base + 4
      ? new Int32Array(bytes.buffer, bytes.byteOffset + base, (bytes.length - base) >> 2)
      : noWords
  // The open containers, innermost last.
  let open = new Uint8Array(64)
  let depth = 0
  let i = skipSpace(bytes, 0)
  for (;;) {
    // A value starts at `i`.
    const b = bytes[i]
    if (b === OPEN_OBJECT || b === OPEN_ARRAY) {
      const close = b === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY
      i = skipSpace(bytes, i + 1)
      if (bytes[i] === close) {
        i++
      } else {
        if (depth === open.length) {
          const grown = new Uint8Array(depth * 2)
          grown.set(open)
          open = grown
        }
        open[depth++] = b === OPEN_OBJECT ? IN_OBJECT : IN_ARRAY
        if (b === OPEN_OBJECT) {
          i = checkName(bytes, words, base, i)
          if (i < 0) return false
        }
        continue
      }
    } else if (b === QUOTE) {
      i = checkString(bytes, words, base, i)
    } else if (b === 0x74) {
      i = checkWord(bytes, i, TRUE)
    } else if (b === 0x66) {
      i = checkWord(bytes, i, FALSE)
    } else if (b === 0x6e) {
      i = checkWord(bytes, i, NULL)
    } else {
      i = checkNumber(bytes, i)
    }
    if (i < 0) return false
    // A value ended: close what it ends, or move to the next one.
    for (;;) {
      i = skipSpace(bytes, i)
      if (depth === 0) return i === bytes.length
      const inside = open[depth - 1]
      const c = bytes[i]
      if (c === COMMA) {
        i = skipSpace(bytes, i + 1)
        if (inside === IN_OBJECT) {
          i = checkName(bytes, words, base, i)
          if (i < 0) return false
        }
        break
      }
      if (c !== (inside === IN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY)) return false
      depth--
      i++
    }
  }
}

// ---------------------------------------------------------------------------
// Walking a valid body

/**
 * Where the string opening at `at` ends. Conversation text is most of a body,
 * so the closing quote is found with the engine's native search: the next
 * quote ends the string unless an odd run of backslashes escapes it.
 */
const stringEnd = (bytes: Uint8Array, at: number): number => {
  if (bytes[at] !== QUOTE) return -1
  let from = at + 1
  for (;;) {
    const quote = bytes.indexOf(QUOTE, from)
    if (quote < 0) return -1
    let backslashes = 0
    while (quote - backslashes - 1 > at && bytes[quote - backslashes - 1] === BACKSLASH) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    from = quote + 1
  }
}

/** Where the value starting at `at` ends; -1 when there is none. */
const valueEnd = (bytes: Uint8Array, at: number): number => {
  const b = bytes[at]
  if (b === undefined) return -1
  if (b === QUOTE) return stringEnd(bytes, at)
  if (b === OPEN_OBJECT || b === OPEN_ARRAY) {
    let depth = 0
    let i = at
    while (i < bytes.length) {
      const c = bytes[i]
      if (c === QUOTE) {
        i = stringEnd(bytes, i)
        if (i < 0) return -1
        continue
      }
      if (c === OPEN_OBJECT || c === OPEN_ARRAY) depth++
      else if ((c === CLOSE_OBJECT || c === CLOSE_ARRAY) && --depth === 0) return i + 1
      i++
    }
    return -1
  }
  // A number or a word: it runs to the next delimiter.
  let i = at
  while (i < bytes.length) {
    const c = bytes[i]
    if (c === COMMA || c === CLOSE_OBJECT || c === CLOSE_ARRAY || isSpace(c)) break
    i++
  }
  return i > at ? i : -1
}

const encoder = new TextEncoder()

/** A member name as the bytes it must match: ASCII names, which are all slopmax looks for, need no encoding. */
const nameBytes = (name: string): string | Uint8Array => {
  for (let k = 0; k < name.length; k++) if (name.charCodeAt(k) > 0x7f) return encoder.encode(name)
  return name
}

/** Whether the raw name between `start` and `end` (quotes excluded) is `name`, byte for byte. */
const nameIs = (bytes: Uint8Array, start: number, end: number, name: string | Uint8Array): boolean => {
  if (end - start !== name.length) return false
  if (typeof name === "string") {
    for (let k = 0; k < name.length; k++) if (bytes[start + k] !== name.charCodeAt(k)) return false
  } else {
    for (let k = 0; k < name.length; k++) if (bytes[start + k] !== name[k]) return false
  }
  return true
}

/**
 * Visits the members of the object opening at `at`, in order, with each name's
 * range (quotes excluded) and its value's range, until `visit` returns true.
 * The range that stopped it, or undefined at the end of the object or on
 * anything malformed.
 */
const members = (
  bytes: Uint8Array,
  at: number,
  visit: (nameStart: number, nameEnd: number) => boolean,
): Range | undefined => {
  if (bytes[at] !== OPEN_OBJECT) return undefined
  let i = skipSpace(bytes, at + 1)
  if (bytes[i] === CLOSE_OBJECT) return undefined
  for (;;) {
    const nameEnd = stringEnd(bytes, i)
    if (nameEnd < 0) return undefined
    const colon = skipSpace(bytes, nameEnd)
    if (bytes[colon] !== COLON) return undefined
    const start = skipSpace(bytes, colon + 1)
    const end = valueEnd(bytes, start)
    if (end < 0) return undefined
    if (visit(i + 1, nameEnd - 1)) return { start, end }
    i = skipSpace(bytes, end)
    if (bytes[i] !== COMMA) return undefined
    i = skipSpace(bytes, i + 1)
  }
}

/** The value of the first member called `name` in the object opening at `at`. */
const member = (bytes: Uint8Array, at: number, name: string): Range | undefined => {
  const wanted = nameBytes(name)
  return members(bytes, at, (start, end) => nameIs(bytes, start, end, wanted))
}

/** The element at `index` of the array opening at `at`. */
const element = (bytes: Uint8Array, at: number, index: number): Range | undefined => {
  if (bytes[at] !== OPEN_ARRAY) return undefined
  let i = skipSpace(bytes, at + 1)
  if (bytes[i] === CLOSE_ARRAY) return undefined
  for (let k = 0; ; k++) {
    const end = valueEnd(bytes, i)
    if (end < 0) return undefined
    if (k === index) return { start: i, end }
    i = skipSpace(bytes, end)
    if (bytes[i] !== COMMA) return undefined
    i = skipSpace(bytes, i + 1)
  }
}

/**
 * Where the value at `path` lies, scanning only what comes before it, so a
 * field near the start of a large body is found at once. Each step is a
 * member name or an array index. The first member with a name wins, and names
 * compare as raw bytes, so an escaped spelling of a name does not match. No
 * steps means the whole document. Undefined when the path leads nowhere.
 */
export const find = (bytes: Uint8Array, ...path: ReadonlyArray<Step>): Range | undefined => findPath(bytes, path)

const findPath = (bytes: Uint8Array, path: ReadonlyArray<Step>): Range | undefined => {
  const start = skipSpace(bytes, 0)
  if (path.length === 0) {
    const end = valueEnd(bytes, start)
    return end < 0 ? undefined : { start, end }
  }
  let at = start
  let found: Range | undefined
  for (const step of path) {
    found = typeof step === "string" ? member(bytes, at, step) : element(bytes, at, step)
    if (found === undefined) return undefined
    at = found.start
  }
  return found
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * The text of a JSON string's bytes (quotes included), or undefined when it is
 * not valid UTF-8 or holds an escaped lone surrogate, which no text can carry.
 */
const decodeString = (bytes: Uint8Array, range: Range): string | undefined => {
  try {
    const inner = bytes.subarray(range.start + 1, range.end - 1)
    // Most strings have no escapes at all: their bytes are their text.
    if (inner.indexOf(BACKSLASH) < 0) return utf8.decode(inner)
    const value: unknown = JSON.parse(utf8.decode(bytes.subarray(range.start, range.end)))
    return typeof value === "string" && value.isWellFormed() ? value : undefined
  } catch {
    return undefined
  }
}

/** The string at `path`, decoded; undefined when there is no string there. */
export const findString = (bytes: Uint8Array, ...path: ReadonlyArray<Step>): string | undefined => {
  const range = findPath(bytes, path)
  return range === undefined || bytes[range.start] !== QUOTE ? undefined : decodeString(bytes, range)
}

/** Whether the value at `path` is the literal `true`, as a request's `stream` flag is. */
export const isTrue = (bytes: Uint8Array, ...path: ReadonlyArray<Step>): boolean => {
  const range = findPath(bytes, path)
  return range !== undefined && range.end - range.start === 4 && checkWord(bytes, range.start, TRUE) === range.end
}

/**
 * How many members of the top-level object are called `name`. A body that
 * names `model` twice could be routed by one and answered by the other, since
 * the proxy reads the first and most JSON parsers keep the last; a client key
 * held to some models refuses it. Escaped spellings count here, since a parser
 * upstream would read them as the name. 0 when the body is not an object.
 */
export const countTopLevel = (bytes: Uint8Array, name: string): number => {
  const wanted = nameBytes(name)
  let count = 0
  members(bytes, skipSpace(bytes, 0), (start, end) => {
    if (nameIs(bytes, start, end, wanted)) count++
    else if (
      bytes.subarray(start, end).indexOf(BACKSLASH) >= 0 &&
      decodeString(bytes, { start: start - 1, end: end + 1 }) === name
    )
      count++
    return false
  })
  return count
}

/** The body with the bytes in `range` replaced, every other byte left as it was. */
export const splice = (bytes: Uint8Array, range: Range, replacement: string | Uint8Array): Uint8Array => {
  const middle = typeof replacement === "string" ? encoder.encode(replacement) : replacement
  const out = new Uint8Array(bytes.length - (range.end - range.start) + middle.length)
  out.set(bytes.subarray(0, range.start), 0)
  out.set(middle, range.start)
  out.set(bytes.subarray(range.end), range.start + middle.length)
  return out
}
