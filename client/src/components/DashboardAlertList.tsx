import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useDashboardAlerts } from "@/hooks/useDashboardAlerts";
import { useDetailDrawer } from "./interactions/DetailDrawer";
import { AlertBadge } from "./AlertBadge";
import { cn } from "@/lib/utils";
function AlertDetails({ boardId }: { boardId: string }) {
  const { byBoard } = useDashboardAlerts();
  const open = useDetailDrawer();
  const alerts = byBoard[boardId]?.alerts ?? [];
  return <div className="divide-y">{!alerts.length && <p className="text-sm text-muted-foreground">No active alerts on this dashboard.</p>}{alerts.map(alert => <button key={alert.id} type="button" className="flex w-full items-start gap-3 rounded-lg px-2 py-4 text-left hover:bg-accent/40" onClick={() => open({ title: alert.title, description: `${alert.severity === "critical" ? "Needs action" : "Needs attention"} · ${alert.sources.join(", ")}`, content: <div className="space-y-5 text-sm"><p className="whitespace-pre-wrap break-words leading-relaxed">{alert.detail || "The latest check reported this issue."}</p><p className="text-xs text-muted-foreground">Health alerts clear after a successful check confirms recovery.</p>{alert.href && <Link to={alert.href} className="inline-block underline underline-offset-4">Open source →</Link>}</div> })}>
    <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", alert.severity === "critical" ? "bg-destructive" : "bg-warn")}/><span className="min-w-0 flex-1"><span className="text-sm font-medium">{alert.title}</span><span className="mt-1 line-clamp-2 text-xs text-muted-foreground">{alert.detail}</span></span><ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground"/>
  </button>)}</div>;
}
export function DashboardAlertList({ boardId }: { boardId: string }) {
  const { byBoard, error, refresh } = useDashboardAlerts();
  const open = useDetailDrawer();
  const summary = byBoard[boardId];
  if (!summary || (!summary.count && !error)) return null;
  return <div className="mb-5" data-dashboard-alerts>
    {error && <p role="status" className="mb-2 text-xs text-warn">{error} <button type="button" onClick={refresh} className="underline underline-offset-2">Retry</button></p>}
    {summary.count > 0 && <button type="button" className="flex w-full items-center gap-2 rounded-2xl border bg-card px-4 py-3 text-left text-xs hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-primary" onClick={() => open({ title: "Dashboard alerts", description: "Current health issues and open rules.", content: <AlertDetails boardId={boardId}/> })}>
      <AlertBadge summary={summary}/><span>{summary.count} alert{summary.count === 1 ? "" : "s"} need{summary.count === 1 ? "s" : ""} attention</span><span className="ml-auto text-[10px] text-muted-foreground">Review</span><ChevronRight className="size-3.5"/>
    </button>}
  </div>;
}
