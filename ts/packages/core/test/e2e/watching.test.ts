// What front ends and T3 Code see of a running daemon: the event stream the
// dashboard and the desktop window follow, and the CLIProxyAPI-style hub
// T3 Code reads usage and limit resets through.
import { describe, expect } from "bun:test"
import { AccountId, type Event } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Stream } from "effect"
import { codexConsumeUrl, codexCreditsUrl, codexUsageUrl } from "../../src/api/hub.ts"
import { eventually, field, ownerKey, parseJson, until } from "../support/clients.ts"
import { observeUsage, subscriptions } from "../support/fixtures.ts"
import { type Harness, transports } from "../support/harness.ts"

/** A management call as T3 Code makes one, with the owner key as its management key. */
const hub = (harness: Harness, method: string, path: string, body?: unknown) =>
  harness.call(method, `/v0/management/${path}`, {
    key: null,
    headers: { "x-management-key": ownerKey },
    ...(body === undefined ? {} : { body }),
  })

/** An `api-call` for an account: the inner status and the inner body as JSON. */
const apiCall = (harness: Harness, account: string, method: string, url: string, data?: unknown) =>
  Effect.map(
    hub(harness, "POST", "api-call", {
      auth_index: account,
      method,
      url,
      header: { Authorization: "Bearer $TOKEN$" },
      ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    }),
    (answer) => {
      const text = field(answer.json, "body")
      return {
        status: answer.status,
        inner: field(answer.json, "status_code"),
        body: typeof text === "string" ? parseJson(text) : undefined,
      }
    },
  )

for (const [where, make] of transports) {
  describe(`watching the daemon ${where}`, () => {
    it.live("the event stream says hello, sends the report, and tells each request as it settles", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-ok"]) })
        const api = yield* harness.api
        const seen: Array<Event> = []
        yield* api.events.watch().pipe(
          Effect.flatMap((stream) => Stream.runForEach(stream, (event) => Effect.sync(() => seen.push(event)))),
          Effect.forkScoped,
        )
        yield* eventually(
          Effect.suspend(() =>
            until(
              seen.some((event) => event._tag === "Status"),
              "the report",
            ),
          ),
        )
        expect(seen[0]?._tag).toBe("Hello")

        const answer = yield* harness.codex()
        expect(answer.status).toBe(200)
        const request = yield* eventually(
          Effect.suspend(() => {
            const found = seen.find((event) => event._tag === "Request")
            return Effect.as(until(found !== undefined, "the request told"), found)
          }),
        )
        expect(request?._tag === "Request" ? request.record.account : undefined).toBe(AccountId.make("codex-0"))
      }),
    )

    it.live("T3 Code reads accounts, usage and limit resets through the hub, with no token leaving slopmax", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-ok"]) })
        const files = yield* hub(harness, "GET", "auth-files")
        expect(files.status).toBe(200)
        const listed = field(files.json, "files")
        expect(Array.isArray(listed) ? listed.map((file) => field(file, "auth_index")) : []).toEqual(["codex-0"])
        expect(files.text).not.toContain("tok-ok")

        yield* harness.run(observeUsage(AccountId.make("codex-0"), 40))
        const usage = yield* apiCall(harness, "codex-0", "GET", codexUsageUrl)
        expect([usage.status, usage.inner]).toEqual([200, 200])
        // Usage comes from slopmax's own reading, not from asking ChatGPT again.
        expect(harness.upstream.at("/backend-api/wham/usage")).toHaveLength(0)

        const credits = yield* apiCall(harness, "codex-0", "GET", codexCreditsUrl)
        expect(credits.inner).toBe(200)
        expect(field(credits.body, "credits", 0, "id")).toBe("credit-later")
        const consumed = yield* apiCall(harness, "codex-0", "POST", codexConsumeUrl, {
          redeem_request_id: "r-1",
          credit_id: "credit-later",
        })
        expect([consumed.inner, consumed.body]).toEqual([200, { code: "reset" }])
        // What reached ChatGPT carried the account's own token, sent by slopmax.
        const redeemed = harness.upstream.at("/backend-api/wham/rate-limit-reset-credits/consume")
        expect(redeemed.map((call) => call.token)).toEqual(["tok-ok"])

        const wrongKey = yield* harness.call("GET", "/v0/management/auth-files", {
          key: null,
          headers: { "x-management-key": "nope" },
        })
        expect(wrongKey.status).toBe(401)
      }),
    )
  })
}
