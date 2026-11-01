// The desktop app end to end, under a display (Xvfb in CI): the real
// Electron app, built (`bun build.ts`) or packaged (`SLOPMAX_DESKTOP_APP`),
// against a stand-in proxy in this process and a stand-in CLI that names it.
// The window shows the running report; stopping the proxy shows the offline
// report the CLI reads; a notice from the proxy is posted as a notification.
// It runs only when asked (`SLOPMAX_DESKTOP_SMOKE=1`), since it opens windows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ElectronApplication, Page } from "playwright-core"
import { launch, textWhere, windowAt } from "../drive.ts"

const root = path.join(import.meta.dir, "..")
const packaged = process.env["SLOPMAX_DESKTOP_APP"]
const runs =
  process.env["SLOPMAX_DESKTOP_SMOKE"] === "1" &&
  // Linux needs a display (Xvfb in CI); macOS and Windows always have one.
  (process.platform !== "linux" || process.env["DISPLAY"] !== undefined) &&
  (packaged !== undefined || (await Bun.file(path.join(root, "out/main.js")).exists()))

const key = "sm-smoke-key"
const at = "2026-11-01T09:00:00.000Z"

const account = (name: string, used: number) => ({
  id: `claude-${name.length}`,
  provider: "claude",
  name,
  disabled: false,
  priority: 0,
  pinned: false,
  models: [],
  sessions: 0,
  condition: { _tag: "Ready" },
  notes: [],
  windows: [{ span: "5h", used, resetsAt: "2099-01-01T00:00:00Z" }],
  resets: [],
  served: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
})

/** A report with one Claude account; the live one and the one on disk differ in how much is used. */
const report = (live: boolean, name: string, used: number) => ({
  version: "0.4.0",
  live,
  generatedAt: at,
  strategy: "fill-first",
  accounts: [account(name, used)],
  pools: [
    {
      provider: "claude",
      accounts: 1,
      windows: [{ span: "5h", used, resetsAt: "2099-01-01T00:00:00Z", weighted: false }],
      scoped: [],
      shares: {},
    },
  ],
  nudges: [],
})

const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/** A stand-in proxy: `/healthz`, the event stream, and the report; every stream it opened can be sent more. */
const standIn = () => {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/healthz") return Response.json({ status: "ok", version: "0.4.0" })
      if (request.headers.get("authorization") !== `Bearer ${key}`) return new Response("no", { status: 401 })
      if (url.pathname === "/slopmax/api/events") {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            streams.add(controller)
            controller.enqueue(frame({ _tag: "Hello", version: "0.4.0" }))
            controller.enqueue(frame({ _tag: "Status", report: report(true, "live@example.com", 42) }))
          },
          cancel: () => undefined,
        })
        return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
      }
      if (url.pathname === "/slopmax/api/status") return Response.json(report(true, "live@example.com", 42))
      return Response.json(
        { _tag: "NotFound", what: "slopmax endpoint", message: "no such slopmax endpoint" },
        { status: 404 },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    send: (event: unknown) => {
      for (const stream of streams) stream.enqueue(frame(event))
    },
    stop: () => {
      for (const stream of streams) stream.error(new Error("stopped"))
      void server.stop(true)
    },
  }
}

/** A stand-in CLI that answers from files beside it, as the real one would print them. */
const writeCli = async (dir: string, proxyUrl: string) => {
  await Bun.write(
    path.join(dir, "start.json"),
    JSON.stringify({ url: proxyUrl, dashboard: `${proxyUrl}/slopmax/#key=${key}`, version: "0.4.0", log: "/dev/null" }),
  )
  await Bun.write(path.join(dir, "status.json"), JSON.stringify(report(false, "offline@example.com", 77)))
  await Bun.write(
    path.join(dir, "doctor.json"),
    JSON.stringify([{ title: "Proxy", findings: [{ level: "fail", text: "slopmax is not running" }] }]),
  )
  const cli = path.join(dir, "slopmax")
  await Bun.write(
    cli,
    [
      "#!/bin/sh",
      'here="$(dirname "$0")"',
      'case "$1" in',
      '  --version) echo "slopmax 0.4.0" ;;',
      '  start) cat "$here/start.json" ;;',
      '  stop) echo "slopmax stopped" ;;',
      '  status) cat "$here/status.json" ;;',
      '  doctor) cat "$here/doctor.json"; exit 1 ;;',
      '  *) echo "error: no supported service manager here" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  )
  await chmod(cli, 0o755)
  return cli
}

describe.skipIf(!runs)("the desktop app", () => {
  let dir = ""
  let proxy: ReturnType<typeof standIn>
  let app: ElectronApplication
  let window: Page

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "slopmax-desktop-smoke-"))
    proxy = standIn()
    const cli = await writeCli(dir, proxy.url)
    app = await launch({
      app: packaged,
      userData: path.join(dir, "user-data"),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: dir,
        SLOPMAX_CLI: cli,
        ...(process.env["DISPLAY"] === undefined ? {} : { DISPLAY: process.env["DISPLAY"] }),
      },
    })
    window = await windowAt(app, "#/")
  }, 60_000)

  afterAll(async () => {
    await app?.close().catch(() => undefined)
    proxy?.stop()
    if (dir !== "") await rm(dir, { recursive: true, force: true })
  })

  test("shows the running proxy's report", async () => {
    const text = await textWhere(window, (seen) => seen.includes("Running 0.4.0") && seen.includes("Claude"))
    expect(text).toContain("42%")
  }, 30_000)

  test("posts a notice from the proxy as a notification", async () => {
    await app.evaluate(({ Notification }) => {
      const shown: Array<string> = []
      Reflect.set(globalThis, "slopmaxShown", shown)
      Notification.isSupported = () => true
      Notification.prototype.show = function (this: Electron.Notification) {
        shown.push(`${this.title} | ${this.body}`)
      }
    })
    proxy.send({
      _tag: "Notice",
      notice: {
        kind: "exhausted",
        key: "exhausted:claude",
        message: "Every Claude account is limited; run `slopmax status`",
        at,
      },
    })
    const deadline = Date.now() + 10_000
    let shown: unknown = []
    while (Date.now() < deadline) {
      shown = await app.evaluate(() => Reflect.get(globalThis, "slopmaxShown"))
      if (Array.isArray(shown) && shown.length > 0) break
      await Bun.sleep(100)
    }
    expect(shown).toEqual(["Every account is limited | Every Claude account is limited; run slopmax status"])
  }, 30_000)

  test("shows the offline report and the doctor once the proxy stops", async () => {
    proxy.stop()
    const text = await textWhere(window, (seen) => seen.includes("This is what slopmax last saved"), 30_000)
    expect(text).toContain("The proxy is stopped")
    expect(text).toContain("77%")
    expect(text).toContain("Start the proxy")
  }, 40_000)
})
