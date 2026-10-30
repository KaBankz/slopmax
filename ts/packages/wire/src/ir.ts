// The common form translation goes through. A client's request is decoded
// from its format into a `Request` and encoded into the upstream's; the
// answer comes back as `Event`s that the client's format encodes again.
// Each format needs one codec instead of one translator per pair.
//
// Only what agents use crosses: text, images and documents, tool calls
// and results, reasoning, and the settings that shape an answer. Anything
// else stays behind rather than being guessed at.
import { Usage } from "./base.ts"
import { get, type Json, str } from "./json.ts"

/** A request, as far as translation carries it. */
export interface Request {
  readonly model: string
  /** System instructions, in order. */
  readonly system: ReadonlyArray<string>
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<Tool>
  readonly toolChoice: ToolChoice
  readonly parallelToolCalls: boolean | undefined
  readonly maxTokens: number | undefined
  readonly temperature: number | undefined
  readonly topP: number | undefined
  readonly stop: ReadonlyArray<string>
  readonly effort: Effort | undefined
  /** A JSON schema the answer must follow. */
  readonly format: Format | undefined
  readonly stream: boolean
  /** Keys the provider's prompt cache: the conversation's id. */
  readonly cacheKey: string | undefined
  /**
   * The client asks for its history to be compacted into a summary
   * (Codex's remote compaction) rather than for an answer.
   */
  readonly compact: boolean
}

export const Request = {
  /** `Request { ..Request::default() }` with `fields` set. */
  make: (fields: Partial<Request> = {}): Request => ({
    model: "",
    system: [],
    messages: [],
    tools: [],
    toolChoice: ToolChoice.Auto,
    parallelToolCalls: undefined,
    maxTokens: undefined,
    temperature: undefined,
    topP: undefined,
    stop: [],
    effort: undefined,
    format: undefined,
    stream: false,
    cacheKey: undefined,
    compact: false,
    ...fields,
  }),
} as const

export type Role = "User" | "Assistant"

export interface Message {
  readonly role: Role
  readonly parts: ReadonlyArray<Part>
}

export type Part =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Image"; readonly media: Media }
  /** A document such as a PDF. */
  | { readonly _tag: "File"; readonly media: Media }
  | { readonly _tag: "Call"; readonly call: Call }
  | { readonly _tag: "Result"; readonly result: ToolResult }
  /** Reasoning from an earlier turn. */
  | { readonly _tag: "Reasoning"; readonly reasoning: Reasoning }

export const Part = {
  Text: (text: string): Part => ({ _tag: "Text", text }),
  Image: (media: Media): Part => ({ _tag: "Image", media }),
  File: (media: Media): Part => ({ _tag: "File", media }),
  Call: (call: Call): Part => ({ _tag: "Call", call }),
  Result: (result: ToolResult): Part => ({ _tag: "Result", result }),
  Reasoning: (reasoning: Reasoning): Part => ({ _tag: "Reasoning", reasoning }),
} as const

/** An image or document, inline or by URL. */
export interface Media {
  readonly mediaType: string
  readonly source: Source
  readonly name: string | undefined
}

export type Source = { readonly _tag: "Base64"; readonly data: string } | { readonly _tag: "Url"; readonly url: string }

export const Source = {
  Base64: (data: string): Source => ({ _tag: "Base64", data }),
  Url: (url: string): Source => ({ _tag: "Url", url }),
} as const

export const Media = {
  /** A `data:` URL for inline media, else the URL itself. */
  url: (media: Media): string =>
    media.source._tag === "Base64" ? `data:${media.mediaType};base64,${media.source.data}` : media.source.url,

  /** Reads a URL that may be a `data:` URL. */
  fromUrl: (url: string): Media => {
    if (url.startsWith("data:")) {
      const split = url.indexOf(";base64,", 5)
      if (split >= 0) {
        return { mediaType: url.slice(5, split), source: Source.Base64(url.slice(split + 8)), name: undefined }
      }
    }
    return { mediaType: "", source: Source.Url(url), name: undefined }
  },
} as const

/** A tool call the model made. */
export interface Call {
  readonly id: string
  readonly name: string
  /** JSON text for a function; the raw input for a freeform tool. */
  readonly input: string
  readonly kind: ToolKind
}

export interface ToolResult {
  readonly id: string
  /** Text and images. */
  readonly content: ReadonlyArray<Part>
  readonly isError: boolean
}

export const ToolResult = {
  /** The result's text, joined. */
  text: (result: ToolResult): string => {
    const texts: Array<string> = []
    for (const part of result.content) if (part._tag === "Text") texts.push(part.text)
    return texts.join("\n")
  },
} as const

export interface Reasoning {
  /** The readable summary. */
  readonly text: string
  /** State only the provider that produced it can read. */
  readonly opaque: string | undefined
}

export interface Tool {
  readonly name: string
  readonly description: string
  /** JSON schema of a function's arguments. */
  readonly schema: Json
  readonly kind: ToolKind
}

/**
 * How a tool takes its input: JSON arguments matching a schema
 * (`Function`), or free text such as Codex's `apply_patch` (`Freeform`).
 * Formats without freeform tools see a function taking `{"input": string}`.
 */
export type ToolKind = "Function" | "Freeform"

