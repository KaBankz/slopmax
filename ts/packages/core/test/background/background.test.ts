import { describe, expect } from "bun:test"
import { AccountId, Conflict, RedeemResult, Report, slopmaxVersion, Unauthorized } from "@slopmax/domain"
import { it, MemoryFileSystem } from "@slopmax/test"
import { ConfigProvider, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { RedeemRequest } from "@slopmax/domain/api"
import { Background, NotRunning, StartFailed } from "../../src/background.ts"
import { Home } from "../../src/home.ts"
import type { ServiceManager, ServiceStatus } from "../../src/service.ts"
import { SettingsService } from "../../src/settings.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"

const root = "/home/me/.slopmax"
const base = "http://127.0.0.1:7567"

const report = Schema.encodeSync(Report)(
  new Report({
    version: slopmaxVersion,
    live: true,
    generatedAt: DateTime.makeUnsafe(0),
    strategy: "reset-first",
    accounts: [],
    pools: [],
    nudges: [],
  }),
)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const health = (version = slopmaxVersion) => json({ status: "ok", service: "slopmax", version })

/** A pretend proxy: what it answers, and every request it saw. */
const proxy = (answer: (request: Request, path: string) => Response | Promise<Response>) => {
  const seen: Array<string> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const path = new URL(request.url).pathname
    seen.push(`${request.method} ${path} ${request.headers.get("authorization") ?? "-"}`)
    return answer(request, path)
  }
  return { fetch, seen }
}

const refused = () => Promise.reject(new TypeError("Unable to connect. Is the computer able to access the url?"))

/** A login service that records what it was asked to do. */
const fakeManager = (status: Partial<ServiceStatus> = {}, onStart: () => void = () => undefined) => {
  const asked: Array<string> = []
  const manager: ServiceManager = {
    kind: Option.some("systemd"),
    status: Effect.succeed({ installed: false, running: false, file: "/unit", lingering: Option.none(), ...status }),
    install: Effect.sync(() => {
      asked.push("install")
      onStart()
      return "/unit"
    }),
    uninstall: Effect.succeed("/unit"),
    start: Effect.sync(() => {
      asked.push("start")
      onStart()
    }),
  }
  return { manager, asked }
}

const noManager: ServiceManager = {
  kind: Option.none(),
  status: Effect.succeed({ installed: false, running: false, file: "", lingering: Option.none() }),
  install: Effect.die("no manager"),
  uninstall: Effect.die("no manager"),
  start: Effect.die("no manager"),
}

const background = (
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  /** The login service; "system" looks for the system's own, through the recording spawner. */
  manager: ServiceManager | "system" = noManager,
) => {
  const spawner = recordingSpawner()
  const layer = Background.layerWith({
    exe: ["/opt/slopmax"],
    manager: manager === "system" ? undefined : manager,
    settle: { every: Duration.millis(5), within: Duration.millis(150) },
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Home.layerAt(root),
        SettingsService.layerValue({ apiKey: "sm-test" }),
        spawner.layer,
        Layer.succeed(FetchHttpClient.Fetch)(Object.assign(fetch, { preconnect: () => undefined })),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
      ),
    ),
    Layer.provideMerge(MemoryFileSystem.layer),
  )
  return { layer, spawned: spawner.calls }
}

describe("finding the proxy", () => {
  it.live("the running proxy reports its version", () => {
    const { fetch, seen } = proxy(() => health("9.9.9"))
    return Effect.gen(function* () {
      const bg = yield* Background
      expect(bg.baseUrl).toBe(base)
      expect(yield* bg.running).toEqual(Option.some({ version: "9.9.9" }))
      expect(seen).toEqual(["GET /healthz -"])
    }).pipe(Effect.provide(background(fetch).layer))
  })

  it.live("another program on the port is not the proxy", () =>
    Effect.gen(function* () {
      for (const answer of [
        () => new Response("<html>hello</html>", { headers: { "content-type": "text/html" } }),
        () => json({ status: "ok", service: "something-else", version: "1" }),
        () => json({ error: "nope" }, 404),
      ]) {
        const running = yield* Effect.flatMap(Background, (bg) => bg.running).pipe(
          Effect.provide(background(proxy(answer).fetch).layer),
        )
        expect(running).toEqual(Option.none())
      }
    }),
  )

  it.live("nothing listening is not running, and its API cannot be had", () =>
    Effect.gen(function* () {
      const bg = yield* Background
      expect(yield* bg.running).toEqual(Option.none())
      const failed = yield* Effect.flip(bg.client)
      expect(failed).toBeInstanceOf(NotRunning)
      expect(failed.message).toContain(base)
    }).pipe(Effect.provide(background(refused).layer)),
  )
})

