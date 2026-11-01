// The in-process upstream the proxy tests stand on: what it records must be
// what slopmax sent, or every assertion over `seen` checks the wrong thing.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect } from "effect"
import { Upstream } from "../../src/upstream.ts"
import { json, memoryUpstream, on } from "../support/memory-upstream.ts"

describe("the in-process upstream", () => {
  it.effect("records each call and answers it from its route", () => {
    const upstream = memoryUpstream([on("POST /v1/thing", (seen) => json(201, { got: seen.text }))])
    return Effect.gen(function* () {
      const http = yield* Upstream
      const response = yield* http.send({
        url: "https://api.example.com/v1/thing?x=1",
        method: "POST",
        headers: new Headers({ authorization: "Bearer tok-ok" }),
        body: "hello",
      })
      const body: unknown = yield* Effect.promise(() => response.json())
      expect({ status: response.status, body }).toEqual({ status: 201, body: { got: "hello" } })
      const seen = upstream.at("/v1/thing")
      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe("/v1/thing?x=1")
      expect(seen[0]?.method).toBe("POST")
      expect(seen[0]?.token).toBe("tok-ok")
      expect(seen[0]?.url.origin).toBe("https://api.example.com")
    }).pipe(Effect.provide(upstream.layer))
  })

  it.effect("answers what no route takes with a 404", () => {
    const upstream = memoryUpstream([])
    return Effect.gen(function* () {
      const http = yield* Upstream
      const response = yield* http.send({
        url: "https://api.example.com/nowhere",
        method: "GET",
        headers: new Headers(),
        body: undefined,
      })
      expect(response.status).toBe(404)
      expect(upstream.paths()).toEqual(["/nowhere"])
    }).pipe(Effect.provide(upstream.layer))
  })
})
