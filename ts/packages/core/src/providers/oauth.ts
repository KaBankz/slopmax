// The parts of OAuth every subscription sign-in shares: PKCE and state,
// reading a token's claims, and the browser half of an authorization-code
// sign-in.
//
// The browser half listens on the provider's registered loopback redirect
// and, at the same time, takes the final redirect address pasted by hand.
// Pasting is what makes sign-in work on a machine without a browser:
// authorize in any browser, then copy the address bar of the localhost page
// that failed to load back into slopmax.
import { LoginEvent, newToken } from "@slopmax/domain"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Context, DateTime, Duration, Effect, Option, Queue, Result, Schema, type Scope, Stream } from "effect"
import { Digest, type SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { open as openBrowser } from "../browser.ts"
import { causeText } from "../home.ts"
import { fromUnixSeconds, LoginFailed, LoginTimedOut, optionalField, parseJson, StateMismatch } from "./provider.ts"

/** The person's side of a sign-in: where its progress goes, and redirect addresses pasted by hand. */
export class LoginUi extends Context.Service<
  LoginUi,
  {
    readonly tell: (event: LoginEvent) => Effect.Effect<void>
    /** Each line typed or pasted, until nothing more can be pasted. */
    readonly pasted: Stream.Stream<string>
    /** Whether slopmax opens a browser itself: the terminal does; the API leaves it to its caller's window. */
    readonly openBrowser: boolean
  }
>()("@slopmax/core/LoginUi") {}

/** How long slopmax waits for someone to finish authorizing. */
export const loginWait = Duration.minutes(10)

// ---------------------------------------------------------------------------
// PKCE, state, and token claims

export interface Pkce {
  /** 43 characters of `[A-Za-z0-9_-]`, kept by slopmax until the code exchange. */
  readonly verifier: string
  /** The verifier's SHA-256, base64url without padding, sent with the authorization. */
  readonly challenge: string
}

const utf8 = new TextEncoder()

/** The S256 challenge for a verifier. */
export const challengeOf = (verifier: string): Effect.Effect<string, never, Digest.Digest> =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest
    return Base64Url.encode(yield* digest.digest(Digest.sha256, utf8.encode(verifier)))
  })

/** A fresh PKCE pair. */
export const makePkce: Effect.Effect<Pkce, never, SecureRandom.SecureRandom | Digest.Digest> = Effect.gen(function* () {
  const verifier = yield* newToken
  return { verifier, challenge: yield* challengeOf(verifier) }
})

/** The `state` that ties a redirect to the sign-in that asked for it. */
export const newState: Effect.Effect<string, never, SecureRandom.SecureRandom> = newToken

/** A token's payload, read without checking its signature (slopmax only reads who the token names). */
const jwtPayload = (token: string): Option.Option<unknown> => {
  const payload = token.split(".")[1]
  if (payload === undefined) return Option.none()
  const decoded = Base64Url.decodeString(payload.replace(/=+$/, ""))
  return Result.isFailure(decoded) ? Option.none() : parseJson(decoded.success)
}

/** A reader of the claims `schema` describes; none when the token is not a JWT or its claims do not fit. */
export const jwtClaims = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
): ((token: string) => Option.Option<S["Type"]>) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (token) => Option.flatMap(jwtPayload(token), (payload) => decode(payload))
}

const readExpiry = jwtClaims(Schema.Struct({ exp: optionalField(Schema.Int) }))

/** When a token expires, from its integer `exp` claim. */
export const jwtExpiry = (token: string): Option.Option<DateTime.Utc> =>
  Option.flatMap(readExpiry(token), (claims) =>
    claims.exp === undefined ? Option.none() : Option.some(fromUnixSeconds(claims.exp)),
  )

// ---------------------------------------------------------------------------
// The redirect

/** The authorization code a provider sent back, and its state when there is one. */
export interface Callback {
  readonly code: string
  readonly state?: string | undefined
}

/** Reads a redirect's query parameters into a code, or says why there is none. */
const callbackOf = (params: URLSearchParams): Result.Result<Callback, string> => {
  const error = params.get("error")
  if (error !== null) return Result.fail(`authorization failed: ${error} ${params.get("error_description") ?? ""}`)
  const code = params.get("code")
  if (code === null || code === "") return Result.fail("no code")
  const state = params.get("state") ?? undefined
  // Anthropic's manual page shows the code and state as one value, `code#state`.
  const hash = code.indexOf("#")
  if (hash >= 0 && state === undefined)
    return Result.succeed({ code: code.slice(0, hash), state: code.slice(hash + 1) })
  return Result.succeed({ code, state })
}

