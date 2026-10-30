// Codex's remote compaction, for models that cannot do it themselves.
//
// Codex asks for compaction by ending a request's input with a
// `compaction_trigger` item and expects one `compaction` item back, whose
// sealed content stands in for the history from then on. For a model
// reached by translation, slopmax asks the model for a summary instead,
// seals it in the item itself, and opens it again when the item comes
// back.
import { Buffer } from "node:buffer"

/** Marks compaction content slopmax sealed. */
const SEAL = "slopmax1:"

/** What the model is asked to write when compacting. */
export const PROMPT =
  "Summarize this conversation so that another assistant can continue the task without it. " +
  "Include the goal and the user's instructions, what has been done (files read or changed, " +
  "commands run, and what they showed), decisions made, and what remains to do. Write only the summary."

/** Introduces a summary when the history it replaced comes back. */
export const PREFIX = "The conversation so far was compacted into this summary. Continue the task from it:"

/** Seals a summary into compaction content. */
export const seal = (summary: string): string => SEAL + Buffer.from(summary, "utf8").toString("base64")

// Standard base64 as the Rust's `STANDARD` engine accepts it: canonical
// padding, and no stray bits in the last symbol.
const CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The summary in compaction content slopmax sealed. */
export const open = (content: string): string | undefined => {
  if (!content.startsWith(SEAL)) return undefined
  const encoded = content.slice(SEAL.length)
  if (!CANONICAL.test(encoded)) return undefined
  try {
    return utf8.decode(Buffer.from(encoded, "base64"))
  } catch {
    return undefined
  }
}
