import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Notice, type NoticeKind } from "@slopmax/domain"
import { posted, postingFor } from "../src/main/notifications.ts"

const notice = (kind: NoticeKind, message: string) =>
  new Notice({ kind, key: `${kind}:claude-1`, message, at: DateTime.makeUnsafe("2026-11-01T09:00:00Z") })

describe("notifications", () => {
  test("are posted for what asks someone to act, not for every account's ups and downs", () => {
    for (const kind of ["exhausted", "recovered", "signed-out", "reset-expiring", "quota-unused"] as const) {
      expect(posted(kind)).toBe(true)
    }
    // The test notice is how someone checks that notifications arrive.
    expect(posted("test")).toBe(true)
    expect(posted("limited")).toBe(false)
    expect(posted("available")).toBe(false)
  })

  test("read plainly: a title for the kind, the message without backticks, and the notice's key", () => {
    expect(postingFor(notice("signed-out", "Sign in to me@x.com again: `slopmax login claude`"))).toEqual({
      title: "Sign in again",
      body: "Sign in to me@x.com again: slopmax login claude",
      key: "signed-out:claude-1",
    })
  })
})
