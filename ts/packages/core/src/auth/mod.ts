// Account connection: OAuth login, token refresh, and credential import.
//
// This module holds what signing in and refreshing share: grants, why a
// refresh failed, the HTTP client for OAuth calls, and the person's side of
// a sign-in. The browser half of a login is in `callback.ts`; connecting an
// account and keeping its token fresh under the file lock are in
// `connect.ts` (they go through the provider registry, which the providers
// themselves, using what is here, cannot import back).
import { Cause, Data, Effect, Queue } from "effect"

import { type Timestamp, text as texts } from "@slopmax/common"
import { Client, client, type Origins } from "@slopmax/net"

import type { Endpoint, Tokens } from "../account.ts"
import { chain, Failure } from "../error.ts"
import { USER_AGENT } from "../version.ts"

/** Tokens returned by a code exchange or refresh. */
export interface Grant {
  readonly accessToken: string
  readonly refreshToken: string | undefined
  readonly idToken: string | undefined
  readonly expiresAt: Timestamp | undefined
}

export const Grant = {
  intoTokens: (self: Grant, now: Timestamp): Tokens => ({
    accessToken: self.accessToken,
    ...(self.refreshToken === undefined ? {} : { refreshToken: self.refreshToken }),
    ...(self.idToken === undefined ? {} : { idToken: self.idToken }),
    ...(self.expiresAt === undefined ? {} : { expiresAt: self.expiresAt }),
    refreshedAt: now,
  }),
} as const

/** The refresh token was rejected; only a new login can fix this. */
export class Revoked extends Data.TaggedError("Revoked")<{ readonly reason: string }> {
  override get message(): string {
    return `${this.reason}; log in again`
  }
}

/** A temporary failure; the stored token may still work later. */
export class Transient extends Data.TaggedError("Transient")<{ readonly error: unknown }> {
  override get message(): string {
    return chain(this.error)
  }
}

/** Any error, as a refresh that may work if tried again. */
export const transient = (error: unknown): Transient => new Transient({ error })

/** Why a token refresh failed. */
export type RefreshError = Revoked | Transient

const REJECTIONS = ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]

export const RefreshError = {
  /**
   * Classifies a non-success token endpoint response. Refresh tokens are
   * single-use, so only explicit rejections count as revoked.
   */
  classify: (status: number, body: string): RefreshError => {
    const rejected = REJECTIONS.some((code) => body.includes(code))
    if (status === 401 || (status >= 400 && status < 500 && rejected)) {
      return new Revoked({ reason: `refresh token rejected (${client.statusText(status)})` })
    }
    return new Transient({
      error: new Failure({ message: `token refresh failed (${client.statusText(status)}): ${body}` }),
    })
  },
} as const

/** HTTP client for OAuth and usage endpoints, with bounded timeouts. */
export const httpClient = (origins: Origins): Effect.Effect<Client> =>
  Client.builder().origins(origins).userAgent(USER_AGENT).connectTimeout("10 seconds").timeout("30 seconds").build()

export interface LoginOptions {
  /** Use the device-code flow (Codex only). */
  readonly device: boolean
  /** Ask for authorization without opening a browser. */
  readonly noBrowser: boolean
  /** For a compatible endpoint: where it is and what it serves. */
  readonly endpoint?: Endpoint
  /**
   * For API keys and compatible endpoints: the key, which the CLI or app
   * asks for before signing in.
   */
  readonly key?: string
}

const debugOption = (value: string | undefined): string => (value === undefined ? "None" : `Some(${value})`)

export const LoginOptions = {
  default: (): LoginOptions => ({ device: false, noBrowser: false }),

  /** Rust's `{:?}`, which never prints the key. */
  debug: (self: LoginOptions): string => {
    const endpoint =
      self.endpoint === undefined
        ? undefined
        : `Endpoint { base_url: ${texts.debug(self.endpoint.baseUrl)}, dialect: ${debugDialect(self.endpoint.dialect)}, models: [${self.endpoint.models.map(texts.debug).join(", ")}] }`
    return (
      `LoginOptions { device: ${self.device}, no_browser: ${self.noBrowser}, endpoint: ${debugOption(endpoint)}, ` +
      `key: ${debugOption(self.key === undefined ? undefined : texts.debug("<redacted>"))} }`
    )
  },
} as const

const debugDialect = (dialect: string): string => dialect.charAt(0).toUpperCase() + dialect.slice(1)

/** What a sign-in tells the person signing in, as it goes. */
export type LoginEvent =
  /**
   * Authorize the `title` account at `url`, in the browser `opened` if one
   * could be. The browser then redirects to `localhost:port`; with a browser
   * on another machine, that final address is pasted back.
   */
  | {
      readonly _tag: "Authorize"
      readonly title: string
      readonly url: string
      readonly opened: boolean
      readonly port: number
    }
  /** Enter `code` at `url`: the sign-in for machines without a browser. */
  | { readonly _tag: "DeviceCode"; readonly url: string; readonly code: string }
  /** Something to know while waiting, such as a rejected paste. */
  | { readonly _tag: "Notice"; readonly text: string }

export const LoginEvent = {
  Authorize: (title: string, url: string, opened: boolean, port: number): LoginEvent => ({
    _tag: "Authorize",
    title,
    url,
    opened,
    port,
  }),
  DeviceCode: (url: string, code: string): LoginEvent => ({ _tag: "DeviceCode", url, code }),
  Notice: (text: string): LoginEvent => ({ _tag: "Notice", text }),
} as const

/** Lines pasted by hand; ending the queue (`Queue.end`) says nothing more will come. */
export type Pasted = Queue.Dequeue<string, Cause.Done>

/**
 * The person's side of a sign-in: where its `LoginEvent`s go, and the
 * redirect addresses pasted by hand. The CLI connects it to the terminal,
 * the app to its window.
 */
export class Prompt {
  private constructor(
    private readonly events: (event: LoginEvent) => void,
    private readonly lines: Pasted | undefined,
  ) {}

  static make(events: (event: LoginEvent) => void): Prompt {
    return new Prompt(events, undefined)
  }

  /** Also accepts each line `pasted` delivers as a redirect address. */
  withPasted(pasted: Pasted): Prompt {
    return new Prompt(this.events, pasted)
  }

  tell(event: LoginEvent): void {
    this.events(event)
  }

  /** The next pasted line, or undefined when nothing more can be pasted. */
  get pasted(): Effect.Effect<string | undefined> {
    const lines = this.lines
    if (lines === undefined) return Effect.succeed(undefined)
    return Queue.take(lines).pipe(Effect.catchIf(Cause.isDone, () => Effect.succeed(undefined)))
  }

  /** Whether lines can be pasted at all. */
  get canPaste(): boolean {
    return this.lines !== undefined
  }

  /** Rust's `{:?}`. */
  toString(): string {
    return `Prompt { pasted: ${this.lines !== undefined}, .. }`
  }
}
