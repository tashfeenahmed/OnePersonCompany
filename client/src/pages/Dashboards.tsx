import { Link, Navigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { BoardView, NoBoard } from "@/components/BoardView";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { WindowPicker } from "@/components/WindowPicker";
import { DASHBOARD_WINDOWS, DEFAULT_WINDOW } from "@/lib/window";

/**
 * WHERE THE FOUR REPORTS WENT.
 *
 * Email stats, Mobile health, Web analytics and Growth were FIXED TABS here:
 * pages beside the boards, at /dashboards/reports/<key>, that nobody could
 * rename, rearrange or delete. They are TEMPLATES now — the same figures, as
 * widgets, in the same reading order (see DASHBOARD_PRESETS) — so the answer
 * to "I want this reading" is a board the owner owns rather than a tab the
 * app insists on.
 *
 * THE OLD ADDRESSES BECOME AN OFFER TO MAKE ONE. A link somebody sent, a
 * bookmark, a report written six weeks ago: each lands on the New dashboard
 * page with its own template already chosen. That is the honest end for an
 * address whose page is gone — better than a 404, and better than silently
 * showing a different reading under the URL somebody asked for.
 *
 * The keys ARE the preset ids, which is why there is no map here.
 */
const REPORT_PRESETS = new Set(["email-stats", "mobile-health", "web-analytics", "growth"]);

export function LegacyReport() {
  const { report } = useParams();
  return (
    <Navigate
      to={report && REPORT_PRESETS.has(report) ? `/dashboards/new?preset=${report}` : "/dashboards"}
      replace
    />
  );
}

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
 * is the shared time window and the scope: `!d.ventureId` is the global set,
 * and a board filed under a venture is not shown here even though it is in the
 * same list. An older board saved before ventures had dashboards has no
 * `ventureId` at all, which is why the test is falsiness rather than a null
 * check: a board from before the distinction existed is a global board.
 */
export function Dashboards() {
  const { state, setDashboardWindow } = useStore();
  const { slug } = useParams();

  const boards = state.dashboards.filter((d) => !d.ventureId);
  const board = boards.find((d) => d.slug === slug);
  /*
    WHERE A BARE /dashboards LANDS: the Overview if this workspace has it,
    and otherwise whatever is first.

    BY ID AND NOT BY POSITION, which is the whole reason this is not just
    `boards[0]`. The sidebar is drag-reorderable and the order is the owner's;
    somebody who drags Costs to the front has said where the links go, not
    which board answers "open my dashboard". The Overview is the board built
    to be opened first — it is the one that joins every other board's subject
    into one page — so it is the destination while it exists, and a workspace
    that deleted it falls back to the first dashboard rather than to nothing.
  */
  const first = boards.find((d) => d.id === "d-overview") ?? boards[0];

  /* The bare /dashboards: land on that board and put its own address in the
     bar, replacing rather than pushing so Back still leaves the page. With no
     board at all there is nowhere to land, so it offers to make one — which
     is now the only way a dashboard comes into being. */
  if (!slug)
    return first ? (
      <Navigate to={`/dashboards/${first.slug}`} replace />
    ) : (
      <Navigate to="/dashboards/new" replace />
    );

  if (!board)
    return (
      <NoBoard
        title="No dashboard at this address"
        body={`Nothing here is called “${slug}”. It may have been deleted, filed under a venture, or the link may be from another workspace.`}
        boards={boards}
        basePath="/dashboards"
      />
    );

  return (
    <>
      {/* Navigation lives in the sidebar; this window applies to every dashboard. */}
      <header className="relative flex min-h-12 shrink-0 items-center gap-2 px-4.5 py-1.5">
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <WindowPicker
            value={state.dashboardWindow ?? DEFAULT_WINDOW}
            onChange={setDashboardWindow}
            options={DASHBOARD_WINDOWS}
            label="Window every dashboard is drawn over"
            className="shrink-0"
          />
          <Button asChild size="sm" className="mt-0.5 shrink-0 whitespace-nowrap">
            <Link to="/dashboards/new" aria-label="New dashboard">
              <Plus className="size-3.5" strokeWidth={1.8} />
              <span className="hidden sm:inline">New dashboard</span>
            </Link>
          </Button>
        </div>
      </header>

      {/* Keyed by board: switching dashboards ends an edit session rather than
          carrying a half-open widget panel across to a different board. */}
      <BoardView
        key={board.id}
        board={board}
        basePath="/dashboards"
        homePath="/dashboards"
        ventureId={null}
      />
    </>
  );
}
