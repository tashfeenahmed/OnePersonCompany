import type { AlertSummary } from "@/lib/dashboardAlerts";
import { cn } from "@/lib/utils";
export function AlertBadge({summary,stale=false,className}:{summary:AlertSummary;stale?:boolean;className?:string}) {
  if(!summary.count && !stale)return null;
  const label=stale?`${summary.count?`${summary.count} last known alerts. `:""}Alert status unavailable`: `${summary.count} alert${summary.count===1?"":"s"}${summary.critical?`, ${summary.critical} critical`:""}`;
  return <span role="img" aria-label={label} title={stale?`${label}${summary.count?`\n${summary.title}`:""}`:summary.title} data-alert-count={summary.count} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums",summary.critical?"bg-destructive/15 text-destructive":"bg-warn/15 text-warn",className)}><span aria-hidden="true" className="size-1 rounded-full bg-current"/><span aria-hidden="true">{stale?`${summary.count || ""}!`:summary.count}</span></span>;
}
