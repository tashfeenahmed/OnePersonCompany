import { useLive } from "@/lib/live";
import { Link } from "react-router-dom";
import { call } from "@/lib/api";
import type { InboxItem } from "@/lib/api/inbox";
import { ago } from "@/lib/format";
import { useDetailDrawer } from "./DetailDrawer";
import { useUndoActions, type UndoResult } from "./UndoActions";

export function InboxItemDetails({ item }: { item: InboxItem }) {
  const { perform, busy, handled } = useUndoActions();
  const { inbox } = useLive();
  const closed = handled.has(item.id) || (inbox && !inbox.items.some(i => i.id === item.id));
  const act = (action: string) => perform({ key: item.id, label: action === "snooze" ? "Snoozed for one day" : item.resolution,
    run: () => call<UndoResult>(`/action-inbox/${encodeURIComponent(item.id)}/${action}`, { method: "POST" }) });
  return <div className="space-y-5 text-sm">
    <p className="text-xs text-muted-foreground">{item.source} · {ago(item.at)}</p>
    <p className="whitespace-pre-wrap break-words leading-relaxed">{item.title}</p>
    {item.detail && <p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">{item.detail}</p>}
    {closed ? <p role="status" className="text-ok">{handled.has(item.id) ? "Updated." : "This item is no longer open."}</p> : <div className="flex flex-wrap gap-2">
      <button className="rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-40" disabled={busy.has(item.id)} onClick={() => void act("resolve")}>{item.resolution}</button>
      <button className="rounded-lg bg-muted px-4 py-2 disabled:opacity-40" disabled={busy.has(item.id)} onClick={() => void act("snooze")}>Snooze 1 day</button>
    </div>}
    <Link className="inline-block text-xs underline underline-offset-4" to={item.href}>Open source</Link>
  </div>;
}
export function InboxItems({ items }: { items: InboxItem[] }) {
  const open = useDetailDrawer();
  const { handled } = useUndoActions();
  const visible = items.filter(i => !handled.has(i.id));
  return <div className="divide-y">
    {!visible.length && <p className="py-4 text-sm text-muted-foreground">Nothing needs your attention.</p>}
    {visible.slice(0, 8).map(item => <button key={item.id} type="button" className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-primary" onClick={() => open({ title: item.source, description: "Review and handle this item.", content: <InboxItemDetails item={item}/> })}>
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${item.priority === 1 ? "bg-warn" : "bg-muted-foreground"}`}/>
      <span className="min-w-0 flex-1"><span className="line-clamp-2 text-xs font-medium">{item.title}</span><span className="mt-1 block text-[11px] text-muted-foreground">{item.source} · {ago(item.at)}</span></span>
      <span className="shrink-0 text-[11px] text-muted-foreground">Review →</span>
    </button>)}
    {visible.length > 8 && <Link to="/action-inbox" className="block pt-3 text-xs underline">View all {visible.length} actions</Link>}
  </div>;
}
