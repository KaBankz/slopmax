import { describe, expect } from "bun:test"
import { existsSync, rmSync } from "node:fs"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { json, Mock, Seen, tempDir } from "../src/testkit.ts"

describe("testkit", () => {
  it.live("the_mock_records_requests_sent_to_redirected_origins", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) => json(201, { got: Seen.text(seen) }))
      const http = yield* mock.client(["https://api.example.com"])
      const response = yield* http.post("https://api.example.com/v1/thing?x=1").body("hello").send()
      expect(response.status).toBe(201)
      const answer = yield* response.json()
      expect(answer).toEqual({ got: "hello" })
      const seen = mock.seenAt("/v1/thing")
      expect(seen.length).toBe(1)
      expect(seen[0]?.path).toBe("/v1/thing?x=1")
      expect(seen[0]?.method).toBe("POST")
      const dir = tempDir("kit")
      expect(existsSync(dir)).toBe(true)
      rmSync(dir, { recursive: true })
      // Probes of `/` are answered 404 and not recorded.
      const probe = yield* http.get(`${mock.url}/`).send()
      expect(probe.status).toBe(404)
      expect(mock.seen().length).toBe(1)
    }),
  )
})
