// Codex's remote compaction, for models that cannot do it themselves.
//
// Codex asks for compaction by ending a request's input with a
// `compaction_trigger` item, and expects one `compaction` item back whose
// sealed content stands in for the history from then on. A model reached by
// translation cannot seal anything, so slopmax asks it for a summary instead,
// seals the summary into the item itself, and opens it again when Codex sends
// the item back on its next request.
import { Base64 } from "effect/encoding"
import type { Request } from "./common.ts"

/** Marks compaction content slopmax sealed, as opposed to OpenAI's own. */
const sealMark = "slopmax1:"

/** What the model is asked to write when compacting. */
export const prompt =
  "Summarize this conversation so that another assistant can continue the task without it. Include the goal and the user's instructions, what has been done (files read or changed, commands run, and what they showed), decisions made, and what remains to do. Write only the summary."

/** Introduces a summary when the history it replaced comes back. */
export const prefix = "The conversation so far was compacted into this summary. Continue the task from it:"

/** A summary sealed into compaction content. */
export const seal = (summary: string): string => `${sealMark}${Base64.encode(summary)}`

const strict = new TextDecoder("utf-8", { fatal: true })

/** The summary inside compaction content slopmax sealed; undefined for anything else, OpenAI's sealed history included. */
export const open = (content: string): string | undefined => {
  if (!content.startsWith(sealMark)) return undefined
  const bytes = Base64.decode(content.slice(sealMark.length))
  if (bytes._tag === "Failure") return undefined
  try {
    return strict.decode(bytes.success)
  } catch {
    return undefined
  }
}

/** The text a summary comes back as, at the start of the next request's history. */
export const reopened = (summary: string): string => `${prefix}\n\n${summary}`

/**
 * The request to send instead of a compaction request: the same conversation
 * with the summary prompt as the last user turn, and no tools to call.
 */
export const summaryRequest = (request: Request): Request => ({
  ...request,
  messages: [...request.messages, { role: "user", parts: [{ _tag: "Text", text: prompt }] }],
  toolChoice: { _tag: "None" },
})
