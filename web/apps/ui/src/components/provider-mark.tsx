// The providers' own marks for identification. Chart inks follow the dashboard theme.
import type { ProviderId } from "@slopmax/client"
import { Plug } from "lucide-react"
import anthropicDark from "../brands/anthropic-dark.svg"
import anthropic from "../brands/anthropic.svg"
import chatgptDark from "../brands/chatgpt-dark.svg"
import chatgpt from "../brands/chatgpt.svg"
import claude from "../brands/claude.svg"
import grokDark from "../brands/grok-dark.svg"
import grok from "../brands/grok.svg"
import openaiDark from "../brands/openai-dark.svg"
import openai from "../brands/openai.svg"
import xaiDark from "../brands/xai-dark.svg"
import xai from "../brands/xai.svg"
import type { Ink } from "./charts.tsx"

const inks = {
  claude: "provider-claude",
  codex: "provider-codex",
  grok: "provider-grok",
  anthropic: "provider-anthropic",
  openai: "provider-openai",
  xai: "provider-xai",
  compat: "chart-2",
} as const satisfies Record<ProviderId, Ink>

const marks: Record<Exclude<ProviderId, "compat">, { readonly light: string; readonly dark?: string }> = {
  claude: { light: claude },
  codex: { light: chatgpt, dark: chatgptDark },
  grok: { light: grok, dark: grokDark },
  anthropic: { light: anthropic, dark: anthropicDark },
  openai: { light: openai, dark: openaiDark },
  xai: { light: xai, dark: xaiDark },
}

export const providerInk = (provider: ProviderId | undefined): Ink =>
  provider === undefined ? "chart-3" : inks[provider]

export function ProviderMark({ provider }: { readonly provider: ProviderId }) {
  if (provider === "compat") return <Plug aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  const { light, dark } = marks[provider]
  return dark === undefined ? (
    <img alt="" src={light} className="size-4 shrink-0 object-contain" />
  ) : (
    <span aria-hidden className={provider === "xai" ? "h-4 w-6 shrink-0" : "size-4 shrink-0"}>
      <img alt="" src={light} className="size-full object-contain dark:hidden" />
      <img alt="" src={dark} className="hidden size-full object-contain dark:block" />
    </span>
  )
}
