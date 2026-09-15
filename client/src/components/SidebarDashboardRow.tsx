import { Link, useLocation } from "react-router-dom";
import { useStore, type Dashboard } from "@/lib/store";
import { useDashboardAlerts } from "@/hooks/useDashboardAlerts";
import { AlertBadge } from "./AlertBadge";
import { ModuleIcon } from "./ModuleIcon";
import { SidebarPinButton } from "./SidebarPinButton";
import { cn } from "@/lib/utils";
import { sidebarPins } from "../../../shared/sidebarPins";
import { dashboardDestination } from "../../../shared/dashboardNavigation";

export function SidebarDashboardRow({ board, nested = false }: { board: Dashboard; nested?: boolean }) {
  const { state, togglePinned } = useStore();
  const { pathname } = useLocation();
  const alerts = useDashboardAlerts();
  const to = dashboardDestination(board, state.ventures);
  if (!to) return null;
  const active = pathname === to;
  const pinned = sidebarPins(state).some(pin => pin.type === "dashboard" && pin.dashboardId === board.id);
  return <div className={cn("sidebar-row flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors focus-within:bg-accent", active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
    <Link to={to} aria-current={active ? "page" : undefined} title={board.name} draggable={false}
      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 text-[13px] outline-none">
      {!nested && <ModuleIcon path="/dashboards" />}
      <span className="truncate">{board.name}</span>
      {alerts.byBoard[board.id] && <AlertBadge summary={alerts.byBoard[board.id]} stale={!!alerts.error} className="ml-auto" />}
    </Link>
    <SidebarPinButton label={board.name} pinned={pinned} onClick={() => togglePinned({ type: "dashboard", dashboardId: board.id })} />
  </div>;
}
