// `slopmax doctor`'s findings, as the CLI prints them and the API and the
// dashboard show them. Findings never carry a key or a token.
import { Schema } from "effect"

/** How much a finding matters, from fine to broken. */
export const Level = Schema.Literals(["ok", "info", "warn", "fail"])
export type Level = typeof Level.Type

export class Finding extends Schema.Class<Finding>("Finding")({
  level: Level,
  text: Schema.String,
  /** What to run or change to fix it. */
  fix: Schema.optionalKey(Schema.String),
}) {}

/** The findings about one thing: the proxy, the accounts, an agent, the network, the files. */
export class Section extends Schema.Class<Section>("Section")({
  title: Schema.String,
  findings: Schema.Array(Finding),
}) {}
