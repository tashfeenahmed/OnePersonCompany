import { ArrowUpRight, Check, CircleAlert, Clock3 } from "lucide-react";
import { Link } from "react-router-dom";
import { RoleIcon } from "@/components/org/RoleIcon";
import { cn } from "@/lib/utils";
import type { ChatReport } from "../../../../shared/chatReport";

const states = {
  done: { label: "Report ready", icon: Check, tone: "text-ok" },
  failed: { label: "Run failed", icon: CircleAlert, tone: "text-destructive" },
  cancelled: { label: "Run cancelled", icon: CircleAlert, tone: "text-muted-foreground" },
  running: { label: "Working", icon: Clock3, tone: "text-muted-foreground" },
  queued: { label: "Queued", icon: Clock3, tone: "text-muted-foreground" },
};

export function ReportCard({ report }: { report: ChatReport }) {
  const state = states[report.status];
  const StatusIcon = state.icon;
  return (
    <Link
      to={report.to}
      aria-label={`${report.title} — ${state.label} — ${report.agentName}`}
      className="group border-line-soft bg-card hover:border-line-strong focus-visible:ring-ring flex w-full max-w-xl items-start gap-4 rounded-2xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none sm:p-5"
    >
      <RoleIcon role={report.role} className="mt-0.5 size-12 sm:size-14" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-[12.5px] break-words">{report.agentName}</p>
        <p className="mt-1 text-[15px] font-medium break-words">{report.title}</p>
        <p className={cn("mt-3 flex items-center gap-1.5 text-[12.5px]", state.tone)}>
          <StatusIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {state.label}
          <span className="text-muted-foreground ml-1">· {report.status === "done" ? "Open report" : "View run"}</span>
        </p>
        {report.error && <p className="text-muted-foreground mt-2 line-clamp-2 text-[12.5px] break-words">{report.error}</p>}
      </div>
      <ArrowUpRight className="text-muted-foreground group-hover:text-foreground mt-1 size-4 shrink-0 transition-colors" aria-hidden="true" />
    </Link>
  );
}
