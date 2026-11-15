// The dashboard on the tailnet: whether this machine's tailnet identity
// opens it without a key, what a machine that may only look is told, and
// the Other machines card on the Access page.
import { type Health, hubHost, type TailnetView } from "@slopmax/client"
import { Option } from "effect"

/**
 * What this machine's tailnet identity lets the dashboard do, as `/healthz`
 * answered a request carrying the tailnet token: view or admin, when the
 * request came over the tailnet. Anything else (a local request, use only,
 * no answer) means asking for a key.
 */
export const tailnetAccess = (health: Option.Option<Health>): Option.Option<"view" | "admin"> =>
  Option.flatMap(health, (h) =>
    h.via === "tailnet" && (h.access === "view" || h.access === "admin") ? Option.some(h.access) : Option.none(),
  )

/** The command that lets a machine manage slopmax, run on the hub. */
export const adminCommand = (machine: Option.Option<string>): string =>
  `slopmax tailscale admins add ${Option.getOrElse(machine, () => "<machine>")}`

/** Said wherever a machine that may only look would change something. */
export const readOnlyShort = "Read-only from this machine"

/** One line of the Other machines card. */
export interface MachineRow {
  readonly title: string
  readonly value: string
  readonly detail?: string
  /** A command or an address, shown as code with a Copy button. */
  readonly copy?: boolean
}

/** The Other machines card: how they reach slopmax, who may, and what is wrong. */
export interface MachinesCard {
  readonly rows: ReadonlyArray<MachineRow>
  /** What stops it, and the command that fixes it. */
  readonly problem?: { readonly text: string; readonly fix?: string }
  /** What to run on the hub when slopmax is not published yet. */
  readonly start?: string
}

/** The command that publishes slopmax to the tailnet, run on the hub. */
export const startCommand = "slopmax tailscale on"

/** The Other machines card, from the hub's view of the tailnet. */
export const machinesCard = (view: TailnetView): MachinesCard => {
  const rows: Array<MachineRow> = []
  if (view.url !== undefined) {
    rows.push({ title: "Address", value: view.url, detail: "Where your other machines reach slopmax.", copy: true })
  }
  if (view.transport !== undefined) {
    rows.push(
      view.transport === "socket"
        ? {
            title: "Reached through",
            value: "slopmax's socket",
            detail: "Tailscale tells slopmax which machine is asking.",
          }
        : {
            title: "Reached through",
            value: "127.0.0.1",
            detail: "Tailscale here can't tell slopmax who is asking, so every machine needs a key.",
          },
    )
  }
  if (view.url !== undefined) {
    rows.push(
      view.identity && view.users.length > 0
        ? {
            title: "No key for",
            value: view.users.join(", "),
            detail: "Machines signed in as these logins use slopmax and see its status.",
          }
        : { title: "No key for", value: "No one", detail: "Every machine needs a key: slopmax key add <name>." },
    )
    rows.push(
      view.admins.length > 0
        ? {
            title: "Admins",
            value: view.admins.map((admin) => admin.machine).join(", "),
            detail: "These machines may also manage slopmax.",
          }
        : {
            title: "Admins",
            value: "None",
            detail: `To let a machine manage slopmax: ${adminCommand(Option.none())}.`,
          },
    )
    const host = hubHost(view)
    if (host !== undefined) {
      rows.push({
        title: "On another machine",
        value: `slopmax setup --hub ${host}`,
        detail: "Points its Claude Code and Codex at this slopmax.",
        copy: true,
      })
    }
  }
  const unpublished = view.tailscale === "missing" || view.url === undefined
  return {
    rows,
    ...(view.problem === undefined
      ? {}
      : {
          problem: {
            text: view.problem.text,
            ...(view.problem.fix === undefined ? {} : { fix: view.problem.fix }),
          },
        }),
    ...(unpublished ? { start: `On the hub: ${startCommand}` } : {}),
  }
}
