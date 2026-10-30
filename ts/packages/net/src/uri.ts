// What the `http` crate's `Uri` parser accepts, for URLs and proxy
// addresses that must fail (and pass) exactly where Rust's did. WHATWG's
// URL parser is more forgiving in some places and stricter in others.

const table = (chars: string): Uint8Array => {
  const out = new Uint8Array(256)
  for (let i = 0; i < chars.length; i++) out[chars.charCodeAt(i)] = 1
  return out
}

const range = (from: number, to: number): string => {
  let out = ""
  for (let c = from; c <= to; c++) out += String.fromCharCode(c)
  return out
}

// http's URI_CHARS, without the delimiters the authority stops at.
const URI_CHARS = table(`!$&'()*+,-.0123456789:;=@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~`)
const SCHEME_CHARS = table(`+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz~`)
// Bytes a path holds as they are (`?` and `#` end it).
const PATH_CHARS = table(`!${range(0x24, 0x3b)}=${range(0x40, 0x5f)}${range(0x61, 0x7a)}|~"{}`)
const QUERY_CHARS = table(`!${range(0x24, 0x3b)}=${range(0x3f, 0x7e)}`)

const INVALID_CHAR = "invalid uri character"
const INVALID_AUTHORITY = "invalid authority"
const MAX_LEN = 65534
const MAX_SCHEME = 64

/** Where the authority starting at `from` ends, or http's error. */
const authorityEnd = (bytes: Uint8Array, from: number): number | string => {
  let colons = 0
  let open = false
  let close = false
  let percent = false
  let end = bytes.length
  let at = bytes.length
  for (let i = from; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    if (b === 0x2f || b === 0x3f || b === 0x23) {
      end = i
      break
    }
    if (URI_CHARS[b] === 0) {
      if (b !== 0x25) return INVALID_CHAR
      percent = true
    } else if (b === 0x3a) {
      if (colons >= 8) return INVALID_AUTHORITY
      colons++
    } else if (b === 0x5b) {
      if (percent || open) return INVALID_AUTHORITY
      open = true
    } else if (b === 0x5d) {
      if (!open || close) return INVALID_AUTHORITY
      close = true
      colons = 0
      percent = false
    } else if (b === 0x40) {
      at = i
      colons = 0
      percent = false
    }
  }
  if (open !== close || colons > 1) return INVALID_AUTHORITY
  if (end > from && at === end - 1) return INVALID_AUTHORITY
  if (percent) return INVALID_AUTHORITY
  return end
}

// http's check of a path and query; anything from `#` on is dropped.
const pathProblem = (bytes: Uint8Array, from: number): string | undefined => {
  let i = from
  for (; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    if (b === 0x3f) {
      i++
      break
    }
    if (b === 0x23) return undefined
    if (b < 0x80 && PATH_CHARS[b] === 0) return INVALID_CHAR
  }
  for (; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    if (b === 0x23) return undefined
    if (b < 0x80 && QUERY_CHARS[b] === 0) return INVALID_CHAR
  }
  return undefined
}

// Where a `scheme://` prefix ends, 0 without one, or http's error.
const schemeEnd = (bytes: Uint8Array): number | string => {
  if (bytes.length <= 3) return 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    if (b === 0x3a) {
      if (bytes.length < i + 3 || bytes[i + 1] !== 0x2f || bytes[i + 2] !== 0x2f) return 0
      return i > MAX_SCHEME ? "scheme too long" : i + 3
    }
    if (SCHEME_CHARS[b] === 0) return 0
  }
  return 0
}

const utf8 = new TextEncoder()

/** What http makes of a URI: its scheme (when it has one) and authority, or http's error. */
export type Parsed =
  | { readonly ok: true; readonly scheme: string | undefined; readonly authority: string }
  | { readonly ok: false; readonly error: string }

const failed = (error: string): Parsed => ({ ok: false, error })

/** `text` as http's `Uri` parses it. */
export const parse = (text: string): Parsed => {
  const bytes = utf8.encode(text)
  if (bytes.length > MAX_LEN) return failed("uri too long")
  if (bytes.length === 0) return failed("empty string")
  if (bytes[0] === 0x2f) {
    const problem = pathProblem(bytes, 0)
    return problem === undefined ? { ok: true, scheme: undefined, authority: "" } : failed(problem)
  }
  const start = schemeEnd(bytes)
  if (typeof start === "string") return failed(start)
  const end = authorityEnd(bytes, start)
  if (typeof end === "string") return failed(end)
  // Every byte before `end` is ASCII, so it indexes the text as well.
  const authority = text.slice(start, end)
  if (start === 0) {
    return end === bytes.length ? { ok: true, scheme: undefined, authority } : failed("invalid format")
  }
  if (end === start) return failed("invalid format")
  const problem = end === bytes.length ? undefined : pathProblem(bytes, end)
  if (problem !== undefined) return failed(problem)
  const scheme = text.slice(0, start - 3)
  const lower = scheme.toLowerCase()
  return { ok: true, scheme: lower === "http" || lower === "https" ? lower : scheme, authority }
}