describe("talking to the proxy", () => {
  it.live("reports are read with the key, and refreshes and syncs are POSTs", () => {
    const { fetch, seen } = proxy((_request, path) => (path === "/healthz" ? health() : json(report)))
    return Effect.gen(function* () {
      const client = yield* (yield* Background).client
      expect((yield* client.system.status()).version).toBe(slopmaxVersion)
      yield* client.system.refresh()
      yield* client.system.sync()
      expect(seen.filter((line) => !line.includes("healthz"))).toEqual([
        "GET /slopmax/api/status Bearer sm-test",
        "POST /slopmax/api/refresh Bearer sm-test",
        "POST /slopmax/api/sync Bearer sm-test",
      ])
    }).pipe(Effect.provide(background(fetch).layer))
  })

  it.live("a wrong key is refused, as the proxy's own error", () => {
    const { fetch } = proxy((_request, path) =>
      path === "/healthz" ? health() : json({ _tag: "Unauthorized", message: "missing or invalid slopmax key" }, 401),
    )
    return Effect.gen(function* () {
      const client = yield* (yield* Background).client
      const failed = yield* Effect.flip(client.system.status())
      expect(failed).toBeInstanceOf(Unauthorized)
    }).pipe(Effect.provide(background(fetch).layer))
  })

  it.live("redeeming returns the outcome, or the proxy's reason it could not", () => {
    let answer: Response = json({ outcome: "reset", report })
    const { fetch, seen } = proxy((_request, path) => (path === "/healthz" ? health() : answer))
    return Effect.gen(function* () {
      const client = yield* (yield* Background).client
      const params = { id: AccountId.make("codex-1a2b3c4d") }
      const result = yield* client.accounts.redeem({ params, payload: new RedeemRequest({}) })
      expect(result).toBeInstanceOf(RedeemResult)
      expect(result.outcome).toBe("reset")
      expect(seen.at(-1)).toBe("POST /slopmax/api/accounts/codex-1a2b3c4d/redeem Bearer sm-test")
      answer = json({ _tag: "Conflict", message: "the account has no limit reset to redeem" }, 409)
      const failed = yield* Effect.flip(client.accounts.redeem({ params, payload: new RedeemRequest({}) }))
      expect(failed).toBeInstanceOf(Conflict)
      expect(failed.message).toBe("the account has no limit reset to redeem")
    }).pipe(Effect.provide(background(fetch).layer))
  })
})

describe("starting and stopping", () => {
  it.live("stopping asks a running proxy to shut down and waits until it is gone", () => {
    let up = true
    const { fetch, seen } = proxy((_request, path) => {
      if (path === "/slopmax/api/shutdown") {
        up = false
        return json({ status: "stopping" })
      }
      return up ? health() : Promise.reject(new TypeError("connection refused"))
    })
    return Effect.gen(function* () {
      const bg = yield* Background
      expect(yield* bg.stop).toBe(true)
      expect(seen).toContain("POST /slopmax/api/shutdown Bearer sm-test")
      expect(yield* bg.stop).toBe(false)
    }).pipe(Effect.provide(background(fetch).layer))
  })

  it.live("ensuring a proxy that already runs starts nothing", () => {
    const { layer, spawned } = background(proxy(() => health()).fetch)
    return Effect.gen(function* () {
      expect(yield* (yield* Background).ensure).toEqual({ started: false })
      expect(spawned).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.live("with no login service, the proxy starts as a detached serve that writes its own log", () => {
    // The pretend proxy answers once the spawner has been asked to start it.
    const run = background(proxy(() => (run.spawned.length > 0 ? health() : refused())).fetch)
    return Effect.gen(function* () {
      expect(yield* (yield* Background).ensure).toEqual({ started: true })
      expect(run.spawned).toEqual([
        {
          line: `/opt/slopmax serve --log ${root}/slopmax.log`,
          program: "/opt/slopmax",
          args: ["serve", "--log", `${root}/slopmax.log`],
          detached: true,
        },
      ])
    }).pipe(Effect.provide(run.layer))
  })

  it.live("an installed login service is started instead of a detached proxy", () => {
    let up = false
    const { manager, asked } = fakeManager({ installed: true }, () => {
      up = true
    })
    const run = background(proxy(() => (up ? health() : Promise.reject(new TypeError("refused")))).fetch, manager)
    return Effect.gen(function* () {
      expect(yield* (yield* Background).ensure).toEqual({ started: true })
      expect(asked).toEqual(["start"])
      expect(run.spawned).toEqual([])
    }).pipe(Effect.provide(run.layer))
  })

  it.live("a port that takes the call and never answers still ends the wait on time", () => {
    // Nothing there at first; once started, the port takes calls and never answers them.
    const run = background(() => (run.spawned.length === 0 ? refused() : new Promise<Response>(() => undefined)))
    return Effect.gen(function* () {
      const started = Date.now()
      const failed = yield* Effect.flip((yield* Background).ensure)
      expect(failed).toBeInstanceOf(StartFailed)
      expect(Date.now() - started).toBeLessThan(1_000)
    }).pipe(Effect.provide(run.layer))
  })

  it.live("the login service is looked for only when it is used", () => {
    const run = background(proxy(() => health()).fetch, "system")
    return Effect.gen(function* () {
      const bg = yield* Background
      yield* bg.running
      expect(run.spawned).toEqual([])
      const kind = yield* bg.service.kind
      if (process.platform === "linux") {
        expect(run.spawned.map((call) => call.line)).toEqual(["systemctl --user --version"])
        expect(kind).toEqual(Option.some("systemd"))
      }
      yield* bg.service.kind
      expect(run.spawned.length).toBeLessThanOrEqual(1)
    }).pipe(Effect.provide(run.layer))
  })

  it.live("a proxy that never comes up points at its log", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip((yield* Background).ensure)
      expect(failed).toBeInstanceOf(StartFailed)
      expect(failed.message).toBe(`the proxy did not start; see ${root}/slopmax.log`)
    }).pipe(Effect.provide(background(refused).layer)),
  )

  it.live("installing the service stops a running proxy first, then waits for the service's", () => {
    let up = true
    const { manager, asked } = fakeManager({}, () => {
      up = true
    })
    const { fetch, seen } = proxy((_request, path) => {
      if (path === "/slopmax/api/shutdown") {
        up = false
        asked.push("shutdown")
        return json({ status: "stopping" })
      }
      return up ? health() : Promise.reject(new TypeError("refused"))
    })
    return Effect.gen(function* () {
      expect(yield* (yield* Background).service.install).toBe("/unit")
      expect(asked).toEqual(["shutdown", "install"])
      expect(seen.at(-1)).toBe("GET /healthz -")
    }).pipe(Effect.provide(background(fetch, manager).layer))
  })
})
