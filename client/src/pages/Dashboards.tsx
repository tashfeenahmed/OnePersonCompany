import { lazy, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { BarChart3, Plus, Wallet } from "lucide-react";
import { TabStrip } from "@/components/TabStrip";
import {
  BoardView,
  NewDashboardDialog,
  NoBoard,
} from "@/components/BoardView";
import { useStore } from "@/lib/store";
import { appPage } from "../../../shared/navigation";
const EmailStats = lazy(() => import("@/pages/EmailStats").then(m => ({ default: m.EmailStats })));

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
export function Dashboards({ report }: { report?: "email-stats" }) {
  const { state, addDashboard, copyDashboard, reorderDashboards } = useStore();
  const { slug } = useParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const boards = state.dashboards.filter((d) => !d.ventureId);
  const board = boards.find((d) => d.slug === slug);
  const first = boards[0];

  /** One place for "make a board here", used by the header and by the empty
   *  state — either from a preset or as a copy of any board that exists. */
  function create(name: string, presetId: string | null, copyFromId: string | null) {
    const made = copyFromId
      ? copyDashboard(copyFromId, { name, ventureId: null })
      : addDashboard(name, presetId ?? "blank", null);
    if (made) navigate(`/dashboards/${made.slug}`, { state: { editing: true } });
  }

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
        body={`Nothing here is called “${slug}”. It may have been deleted, filed under a venture, or the link may be from another workspace.`}
        boards={boards}
        basePath="/dashboards"
        onCreate={create}
      />
    );

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
        {/* Links, not buttons: each tab IS the board's address. Hold and drag
            to reorder — the order lives in the store beside the boards. */}
        <TabStrip
          /* FINANCE IS A FIXED TAB AND NOT A BOARD. The cost cards on the
             boards below are widgets; the ledger, the allocation rules and the
             per-venture P&L are a page, and this strip is the place somebody
             already comes to ask what things cost. It leaves /dashboards on
             purpose — see areas/finance/Finance.tsx. */
          tabs={[{ key: "report:email-stats", to: appPage("email-stats"), label: "Email stats", icon: BarChart3, fixed: true }, { key: "page:finance", to: "/finance", label: "Finance", icon: Wallet, fixed: true }, ...boards.map((d) => ({
            key: d.id,
            to: `/dashboards/${d.slug}`,
            label: d.name,
            count: d.widgets.length,
          }))]}
          activeKey={report ? "report:email-stats" : board?.id ?? null}
          onReorder={reorderDashboards}
        />
        <button
          onClick={() => setCreating(true)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <Plus className="size-3.5" strokeWidth={1.6} />
          <span className="hidden sm:inline">New dashboard</span><span className="sr-only sm:hidden">New dashboard</span>
        </button>
      </header>

      {/* Keyed by board: switching dashboards ends an edit session rather than
          carrying a half-open widget panel across to a different board. */}
      {report ? <EmailStats /> : board && <BoardView
        key={board.id}
        board={board}
        basePath="/dashboards"
        homePath="/dashboards"
        ventureId={null}
      />}

      <NewDashboardDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={create}
      />
    </>
  );
}
