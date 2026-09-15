import { useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { call } from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

type Status = { enabled: boolean; sources: { id: string; label: string; enabled: boolean }[]; checkedAt: string | null; lastFiled: number; totalFiled: number; errors: string[]; running: boolean };
const path = "/board/automation";

export function BoardAutomation({ onChecked }: { onChecked: () => void }) {
  const { data, error, reload, setData } = useApi(() => call<Status>(path), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [open, reload]);
  async function update(body?: unknown) {
    setBusy(true); setProblem(null);
    try {
      setData(await call<Status>(body ? path : `${path}/sync`, {
        method: body ? "PATCH" : "POST", ...(body ? { body: JSON.stringify(body) } : {}),
      }));
      onChecked();
    } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (value) reload(); }}>
    <DialogTrigger asChild><Button variant="ghost" className="ml-auto shrink-0 gap-1.5"><Sparkles className="size-4" />Auto cards{data ? ` · ${data.enabled ? "On" : "Off"}` : ""}</Button></DialogTrigger>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>Automatic cards</DialogTitle><DialogDescription>Useful work from your connected data lands in Backlog, ready for you to review.</DialogDescription></DialogHeader>
      {data && <>
        <label className="flex items-center justify-between gap-3 py-2 font-medium">Create cards automatically<Switch aria-label="Create cards automatically" checked={data.enabled} disabled={busy} onCheckedChange={enabled => void update({ enabled })} /></label>
        <div className="space-y-4 rounded-xl bg-muted/40 p-4">
          {data.sources.map(source => <label key={source.id} className="flex items-center justify-between gap-3 text-sm">{source.label}<Switch aria-label={source.label} checked={source.enabled} disabled={busy} onCheckedChange={enabled => void update({ sources: { [source.id]: enabled } })} /></label>)}
        </div>
        <p className="text-sm text-muted-foreground">Checks every minute while the app server is running. Cards keep their source and snapshot date. Your edits and completed work stay intact.</p>
        <p className="text-xs text-muted-foreground">{data.checkedAt ? `Last checked ${new Date(data.checkedAt).toLocaleString()} · ${data.lastFiled} added` : "Waiting for the first check"} · {data.totalFiled} tracked</p>
        {data.errors.map(message => <p key={message} role="alert" className="text-sm text-destructive">{message}</p>)}
        <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Uses collected data. No new AI calls.</p><Button disabled={busy || !data.enabled || data.running} onClick={() => void update()}><RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />{busy ? "Checking…" : "Check now"}</Button></div>
      </>}
      {(error || problem) && <p role="alert" className="text-sm text-destructive">{problem || error}</p>}
    </DialogContent>
  </Dialog>;
}
