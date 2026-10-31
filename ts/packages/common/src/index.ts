// What every slopmax package needs: wall-clock time without a date library,
// random identifiers, a small logger, durations and counts in short forms
// for people, and numbers and text laid out (and ordered) as Rust does.
export * as fmt from "./fmt.ts"
export * as human from "./human.ts"
export * as ids from "./ids.ts"
export * as log from "./log.ts"
export * as num from "./num.ts"
export * as text from "./text.ts"
export * as time from "./time.ts"

export { ParseError, SignedDuration, Timestamp, TimestampFromString } from "./time.ts"
