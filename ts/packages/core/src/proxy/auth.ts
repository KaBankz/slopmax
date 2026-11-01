// Who is asking: the owner, holding the key agents are set up with, or a
// client key made for another machine or tool, perhaps held to some models.
//
// Keys are compared in constant time against bytes prepared once per
// settings value, so a request costs one header read and a few compares.
import type { ClientKey, Settings } from "@slopmax/domain"
import { Data, Redacted } from "effect"
import { Mac } from "effect/crypto"

/** Who sent a request. */
export type Caller = Data.TaggedEnum<{
  /** The owner key (`apiKey`): every model, and slopmax's own API. */
  Owner: {}
  /** A client key, held to its models when it names any. */
  Client: { readonly key: ClientKey }
}>
export const Caller = Data.taggedEnum<Caller>()

const owner: Caller = Caller.Owner()

/**
 * The key a request presents: a bearer token in `authorization` (spelled
 * `Bearer ` or `bearer `), else `x-api-key`, trimmed. A bearer token wins,
 * so `x-api-key` is not read when one is there.
 */
export const presentedKey = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization")
  if (authorization !== null && (authorization.startsWith("Bearer ") || authorization.startsWith("bearer "))) {
    return authorization.slice(7).trim()
  }
  const apiKey = headers.get("x-api-key")
  return apiKey === null ? undefined : apiKey.trim()
}

/** The keys a request may present, as bytes ready to compare. */
export interface KeyRing {
  readonly owner: Uint8Array
  readonly clients: ReadonlyArray<{ readonly key: ClientKey; readonly bytes: Uint8Array }>
}

const utf8 = new TextEncoder()

const ringOf = (settings: Settings): KeyRing => ({
  owner: utf8.encode(Redacted.value(settings.apiKey)),
  clients: settings.keys.map((key) => ({ key, bytes: utf8.encode(Redacted.value(key.key)) })),
})

// Settings are immutable values replaced whole on every change, so the ring
// is worked out once per value.
const rings = new WeakMap<Settings, KeyRing>()

/** The key ring for these settings. */
export const keyRing = (settings: Settings): KeyRing => {
  const known = rings.get(settings)
  if (known !== undefined) return known
  const ring = ringOf(settings)
  rings.set(settings, ring)
  return ring
}

const same = (expected: Uint8Array, given: Uint8Array): boolean =>
  expected.length > 0 && expected.length === given.length && Mac.timingSafeEqual(expected, given)

/** Who the request is from, or undefined when it holds no key slopmax knows. */
export const authenticate = (headers: Headers, ring: KeyRing): Caller | undefined => {
  const presented = presentedKey(headers)
  if (presented === undefined || presented === "") return undefined
  const given = utf8.encode(presented)
  if (same(ring.owner, given)) return owner
  for (const client of ring.clients) if (same(client.bytes, given)) return Caller.Client({ key: client.key })
  return undefined
}

/** The client key a caller is held to, when it names models; the owner and unrestricted keys are not held. */
export const heldKey = (caller: Caller): ClientKey | undefined =>
  caller._tag === "Client" && caller.key.models.length > 0 ? caller.key : undefined
