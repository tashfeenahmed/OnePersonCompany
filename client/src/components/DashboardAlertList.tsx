import { ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { useDashboardAlerts } from "@/hooks/useDashboardAlerts";
import { AlertBadge } from "./AlertBadge";
import { cn } from "@/lib/utils";
export function DashboardAlertList({boardId}:{boardId:string}) {
  const {byBoard,error,refresh}=useDashboardAlerts();
  const summary=byBoard[boardId];
  if(!summary || (!summary.count && !error))return null;
  return <div className="mb-5" data-dashboard-alerts>
    {error && <p role="status" className="mb-2 text-xs text-warn">{error} <button type="button" onClick={refresh} className="underline underline-offset-2">Retry</button></p>}
    {summary.count>0 && <details className="group rounded-2xl border border-border bg-card px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden"><ChevronDown className="size-3.5 text-muted-foreground group-open:rotate-180"/><span>{summary.count} alert{summary.count===1?"":"s"} need{summary.count===1?"s":""} attention</span><AlertBadge summary={summary}/><span className="ml-auto text-[10px] text-muted-foreground">Health & open rules</span></summary>
      <ul className="mt-3 divide-y divide-border">{summary.alerts.map(alert=><li key={alert.id} className="flex items-start gap-2.5 py-2.5"><span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full",alert.severity==="critical"?"bg-destructive":"bg-warn")}/><div className="min-w-0 flex-1"><p className="text-xs font-medium">{alert.title}</p>{alert.detail && <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{alert.detail}</p>}</div>{alert.href && <Link to={alert.href} className="shrink-0 text-[11px] underline underline-offset-2">View</Link>}</li>)}</ul>
    </details>}
  </div>;
}
