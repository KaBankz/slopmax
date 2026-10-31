// Byte-level JSON scanning for surgical edits.
//
// Request bodies are forwarded byte-for-byte. Where slopmax must read or
// change a value, these helpers locate it in place: re-serializing through
// a JSON library would reorder keys and reformat numbers in the rest of the
// body. Input must already be valid JSON (see `isValid`).

/** One step of a path into a JSON document: an object key, or an array index. */
export type Seg = string | number

export const Seg = {
  Key: (key: string): Seg => key,
  Index: (index: number): Seg => index,
} as const

/** A byte range, `start` inclusive, `end` exclusive. */
export interface Range {
  readonly start: number
  readonly end: number
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const COLON = 0x3a
const COMMA = 0x2c
const MINUS = 0x2d
const DOT = 0x2e
const ZERO = 0x30
const NINE = 0x39

const isDigit = (b: number | undefined): boolean => b !== undefined && b >= ZERO && b <= NINE

/**
 * `serde_json::from_slice::<IgnoredAny>`: JSON's grammar and nothing more.
 * Nesting has no limit, numbers are not converted (so none is out of
 * range), and a string may hold any byte but a control character, with
 * `\u` escapes checked for their four hex digits only (a lone surrogate
 * passes, as does invalid UTF-8).
 */
export const isValid = (body: Uint8Array): boolean => {
  // The open containers, innermost last.
  const stack: Array<number> = []
  let pos = 0
  for (;;) {
    // A value.
    pos = skipWs(body, pos)
    const first = body[pos]
    if (first === OPEN_BRACE || first === OPEN_BRACKET) {
      const close = first === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET
      pos = skipWs(body, pos + 1)
      if (body[pos] !== close) {
        stack.push(first)
        if (first === OPEN_BRACE) {
          pos = memberKey(body, pos)
          if (pos < 0) return false
        }
        continue
      }
      pos++
    } else if (first === QUOTE) {
      pos = ignoreString(body, pos)
    } else if (first === MINUS) {
      pos = ignoreNumber(body, pos + 1)
    } else if (isDigit(first)) {
      pos = ignoreNumber(body, pos)
    } else if (first === 0x6e) {
      pos = ident(body, pos, NULL)
    } else if (first === 0x74) {
      pos = ident(body, pos, TRUE)
    } else if (first === 0x66) {
      pos = ident(body, pos, FALSE)
    } else {
      return false
    }
    if (pos < 0) return false
    // What follows it: a comma and the next value, or the end of containers.
    for (;;) {
      pos = skipWs(body, pos)
      const open = stack.at(-1)
      if (open === undefined) return pos === body.length
      const b = body[pos]
      if (b === COMMA) {
        pos++
        if (open === OPEN_BRACE) {
          pos = memberKey(body, skipWs(body, pos))
          if (pos < 0) return false
        }
        break
      }
      if (b !== (open === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET)) return false
      stack.pop()
      pos++
    }
  }
}

const NULL = new Uint8Array([0x6e, 0x75, 0x6c, 0x6c])
const TRUE = new Uint8Array([0x74, 0x72, 0x75, 0x65])
const FALSE = new Uint8Array([0x66, 0x61, 0x6c, 0x73, 0x65])

const ident = (body: Uint8Array, pos: number, word: Uint8Array): number => {
  for (let i = 0; i < word.length; i++) if (body[pos + i] !== word[i]) return -1
  return pos + word.length
}

// A member's key and its colon; where its value starts, or -1.
const memberKey = (body: Uint8Array, pos: number): number => {
  if (body[pos] !== QUOTE) return -1
  const end = ignoreString(body, pos)
  if (end < 0) return -1
  const colon = skipWs(body, end)
  return body[colon] === COLON ? colon + 1 : -1
}

// The end of the string at `pos`, or -1.
const ignoreString = (body: Uint8Array, pos: number): number => {
  let i = pos + 1
  for (;;) {
    const b = body[i]
    if (b === undefined) return -1
    if (b === QUOTE) return i + 1
    if (b === BACKSLASH) {
      const e = body[i + 1]
      if (e === 0x75) {
        for (let k = 2; k < 6; k++) if (!isHex(body[i + k])) return -1
        i += 6
        continue
      }
      if (e === undefined || !SIMPLE_ESCAPES.has(e)) return -1
      i += 2
      continue
    }
    if (b < 0x20) return -1
    i++
  }
}

// The escapes besides `\u`: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`.
const SIMPLE_ESCAPES: ReadonlySet<number> = new Set([QUOTE, BACKSLASH, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74])

const isHex = (b: number | undefined): boolean =>
  b !== undefined && ((b >= ZERO && b <= NINE) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66))

