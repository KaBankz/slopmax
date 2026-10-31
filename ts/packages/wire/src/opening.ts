// Judging how an answer stream opens.
//
// Codex's provider can refuse inside a stream that already answered 200: the
// response is created, then fails because the account's quota is spent or the
// service is busy. The proxy holds such a stream's first events back and
// feeds them to an `Opening`; a refusal there moves the request to another
// account before the client has seen a byte. Claude and Chat providers refuse
// with a status code instead, so their streams are never held.
import type { Dialect } from "@slopmax/domain"
import { Data } from "effect"
import { dataJson, Lines } from "./lines.ts"
import { isSpentCode, jsonAt, responsesFailureCode } from "./observe.ts"

/** What the opening of a stream says so far. */
export type Verdict = Data.TaggedEnum<{
  /** Nothing telling yet: the response was only created, queued or started. */
  Wait: {}
  /** Content began, or a failure that belongs to the request (and so to the client). */
  Content: {}
  /** The account refused: its quota is spent (`exhausted`), or it is throttled. */
  Refused: { readonly exhausted: boolean }
}>
export const Verdict = Data.taggedEnum<Verdict>()

const wait: Verdict = Verdict.Wait()
const content: Verdict = Verdict.Content()
const spent: Verdict = Verdict.Refused({ exhausted: true })
const busy: Verdict = Verdict.Refused({ exhausted: false })

/** Whether the proxy holds back the start of `dialect`'s streams until they open. Only Responses refuses inside a stream. */
export const holdsStart = (dialect: Dialect): boolean => dialect === "responses"

const isBusyCode = (code: string | undefined): boolean =>
  code === "server_is_overloaded" || code === "slow_down" || code === "rate_limit_exceeded"

/**
 * How a stream opening with `event` should be treated. In Responses the
 * lifecycle events say nothing yet, and a failure is the account's only when
 * coded as a spent quota or throttling: anything else (a context too long, a
 * policy refusal) goes to the client. In the other formats every event is
 * content.
 */
export const judge = (dialect: Dialect, event: unknown): Verdict => {
  if (dialect !== "responses") return content
  const type = jsonAt(event, "type")
  if (type === "response.created" || type === "response.in_progress" || type === "response.queued") return wait
  if (type === "response.failed" || type === "error") {
    const code = responsesFailureCode(event)
    if (isSpentCode(code)) return spent
    if (isBusyCode(code)) return busy
  }
  return content
}

/**
 * Judges a stream's opening from its bytes as they arrive: each complete
 * `data:` line's JSON is judged in turn, and the first verdict that is not
 * `Wait` is final. Lines that are not JSON data (`event:` lines, blanks,
 * comments) say nothing.
 */
export class Opening {
  private readonly lines = new Lines()
  private verdict: Verdict = wait

  constructor(readonly dialect: Dialect) {}

  /** Reads the next chunk of the stream and says what its opening is so far. */
  feed(chunk: Uint8Array): Verdict {
    if (this.verdict._tag === "Wait") this.lines.push(chunk, this.visit)
    return this.verdict
  }

  private readonly visit = (bytes: Uint8Array, start: number, end: number): boolean => {
    const event = dataJson(bytes, start, end)
    if (event === undefined) return false
    this.verdict = judge(this.dialect, event)
    return this.verdict._tag !== "Wait"
  }
}
