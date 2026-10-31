// PKCE (RFC 7636) and OAuth `state` generation.
import { Buffer } from "node:buffer"

import { ids } from "@slopmax/common"

/** A PKCE verifier and its S256 challenge. */
export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

/** The S256 challenge for `verifier`. */
export const challengeOf = (verifier: string): string => Buffer.from(ids.sha256(verifier)).toString("base64url")

export const Pkce = {
  generate: (): Pkce => {
    const verifier = ids.token()
    return { verifier, challenge: challengeOf(verifier) }
  },
} as const