// The end of the number whose digits start at `pos` (after any minus), or -1.
const ignoreNumber = (body: Uint8Array, pos: number): number => {
  let i = pos
  const first = body[i]
  if (first === ZERO) {
    i++
    // There can be only one leading '0'.
    if (isDigit(body[i])) return -1
  } else if (isDigit(first)) {
    while (isDigit(body[i])) i++
  } else {
    return -1
  }
  if (body[i] === DOT) {
    i++
    if (!isDigit(body[i])) return -1
    while (isDigit(body[i])) i++
  }
  const e = body[i]
  if (e === 0x65 || e === 0x45) {
    i++
    if (body[i] === 0x2b || body[i] === MINUS) i++
    if (!isDigit(body[i])) return -1
    while (isDigit(body[i])) i++
  }
  return i
}

/**
 * Byte range of the value at `path`. Only what lies before the value is
 * scanned, so a key near the start of a large body is found quickly.
 */
export const find = (body: Uint8Array, path: ReadonlyArray<Seg>): Range | undefined => {
  const start = skipWs(body, 0)
  if (path.length === 0) {
    const end = skipValue(body, start)
    return end === undefined ? undefined : { start, end }
  }
  let range: Range | undefined = { start, end: start }
  for (const seg of path) {
    range = typeof seg === "string" ? member(body, range.start, seg) : element(body, range.start, seg)
    if (range === undefined) return undefined
  }
  return range
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** The string at `path`, decoded. */
export const findStr = (body: Uint8Array, path: ReadonlyArray<Seg>): string | undefined => {
  const range = find(body, path)
  if (range === undefined) return undefined
  if (body[range.start] !== QUOTE) return undefined
  try {
    const raw = utf8.decode(body.subarray(range.start, range.end))
    const value: unknown = JSON.parse(raw)
    // serde_json refuses lone surrogates in a `String`.
    return typeof value === "string" && value.isWellFormed() ? value : undefined
  } catch {
    return undefined
  }
}

/** `body` with `range` replaced by `with`. */
export const splice = (body: Uint8Array, range: Range, replacement: Uint8Array | string): Uint8Array => {
  const bytes = typeof replacement === "string" ? encoder.encode(replacement) : replacement
  const out = new Uint8Array(range.start + bytes.length + (body.length - range.end))
  out.set(body.subarray(0, range.start), 0)
  out.set(bytes, range.start)
  out.set(body.subarray(range.end), range.start + bytes.length)
  return out
}

/**
 * The keys of the members of the object `body` holds, as ranges with their
 * quotes, in order (repeated keys included); undefined when it is not an
 * object, or is malformed.
 */
export const keys = (body: Uint8Array): Array<Range> | undefined => {
  const start = skipWs(body, 0)
  if (body[start] !== OPEN_BRACE) return undefined
  const found: Array<Range> = []
  let pos = skipWs(body, start + 1)
  if (body[pos] === CLOSE_BRACE) return found
  for (;;) {
    const keyEnd = skipString(body, pos)
    if (keyEnd === undefined) return undefined
    found.push({ start: pos, end: keyEnd })
    const colon = skipWs(body, keyEnd)
    if (body[colon] !== COLON) return undefined
    const valueEnd = skipValue(body, skipWs(body, colon + 1))
    if (valueEnd === undefined) return undefined
    pos = skipWs(body, valueEnd)
    if (body[pos] === CLOSE_BRACE) return found
    if (body[pos] !== COMMA) return undefined
    pos = skipWs(body, pos + 1)
  }
}

// The value of the first member named `key` in the object at `object`.
const member = (body: Uint8Array, object: number, key: string): Range | undefined => {
  if (body[object] !== OPEN_BRACE) return undefined
  let pos = skipWs(body, object + 1)
  if (body[pos] === CLOSE_BRACE) return undefined
  const wanted = isAscii(key) ? key : encoder.encode(key)
  for (;;) {
    const keyEnd = skipString(body, pos)
    if (keyEnd === undefined) return undefined
    const colon = skipWs(body, keyEnd)
    if (body[colon] !== COLON) return undefined
    const valueStart = skipWs(body, colon + 1)
    const valueEnd = skipValue(body, valueStart)
    if (valueEnd === undefined) return undefined
    if (keyIs(body, pos, keyEnd, wanted)) return { start: valueStart, end: valueEnd }
    pos = skipWs(body, valueEnd)
    if (body[pos] !== COMMA) return undefined
    pos = skipWs(body, pos + 1)
  }
}

// The element at `index` in the array at `array`.
const element = (body: Uint8Array, array: number, index: number): Range | undefined => {
  if (body[array] !== OPEN_BRACKET) return undefined
  let pos = skipWs(body, array + 1)
  if (body[pos] === CLOSE_BRACKET) return undefined
  for (let i = 0; ; i++) {
    const end = skipValue(body, pos)
    if (end === undefined) return undefined
    if (i === index) return { start: pos, end }
    pos = skipWs(body, end)
    if (body[pos] !== COMMA) return undefined
    pos = skipWs(body, pos + 1)
  }
}

// Keys slopmax looks for are ASCII, whose characters are their bytes, so
// they are compared without being encoded on every lookup.
const isAscii = (key: string): boolean => {
  for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) > 0x7f) return false
  return true
}

