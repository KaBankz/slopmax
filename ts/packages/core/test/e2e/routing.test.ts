// Routing by model end to end: OpenAI-style tools reach API keys,
// compatible endpoints and ChatGPT accounts by the model they name; API keys
// take subscription models only as paid overflow; Claude Code reaches other
// vendors' Messages endpoints; and an account that speaks another format is
// translated for, both ways.
import { describe, expect } from "bun:test"
import { AccountId, type LedgerRecord } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Effect } from "effect"
import { claudeCodeBody, eventually, field, parseJson, until } from "../support/clients.ts"
import { endpointAccount, keyAccount, subscription, subscriptions } from "../support/fixtures.ts"
import { transports } from "../support/harness.ts"

const jsonOf = (text: string | undefined): unknown => (text === undefined ? undefined : parseJson(text))

const usageOf = (record: LedgerRecord | undefined) =>
  record?._tag === "Request" ? [record.account, record.usage.input, record.usage.output] : undefined

for (const [where, make] of transports) {
  describe(`routing by model ${where}`, () => {
    it.live("OpenAI-style tools reach API keys, endpoints and ChatGPT accounts by the model they name", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const harness = yield* make({
          accounts: [
            subscription("codex", "tok-ok", 0, now),
            keyAccount("xai", "key-xai"),
            endpointAccount("local", "chat", ["qwen3-*"]),
          ],
        })

        const grok = yield* harness.chat("grok-4")
        expect(grok.status).toBe(200)
        const toXai = harness.upstream.seen.at(-1)
        expect(toXai?.url.href).toBe("https://api.x.ai/v1/chat/completions")
        expect(toXai?.headers.get("authorization")).toBe("Bearer key-xai")
        expect(toXai?.headers.get("user-agent")).toBe("OpenAI/Python 2.4.0")
        expect(toXai?.text).toContain('"model":"grok-4"')

        const qwen = yield* harness.chat("qwen3-coder")
        expect(qwen.status).toBe(200)
        const toLocal = harness.upstream.seen.at(-1)
        expect(toLocal?.url.href).toBe("https://endpoints.test/local/v1/chat/completions")
        // An endpoint with no key is sent no credential at all.
        expect(toLocal?.headers.has("authorization")).toBe(false)

        // ChatGPT accounts speak Responses: the Chat request is translated for them, and the answer back.
        const gpt = yield* harness.chat("gpt-6-sol")
        expect(gpt.status).toBe(200)
        const toChatgpt = harness.upstream.seen.at(-1)
        expect(toChatgpt?.path).toBe("/backend-api/codex/responses")
        const sent = jsonOf(toChatgpt?.text)
        expect(field(sent, "input", 0, "content", 0, "text")).toBe("hi")
        expect(field(sent, "store")).toBe(false)
        expect(toChatgpt?.headers.get("user-agent")?.startsWith("slopmax/")).toBe(true)
        expect(toChatgpt?.headers.get("authorization")).toBe("Bearer tok-ok")
        expect(field(gpt.json, "object")).toBe("chat.completion")
        expect(field(gpt.json, "model")).toBe("gpt-6-sol")
        expect(field(gpt.json, "usage", "prompt_tokens")).toBe(100)

        const nope = yield* harness.chat("nope")
        expect(nope.status).toBe(404)
        expect(String(field(nope.json, "error", "message"))).toContain("nope")

        const records = yield* eventually(
          Effect.flatMap(harness.ledger, (all) => Effect.as(until(all.length >= 3, "three records"), all)),
        )
        expect(records.map(usageOf)).toContainEqual([AccountId.make("xai-key"), 12, 3])
      }),
    )

    it.live("API keys take subscription models only as paid overflow, or when a request names them", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const accounts = [subscription("codex", "tok-limited", 0, now), keyAccount("openai", "key-openai")]
        const strict = yield* make({ accounts })
        const refused = yield* strict.codex()
        expect(refused.status).toBe(429)
        expect(strict.upstream.seen.every((call) => call.url.host !== "api.openai.com")).toBe(true)

        // Naming the key's provider opts in for one request, and the model is sent as the vendor names it.
        const named = yield* strict.codex({ body: '{"model":"openai/gpt-6-sol","input":[],"stream":true}' })
        expect(named.status).toBe(200)
        const toOpenai = strict.upstream.seen.at(-1)
        expect(toOpenai?.url.href).toBe("https://api.openai.com/v1/responses")
        expect(toOpenai?.headers.get("authorization")).toBe("Bearer key-openai")
        expect(toOpenai?.text).toBe('{"model":"gpt-6-sol","input":[],"stream":true}')

        const overflow = yield* make({ accounts, settings: { paidOverflow: true } })
        const served = yield* overflow.codex()
        expect(served.status).toBe(200)
        expect(overflow.upstream.seen.map((call) => call.url.href)).toEqual([
          "https://chatgpt.com/backend-api/codex/responses",
          "https://api.openai.com/v1/responses",
        ])
      }),
    )

    it.live("Claude Code reaches another vendor's Messages endpoint by model, and Claude models stay on Claude", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const harness = yield* make({
          accounts: [
            subscription("claude", "tok-ok", 0, now),
            endpointAccount("kimi", "messages", ["kimi-*"], { key: "key-kimi" }),
          ],
        })
        const kimi = yield* harness.claude({ body: claudeCodeBody("kimi-k2") })
        expect(kimi.status).toBe(200)
        const toKimi = harness.upstream.seen.at(-1)
        expect(toKimi?.url.href).toBe("https://endpoints.test/kimi/v1/messages?beta=true")
        expect(toKimi?.headers.get("x-api-key")).toBe("key-kimi")
        expect(toKimi?.headers.has("authorization")).toBe(false)

        const claude = yield* harness.claude()
        expect(claude.status).toBe(200)
        expect(harness.upstream.seen.at(-1)?.url.href).toBe("https://api.anthropic.com/v1/messages?beta=true")
      }),
    )

    it.live("Claude Code runs a GPT model on a ChatGPT account, hearing Messages events, its reasoning kept back", () =>
      Effect.gen(function* () {
        const harness = yield* make({ accounts: yield* subscriptions("codex", ["tok-talk"]) })
        const body = JSON.stringify({
          model: "gpt-6-sol",
          max_tokens: 1000,
          stream: true,
          system: "You are Claude Code.",
          messages: [{ role: "user", content: "list files" }],
          tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }],
        })
        const answer = yield* harness.claude({ body })
        expect(answer.status).toBe(200)
        expect(answer.headers.get("content-type")).toContain("text/event-stream")
        for (const expected of [
          '"model":"gpt-6-sol"',
          '"text":"Hello"',
          '"type":"tool_use","id":"call_1","name":"Bash"',
          '"stop_reason":"tool_use"',
          "message_stop",
        ]) {
          expect(answer.text).toContain(expected)
        }
        // The opaque reasoning state stays with slopmax, for the account that made it.
        expect(answer.text).not.toContain("enc-1")
        const sent = jsonOf(harness.upstream.seen.at(-1)?.text)
        expect(field(sent, "instructions")).toBe("You are Claude Code.")
        expect(field(sent, "tools", 0, "name")).toBe("Bash")

        yield* harness.settled
        const served = yield* harness.health(AccountId.make("codex-0"))
        expect(served.served.requests).toBe(1)
      }),
    )
  })
}
