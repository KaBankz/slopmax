import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { slopmaxVersion } from "../src/index.ts"

describe("version", () => {
  it("is a plain release number, as the user agent and /healthz carry it", () => {
    expect(slopmaxVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })
})
