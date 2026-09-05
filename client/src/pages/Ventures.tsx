import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

/**
 * EVERY VENTURE, AS A CARD.
 *
 * A card rather than a row because a venture is now a thing with a face: the
 * icon its own site serves, the colour measured from it, a stage, a host. The
 * old list was four names and four coloured squares, which is what a venture
 * was when it lived in localStorage.
 *
 * THE WHOLE CARD IS A LINK, and there is no edit pencil on it any more.
 * Everything a venture has — its boards, its chats, what the agent knows about
 * it, what was read from the site — is at /ventures/<slug>, and a card that
 * opened a dialog instead was a door onto a form rather than onto the venture.
 * Editing is one press further in, where the rest of it is.
 *
 * The counts are the point of the card: how much of this thing exists. Boards
 * and chats come from the store; the open board cards come from the server, in
 * one fetch for the page rather than one per venture.
 */
export function Ventures() {
  const { state, sessionsFor, dashboardsIn } = useStore();

  /*
    THE BOARD, ONCE, FOR THE WHOLE PAGE. A failure is silent and the counts
    simply do not appear: "3 open" and no number at all are both honest, and
    an error banner about a work count would be louder than the fact deserves.
  */
  const { data: board } = useApi(() => api.board(), []);

  /** Open cards for one venture — everything it carries that is not in Done.
   *  Counted by COLUMN rather than by `doneAt`, the same way the board's own
   *  totals are: the column is where a card is, and a stamp is a history. */
  const openFor = (id: string) =>
    board
      ? board.columns
          .filter((c) => c.key !== "done")
          .reduce(
            (n, c) => n + c.cards.filter((card) => card.ventureId === id).length,
            0,
          )
      : null;

  const filed = state.sessions.filter((s) => s.ventureId).length;

  return (
    <>
      <TopBar label="Ventures" />
      <PageShell
        title="Ventures"
        sub={
          <>
            <b className="text-foreground font-medium">
              {state.ventures.length}
            </b>{" "}
            ventures,{" "}
            <b className="text-foreground font-medium">{filed}</b> of{" "}
            {state.sessions.length} sessions about one of them.
          </>
        }
        action={
          <Button asChild>
            <Link to="/ventures/new">
              <Plus className="size-[15px]" strokeWidth={2} />
              New venture
            </Link>
          </Button>
        }
      >
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {state.ventures.map((v) => {
            const chats = sessionsFor(v.id);
            const boards = dashboardsIn(v.id);
            const open = openFor(v.id);
            return (
              <Link
                key={v.id}
                to={`/ventures/${v.slug}`}
                className="bg-card hover:border-line-strong flex min-h-[148px] flex-col rounded-[10px] border p-3.5 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <VentureMark venture={v} size={18} />
                  <span className="truncate text-[13.5px] font-medium tracking-tight">
                    {v.name}
                  </span>
                  <StagePill stage={v.stage} className="ml-auto" />
                </div>

                {/* The host, not the whole URL: nobody reads "https://" and
                    the scheme is never the interesting half. */}
                {v.host && (
                  <span className="text-muted-foreground mt-1 truncate text-[11.5px]">
                    {v.host}
                  </span>
                )}

                <p className="text-muted-foreground mt-1.5 line-clamp-2 text-[12px]">
                  {v.description || "No description yet."}
                </p>

                <div className="border-line-soft text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t pt-2.5 text-[11.5px]">
                  <span>
                    {boards.length}{" "}
                    {boards.length === 1 ? "dashboard" : "dashboards"}
                  </span>
                  <span>
                    {chats.length} {chats.length === 1 ? "chat" : "chats"}
                  </span>
                  {/* Null is "the board could not be read", which is not zero
                      open cards, so the clause is left out entirely. */}
                  {open !== null && <span>{open} open on the board</span>}
                </div>
              </Link>
            );
          })}

          <Link
            to="/ventures/new"
            className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed transition-colors"
          >
            <Plus className="size-[18px]" strokeWidth={1.6} />
            <span className="text-[13px]">New venture</span>
          </Link>
        </div>

        {!state.ventures.length && (
          <p className="text-muted-foreground mt-4 text-[12.5px]">
            Nothing here yet — or the API has not answered. Ventures live on the
            server now, so this list is what this browser last saw.
          </p>
        )}
      </PageShell>
    </>
  );
}
