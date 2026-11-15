// The typed client for slopmax's own API, as atoms. One definition of the
// API (`@slopmax/client/api`) gives the daemon its handlers and this page its
// client. The page talks to its own origin: the proxy itself for the web
// dashboard, the desktop app's main process (which adds the key) for the window.
import type { Access } from "@slopmax/client"
import { SlopmaxApi } from "@slopmax/client/api"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Atom, AtomHttpApi } from "effect/reactivity"
import type { HostShape } from "./host.ts"
import { Host, hostLayer } from "./host.ts"

/** The host the page runs in, set once at startup (or by a test). */
export const hostAtom = Atom.make<Option.Option<HostShape>>(Option.none()).pipe(Atom.keepAlive)

/** How requests leave the page: the browser's fetch, or in tests, the stub API in process. */
export const transportAtom = Atom.make<Layer.Layer<HttpClient.HttpClient>>(FetchHttpClient.layer).pipe(Atom.keepAlive)

/**
 * The owner key the web dashboard holds; none in the desktop window, whose
 * main process adds it. A page opened over the tailnet without a key holds
 * the tailnet token here instead, for this tab only.
 */
export const ownerKeyAtom = Atom.make<Option.Option<string>>(Option.none()).pipe(Atom.keepAlive)

/**
 * What the page may do: everything with a key, else what the hub said this
 * machine's tailnet identity may do (view or admin).
 */
export const accessAtom = Atom.make<Access>("admin").pipe(Atom.keepAlive)

/** The hub's name for this machine, when the page uses its tailnet identity. */
export const machineAtom = Atom.make<Option.Option<string>>(Option.none()).pipe(Atom.keepAlive)

/** Where the API is: the page's own origin. */
const originAtom = Atom.make((get) =>
  get(hostAtom).pipe(
    Option.map((host) => host.origin),
    Option.getOrElse(() => "http://localhost"),
  ),
)

/**
 * The page's HTTP client: every request goes to the page's origin, carries
 * the owner key when the page holds one, and no trace headers.
 */
const clientLayer = (
  transport: Layer.Layer<HttpClient.HttpClient>,
  origin: string,
  key: Option.Option<string>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return client.pipe(
        HttpClient.mapRequest((request) => {
          const placed = HttpClientRequest.prependUrl(request, origin)
          return Option.match(key, { onNone: () => placed, onSome: (k) => HttpClientRequest.bearerToken(placed, k) })
        }),
        HttpClient.transform((effect) => Effect.provideService(effect, HttpClient.TracerPropagationEnabled, false)),
      )
    }),
  ).pipe(Layer.provide(transport))

/**
 * The page's way out without the key it holds, for checking a key before it
 * is kept: the gate asks slopmax with the typed key first, so a wrong one
 * never opens the dashboard.
 */
export const keyCheckRuntime = Atom.runtime((get) => clientLayer(get(transportAtom), get(originAtom), Option.none()))

export class Api extends AtomHttpApi.Service<Api>()("@slopmax/ui/Api", {
  api: SlopmaxApi,
  httpClient: (get) => clientLayer(get(transportAtom), get(originAtom), get(ownerKeyAtom)),
}) {}

/** Everything the app's actions use: the API client and the host. */
export const appRuntime = Atom.runtime((get) =>
  Layer.mergeAll(
    get(Api.runtime.layer),
    get(hostAtom).pipe(
      Option.match({
        onNone: () => Layer.effect(Host, Effect.die(new Error("the page has no host yet"))),
        onSome: hostLayer,
      }),
    ),
  ),
)
