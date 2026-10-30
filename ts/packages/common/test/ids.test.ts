import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { hex64, random, sha256, token, uuidV4 } from "../src/ids.ts"

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

describe("ids (Rust tests)", () => {
  it("shapes", () => {
    expect(token().length).toBe(43)
    expect(hex64().length).toBe(64)
    const id = uuidV4()
    expect(id.length).toBe(36)
    expect(id[14]).toBe("4")
    expect(["8", "9", "a", "b"]).toContain(id[19] ?? "")
    expect(uuidV4()).not.toBe(uuidV4())
  })
})

describe("ids (contract details)", () => {
  it("tokens are base64url without padding and hex is lowercase", () => {
    for (let i = 0; i < 50; i++) {
      expect(token()).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(hex64()).toMatch(/^[0-9a-f]{64}$/)
      expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(random(16).length).toBe(16)
    expect(token()).not.toBe(token())
  })

  it("sha256 matches the standard vectors", () => {
    expect(hex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(hex(sha256("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(hex(sha256(new TextEncoder().encode("abc")))).toBe(hex(sha256("abc")))
    expect(sha256("abc").length).toBe(32)
  })
})
