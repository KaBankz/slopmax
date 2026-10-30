// Durations and counts in short forms for people, shared by every place
// that shows them, so the CLI, the app, and messages to agents read alike.
import { fixed, zeroPad } from "./fmt.ts"
import { SignedDuration, Timestamp } from "./time.ts"

/** A duration in its two most significant units: `3d4h`, `2h05m`, `9m30s`. */
export const duration = (d: SignedDuration): string => {
  const secs = Math.max(SignedDuration.asSecs(d), 0)
  const days = Math.floor(secs / 86_400)
  const hours = Math.floor((secs % 86_400) / 3_600)
  const mins = Math.floor((secs % 3_600) / 60)
  const s = secs % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${zeroPad(mins, 2)}m`
  if (mins > 0) return `${mins}m${zeroPad(s, 2)}s`
  return `${s}s`
}

/** Time remaining until `at`, or `now` once it has passed. */
export const until = (at: Timestamp, now: Timestamp): string => {
  const left = Timestamp.durationSince(at, now)
  return SignedDuration.isPositive(left) ? duration(left) : "now"
}

/** A count in about three significant figures: `1234567` → `1.2M`. */
export const compact = (n: number): string => {
  if (n >= 1_000_000_000) return `${fixed(n / 1e9, 1)}B`
  if (n >= 1_000_000) return `${fixed(n / 1e6, 1)}M`
  if (n >= 1_000) return `${fixed(n / 1e3, 1)}k`
  return String(n)
}
