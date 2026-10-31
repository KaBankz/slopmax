// The header rules the proxy and the providers share: what of an agent's
// request may go upstream, what of an answer may come back, and how a
// header's value is read. (In the Rust these sit in `proxy/mod.rs`; they
// live apart here so providers and agents can use them without importing
// the proxy, which imports them.)
//
// A header map is the web's `Headers`: names are case-insensitive, and
// several values of one name read as one, joined by ", ".

import { text } from "@slopmax/common"

const HOP_BY_HOP: ReadonlyArray<string> = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

/** Headers that belong to one connection, never forwarded. */
export const isHopByHop = (name: string): boolean => HOP_BY_HOP.includes(name)

// `HeaderValue::to_str`: visible ASCII and tabs only.
const visible = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09) || c > 0x7e) return false
  }
  return true
}

/** `headers.get(name)?.to_str().ok()`: the value, unless absent or not visible ASCII. */
export const header = (headers: Headers, name: string): string | undefined => {
  const value = headers.get(name)
  return value === null || !visible(value) ? undefined : value
}

/** The request's `user-agent`. */
export const userAgent = (headers: Headers): string | undefined => header(headers, "user-agent")

/**
 * `HeaderValue::from_str(value)` then `headers.insert(name, value)`: sets
 * `name`, replacing every value it had, unless `value` cannot be a header
 * value (control characters), in which case nothing changes.
 */
export const insert = (headers: Headers, name: string, value: string): void => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return
  }
  try {
    headers.set(name, value)
  } catch {
    // Text the web's headers cannot carry (past Latin-1) is left out too.
  }
}

/**
 * Client headers safe to forward upstream: everything but hop-by-hop
 * headers and the agent's local credentials and cookies.
 */
export const forwardable = (client: Headers): Headers => {
  const headers = new Headers()
  for (const [name, value] of client) {
    // slopmax's own headers are for slopmax alone.
    const skip =
      isHopByHop(name) ||
      name.startsWith("x-slopmax-") ||
      name === "host" ||
      name === "content-length" ||
      name === "authorization" ||
      name === "x-api-key" ||
      name === "cookie"
    if (!skip) headers.append(name, value)
  }
  return headers
}

/**
 * A request's own say on session affinity: `x-slopmax-affinity: off`
 * places it by the strategy alone, `on` keeps it on its session's account
 * even when the config turns affinity off.
 */
export const affinity = (headers: Headers): boolean | undefined => {
  const value = header(headers, "x-slopmax-affinity")?.trim()
  switch (value === undefined ? undefined : text.asciiLowercase(value)) {
    case "on":
    case "true":
    case "1":
    case "yes":
      return true
    case "off":
    case "false":
    case "0":
    case "no":
      return false
    default:
      return undefined
  }
}

/** Upstream response headers safe to return to the agent. */
export const returnable = (upstream: Headers): Headers => {
  const headers = new Headers()
  for (const [name, value] of upstream) {
    if (!isHopByHop(name) && name !== "content-length" && name !== "set-cookie") headers.append(name, value)
  }
  return headers
}
