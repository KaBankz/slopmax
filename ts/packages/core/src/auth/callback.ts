// The browser half of an OAuth authorization-code flow.
//
// slopmax listens on the provider's registered loopback redirect and, at the
// same time, accepts the final redirect address pasted into the CLI or app.
// The paste path makes logins work on headless machines: authorize in any
// browser, then copy the address bar of the (failed) localhost page back.
import { spawn } from "node:child_process"
import process from "node:process"

import { Config, Duration, Effect, Option, Queue, Result, type Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import { form, server } from "@slopmax/net"

import { chain, Failure } from "../error.ts"
import { osErrorText } from "../fsx.ts"
import { LoginEvent, type LoginOptions, type Prompt } from "./mod.ts"

/** How long to wait for the user to finish authorizing. */
const LOGIN_TIMEOUT = Duration.seconds(600)

/** Authorization code returned by the provider. */
export interface Callback {
  readonly code: string
  readonly state: string | undefined
}

interface Params {
  code: string | undefined
  state: string | undefined
  error: string | undefined
  errorDescription: string | undefined
}

const intoCallback = (params: Params): Result.Result<Callback, Failure> => {
  if (params.error !== undefined) {
    const detail = params.errorDescription ?? ""
    return Result.fail(new Failure({ message: `authorization failed: ${params.error} ${detail}` }))
  }
  const code = params.code
  if (code === undefined || code === "") return Result.fail(new Failure({ message: "no code" }))
  // Anthropic's manual flow shows `code#state` as a single value.
  const hash = code.indexOf("#")
  if (hash >= 0 && params.state === undefined) {
    return Result.succeed({ code: code.slice(0, hash), state: code.slice(hash + 1) })
  }
  return Result.succeed({ code, state: params.state })
}

/** Parses a pasted redirect URL, query string, or bare `code#state`. */
export const parsePasted = (input: string): Result.Result<Callback, Failure> => {
  const trimmed = input.trim()
  const question = trimmed.indexOf("?")
  let query: string
  if (question >= 0) query = trimmed.slice(question + 1)
  else if (trimmed.includes("=")) query = trimmed
  else {
    return intoCallback({ code: trimmed, state: undefined, error: undefined, errorDescription: undefined })
  }
  const hash = query.indexOf("#")
  return intoCallback(parseQuery(hash >= 0 ? query.slice(0, hash) : query))
}

/** Decodes the OAuth parameters from a URL query string. */
const parseQuery = (query: string): Params => {
  const params: Params = { code: undefined, state: undefined, error: undefined, errorDescription: undefined }
  for (const [key, value] of form.decode(query)) {
    switch (key) {
      case "code":
        params.code = value
        break
      case "state":
        params.state = value
        break
      case "error":
        params.error = value
        break
      case "error_description":
        params.errorDescription = value
        break
    }
  }
  return params
}

type Next =
  | { readonly _tag: "Redirect"; readonly result: Result.Result<Callback, Failure> }
  | { readonly _tag: "Line"; readonly line: string }
  | { readonly _tag: "NoMorePastes" }

/**
 * Waits for the authorization code, from either the loopback redirect or an
 * address pasted into `prompt`, and checks the CSRF `state`.
 */
export const receive = Effect.fn("callback.receive")(function* (
  port: number,
  path: string,
  expectedState: string,
  prompt: Prompt,
): Effect.fn.Return<Callback, Failure, Scope.Scope> {
  const redirects = yield* Queue.bounded<Result.Result<Callback, Failure>>(4)
  const bound = yield* Effect.result(server.bind({ hostname: "127.0.0.1", port }))
  let serving = false
  if (bound._tag === "Success") {
    yield* bound.success.serve(serve(path, redirects))
    serving = true
  } else {
    // No redirect can arrive, so waiting ends once pastes do too.
    const error = bound.failure
    const reason = error.code === undefined ? error.reason : osErrorText(error.code, error.reason)
    prompt.tell(LoginEvent.Notice(`port ${port} is busy (${reason}); paste the redirect address instead`))
  }

  let pastesDone = false
  const pasted: Effect.Effect<Next> = Effect.map(prompt.pasted, (line): Next =>
    line === undefined ? { _tag: "NoMorePastes" } : { _tag: "Line", line },
  )
  const redirected: Effect.Effect<Next> = Effect.map(Queue.take(redirects), (result): Next => ({
    _tag: "Redirect",
    result,
  }))
  const waiting = Effect.gen(function* () {
    for (;;) {
      if (!serving && pastesDone) {
        return yield* Effect.fail(
          new Failure({ message: `port ${port} is busy and no redirect address can be pasted` }),
        )
      }
      const pasteSide = pastesDone ? Effect.never : pasted
      const next = serving ? yield* Effect.raceFirst(redirected, pasteSide) : yield* pasteSide
      let attempt: Result.Result<Callback, Failure>
      if (next._tag === "NoMorePastes") {
        pastesDone = true
        continue
      } else if (next._tag === "Line") {
        if (next.line.trim() === "") continue
        attempt = parsePasted(next.line)
      } else {
        attempt = next.result
      }
      if (attempt._tag === "Success") return attempt.success
      prompt.tell(LoginEvent.Notice(`${chain(attempt.failure)}; try again`))
    }
  })
  const callback = yield* Effect.timeoutOrElse(waiting, {
    duration: LOGIN_TIMEOUT,
    orElse: () => Effect.fail(new Failure({ message: "timed out waiting for authorization" })),
  })
  if (callback.state !== undefined && callback.state !== expectedState) {
    return yield* Effect.fail(new Failure({ message: "OAuth state mismatch; start over" }))
  }
  return callback
}, Effect.scoped)

const serve = (path: string, redirects: Queue.Queue<Result.Result<Callback, Failure>>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname !== path) return HttpServerResponse.empty({ status: 404 })
    const result = intoCallback(parseQuery(url.search.replace(/^\?/, "")))
    const page = Result.isSuccess(result) ? SUCCESS_PAGE : FAILURE_PAGE
    yield* Queue.offer(redirects, result)
    return HttpServerResponse.text(page, { contentType: "text/html; charset=utf-8" })
  })

