import { useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import { useStore } from "@/lib/store";
import { useDashboardAlerts } from "@/hooks/useDashboardAlerts";
import { cn } from "@/lib/utils";
import { AlertBadge } from "./AlertBadge";
import { ModuleIcon } from "./ModuleIcon";
import { SidebarPinButton } from "./SidebarPinButton";
import { SidebarDashboardRow } from "./SidebarDashboardRow";
import { SortableList } from "./SortableList";

export function SidebarDashboards({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  const { state, reorderDashboards } = useStore();
  const { pathname } = useLocation();
  const here = pathname === "/dashboards" || pathname.startsWith("/dashboards/");
  const [expanded, setExpanded] = useState({ pathname, open: here });
  if (expanded.pathname !== pathname) setExpanded({ pathname, open: expanded.open || here });
  const alerts = useDashboardAlerts();
  const contentId = useId();
  const boards = state.dashboards.filter(board => !board.ventureId);
  return <div>
    <div className={cn("sidebar-row flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors focus-within:bg-accent", here && !expanded.open ? "bg-accent font-medium" : "hover:bg-accent")}>
      <button type="button" data-sort-handle aria-label="Dashboards" aria-expanded={expanded.open} aria-controls={contentId}
        onClick={() => setExpanded({ pathname, open: !expanded.open })}
        className="sidebar-dashboard-toggle flex min-w-0 flex-1 items-center gap-2 py-1 pl-1.5 text-left text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
        <span className="relative size-4 shrink-0">
          <ModuleIcon path="/dashboards" className="sidebar-dashboard-icon absolute inset-0" />
          <ChevronRight aria-hidden="true" strokeWidth={1.7} className={cn("sidebar-dashboard-chevron absolute inset-0 size-4", expanded.open && "rotate-90")} />
        </span>
        <span className="truncate">Dashboards</span>
        <AlertBadge summary={alerts.total} stale={!!alerts.error} className="ml-auto" />
      </button>
      <SidebarPinButton label="Dashboards" pinned={pinned} onClick={onTogglePin} />
    </div>
    <div id={contentId} aria-hidden={!expanded.open} inert={!expanded.open || undefined}
      className={cn("sidebar-dashboard-accordion grid", expanded.open ? "grid-rows-[1fr] visible" : "grid-rows-[0fr] invisible")}>
      <div className="min-h-0 overflow-hidden">
        <div className="my-1 ml-[13px] border-l border-line-soft pl-2">
          <SortableList items={boards.map(board => ({ key: board.id, label: board.name, board }))}
            describedAs="dashboard" onReorder={reorderDashboards}
            renderItem={item => <SidebarDashboardRow board={item.board} nested />} />
          <Link to="/dashboards/new" className="mt-1 flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Plus className="size-3.5" aria-hidden="true" />New dashboard
          </Link>
        </div>
      </div>
    </div>
  </div>;
}
