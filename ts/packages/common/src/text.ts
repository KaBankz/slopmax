// Text measured and cut as Rust does: by characters (code points), not by
// UTF-16 units, so names with emoji or accents line up and truncate the
// same as in the Rust CLI (`chars().count()`, `chars().take(n)`, `{:<w$}`).

const SURROGATE = /[\uD800-\uDFFF]/

/** The number of characters (code points) in `s`: Rust's `s.chars().count()`. */
export const width = (s: string): number => {
  if (!SURROGATE.test(s)) return s.length
  let n = 0
  for (const _ of s) n++
  return n
}

/** The first `n` characters of `s`: Rust's `s.chars().take(n).collect()`. */
export const take = (s: string, n: number): string => {
  if (!SURROGATE.test(s)) return s.slice(0, Math.max(0, n))
  // Step over `n` code points, a high surrogate followed by a low one counting once.
  let end = 0
  for (let i = 0; i < n && end < s.length; i++) {
    const c = s.charCodeAt(end)
    const next = s.charCodeAt(end + 1)
    end += c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1
  }
  return s.slice(0, end)
}

/** `s` cut to `n` characters, its last one an ellipsis when anything was cut. */
export const truncate = (s: string, n: number): string => {
  if (width(s) <= n) return s
  return n < 1 ? "" : `${take(s, n - 1)}…`
}

const fill = (n: number): string => (n > 0 ? " ".repeat(n) : "")

/** Rust's `{:<w$}`: `s` padded with spaces on the right to `w` characters. */
export const padEnd = (s: string, w: number): string => s + fill(w - width(s))

/** Rust's `{:>w$}`: `s` padded with spaces on the left to `w` characters. */
export const padStart = (s: string, w: number): string => fill(w - width(s)) + s

/** Rust's `{:^w$}`: `s` centered in `w` characters, the odd space on the right. */
export const padCenter = (s: string, w: number): string => {
  const pad = Math.max(0, w - width(s))
  const left = Math.floor(pad / 2)
  return fill(left) + s + fill(pad - left)
}

// Rust's `char::is_whitespace` (the Unicode White_Space property). JS's
// `trim` differs by U+FEFF (JS only) and U+0085 (Rust only). Written as
// numbers: a formatter turns escapes in a regex into the characters, and
// U+2028 there ends the line.
const isWhitespace = (c: number): boolean =>
  (c >= 0x09 && c <= 0x0d) ||
  c === 0x20 ||
  (c > 0x7f &&
    (c === 0x85 ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000))

/** Rust's `str::trim`. */
export const trim = (s: string): string => {
  let start = 0
  let end = s.length
  while (start < end && isWhitespace(s.charCodeAt(start))) start++
  while (end > start && isWhitespace(s.charCodeAt(end - 1))) end--
  return start === 0 && end === s.length ? s : s.slice(start, end)
}

/** Rust's `str::to_ascii_lowercase`: only `A`–`Z` change. */
export const asciiLowercase = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

// Characters Rust's `{:?}` writes as `\u{…}`: controls, format and
// private-use characters, unassigned code points, separators other than
// the space, lone surrogates, and combining marks.
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\p{Grapheme_Extend}]/u

/** Rust's `{:?}` for a `str`: double-quoted, with Rust's escapes. */
export const debug = (s: string): string => {
  let out = '"'
  for (const c of s) {
    switch (c) {
      case "\0":
        out += "\\0"
        break
      case "\t":
        out += "\\t"
        break
      case "\r":
        out += "\\r"
        break
      case "\n":
        out += "\\n"
        break
      case "\\":
        out += "\\\\"
        break
      case '"':
        out += '\\"'
        break
      default:
        out += c !== " " && NOT_PRINTABLE.test(c) ? `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}` : c
    }
  }
  return `${out}"`
}
