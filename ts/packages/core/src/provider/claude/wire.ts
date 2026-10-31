// Claude upstream adaptation.
//
// Claude Code's requests are forwarded as it sent them. The only change is
// the credential: the account's bearer token replaces the slopmax key, and
// the `oauth-2025-04-20` beta flag that OAuth tokens require is added. The
// body, including the billing header and `metadata.user_id`, is untouched.
import { forwardable, header, insert } from "../../proxy/headers.ts"
import { OAUTH_BETA } from "./oauth.ts"

/** The agent's beta list with the OAuth flag appended if missing. */
export const withOauthBeta = (existing: string | undefined): string => {
  const betas = (existing ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b !== "")
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA)
  return betas.join(",")
}

/**
 * Headers for the upstream request: the agent's own headers, with the
 * account's token in place of the slopmax key.
 */
export const upstreamHeaders = (client: Headers, accessToken: string): Headers => {
  const headers = forwardable(client)
  insert(headers, "anthropic-beta", withOauthBeta(header(client, "anthropic-beta")))
  insert(headers, "authorization", `Bearer ${accessToken}`)
  return headers
}

/**
 * Claude Code's user agent, like `claude-cli/2.1.291 (external, cli)`, if
 * it sent the request.
 */
export const clientAgent = (headers: Headers): string | undefined => {
  const agent = header(headers, "user-agent")
  return agent !== undefined && agent.startsWith("claude-cli/") && agent.length <= 200 ? agent : undefined
}