export type ToolChoice =
  | { readonly _tag: "Auto" }
  | { readonly _tag: "None" }
  | { readonly _tag: "Required" }
  | { readonly _tag: "Named"; readonly name: string }

export const ToolChoice: {
  readonly Auto: ToolChoice
  readonly None: ToolChoice
  readonly Required: ToolChoice
  readonly Named: (name: string) => ToolChoice
} = {
  Auto: { _tag: "Auto" },
  None: { _tag: "None" },
  Required: { _tag: "Required" },
  Named: (name) => ({ _tag: "Named", name }),
}

/** How hard the model should think, least first. */
export type Effort = "Minimal" | "Low" | "Medium" | "High" | "Max"

export const Effort = {
  parse: (text: string): Effort | undefined => {
    switch (text) {
      case "minimal":
      case "none":
        return "Minimal"
      case "low":
        return "Low"
      case "medium":
        return "Medium"
      case "high":
        return "High"
      case "xhigh":
      case "max":
        return "Max"
      default:
        return undefined
    }
  },

  /** The effort a thinking budget in tokens amounts to. */
  fromBudget: (tokens: number): Effort => (tokens < 4_096 ? "Low" : tokens < 16_384 ? "Medium" : "High"),
} as const

export interface Format {
  readonly name: string
  readonly schema: Json
  readonly strict: boolean
}

/** One step of an answer. */
export type Event =
  /** More of the answer's text. */
  | { readonly _tag: "Text"; readonly text: string }
  /** More of the model's readable reasoning. */
  | { readonly _tag: "Reasoning"; readonly text: string }
  /**
   * Reasoning state for the next turn, readable only by its provider. It
   * belongs to the calls that follow.
   */
  | { readonly _tag: "State"; readonly state: string }
  /** A complete tool call. */
  | { readonly _tag: "Call"; readonly call: Call }
  /** The answer ended. */
  | { readonly _tag: "Done"; readonly stop: Stop; readonly usage: Usage }
  /** The answer failed partway. */
  | { readonly _tag: "Error"; readonly failure: Failure }

export const Event = {
  Text: (text: string): Event => ({ _tag: "Text", text }),
  Reasoning: (text: string): Event => ({ _tag: "Reasoning", text }),
  State: (state: string): Event => ({ _tag: "State", state }),
  Call: (call: Call): Event => ({ _tag: "Call", call }),
  Done: (stop: Stop, usage: Usage): Event => ({ _tag: "Done", stop, usage }),
  Error: (failure: Failure): Event => ({ _tag: "Error", failure }),
} as const

/**
 * Why an answer ended: it was finished (`End`), called tools and waits for
 * their results (`ToolUse`), reached the token limit (`Length`), hit a stop
 * sequence (`Sequence`), or a content filter stopped it (`Filtered`).
 */
export type Stop = "End" | "ToolUse" | "Length" | "Sequence" | "Filtered"

/** An upstream failure, in terms every format can state. */
export interface Failure {
  readonly status: number
  readonly message: string
}

export const Failure = {
  /** A kind of error every format names the same way. */
  kind: (failure: Failure): string => {
    switch (failure.status) {
      case 400:
        return "invalid_request_error"
      case 401:
        return "authentication_error"
      case 403:
        return "permission_error"
      case 404:
        return "not_found_error"
      case 413:
        return "request_too_large"
      case 429:
        return "rate_limit_error"
      case 529:
      case 503:
        return "overloaded_error"
      default:
        return "api_error"
    }
  },
} as const

/** A whole answer, collected from its events. */
export interface Answer {
  readonly text: string
  readonly reasoning: string
  readonly calls: ReadonlyArray<Call>
  readonly stop: Stop | undefined
  readonly usage: Usage
  readonly error: Failure | undefined
}

export const Answer = {
  make: (fields: Partial<Answer> = {}): Answer => ({
    text: "",
    reasoning: "",
    calls: [],
    stop: undefined,
    usage: Usage.zero(),
    error: undefined,
    ...fields,
  }),

  collect: (events: Iterable<Event>): Answer => {
    let text = ""
    let reasoning = ""
    const calls: Array<Call> = []
    let stop: Stop | undefined
    let usage = Usage.zero()
    let error: Failure | undefined
    for (const event of events) {
      switch (event._tag) {
        case "Text":
          text += event.text
          break
        case "Reasoning":
          reasoning += event.text
          break
        case "State":
          break
        case "Call":
          calls.push(event.call)
          break
        case "Done":
          stop = event.stop
          usage = event.usage
          break
        case "Error":
          error = event.failure
          break
      }
    }
    return { text, reasoning, calls, stop, usage, error }
  },

  /** Why it ended, inferring tool use from the calls. */
  stop: (answer: Answer): Stop => {
    if ((answer.stop === "End" || answer.stop === undefined) && answer.calls.length > 0) return "ToolUse"
    return answer.stop ?? "End"
  },
} as const

/**
 * The text inside JSON `content` that is a plain string or an array of
 * typed parts (`{"type": "text", "text": …}` and the like).
 */
export const textOf = (content: Json | undefined): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: Array<string> = []
    for (const part of content) {
      const text = str(get(part, "text"))
      if (text !== undefined) texts.push(text)
    }
    return texts.join("\n")
  }
  return ""
}
