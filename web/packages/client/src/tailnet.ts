// slopmax on the user's tailnet: who may do what, how the hub is published
// (`/slopmax/api/tailnet`), and what `/healthz` tells a caller about itself.
// The hub is for the user's own machines; Tailscale tells it which machine
// is asking, so they need no key.
import { Schema } from "effect"
import { defaultPort } from "./settings.ts"

/** What a caller may do, from least to most. */
export const Access = Schema.Literals(["none", "use", "view", "admin"])
export type Access = typeof Access.Type

/**
 * Whether `access` reaches `needed`: `use` is the proxy and the model list,
 * `view` adds status, usage and history, and `admin` is everything.
 */
export const reaches = (access: Access, needed: Access): boolean =>
  Access.literals.indexOf(access) >= Access.literals.indexOf(needed)

/** Tailscale on the hub, as its CLI reports it. */
export const TailscaleState = Schema.Literals([
  /** No `tailscale` CLI there. */
  "missing",
  /** The CLI runs, but tailscaled does not answer. */
  "down",
  "signedOut",
  /** Turned off (`tailscale up` turns it on). */
  "off",
  /** The tailnet's admin has yet to approve the machine. */
  "needsApproval",
  "running",
  /** A state that slopmax does not know. */
  "unknown",
])
export type TailscaleState = typeof TailscaleState.Type

/**
 * How tailscaled reaches slopmax on the hub: its owner-only socket, which
 * tells slopmax who is asking, or the proxy's port on 127.0.0.1, where only
 * keys work.
 */
export const Transport = Schema.Literals(["socket", "loopback"])
export type Transport = typeof Transport.Type

/** A machine that may manage slopmax, matched by Tailscale's stable node id. */
export class AdminMachine extends Schema.Class<AdminMachine>("AdminMachine")({
  /** Its name on the tailnet: the first label of its DNS name. */
  machine: Schema.String,
  /** Its stable node id (`nXXXXCNTRL`). */
  id: Schema.String,
}) {}

/** What is wrong with publishing slopmax, and what fixes it. */
export class Problem extends Schema.Class<Problem>("Problem")({
  text: Schema.String,
  /** A command that fixes it, when one does. */
  fix: Schema.optionalKey(Schema.String),
}) {}

/** `GET /tailnet`: slopmax on the tailnet, as the hub sees it. */
export class TailnetView extends Schema.Class<TailnetView>("TailnetView")({
  tailscale: TailscaleState,
  /** Where the tailnet reaches slopmax, when it is published. */
  url: Schema.optionalKey(Schema.String),
  transport: Schema.optionalKey(Transport),
  /** Whether tailnet logins in `users` are taken without a key. */
  identity: Schema.Boolean,
  /** The hub's name on the tailnet. */
  host: Schema.optionalKey(Schema.String),
  /** Tailnet logins whose machines use slopmax and see its status. */
  users: Schema.Array(Schema.String),
  /** Machines that may also manage it. */
  admins: Schema.Array(AdminMachine),
  /** Whether Tailscale Funnel exposes the port to the internet, which slopmax refuses. */
  funnel: Schema.Boolean,
  problem: Schema.optionalKey(Problem),
}) {}

/** `PATCH /tailnet`: changes to who may use slopmax over the tailnet; what is left out stays as it is. */
export class TailnetPatch extends Schema.Class<TailnetPatch>("TailnetPatch")({
  users: Schema.optionalKey(Schema.Array(Schema.String)),
  admins: Schema.optionalKey(Schema.Array(AdminMachine)),
}) {}

/**
 * The token a machine on the tailnet sends in place of a key. It is not a
 * secret: the hub knows the machine by its tailnet identity, and a token of
 * any value only shows that the request was not made by another site.
 */
export const tailnetToken = "tailnet"

/**
 * What `/healthz` says of the slopmax answering, and of the caller. It is
 * outside the API and needs no key; what it adds depends on how it was asked.
 */
export class Health extends Schema.Class<Health>("Health")({
  service: Schema.optionalKey(Schema.String),
  version: Schema.String,
  /** The proxy's process; left out over the tailnet. */
  pid: Schema.optionalKey(Schema.Number),
  /** Whether it takes the key sent, when one was. */
  owner: Schema.optionalKey(Schema.Boolean),
  /** What the caller may do there, when it sent a token. */
  access: Schema.optionalKey(Access),
  /** `tailnet` when the request came over the tailnet. */
  via: Schema.optionalKey(Schema.String),
  /** The tailnet login it knows the caller's machine by. */
  login: Schema.optionalKey(Schema.String),
  /** The name it knows the caller's machine by: a client key's, or its tailnet machine name. */
  machine: Schema.optionalKey(Schema.String),
}) {}

/**
 * What `slopmax setup --hub` takes to reach this hub from another machine:
 * its name (`hub` of `https://hub.example.ts.net:7567`), which setup looks up
 * on the usual port, else its whole URL when it is published on another port.
 */
export const hubTarget = (view: TailnetView): string | undefined => {
  if (view.url === undefined) return undefined
  const match = /^[a-z]+:\/\/([^/:]+)(?::(\d+))?/i.exec(view.url)
  const port = match?.[2] === undefined ? (view.url.startsWith("https:") ? 443 : 80) : Number(match[2])
  if (port !== defaultPort) return view.url
  if (view.host !== undefined && view.host !== "") return view.host
  return match?.[1]?.split(".")[0]
}