/**
 * Reads what someone pasted: a whole redirect address, its query alone, or
 * a bare code (`code#state` included). A `#fragment` after the query is
 * dropped.
 */
export const parsePasted = (input: string): Result.Result<Callback, string> => {
  const text = input.trim()
  const question = text.indexOf("?")
  if (question < 0 && !text.includes("=")) return callbackOf(new URLSearchParams([["code", text]]))
  const query = question >= 0 ? text.slice(question + 1) : text
  return callbackOf(new URLSearchParams(query.split("#")[0] ?? query))
}

const page = (title: string, text: string) =>
  `<!doctype html><title>slopmax</title><body style="font-family:system-ui;text-align:center;padding:4em"><h2>${title}</h2><p>${text}</p>`

export const successPage = page("Account connected", "You can close this tab and return to slopmax.")
export const failurePage = page("Authorization failed", "slopmax shows what went wrong.")

/** Listens on `127.0.0.1:port` for the redirect until the scope closes; why not, when the port is taken. */
const listen = (
  port: number,
  path: string,
  redirects: Queue.Queue<Result.Result<Callback, string>>,
): Effect.Effect<Result.Result<void, string>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port })
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://127.0.0.1")
        if (url.pathname !== path) return HttpServerResponse.empty({ status: 404 })
        const result = callbackOf(url.searchParams)
        yield* Queue.offer(redirects, result)
        return HttpServerResponse.text(Result.isSuccess(result) ? successPage : failurePage, {
          contentType: "text/html; charset=utf-8",
        })
      }),
    )
  }).pipe(
    Effect.mapError((error) => causeText(error.cause ?? error)),
    // Bun refuses a taken port by throwing, which arrives as a defect.
    Effect.catchDefect((defect) => Effect.fail(causeText(defect))),
    Effect.result,
  )

/**
 * Waits for the authorization code from the loopback redirect or a pasted
 * address, whichever comes first. A failed attempt is told and waited past.
 * The server stops as soon as a code arrives. A state that differs from ours
 * is refused; a missing one is accepted, as some providers' manual pages
 * leave it out.
 */
export const receive = (
  port: number,
  path: string,
  state: string,
): Effect.Effect<Callback, LoginFailed | StateMismatch, LoginUi> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ui = yield* LoginUi
      const redirects = yield* Queue.unbounded<Result.Result<Callback, string>>()
      const server = yield* listen(port, path, redirects)
      if (Result.isFailure(server)) {
        yield* ui.tell(
          LoginEvent.cases.Note.make({
            text: `port ${port} is busy (${server.failure}); paste the redirect address instead`,
          }),
        )
      }
      const fromServer = Result.isSuccess(server) ? Stream.fromQueue(redirects) : Stream.empty
      const fromPastes = ui.pasted.pipe(
        Stream.filter((line) => line.trim() !== ""),
        Stream.map(parsePasted),
      )
      const first = yield* Stream.merge(fromServer, fromPastes).pipe(
        Stream.tap((attempt) =>
          Result.isFailure(attempt)
            ? ui.tell(LoginEvent.cases.Note.make({ text: `${attempt.failure}; try again` }))
            : Effect.void,
        ),
        Stream.filter(Result.isSuccess),
        Stream.runHead,
      )
      if (Option.isNone(first)) {
        return yield* new LoginFailed({ message: `port ${port} is busy and no redirect address can be pasted` })
      }
      const callback = first.value.success
      if (callback.state !== undefined && callback.state !== state) return yield* new StateMismatch()
      return callback
    }),
  )

/**
 * The browser half of an authorization-code sign-in: opens `url` (when the
 * caller opens browsers), says where to authorize, then waits up to 10
 * minutes for the code.
 */
export const browserLogin = (options: {
  readonly title: string
  readonly url: string
  readonly port: number
  readonly path: string
  readonly state: string
}): Effect.Effect<
  Callback,
  LoginFailed | LoginTimedOut | StateMismatch,
  LoginUi | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const ui = yield* LoginUi
    const opened = ui.openBrowser ? yield* openBrowser(options.url) : false
    yield* ui.tell(
      LoginEvent.cases.Authorize.make({ title: options.title, url: options.url, port: options.port, opened }),
    )
    return yield* receive(options.port, options.path, options.state).pipe(
      Effect.timeoutOrElse({ duration: loginWait, orElse: () => Effect.fail(new LoginTimedOut()) }),
    )
  }).pipe(Effect.withSpan("oauth.browserLogin"))
