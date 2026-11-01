// The raw probe: the least a proxy on Bun can do, as the yardstick the
// gates hold slopmax to. It reads each request body whole, forwards it to
// the mock provider with `fetch`, and streams the answer back through a tap
// that counts its bytes, the way slopmax's relay watches a stream go by. No
// Effect, no routing, no accounts: what slopmax costs beyond this is the
// price of its decisions.
//
//   raw <host:port> <mock-url>
//
// `/claude/*` goes to the mock's `/*` and `/codex/*` to its `/codex/*`, as
// slopmax sends them, so the same load runs against both. It is compiled
// with the slopmax binary's flags and run in the same job.

/** Where a request for `path` goes upstream, or nothing for a path the probe does not serve. */
export const rawTarget = (path: string, upstream: string): string | undefined => {
  if (path.startsWith("/claude/")) return `${upstream}${path.slice("/claude".length)}`
  if (path.startsWith("/codex/")) return `${upstream}${path}`
  return undefined
}

/** The headers sent upstream: the client's, less the hop's own. */
const forwardHeaders = (headers: Headers): Headers => {
  const out = new Headers(headers)
  out.delete("host")
  out.delete("content-length")
  out.delete("connection")
  return out
}

/** Bytes relayed so far, over every answer: the tap's only state. */
let relayed = 0

/** Passes each chunk on, counting it. */
const tap = (): TransformStream<Uint8Array, Uint8Array> =>
  new TransformStream({
    transform: (chunk, controller) => {
      relayed += chunk.byteLength
      controller.enqueue(chunk)
    },
  })

const health = () => Response.json({ status: "ok", service: "raw", relayed })

/** Answers one request through the probe. */
export const handleRaw = async (request: Request, upstream: string): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === "/healthz") return health()
  const target = rawTarget(url.pathname, upstream)
  if (target === undefined) return new Response(null, { status: 404 })
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.bytes()
  const answer = await fetch(`${target}${url.search}`, {
    method: request.method,
    headers: forwardHeaders(request.headers),
    ...(body === undefined ? {} : { body }),
    decompress: false,
  })
  const headers = new Headers(answer.headers)
  headers.delete("content-length")
  const stream = answer.body === null ? null : answer.body.pipeThrough(tap())
  return new Response(stream, { status: answer.status, headers })
}

/** Splits `host:port`; a missing or bad port is 0, which picks a free one. */
export const splitAddress = (listen: string): { readonly hostname: string; readonly port: number } => {
  const at = listen.lastIndexOf(":")
  const port = Number(listen.slice(at + 1))
  return {
    hostname: at < 0 ? listen : listen.slice(0, at),
    port: at < 0 || !Number.isInteger(port) ? 0 : port,
  }
}

if (import.meta.main) {
  const [listen, upstream] = process.argv.slice(2)
  if (listen === undefined || upstream === undefined) {
    process.stderr.write("usage: raw <host:port> <mock-url>\n")
    process.exit(2)
  }
  const { hostname, port } = splitAddress(listen)
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    fetch: (request) => handleRaw(request, upstream.replace(/\/+$/, "")),
  })
  process.stderr.write(`raw probe on http://${hostname}:${server.port}\n`)
  const stop = () => {
    void server.stop(true).then(() => process.exit(0))
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