// Compares a raw key (with quotes) to `key` without decoding it.
const keyIs = (body: Uint8Array, start: number, end: number, key: string | Uint8Array): boolean => {
  if (end - start - 2 !== key.length) return false
  if (typeof key === "string") {
    for (let i = 0; i < key.length; i++) if (body[start + 1 + i] !== key.charCodeAt(i)) return false
  } else {
    for (let i = 0; i < key.length; i++) if (body[start + 1 + i] !== key[i]) return false
  }
  return true
}

const skipWs = (body: Uint8Array, pos: number): number => {
  let at = pos
  for (;;) {
    const b = body[at]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0d && b !== 0x0a) return at
    at++
  }
}

// Strings are most of a conversation, so their ends are found with the
// engine's native search rather than byte by byte: the next quote is the
// end unless an odd run of backslashes escapes it.
const skipString = (body: Uint8Array, pos: number): number | undefined => {
  if (body[pos] !== QUOTE) return undefined
  let from = pos + 1
  for (;;) {
    const quote = body.indexOf(QUOTE, from)
    if (quote < 0) return undefined
    let slashes = 0
    while (quote - slashes - 1 >= pos + 1 && body[quote - slashes - 1] === BACKSLASH) slashes++
    if (slashes % 2 === 0) return quote + 1
    from = quote + 1
  }
}

const skipValue = (body: Uint8Array, pos: number): number | undefined => {
  const first = body[pos]
  if (first === undefined) return undefined
  if (first === QUOTE) return skipString(body, pos)
  if (first === OPEN_BRACE || first === OPEN_BRACKET) {
    let depth = 0
    let i = pos
    while (i < body.length) {
      const b = body[i]
      if (b === QUOTE) {
        const end = skipString(body, i)
        if (end === undefined) return undefined
        i = end
        continue
      }
      if (b === OPEN_BRACE || b === OPEN_BRACKET) depth++
      else if (b === CLOSE_BRACE || b === CLOSE_BRACKET) {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    return undefined
  }
  let end = pos
  while (end < body.length) {
    const b = body[end]
    if (
      b === COMMA ||
      b === CLOSE_BRACE ||
      b === CLOSE_BRACKET ||
      b === 0x20 ||
      b === 0x09 ||
      b === 0x0d ||
      b === 0x0a
    ) {
      break
    }
    end++
  }
  return end > pos ? end : undefined
}
