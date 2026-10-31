// Codex upstream adaptation.
//
// Codex requests go to the ChatGPT backend with the account's bearer token
// and workspace id. Encrypted reasoning in the conversation is bound to the
// account that produced it, so it is dropped when a session changes
// accounts; the readable summaries stay.
import { text as texts } from "@slopmax/common"
import { json } from "@slopmax/wire"

import { forwardable, header, insert } from "../../proxy/headers.ts"
import { swapRemove } from "../../serde.ts"

/**
 * Headers for the upstream request. `moved` drops the per-turn routing
 * token, which belongs to the previous account's backend session.
 */
export const upstreamHeaders = (
  client: Headers,
  accessToken: string,
  accountId: string | undefined,
  moved: boolean,
): Headers => {
  const headers = forwardable(client)
  insert(headers, "authorization", `Bearer ${accessToken}`)
  if (accountId !== undefined) insert(headers, "chatgpt-account-id", accountId)
  if (moved) headers.delete("x-codex-turn-state")
  // Uncompressed streams can be read for usage and in-stream refusals.
  insert(headers, "accept-encoding", "identity")
  // Custom providers omit the `version` header the built-in one sends; the
  // backend gates some models on client version.
  if (!headers.has("version")) {
    const version = clientVersion(client)
    if (version !== undefined) insert(headers, "version", version)
  }
  return headers
}

/** `0.159.3` from a user agent like `codex_exec/0.159.3 (Linux; x86_64) …`. */
export const clientVersion = (headers: Headers): string | undefined => {
  const agent = header(headers, "user-agent")
  if (agent === undefined) return undefined
  const slash = agent.indexOf("/")
  if (slash < 0 || !agent.slice(0, slash).startsWith("codex")) return undefined
  const version = /^[0-9.]*/.exec(agent.slice(slash + 1))?.[0] ?? ""
  return version.split(".").length === 3 ? version : undefined
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Removes state bound to another account: `encrypted_content` on
 * reasoning items and any `previous_response_id`. Returns undefined when
 * the body carries none.
 */
export const stripAccountState = (body: Uint8Array): Uint8Array | undefined => {
  const value = json.parse(body)
  if (value === undefined) return undefined
  let changed = json.isObject(value) && swapRemove(value, "previous_response_id")
  for (const item of json.array(json.get(value, "input")) ?? []) {
    if (json.isObject(item) && json.str(item.type) === "reasoning") {
      changed = swapRemove(item, "encrypted_content") || changed
    }
  }
  return changed ? encoder.encode(json.stringify(value)) : undefined
}

/** Whether a 400 says the request carried state minted by another account. */
export const rejectsAccountState = (body: Uint8Array): boolean => {
  const text = texts.asciiLowercase(decoder.decode(body))
  return (
    text.includes("encrypted content") ||
    text.includes("invalid_encrypted_content") ||
    text.includes("not issued to this caller") ||
    (text.includes("item with id") && text.includes("not found"))
  )
}

/**
 * Whether a 5xx body is really a spent quota (the backend sometimes
 * reports an exhausted window as a 502).
 */
export const reportsUsageLimit = (body: Uint8Array): boolean => {
  const text = texts.asciiLowercase(decoder.decode(body))
  return text.includes("usage_limit_reached") || text.includes("usage limit has been reached")
}