/**
 * The browser half of an authorization-code login: opens `url` (unless told
 * not to), then waits for the redirect to `[port, path]` or a pasted address.
 */
export const browserLogin = Effect.fn("callback.browserLogin")(function* (
  title: string,
  url: string,
  [port, path]: readonly [port: number, path: string],
  state: string,
  options: LoginOptions,
  prompt: Prompt,
): Effect.fn.Return<Callback, Failure> {
  const opened = !options.noBrowser && (yield* openBrowser(url))
  prompt.tell(LoginEvent.Authorize(title, url, opened, port))
  return yield* receive(port, path, state, prompt)
})

const envSet = (name: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    return Option.isSome(yield* Config.option(Config.String(name)))
  }).pipe(Effect.orElseSucceed(() => false))

/** Whether this machine can show a browser (it has a desktop session). */
export const hasBrowser: Effect.Effect<boolean> = Effect.gen(function* () {
  if (process.platform === "darwin" || process.platform === "win32") return true
  return (yield* envSet("DISPLAY")) || (yield* envSet("WAYLAND_DISPLAY"))
})

/** Opens `url` in the default browser; false when none is available. */
export const openBrowser = Effect.fn("callback.openBrowser")(function* (url: string): Effect.fn.Return<boolean> {
  if (!(yield* hasBrowser)) return false
  const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  // The opener is left to run on its own, as Rust's `spawn` leaves it.
  return yield* Effect.callback<boolean>((resume) => {
    try {
      const child = spawn(program, [url], { stdio: "ignore", detached: true })
      child.once("spawn", () => {
        child.unref()
        resume(Effect.succeed(true))
      })
      child.once("error", () => resume(Effect.succeed(false)))
    } catch {
      resume(Effect.succeed(false))
    }
  })
})

const SUCCESS_PAGE =
  "<!doctype html><title>slopmax</title>" +
  '<body style="font-family:system-ui;text-align:center;padding:4em">' +
  "<h2>Account connected</h2><p>You can close this tab and return to slopmax.</p>"

const FAILURE_PAGE =
  "<!doctype html><title>slopmax</title>" +
  '<body style="font-family:system-ui;text-align:center;padding:4em">' +
  "<h2>Authorization failed</h2><p>slopmax shows what went wrong.</p>"
