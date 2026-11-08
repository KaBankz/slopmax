// The Settings page's live settings, read from what the API serves: which
// ones Routing and Limit resets show by name, and the rest as Advanced rows
// (a switch or a stepper of minutes), each with its title and its sentence.
import type { LiveKey, SettingsView } from "@slopmax/client"
import { isLiveKey, LivePatch } from "@slopmax/client"
import { Option, Schema } from "effect"
import { liveDetail, minutes, pollSteps, sessionSteps, step } from "./words.ts"

/** The live settings shown in their own sections, not under Advanced. */
export const namedElsewhere: ReadonlyArray<LiveKey> = [
  "strategy",
  "sessionAffinity",
  "redeemExpiring",
  "redeemWhenExhausted",
]

const titles: { readonly [K in LiveKey]: string } = {
  strategy: "Strategy",
  sessionAffinity: "Session affinity",
  sessionMinutes: "Session timeout",
  redeemExpiring: "When one would expire unused",
  redeemWhenExhausted: "When every account is spent",
  warmWindows: "Warm ChatGPT windows",
  paidOverflow: "Overflow to API keys",
  pollMinutes: "Usage polling",
  refreshTokens: "Refresh sign-ins",
  websockets: "Codex WebSockets",
}

/** A live setting's title on the Settings page. */
export const settingTitle = (name: LiveKey): string => titles[name]

/** One Advanced row. */
export type AdvancedRow =
  | {
      readonly _tag: "Switch"
      readonly name: LiveKey
      readonly title: string
      readonly detail: string
      readonly on: boolean
    }
  | {
      readonly _tag: "Minutes"
      readonly name: "sessionMinutes" | "pollMinutes"
      readonly title: string
      readonly detail: string
      readonly value: number
      /** `1 h`, or `Off` for no polling. */
      readonly shown: string
      readonly less?: number
      readonly more?: number
    }

const stepsOf = (name: "sessionMinutes" | "pollMinutes") => (name === "sessionMinutes" ? sessionSteps : pollSteps)

/** Every live setting the API lists that no other section shows, in the order it lists them. */
export const advancedRows = (view: SettingsView): ReadonlyArray<AdvancedRow> =>
  view.live.flatMap((row): ReadonlyArray<AdvancedRow> => {
    const name = row.name
    if (!isLiveKey(name) || namedElsewhere.includes(name)) return []
    const value = view.settings[name]
    const detail = liveDetail(name, view.live)
    if (typeof value === "boolean") return [{ _tag: "Switch", name, title: titles[name], detail, on: value }]
    if (typeof value === "number" && (name === "sessionMinutes" || name === "pollMinutes")) {
      const steps = stepsOf(name)
      const less = step(steps, value, false)
      const more = step(steps, value, true)
      return [
        {
          _tag: "Minutes",
          name,
          title: titles[name],
          detail,
          value,
          shown: name === "pollMinutes" && value === 0 ? "Off" : minutes(value),
          ...(less === undefined ? {} : { less }),
          ...(more === undefined ? {} : { more }),
        },
      ]
    }
    return []
  })

/** Settings that changed in the file and wait for a restart, in a sentence. */
export const restartLine = (view: SettingsView): string | undefined =>
  view.restartNeeded.length === 0
    ? undefined
    : `${view.restartNeeded.join(" and ")} changed in config.json; restart slopmax to use ${view.restartNeeded.length === 1 ? "it" : "them"}.`

/** A change to one live setting, checked as the API will check it; none when the value is not one it takes. */
export const livePatch = (name: LiveKey, value: boolean | number | string): Option.Option<LivePatch> =>
  Schema.decodeUnknownOption(LivePatch)({ [name]: value })
