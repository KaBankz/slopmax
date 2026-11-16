// The daemon's content security policy allows one inline style: the
// stylesheet Sonner inserts when it loads, by its hash. This recomputes that
// hash from the Sonner installed here, so an upgrade that changes the
// stylesheet fails here rather than leaving toasts unstyled in the dashboard.
import { describe, expect, test } from "bun:test"

const policy = new URL("../../../../crates/slopmax-daemon/src/proxy/ui.rs", import.meta.url)

describe("the dashboard's content security policy", () => {
  test("allows the stylesheet Sonner inserts, by its hash", async () => {
    const source = await Bun.file(Bun.resolveSync("sonner", import.meta.dir)).text()
    const literal = /__insertCSS\(("(?:[^"\\]|\\.)*")\)/.exec(source)?.[1]
    expect(literal).toBeDefined()
    const css: unknown = JSON.parse(literal ?? '""')
    expect(typeof css).toBe("string")
    const hash = new Bun.CryptoHasher("sha256").update(String(css)).digest("base64")
    expect(await Bun.file(policy).text()).toContain(`'sha256-${hash}'`)
  })
})
