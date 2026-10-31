// Unverified JWT payload decoding.
//
// Tokens come straight from the issuer over TLS, so slopmax only reads
// claims for display and routing; it never trusts them for authorization.
import { Buffer } from "node:buffer"

import { Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

// base64url without padding, as the base64 crate checks it: its alphabet
// only, no length that leaves a lone character, and no stray bits in the
// last character.
const decodeUrlSafe = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined
  const bytes = Buffer.from(text, "base64url")
  return bytes.toString("base64url") === text ? bytes : undefined
}

/** Decodes the claims segment of a JWT, or undefined if it is not one. */
export const claims = (token: string): json.Json | undefined => {
  const payload = token.split(".")[1]
  if (payload === undefined) return undefined
  const bytes = decodeUrlSafe(payload.replace(/=+$/, ""))
  return bytes === undefined ? undefined : json.parse(bytes)
}

/** The `exp` claim as a timestamp. */
export const expiry = (token: string): Timestamp | undefined => {
  const exp = json.get(claims(token), "exp")
  if (typeof exp !== "number" || !Number.isInteger(exp)) return undefined
  return Timestamp.fromSecond(exp)
}

/** An unsigned JWT carrying `claims`, for tests. */
export const encodeUnsigned = (value: json.Json): string => {
  const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")
  const body = Buffer.from(json.stringify(value)).toString("base64url")
  return `${header}.${body}.sig`
}
