// The coding agents on this machine, and whether each goes through slopmax.
// Connecting edits the agent's own settings; disconnecting puts back what
// was there.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  agentsAtom,
  canChangeAtom,
  connectAgent,
  disconnectAgent,
  proxyAtom,
  readOnlyAtom,
  unansweredAtom,
} from "../atoms.ts"
import { Empty, Label, Loaded, Panel, SettingRow, Skeleton } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { agentLine, agentsInOrder, cannotChange } from "../view/live.ts"
import { readOnlyShort } from "../view/tailnet.ts"

export function AgentsPage() {
  const agents = useAtomValue(agentsAtom)
  const again = useAtomRefresh(agentsAtom)
  const canChange = useAtomValue(canChangeAtom)
  const unanswered = useAtomValue(unansweredAtom)
  const waiting = cannotChange(useAtomValue(proxyAtom), unanswered, useAtomValue(readOnlyAtom))
  const connect = useAtomSet(connectAgent)
  const disconnect = useAtomSet(disconnectAgent)
  return (
    <>
      <p className="max-w-prose text-muted-foreground">
        Connecting points an agent's own settings at slopmax, so its requests share your accounts. Disconnecting puts
        back what was there.
      </p>
      {!canChange ? (
        waiting === undefined ? (
          <Skeleton lines={2} />
        ) : (
          <Empty
            title={waiting}
            detail={
              waiting === readOnlyShort
                ? "Agents on this machine use the hub once it is set up with slopmax setup --hub."
                : "Agents can be connected once it answers again."
            }
          />
        )
      ) : (
        <Loaded result={agents} title="Could not look at the agents" loading={<Skeleton lines={2} />} onRetry={again}>
          {(list) => (
            <Panel>
              {agentsInOrder(list).map((agent) => {
                const line = agentLine(agent)
                const verb = agent.wired ? "Disconnect" : "Connect"
                return (
                  <SettingRow
                    key={agent.id}
                    title={agent.title}
                    detail={
                      <span className="flex flex-wrap gap-x-2">
                        {line.text !== undefined && <span>{line.text}</span>}
                        <code className="font-mono text-xs text-muted-foreground">{agent.configPath}</code>
                      </span>
                    }
                  >
                    {!line.connected && agent.installed && <Label tone="muted" text="Not connected" />}
                    {line.connected && <Label tone="good" text="Connected" />}
                    <Button
                      aria-label={`${verb} ${agent.title}`}
                      variant={!agent.wired && agent.installed ? "default" : "outline"}
                      onClick={() => (agent.wired ? disconnect(agent.id) : connect(agent.id))}
                    >
                      {verb}
                    </Button>
                  </SettingRow>
                )
              })}
            </Panel>
          )}
        </Loaded>
      )}
    </>
  )
}
