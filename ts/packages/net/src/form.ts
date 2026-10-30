// `application/x-www-form-urlencoded`, as used by OAuth query strings and
// token requests: the WHATWG serializer and parser.

const HEX = "0123456789ABCDEF"
const utf8 = new TextEncoder()
const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })

/**
 * Encodes `pairs` as `key=value&…`. Alphanumerics and `*-._` pass through,
 * a space becomes `+`, and every other byte is percent-encoded.
 */
export const encode = (pairs: Iterable<readonly [string, string]>): string => {
  let out = ""
  for (const [key, value] of pairs) {
    if (out !== "") out += "&"
    out += encodePart(key)
    out += "="
    out += encodePart(value)
  }
  return out
}

// Each byte as it is written: itself, `+`, or `%XX`.
const ENCODED: ReadonlyArray<string> = Array.from({ length: 256 }, (_, byte) => {
  const passes =
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2a || // *
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f // _
  if (passes) return String.fromCharCode(byte)
  return byte === 0x20 ? "+" : `%${HEX[byte >> 4]}${HEX[byte & 0xf]}`
})

const PLAIN = /^[A-Za-z0-9*\-._]*$/

const encodePart = (text: string): string => {
  if (PLAIN.test(text)) return text
  let out = ""
  for (const byte of utf8.encode(text)) out += ENCODED[byte] ?? ""
  return out
}

/**
 * Decodes `key=value&…`. `+` is a space; malformed escapes are kept as
 * written, and invalid UTF-8 is replaced.
 */
export const decode = (query: string): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  for (const pair of query.split("&")) {
    if (pair === "") continue
    const eq = pair.indexOf("=")
    const key = eq < 0 ? pair : pair.slice(0, eq)
    const value = eq < 0 ? "" : pair.slice(eq + 1)
    out.push([unescape(key, true), unescape(value, true)])
  }
  return out
}

/** Decodes `%XX` escapes (but not `+`), as in a URL's userinfo. */
export const percentDecode = (text: string): string => unescape(text, false)

const hex = (byte: number | undefined): number | undefined => {
  if (byte === undefined) return undefined
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  return undefined
}

const unescape = (text: string, plusIsSpace: boolean): string => {
  // Nothing to decode: the text stands (unless it holds a lone surrogate,
  // which UTF-8 cannot carry).
  if (!text.includes("%") && !(plusIsSpace && text.includes("+")) && text.isWellFormed()) return text
  const bytes = utf8.encode(text)
  const out = new Uint8Array(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0
    if (byte === 0x2b && plusIsSpace) {
      out[n++] = 0x20
    } else if (byte === 0x25) {
      const high = hex(bytes[i + 1])
      const low = hex(bytes[i + 2])
      if (high !== undefined && low !== undefined) {
        out[n++] = (high << 4) | low
        i += 2
      } else {
        out[n++] = 0x25
      }
    } else {
      out[n++] = byte
    }
  }
  return lossy.decode(out.subarray(0, n))
}
