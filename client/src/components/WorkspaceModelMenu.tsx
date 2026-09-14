import { Cpu, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "./ui/dropdown-menu";
import { PROVIDER_LABELS, useModelProviders } from "@/hooks/useModelProviders";
import type { ProviderId } from "@/lib/api";

const ORDER: ProviderId[] = ["freellmapi", "openrouter", "local", "openai"];

export function WorkspaceModelMenu() {
  const models = useModelProviders();
  const selected = models.data?.chosen;
  const current = models.data?.providers.find(provider => provider.id === selected);
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger className="gap-2">
      <Cpu className="size-4" /><span className="flex-1">LLM</span>
      <span className="max-w-24 truncate text-xs text-muted-foreground">{selected ? PROVIDER_LABELS[selected] : models.data ? "None" : "…"}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1.5rem)]">
      <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">Workspace LLM</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup value={selected ?? "none"} onValueChange={value => { void models.choose(value === "none" ? null : value as ProviderId).catch(() => {}); }}>
        {ORDER.map(id => {
          const provider = models.data?.providers.find(item => item.id === id);
          return <DropdownMenuRadioItem key={id} value={id} disabled={models.saving || !provider?.connected} onSelect={event => event.preventDefault()}>
            <span className="flex-1">{PROVIDER_LABELS[id]}</span>
            {!provider?.connected && <span className="text-xs text-muted-foreground">{models.data ? "Not connected" : "Loading…"}</span>}
          </DropdownMenuRadioItem>;
        })}
        <DropdownMenuSeparator />
        <DropdownMenuRadioItem value="none" disabled={models.saving || !models.data} onSelect={event => event.preventDefault()}>Off</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <p className="px-2 py-1 text-xs text-muted-foreground">Chat, managed assistants and AI jobs.</p>
      {current && <p className="break-words px-2 py-2 text-xs text-muted-foreground">{models.saving ? "Saving…" : current.model || "Provider default model"}</p>}
      {models.error && <p role="alert" className="px-2 py-2 text-xs text-destructive">{models.error}</p>}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild><Link to="/settings?tab=models"><SlidersHorizontal className="size-4" />Models and connections</Link></DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
}
