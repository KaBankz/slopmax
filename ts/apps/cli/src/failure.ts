// How a command ends other than by succeeding. A failure is said in one
// line (`error: …`) and exits 1; a command that has its own exit status (the
// doctor, an agent started with `run`) ends with that status and says
// nothing more; a prompt someone quits ends as Ctrl-C does.
import { Data } from "effect"

/** A command could not do what was asked; the message says why, for people. */
export class CliFailure extends Data.TaggedError("CliFailure")<{ readonly message: string }> {}

/** The command is done and the process exits with `code`, having said everything already. */
export class ExitWith extends Data.TaggedError("ExitWith")<{ readonly code: number }> {}

/** Someone quit a question (Ctrl-C, Esc): nothing more is done or said. */
export class Cancelled extends Data.TaggedError("Cancelled")<{}> {}

/** What any failure says to people: its own message when it has one. */
export const failureText = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message: unknown = error.message
    if (typeof message === "string" && message !== "") return message
  }
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") {
    return error._tag
  }
  return String(error)
}

/** The exit status for a usage mistake the parser caught. */
export const usageExit = 2

/** The exit status after an interruption or a quit question, as a shell reports Ctrl-C. */
export const interruptedExit = 130
