import { useState } from "react";
import type { InsightsReport } from "../../../shared/insights";
import { call } from "@/lib/api";
import { insightNumber } from "@/lib/insightFormat";
import { Link } from "react-router-dom";
import { Network, Plus, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";
import { ventureApi } from "@/lib/api/ventures";
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
  const { data: insights } = useApi(() => call<InsightsReport>("/insights"), []);
  const [showDormant, setShowDormant] = useState(false);
  const dormantIds = new Set(insights?.dormancy.filter(v => v.status === "dormant").map(v => v.id) ?? []);
  const { data: board } = useApi(() => api.board(), []);

  /*
    TWO MORE DOCUMENTS FOR THE WHOLE PAGE, AND BOTH FAIL QUIETLY. The map says
    how many things each venture has claimed; the capture table says which of
    them has a photograph. Neither is worth an error banner on a list of
    ventures — a missing count and a missing picture are both visibly nothing,
    which is what they are.
  */
  const { data: map } = useApi(() => ventureApi.map(), []);
  const { data: shots } = useApi(() => ventureApi.capture(), []);

  /* Null is "the map could not be read", which is not "nothing is linked". */
  const linksFor = (id: string) =>
    map ? map.edges.filter((e) => e.venture === id).length : null;
  const pictureFor = (slug: string) =>
    shots?.ventures.find((v) => v.slug === slug)?.picture ?? null;
  /*
    The strip appears on EVERY card or on none. Showing it only where a picture
    exists makes a grid of ragged cards out of a fact about the capture table,
    so a venture without one gets the space and a sentence saying why it is
    empty.
  */
  const anyPicture = !!shots?.ventures.some((v) => v.picture);

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
          <div className="flex items-center gap-2">
            {/* TWO PICTURES OF THE SAME NINETEEN THINGS, and they answer
                different questions. The map says what each venture OWNS —
                zones, properties, hosts — and the org says who WORKS for it.
                Neither is a tab of the other because a venture's staff has
                nothing to do with its integrations. */}
            <Button asChild variant="outline">
              <Link to="/subagents">
                <Network className="size-[15px]" strokeWidth={1.8} />
                Org chart
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/ventures/map">
                <Waypoints className="size-[15px]" strokeWidth={1.8} />
                How it all connects
              </Link>
            </Button>
            <Button asChild>
              <Link to="/ventures/new">
                <Plus className="size-[15px]" strokeWidth={2} />
                New venture
              </Link>
            </Button>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border p-3 text-sm">
          <span>{insights ? `${dormantIds.size} dormant ventures` : "Checking venture activity…"}</span>
          {insights && <span className="text-muted-foreground">{insights.dormantCosts.map(c => insightNumber(c.amount, c.currency)).join(" + ") || "No priced dormant costs"}{insights.dormantCosts.length ? "/month" : ""}{!insights.dormantCostsComplete && " · some costs unpriced"}</span>}
          <button className="ml-auto underline" onClick={() => setShowDormant(!showDormant)}>{showDormant ? "Hide dormant ventures" : "Show dormant ventures"}</button>
          <Link to="/insights" className="text-muted-foreground underline">Criteria and data coverage</Link>
        </div>
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {state.ventures.filter(v => showDormant || !dormantIds.has(v.id)).map((v) => {
            const chats = sessionsFor(v.id);
            const boards = dashboardsIn(v.id);
            const open = openFor(v.id);
            const links = linksFor(v.id);
            const picture = pictureFor(v.slug);
            return (
              <Link
                key={v.id}
                to={`/ventures/${v.slug}`}
                className="bg-card hover:bg-card-hover flex min-h-[148px] flex-col rounded-[14px] p-1.5 transition-colors"
              >
                {/* The top of the page at 1280x800, not the whole page — so it
                    is anchored to the top rather than centred, which is where
                    the header of any site actually is. */}
                {anyPicture && (
                  <div className="aspect-video shrink-0 overflow-hidden rounded-[9px] border">
                    {picture ? (
                      <img
                        src={picture.url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover object-top"
                      />
                    ) : (
                      <div
                        className="text-muted-foreground grid h-full place-items-center text-[12.5px]"
                        style={{ background: `${v.color}12` }}
                      >
                        {v.website ? "no picture yet" : "no website"}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-1 flex-col px-3 py-3">
                  <div className="flex items-center gap-2">
                    <VentureMark venture={v} size={18} />
                    <span className="truncate text-[14.5px] font-medium tracking-tight">
                      {v.name}
                    </span>
                    {dormantIds.has(v.id) && <span className="text-xs text-muted-foreground">Dormant</span>}
                    <StagePill stage={v.stage} className="ml-auto" />
                  </div>

                  {/* The host, not the whole URL: nobody reads "https://" and
                      the scheme is never the interesting half. */}
                  {v.host && (
                    <span className="text-muted-foreground mt-1 truncate text-[12.5px]">
                      {v.host}
                    </span>
                  )}

                  <p className="text-muted-foreground mt-1.5 line-clamp-2 text-[13px]">
                    {v.description || "No description yet."}
                  </p>

                  <div className="border-line-soft text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t pt-2.5 text-[12.5px]">
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
                    {links !== null && (
                      <span
                        title="Things across the integrations that this venture has been linked to."
                        className="ml-auto"
                      >
                        {links} linked
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}

          <Link
            to="/ventures/new"
            className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed transition-colors"
          >
            <Plus className="size-[18px]" strokeWidth={1.6} />
            <span className="text-[14px]">New venture</span>
          </Link>
        </div>

        {!state.ventures.length && (
          <p className="text-muted-foreground mt-4 text-[13.5px]">
            Nothing here yet — or the API has not answered. Ventures live on the
            server now, so this list is what this browser last saw.
          </p>
        )}
      </PageShell>
    </>
  );
}
