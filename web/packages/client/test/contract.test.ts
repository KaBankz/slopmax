import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Result, Schema } from "effect"
import {
  AccountAmbiguous,
  AccountGone,
  AccountId,
  AccountNotFound,
  ApiErrors,
  BadRequest,
  defaultNoticeKinds,
  Event,
  Finding,
  Instant,
  issueText,
  LedgerRecord,
  Level,
  LoginEvent,
  LoginId,
  Notice,
  NoticeKind,
  NotFound,
  Section,
  SettingRejected,
  SettingsInvalid,
  Unauthorized,
  Usage,
} from "../src/index.ts"

const ts = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]): S["Type"] =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))))

describe("errors", () => {
  it("are worded for people and carry the status slopmax's API answers them with", () => {
    expect(new Unauthorized().message).toBe("missing or invalid slopmax key; see `slopmax agent env`")
    expect(NotFound.of({ what: "account" }).message).toBe("no such account")
    expect(NotFound.of({ what: "slopmax endpoint" }).message).toBe("no such slopmax endpoint")
    expect(AccountNotFound.of({ query: "bob" }).message).toBe('no account matches "bob"')
    const ids = [AccountId.make("codex-1"), AccountId.make("codex-2")]
    expect(AccountAmbiguous.of({ query: "a@x.com", ids }).message).toBe(
      '"a@x.com" matches 2 accounts: codex-1, codex-2',
    )
    expect(AccountGone.of({ id: AccountId.make("codex-1") }).message).toBe("the account codex-1 is gone")
    expect(SettingsInvalid.of({ path: "/h/config.json", issue: "lisen: Expected no excess property" }).message).toBe(
      "invalid settings in /h/config.json: lisen: Expected no excess property",
    )
    expect(SettingRejected.of({ name: "pollMinutes", reason: "pollMinutes is a number of minutes" }).message).toBe(
      "pollMinutes is a number of minutes",
    )
    const statuses = ApiErrors.map((error) => [error.identifier, Schema.resolveAnnotations(error)?.["httpApiStatus"]])
    expect(statuses).toEqual([
      ["Unauthorized", 401],
      ["NotFound", 404],
      ["BadRequest", 400],
      ["Conflict", 409],
      ["UpstreamFailed", 502],
      ["Internal", 500],
    ])
  })

  it("are encoded with their tag and message, and decode back to the same error", () => {
    const error = new BadRequest({ message: "range is today, 7d, 30d, or all" })
    expect(Schema.encodeSync(BadRequest)(error)).toEqual({
      _tag: "BadRequest",
      message: "range is today, 7d, 30d, or all",
    })
    expect(roundTrip(BadRequest, error)).toBeInstanceOf(BadRequest)
    expect(roundTrip(NotFound, NotFound.of({ what: "key" })).message).toBe("no such key")
  })

  it("turn a Schema failure into one line naming where each problem is", () => {
    const result = Schema.decodeUnknownResult(
      Schema.Struct({ a: Schema.Struct({ b: Schema.Number }), c: Schema.String }),
    )({ a: { b: "x" }, c: 1 }, { errors: "all" })
    if (Result.isSuccess(result)) throw new Error("expected a failure")
    expect(issueText(result.failure.issue)).toBe("a.b: Expected number; c: Expected string")
  })

  it("say a malformed time is not an RFC 3339 timestamp", () => {
    const result = Schema.decodeUnknownResult(Instant)("yesterday")
    if (Result.isSuccess(result)) throw new Error("expected a failure")
    expect(issueText(result.failure.issue)).toBe("invalid RFC 3339 timestamp")
  })
})

describe("notices", () => {
  it("have one kind per thing worth telling, and send the ones someone must act on by default", () => {
    expect(NoticeKind.literals).toEqual([
      "limited",
      "available",
      "exhausted",
      "recovered",
      "signed-out",
      "reset-expiring",
      "quota-unused",
      "test",
    ])
    expect(defaultNoticeKinds).toEqual(["exhausted", "recovered", "signed-out", "reset-expiring", "quota-unused"])
  })

  it("carry what they are about, and leave out what they do not know", () => {
    const notice = new Notice({
      kind: "quota-unused",
      key: "unused:claude-1:7d",
      provider: "claude",
      account: "a@x.com",
      until: ts(9_000),
      message: "a@x.com's week resets with 40% unused.",
      at: ts(1_000),
      worth: 12.5,
    })
    expect(roundTrip(Notice, notice)).toEqual(notice)
    const plain = Schema.encodeSync(Notice)(new Notice({ kind: "test", key: "test", message: "hi", at: ts(0) }))
    expect(plain).toEqual({ kind: "test", key: "test", message: "hi", at: "1970-01-01T00:00:00Z" })
  })
})

describe("the doctor's findings", () => {
  it("have levels from fine to broken", () => {
    expect(Level.literals).toEqual(["ok", "info", "warn", "fail"])
  })

  it("come in sections, with a fix only where one helps", () => {
    const section = new Section({
      title: "Accounts",
      findings: [
        new Finding({ level: "ok", text: "2 accounts" }),
        new Finding({ level: "fail", text: "a@x.com needs signing in again", fix: "slopmax login claude" }),
      ],
    })
    const encoded = Schema.encodeSync(Section)(section)
    expect(encoded.findings[0]).toEqual({ level: "ok", text: "2 accounts" })
    expect(roundTrip(Section, section)).toEqual(section)
  })
})

describe("events", () => {
  it("each survive the stream as JSON", () => {
    const record = LedgerRecord.cases.Request.make({
      at: ts(1_000),
      provider: "claude",
      status: 200,
      usage: Usage.zero,
      ms: 4,
      attempts: 1,
      via: "http",
    })
    const login = LoginId.make("login-1")
    const events: ReadonlyArray<Event> = [
      Event.cases.Hello.make({ version: "0.4.0" }),
      Event.cases.Request.make({ record }),
      Event.cases.Notice.make({ notice: new Notice({ kind: "test", key: "test", message: "hi", at: ts(0) }) }),
      Event.cases.Login.make({
        id: login,
        event: LoginEvent.cases.Authorize.make({
          title: "Claude",
          url: "https://x/authorize",
          port: 54_545,
          opened: true,
        }),
      }),
      Event.cases.Login.make({
        id: login,
        event: LoginEvent.cases.DeviceCode.make({ url: "https://x/device", code: "AB-CD" }),
      }),
      Event.cases.Login.make({ id: login, event: LoginEvent.cases.Failed.make({ message: "timed out" }) }),
      Event.cases.Ping.make({}),
    ]
    for (const event of events) expect(roundTrip(Event, event)).toEqual(event)
    expect(Schema.encodeSync(Event)(Event.cases.Ping.make({}))).toEqual({ _tag: "Ping" })
  })
})
