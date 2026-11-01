// The toasts at the bottom right: what the app just did or failed to do.
// A few at most; a failure stays until dismissed, anything else clears
// itself a few seconds after it was shown.
import { Duration } from "effect"

export interface Toast {
  readonly id: number
  readonly text: string
  readonly error: boolean
  /** When it was shown, in epoch milliseconds. */
  readonly at: number
}

/** The most toasts shown at once; older ones give way. */
export const toastLimit = 4

/** How long a toast that is not a failure stays. */
export const toastLife: Duration.Duration = Duration.seconds(6)

let seq = 0

/** Whether a toast still shows at `now`: failures until dismissed, the rest for {@link toastLife}. */
export const showing = (toast: Toast, now: number): boolean =>
  toast.error || now - toast.at < Duration.toMillis(toastLife)

/** Adds a toast, dropping those that have cleared and the oldest past the limit. */
export const addToast = (
  toasts: ReadonlyArray<Toast>,
  text: string,
  error: boolean,
  now: number,
): ReadonlyArray<Toast> => {
  seq += 1
  return [
    ...toasts.filter((toast) => showing(toast, now) && toast.text !== text),
    { id: seq, text, error, at: now },
  ].slice(-toastLimit)
}

/** The toasts to show at `now`. */
export const visibleToasts = (toasts: ReadonlyArray<Toast>, now: number): ReadonlyArray<Toast> =>
  toasts.filter((toast) => showing(toast, now))
