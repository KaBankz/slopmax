// Codex's WebSocket through the running daemon to ChatGPT, on real sockets:
// a turn relayed and recorded, a spent account's socket closed so Codex
// reconnects on another, and messages of every frame length carried intact.
import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect } from "effect"
import { limitedClose } from "../../src/proxy/socket.ts"
import { patterned, patternedText } from "../dial/support.ts"
import { codexAgent, eventually, ownerKey, until } from "../support/clients.ts"
import { subscriptions } from "../support/fixtures.ts"
import { Harness } from "../support/harness.ts"
import { SocketSeen } from "../support/mock-provider.ts"

const socketHeaders = (session: string) => ({
  authorization: `Bearer ${ownerKey}`,
  "user-agent": codexAgent,
  "session-id": session,
  "x-codex-routing-hint": "model=gpt-6-sol;tier=priority",
})

const turn = { type: "response.create", model: "gpt-6-sol", input: [], stream: true }

const typeOf = (event: unknown): unknown =>
  typeof event === "object" && event !== null && "type" in event ? event.type : undefined

describe("Codex's socket through the daemon", () => {
  it.live("relays a turn to ChatGPT on the account picked for it, and records it as a socket request", () =>
    Effect.gen(function* () {
      const harness = yield* Harness.ports({ accounts: yield* subscriptions("codex", ["tok-ok"]) })
      const codex = yield* harness.socket(socketHeaders("ws-1"))
      expect(codex.upgrade.get("openai-model")).toBe("gpt-6-sol")
      codex.sendJson(turn)
      const events = yield* codex.until("response.completed")
      expect(events.map(typeOf)).toEqual([
        "response.created",
        "codex.rate_limits",
        "response.output_text.delta",
        "response.completed",
      ])

      const [open, message] = harness.mock.sockets
      expect(open?._tag).toBe("Open")
      if (open?._tag === "Open") {
        expect(open.url).toBe("https://chatgpt.com/backend-api/codex/responses")
        expect(open.token).toBe("tok-ok")
        expect(open.headers.get("chatgpt-account-id")).toBe("acct-codex0")
      }
      expect(message).toEqual(SocketSeen.Message({ token: "tok-ok", text: JSON.stringify(turn) }))

      const records = yield* eventually(
        Effect.flatMap(harness.ledger, (all) => Effect.as(until(all.length === 1, "the turn recorded"), all)),
      )
      expect(records[0]).toMatchObject({
        _tag: "Request",
        account: "codex-0",
        status: 200,
        session: "ws-1",
        via: "socket",
        usage: { requests: 1, input: 30, cacheRead: 20, output: 4 },
      })
    }),
  )

  it.live("closes a spent account's socket so Codex reconnects, and the new socket goes to the next account", () =>
    Effect.gen(function* () {
      const harness = yield* Harness.ports({ accounts: yield* subscriptions("codex", ["tok-limited", "tok-ok"]) })
      const first = yield* harness.socket(socketHeaders("ws-2"))
      first.sendJson(turn)
      // ChatGPT opened the turn before saying the account is spent, and Codex already has that event.
      yield* first.until("response.created")
      expect(yield* first.closed).toEqual({ code: limitedClose.code, reason: limitedClose.reason })
      const spent = yield* harness.health(AccountId.make("codex-0"))
      expect(spent.blockedUntil).toBeDefined()

      const again = yield* harness.socket(socketHeaders("ws-2"))
      again.sendJson(turn)
      yield* again.until("response.completed")
      const opened = harness.mock.sockets.filter((seen) => seen._tag === "Open")
      expect(opened.map((seen) => (seen._tag === "Open" ? seen.token : undefined))).toEqual(["tok-limited", "tok-ok"])
    }),
  )

  for (const throughProxy of [false, true]) {
    it.live(
      `carries text and binary messages of every frame length both ways${throughProxy ? ", through a CONNECT proxy" : ""}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* Harness.ports({ accounts: yield* subscriptions("codex", ["tok-echo"]), throughProxy })
          const codex = yield* harness.socket({ authorization: `Bearer ${ownerKey}`, "user-agent": codexAgent })
          for (const size of [0, 125, 126, 65_535, 65_536]) {
            codex.raw.send(patternedText(size))
            expect(yield* codex.next).toEqual({ _tag: "Text", text: patternedText(size) })
            codex.raw.send(patterned(size))
            expect(yield* codex.next).toEqual({ _tag: "Binary", bytes: patterned(size) })
          }
          const port = new URL(harness.mock.url).port
          expect(harness.proxy?.tunnels.map((tunnel) => tunnel.target)).toEqual(
            throughProxy ? [`provider.mock:${port}`] : undefined,
          )
        }),
      15_000,
    )
  }

  it.live("sends Codex to HTTP with 426 when websockets are turned off", () =>
    Effect.gen(function* () {
      const harness = yield* Harness.ports({
        accounts: yield* subscriptions("codex", ["tok-ok"]),
        settings: { websockets: false },
      })
      const refused = yield* Effect.flip(harness.socket(socketHeaders("ws-3")))
      expect(refused.status).toBe(426)
      expect(harness.mock.sockets).toHaveLength(0)
      // Codex then streams the same turn over HTTP.
      const answer = yield* harness.codex()
      expect(answer.status).toBe(200)
    }),
  )
})
