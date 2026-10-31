// Reasoning state, carried across turns for clients that cannot carry it.
//
// A Responses upstream (ChatGPT, the OpenAI API) hands back encrypted
// reasoning state with the tool calls it makes, and wants it back on the next
// turn: without it the model reasons from scratch after every tool result.
// Claude Code and Chat clients have nowhere to keep that state. So while a
// translated answer streams, slopmax remembers the state under the id of the
// call that followed it, and puts it back before that call when the client
// sends the conversation again. The state is only readable by the account
// that issued it, so it is only ever given back to that account.
import type { AccountId } from "@slopmax/domain"
import { DateTime, Duration, HashMap, Option } from "effect"
import type { Event, Part, Request } from "./common.ts"

interface Entry {
  readonly account: AccountId
  readonly state: string
  /** When it was remembered, in epoch milliseconds. */
  readonly at: number
  /** Its place in the order calls were first remembered. */
  readonly place: number
}

/**
 * Remembered reasoning state, by call id. It holds at most `ReplayBook.max`
 * calls, the one first remembered going first (remembering a call again keeps
 * its place), and each entry lives `ReplayBook.ttl`, a turn's tool loop with
 * room to spare. It is an immutable value, kept in a `Ref` by the proxy.
 */
export class ReplayBook {
  static readonly max = 4096
  static readonly ttl: Duration.Duration = Duration.hours(2)
  static readonly empty: ReplayBook = new ReplayBook(HashMap.empty(), HashMap.empty(), 0, 0)

  private constructor(
    private readonly entries: HashMap.HashMap<string, Entry>,
    /** Call ids by place, to find the oldest. */
    private readonly order: HashMap.HashMap<number, string>,
    /** The oldest place still held. */
    private readonly oldest: number,
    /** The place the next new call takes. */
    private readonly next: number,
  ) {}

  /** How many calls it holds. */
  get size(): number {
    return HashMap.size(this.entries)
  }

  /** The book with `state` remembered for `callId`, issued by `account`. */
  remember(callId: string, account: AccountId, state: string, now: DateTime.Utc): ReplayBook {
    const at = DateTime.toEpochMillis(now)
    const known = HashMap.get(this.entries, callId)
    if (Option.isSome(known)) {
      const entry: Entry = { account, state, at, place: known.value.place }
      return new ReplayBook(HashMap.set(this.entries, callId, entry), this.order, this.oldest, this.next)
    }
    let entries = this.entries
    let order = this.order
    let oldest = this.oldest
    while (HashMap.size(entries) >= ReplayBook.max && oldest < this.next) {
      const gone = HashMap.get(order, oldest)
      if (Option.isSome(gone)) entries = HashMap.remove(entries, gone.value)
      order = HashMap.remove(order, oldest)
      oldest += 1
    }
    const entry: Entry = { account, state, at, place: this.next }
    return new ReplayBook(
      HashMap.set(entries, callId, entry),
      HashMap.set(order, this.next, callId),
      oldest,
      this.next + 1,
    )
  }

  /** The state remembered for `callId`, when `account` issued it and it has not expired. */
  recall(callId: string, account: AccountId, now: DateTime.Utc): Option.Option<string> {
    return HashMap.get(this.entries, callId).pipe(
      Option.filter(
        (entry) =>
          entry.account === account && DateTime.toEpochMillis(now) - entry.at < Duration.toMillis(ReplayBook.ttl),
      ),
      Option.map((entry) => entry.state),
    )
  }
}

/**
 * A watch for a translated answer that hands `remember` each reasoning state
 * with the id of the call that followed it.
 */
export const pairStates = (remember: (callId: string, state: string) => void): ((event: Event) => void) => {
  let pending: string | undefined
  return (event) => {
    if (event._tag === "State") pending = event.state
    else if (event._tag === "Call" && pending !== undefined) {
      remember(event.call.id, pending)
      pending = undefined
    }
  }
}

/**
 * The request with remembered reasoning state put back before the calls it
 * led to: in each turn, before its first call, when `recall` still has state
 * for that call.
 */
export const restoreReasoning = (request: Request, recall: (callId: string) => Option.Option<string>): Request => {
  let changed = false
  const messages = request.messages.map((message) => {
    const at = message.parts.findIndex((part) => part._tag === "Call")
    const call = message.parts[at]
    if (call?._tag !== "Call") return message
    const state = recall(call.id)
    if (Option.isNone(state)) return message
    changed = true
    const reasoning: Part = { _tag: "Reasoning", text: "", opaque: state.value }
    return { ...message, parts: [...message.parts.slice(0, at), reasoning, ...message.parts.slice(at)] }
  })
  return changed ? { ...request, messages } : request
}
