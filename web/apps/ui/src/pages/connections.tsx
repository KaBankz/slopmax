// Local agent wiring and credentials for clients of the proxy.
import { Section } from "../components/parts.tsx"
import { ClientAccess } from "./access.tsx"
import { CodingAgents } from "./agents.tsx"

export function ConnectionsPage() {
  return (
    <>
      <Section title="Coding agents" headingId="connection-agents">
        <CodingAgents />
      </Section>
      <ClientAccess />
    </>
  )
}
