import { describe, expect, it } from "bun:test"

import { Home, join } from "../src/paths.ts"

describe("paths, beyond the Rust tests", () => {
  it("joins as Path::join does, keeping paths as written", () => {
    expect(join("./h", "config.toml")).toBe("./h/config.toml")
    expect(join("/a/../b/", "x")).toBe("/a/../b/x")
    expect(join("", "x")).toBe("x")
    expect(join("/a", "/abs")).toBe("/abs")
    expect(Home.at("./home").config()).toBe("./home/config.toml")
    expect(Home.at("/h/").accounts()).toBe("/h/accounts")
  })
})
