// The coding agents on this machine, and whether each goes through slopmax.
// Connecting edits the agent's own settings; disconnecting puts back what
// was there.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { agentsAtom, canChangeAtom, connectAgent, disconnectAgent, proxyAtom } from "../atoms.ts"
import { Empty, Label, Loaded, Panel, SettingRow, Skeleton } from "../components/parts.tsx"
import { Button } from "../components/ui/button.tsx"
import { agentLine, needsProxy } from "../view/live.ts"

export function AgentsPage() {
  const agents = useAtomValue(agentsAtom)
  const canChange = useAtomValue(canChangeAtom)
  const waiting = needsProxy(useAtomValue(proxyAtom), "connect agents")
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
          <Empty title={waiting} detail="Agents are wired to the running proxy's address." />
        )
      ) : (
        <Loaded result={agents} title="Could not look at the agents" loading={<Skeleton lines={2} />}>
          {(list) => (
            <Panel>
              {list.map((agent) => {
                const line = agentLine(agent)
                const verb = agent.wired ? "Disconnect" : "Connect"
                return (
                  <SettingRow
                    key={agent.id}
                    title={agent.title}
                    detail={
                      <span className="flex flex-wrap gap-x-2">
                        <span>{agent.installed ? line.text : "Not installed on this machine"}</span>
                        <span className="font-mono text-caption text-faint">{agent.configPath}</span>
                      </span>
                    }
                  >
                    <Label
                      tone={line.connected ? "good" : "muted"}
                      text={line.connected ? "Connected" : "Not connected"}
                    />
                    <Button
                      aria-label={`${verb} ${agent.title}`}
                      variant={agent.wired ? "default" : "primary"}
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
