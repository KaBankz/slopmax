// Small helpers for the tests: reaching into JSON, and reading frames.
import { Result } from "effect"

import { array, get, type Json, parse } from "../src/json.ts"

/** `value["a"]["b"]…`, with numbers indexing arrays. */
export const at = (value: Json | undefined, ...keys: ReadonlyArray<string | number>): Json | undefined => {
  let v = value
  for (const key of keys) v = typeof key === "number" ? array(v)?.[key] : get(v, key)
  return v
}

/** The frames' data, by event name, of a named SSE stream. */
export const frames = (out: string): Array<readonly [string, Json]> =>
  out
    .split("\n\n")
    .filter((f) => f !== "")
    .map((f) => {
      const [first = "", second = ""] = f.split("\n")
      return [first.replace(/^event: /, ""), parse(second.replace(/^data: /, "")) ?? null] as const
    })

/** Each frame's data. */
export const datas = (out: string): Array<Json> =>
  out
    .split("\n\n")
    .filter((f) => f !== "")
    .map((f) => {
      const data = f.split("\n").find((l) => l.startsWith("data: ")) ?? ""
      return parse(data.slice(6)) ?? null
    })

export const ok = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${String(result.failure)}`)
  return result.success
}
