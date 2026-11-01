// Counting tokens for Claude Code when no Messages API serves the model.
//
// Claude Code asks `/v1/messages/count_tokens` before it sends a long
// conversation. Only a Messages API can count exactly; when the model is
// served by an account that speaks another format (Claude Code running a
// GPT model on ChatGPT), slopmax answers with an estimate instead of an
// error Claude Code would stop at.
import type { Dialect } from "@slopmax/domain"
import type { Account } from "../account.ts"
import { providers } from "../providers/registry.ts"
import { json } from "./replies.ts"

/**
 * Whether `account` takes `dialect` as it is, untranslated: its API speaks
 * it, or says nothing of what it speaks (then requests go to it as sent).
 */
export const speaks = (account: Account, dialect: Dialect): boolean => {
  const dialects = providers[account.provider].dialectsOf(account)
  return dialects.length === 0 || dialects.includes(dialect)
}

/** Roughly four bytes of a request per token. */
export const estimate = (body: Uint8Array): number => Math.ceil(body.length / 4)

/** The estimated count, in Messages' `count_tokens` shape. */
export const estimated = (body: Uint8Array): Response => json(200, { input_tokens: estimate(body) })
