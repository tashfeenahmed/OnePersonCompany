import { lazy } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Activity, BarChart3, Globe, Plus, TrendingUp } from "lucide-react";
import { TabStrip } from "@/components/TabStrip";
import { BoardView, NoBoard } from "@/components/BoardView";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { WindowPicker } from "@/components/WindowPicker";
import { DASHBOARD_WINDOWS, DEFAULT_WINDOW } from "@/lib/window";
import { appPage } from "../../../shared/navigation";
const EmailStats = lazy(() => import("@/pages/EmailStats").then(m => ({ default: m.EmailStats })));
const MobileHealth = lazy(() => import("@/areas/mobilehealth/MobileHealth").then(m => ({ default: m.MobileHealth })));
const WebAnalytics = lazy(() => import("@/areas/webanalytics/WebAnalytics").then(m => ({ default: m.WebAnalytics })));
const Growth = lazy(() => import("@/areas/growth/pages/Growth").then(m => ({ default: m.Growth })));

/**
 * THE REPORTS: pages that read collected figures back and are not boards.
 * Each is a fixed tab at /dashboards/reports/<key>, beside the boards, because
 * a reading somebody cannot rearrange still belongs where the readings are.
 * The three growth ones came from a sidebar section of their own; the sidebar
 * lists areas, and a report is not an area.
 */
const REPORTS = [
  { key: "email-stats", label: "Email stats", icon: BarChart3, page: EmailStats },
  { key: "mobile-health", label: "Mobile health", icon: Activity, page: MobileHealth },
  { key: "web-analytics", label: "Web analytics", icon: Globe, page: WebAnalytics },
  { key: "growth", label: "Growth", icon: TrendingUp, page: Growth },
] as const;

/**
 * THE GLOBAL DASHBOARDS — every board that is about the whole operation.
 *
 * THE URL IS THE SELECTION. There is no "which tab is open" state beside the
 * address to fall out of step with it: the bar holds the answer, which is what
 * makes a board linkable, bookmarkable and reachable with the back button.
 *
 * A slug that names nothing is NOT quietly redirected to the first board. A
 * stale bookmark, or a board somebody deleted, is worth being told about —
 * showing a different dashboard's numbers under the URL you asked for is the
 * worst of the answers available.
 *
 * THIS PAGE IS ONE OF TWO DOORS ONTO THE SAME COMPONENT. A venture's boards
 * live at /ventures/<slug>/dashboards/<board> and are the same grid, the same
 * edit panel and the same drag — see components/BoardView. What this page owns
 * is the strip along the top and the scope: `!d.ventureId` is the global set,
 * and a board filed under a venture is not shown here even though it is in the
 * same list. An older board saved before ventures had dashboards has no
 * `ventureId` at all, which is why the test is falsiness rather than a null
 * check: a board from before the distinction existed is a global board.
 */
export function Dashboards() {
  const { state, reorderDashboards, setDashboardWindow } = useStore();
  const { slug, report: reportParam } = useParams();
  const report = REPORTS.find((r) => r.key === reportParam) ?? null;

  const boards = state.dashboards.filter((d) => !d.ventureId);
  const board = boards.find((d) => d.slug === slug);
  const first = boards[0];

  // The bare /dashboards: land on the first board and put its own address in
  // the bar, replacing rather than pushing so Back still leaves the page.
  if (!slug && !report)
    return first ? (
      <Navigate to={`/dashboards/${first.slug}`} replace />
    ) : (
      <Navigate to={appPage("email-stats")} replace />
    );

  if (!board && !report)
    return (
      <NoBoard
        title="No dashboard at this address"
        body={`Nothing here is called “${slug ?? reportParam}”. It may have been deleted, filed under a venture, or the link may be from another workspace.`}
        boards={boards}
        basePath="/dashboards"
      />
    );

  return (
    <>
      {/* The strip wraps, so the header grows with it; the button keeps to
          one line at the right, because "New dashboard" is the one action
          this page has and a wrapped button reads as two. */}
      <header className="flex min-h-12 shrink-0 items-start gap-2 px-4.5 py-1.5">
        {/* Links, not buttons: each tab IS the board's address. Hold and drag
            to reorder — the order lives in the store beside the boards. */}
        <TabStrip
          /* FINANCE IS A FIXED TAB AND NOT A BOARD. The cost cards on the
             boards below are widgets; the ledger, the allocation rules and the
             per-venture P&L are a page, and this strip is the place somebody
             already comes to ask what things cost. It leaves /dashboards on
             purpose — see areas/finance/Finance.tsx. */
          tabs={[...REPORTS.map((r) => ({ key: `report:${r.key}`, to: `/dashboards/reports/${r.key}`, label: r.label, icon: r.icon, fixed: true })), ...boards.map((d) => ({
            key: d.id,
            to: `/dashboards/${d.slug}`,
            label: d.name,
            count: d.widgets.length,
          }))]}
          activeKey={report ? `report:${report.key}` : board?.id ?? null}
          onReorder={reorderDashboards}
          className="min-w-0 flex-1"
        />
        {/*
          ONE WINDOW FOR EVERY BOARD AND EVERY REPORT TAB, here and nowhere
          else. It sits in this strip rather than on each board because the
          point of it is that two boards — and a report beside them — are
          read over the same span; a control per page would be back to the
          seven fetch defaults this replaces. The store keeps it (see
          `dashboardWindow`), the fetch layer reads it, and every windowed
          card's name follows it.
        */}
        <WindowPicker
          value={state.dashboardWindow ?? DEFAULT_WINDOW}
          onChange={setDashboardWindow}
          options={DASHBOARD_WINDOWS}
          label="Window every dashboard is drawn over"
          className="shrink-0"
        />
        <Button asChild size="sm" className="mt-0.5 shrink-0 whitespace-nowrap">
          <Link to="/dashboards/new">
            <Plus className="size-3.5" strokeWidth={1.8} />
            New dashboard
          </Link>
        </Button>
      </header>

      {/* Keyed by board: switching dashboards ends an edit session rather than
          carrying a half-open widget panel across to a different board. */}
      {report ? <report.page /> : board && <BoardView
        key={board.id}
        board={board}
        basePath="/dashboards"
        homePath="/dashboards"
        ventureId={null}
      />}
    </>
  );
}
