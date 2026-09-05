import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { SubagentRow } from "@/components/org/SubagentRow";
import { shortName, teamAddress } from "@/components/org/roleLook";
import { useApi } from "@/hooks/useApi";
import { subagentApi, type Org as OrgDoc } from "@/lib/api/subagents";
import { cn } from "@/lib/utils";

/**
 * THE ORG CHART: the owner, the chief of staff, and one hundred and fourteen
 * workers under them.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A CHART AT ALL, GIVEN THERE IS ALREADY A ROSTER.
 *
 * The roster answers "who is there". This answers a question the roster
 * cannot: WHO WORKS FOR WHOM. Six apps and nineteen ventures is a hundred and
 * fourteen jobs, and until they were drawn as a tree the mental model was a
 * list of tools somebody occasionally pointed at a business. The tree says the
 * true thing instead — every venture has the same six staff, they all report
 * through one chat agent, and that agent reports to the person reading this.
 *
 * THE CHIEF OF STAFF IS A REAL BOX AND IT IS ALLOWED TO BE EMPTY. It is the
 * chat backend: a live agent that investigates with tools, or — when none is
 * connected — one completion from the raw provider with no tools at all, or
 * nothing whatsoever. An org chart with a confident box at the top of a
 * machine with no agent on it is precisely the picture this app refuses to
 * draw, so the card carries the backend's own label and a dot that is only
 * green when something answered.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT IS COMPUTED AND THE EDGES ARE SVG, the same technique
 * `pages/VentureMap.tsx` uses and for the same reason: a curve between two
 * moving points is what a path is for, and a node is a favicon, a stage pill
 * and six links that are all already built. So the geometry is worked out once
 * in `layout`, the connectors are drawn into an absolutely positioned SVG
 * underneath, and the cards sit over it at the same coordinates.
 *
 * WHAT IS DIFFERENT HERE IS THAT THE WIDTH IS NOT KNOWN IN ADVANCE. The map
 * has three fixed columns; this has nineteen cards that must wrap, and how
 * many fit is a fact about the window. Hence the ResizeObserver: the column
 * count is measured, everything below is derived from it, and the SVG is
 * redrawn at the new coordinates. Nothing is positioned by the browser's own
 * flow, because a bus line drawn eight pixels off the card it feeds is a
 * picture that looks broken rather than one that is.
 *
 * THE CONNECTORS RUN IN THE GUTTERS. One spine down the left, one horizontal
 * bus above each row of cards, one short stem into the top of each card — the
 * shape every org chart on paper has. Curves would have to cross the cards
 * themselves to reach the third row.
 */

/* ------------------------------------------------------------- the geometry */

const CARD_W = 236;
const GAP_X = 16;
/**
 * Tall enough for a header and exactly six rows, and FIXED: the SVG computes
 * where a card's top edge is, so a card that grew by a line would take its
 * stem with it.
 *
 * A FEW PIXELS OF SLACK ON PURPOSE. Six rows come to about a hundred and
 * eighty; the difference is empty space nobody can see, where a card measured
 * exactly would clip its sixth worker the day a line-height changed.
 */
const CARD_H = 190;
/** The vertical gutter between rows of cards, which is where a row's bus line
 *  and its stems live. */
const ROW_GAP = 40;
const OWNER_W = 210;
const OWNER_H = 44;
const CHIEF_W = 320;
const CHIEF_H = 64;
/** Between the owner and the chief of staff, and between the chief and the
 *  first bus — both are drawn as a line, so both are empty space. */
const DROP = 30;
const PAD_L = 24;
const PAD_B = 24;

export function Org() {
  const [tick, setTick] = useState(0);
  const doc = useApi(() => subagentApi.org(), [tick]);
  const [q, setQ] = useState("");

  /* Fast while something is in flight, slow while nothing is — the same rule
     the queue page follows. This document is a hundred and fourteen rows and
     four counts; it is not free to build and nobody needs it four times a
     minute while the box is idle. */
  const busy = (doc.data?.summary.running ?? 0) + (doc.data?.summary.queued ?? 0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), busy ? 4000 : 30_000);
    return () => clearInterval(t);
  }, [busy]);

  const ventures = useMemo(() => {
    const all = doc.data?.ventures ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    /* The search reads the workers too, so "paper" finds every venture with a
       writer rather than only the venture called Papers. */
    return all.filter(
      (v) =>
        v.name.toLowerCase().includes(needle) ||
        v.slug.toLowerCase().includes(needle) ||
        v.subagents.some(
          (s) =>
            s.name.toLowerCase().includes(needle) ||
            s.title.toLowerCase().includes(needle) ||
            s.role.includes(needle),
        ),
    );
  }, [doc.data, q]);

  /**
   * The measured width of the space the chart has. Zero until the first
   * observation lands, which is one frame — the chart simply is not drawn
   * until then rather than being drawn once at a guessed width and jumping.
   *
   * A CALLBACK REF RATHER THAN AN EFFECT OVER `useRef`, and that is a bug
   * fixed rather than a preference. The element being measured only exists
   * once the document has arrived — it is inside the `doc.data &&` branch — so
   * an effect with an empty dependency list runs while the ref is still null,
   * finds nothing to observe, and never runs again: a chart that stays blank
   * forever on a page whose data loaded fine. A callback ref fires when the
   * node actually attaches, whenever that is.
   */
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  const layout = useMemo(
    () => (width > 0 ? geometry(width, ventures.length) : null),
    [width, ventures.length],
  );

  const summary = doc.data?.summary;

  return (
    <>
      <TopBar label="Ventures" />
      <PageShell
        wide
        title="The org"
        sub={
          summary ? (
            <>
              <b className="text-foreground font-medium">{summary.subagents}</b>{" "}
              sub-agents across{" "}
              <b className="text-foreground font-medium">
                {doc.data?.ventures.length ?? 0}
              </b>{" "}
              ventures — six to a venture, one per app, provisioned rather than
              created. {summary.enabled} switched on, {summary.running} working,{" "}
              {summary.queued} waiting.
            </>
          ) : (
            "Every venture's six workers, who they report to, and what each of them is doing."
          )
        }
        action={
          <div className="flex items-center gap-2">
            <Link
              to="/subagents"
              className="text-muted-foreground hover:text-foreground text-[12.5px]"
            >
              The roster
            </Link>
            <Link
              to="/ventures"
              className="text-muted-foreground hover:text-foreground text-[12.5px]"
            >
              Back to the list
            </Link>
          </div>
        }
      >
        {doc.error && (
          <p className="text-muted-foreground text-[13px]">
            The org could not be read, so none of it is drawn — an empty chart
            would be a claim that nobody works here.{" "}
            <span className="text-destructive">{doc.error}</span>
          </p>
        )}
        {!doc.data && !doc.error && (
          <p className="text-muted-foreground text-[12.5px]">
            {doc.loading ? "Counting everyone in…" : "Nothing came back."}
          </p>
        )}

        {doc.data && (
          <>
            <div className="mb-4 flex items-center gap-2">
              <div className="relative w-full max-w-[280px]">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
                  strokeWidth={1.6}
                />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter ventures"
                  className="focus:border-line-strong h-8 w-full rounded-[8px] border bg-transparent pr-2 pl-7 text-[12.5px] outline-none"
                />
              </div>
              {q && (
                <span className="text-muted-foreground text-[11.5px]">
                  {ventures.length} of {doc.data.ventures.length}
                </span>
              )}
            </div>

            <div ref={frame} className="w-full">
              {layout && (
                <div
                  className="relative mx-auto"
                  style={{ width, height: layout.height }}
                >
                  <svg
                    width={width}
                    height={layout.height}
                    className="absolute inset-0"
                    aria-hidden
                  >
                    {/* Owner to chief of staff, and chief down to the first
                        bus. Two straight drops, because this half of the chart
                        is a chain rather than a fan. */}
                    <path
                      d={`M ${layout.centerX} ${OWNER_H} L ${layout.centerX} ${OWNER_H + DROP}`}
                      className="stroke-border"
                      strokeWidth={1.25}
                      fill="none"
                    />
                    {layout.rows > 0 && (
                      <path
                        d={`M ${layout.centerX} ${layout.chiefBottom} L ${layout.centerX} ${layout.busY(0)}`}
                        className="stroke-border"
                        strokeWidth={1.25}
                        fill="none"
                      />
                    )}

                    {/* One bus per row, joined by a spine down the left
                        gutter. Every segment is in a gap between cards, which
                        is what makes a wrapping grid drawable as a tree. */}
                    {Array.from({ length: layout.rows }, (_, r) => {
                      const n = Math.min(
                        layout.cols,
                        ventures.length - r * layout.cols,
                      );
                      const lastX = layout.cardX(r * layout.cols + n - 1) + CARD_W / 2;
                      const from = r === 0 ? layout.centerX : layout.spineX;
                      return (
                        <g key={r}>
                          <path
                            d={`M ${Math.min(from, layout.spineX)} ${layout.busY(r)} L ${Math.max(lastX, from)} ${layout.busY(r)}`}
                            className="stroke-border"
                            strokeWidth={1.25}
                            fill="none"
                          />
                          {r < layout.rows - 1 && (
                            <path
                              d={`M ${layout.spineX} ${layout.busY(r)} L ${layout.spineX} ${layout.busY(r + 1)}`}
                              className="stroke-border"
                              strokeWidth={1.25}
                              fill="none"
                            />
                          )}
                          {Array.from({ length: n }, (_, c) => {
                            const i = r * layout.cols + c;
                            const v = ventures[i];
                            const x = layout.cardX(i) + CARD_W / 2;
                            return (
                              <path
                                key={v.id}
                                d={`M ${x} ${layout.busY(r)} L ${x} ${layout.rowTop(r)}`}
                                stroke={v.color}
                                strokeWidth={1.5}
                                opacity={0.7}
                                fill="none"
                              />
                            );
                          })}
                        </g>
                      );
                    })}
                  </svg>

                  {/* ------------------------------------------- the owner */}
                  <div
                    style={{
                      left: layout.centerX - OWNER_W / 2,
                      top: 0,
                      width: OWNER_W,
                      height: OWNER_H,
                    }}
                    className="bg-card absolute flex items-center justify-center gap-2 rounded-[10px] border"
                  >
                    <div className="bg-muted text-foreground grid size-[22px] shrink-0 place-items-center rounded-full text-[10.5px] font-semibold">
                      {doc.data.owner.name.trim()[0]?.toUpperCase() ?? "?"}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium">
                        {doc.data.owner.name}
                      </div>
                      <div className="text-muted-foreground text-[11px]">
                        The one person
                      </div>
                    </div>
                  </div>

                  {/* ----------------------------------- the chief of staff */}
                  <Link
                    to="/"
                    title={
                      doc.data.chiefOfStaff.connected
                        ? "The chat agent. Everything below is dispatched through it."
                        : "Nothing is connected, so a chat here falls back to one completion with no tools — or to nothing at all."
                    }
                    style={{
                      left: layout.centerX - CHIEF_W / 2,
                      top: OWNER_H + DROP,
                      width: CHIEF_W,
                      height: CHIEF_H,
                    }}
                    className="bg-card hover:border-line-strong absolute flex items-center gap-2.5 rounded-[10px] border px-3 transition-colors"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        doc.data.chiefOfStaff.connected ? "bg-ok" : "bg-border",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium">
                        Chief of staff
                      </span>
                      <span className="text-muted-foreground block truncate text-[11.5px]">
                        {chiefLine(doc.data.chiefOfStaff)}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[11.5px]">
                      Open chat
                    </span>
                  </Link>

                  {/* ----------------------------------------- the ventures */}
                  {ventures.map((v, i) => (
                    <div
                      key={v.id}
                      style={{
                        left: layout.cardX(i),
                        top: layout.rowTop(Math.floor(i / layout.cols)),
                        width: CARD_W,
                        height: CARD_H,
                      }}
                      className="bg-card absolute flex flex-col overflow-hidden rounded-[10px] border"
                    >
                      <Link
                        to={`/ventures/${v.slug}`}
                        /* The venture's own colour behind its own name, which
                           is the same tint the map uses and the only place
                           colour appears on this card — the six rows under it
                           are the same six everywhere and must not read as
                           nineteen different palettes. */
                        style={{ background: `${v.color}12` }}
                        className="hover:bg-accent border-line-soft flex items-center gap-2 border-b px-2.5 py-1.5 transition-colors"
                      >
                        <VentureMark
                          venture={{
                            name: v.name,
                            color: v.color,
                            brand: { favicon: v.favicon },
                          }}
                          size={16}
                        />
                        <span className="truncate text-[12.5px] font-medium">
                          {v.name}
                        </span>
                        <StagePill stage={v.stage} className="ml-auto" />
                      </Link>
                      <div className="flex flex-col gap-px p-1">
                        {v.subagents.map((sa) => (
                          <SubagentRow
                            key={sa.id}
                            sa={sa}
                            dense
                            label={shortName(sa.name, v.name)}
                            to={teamAddress(v.slug, sa.role)}
                          />
                        ))}
                        {!v.subagents.length && (
                          <p className="text-muted-foreground px-1.5 py-1 text-[11.5px]">
                            Nobody provisioned yet.
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!ventures.length && (
              <p className="text-muted-foreground text-[12.5px]">
                {doc.data.ventures.length
                  ? `Nothing matches “${q}”.`
                  : "There are no ventures, so there is nobody to staff. Make one and its six workers appear with it."}
              </p>
            )}

            <p className="text-muted-foreground mt-5 text-[11.5px] leading-relaxed">
              Nobody here was created by hand. Every venture gets the same six —
              one per app — the moment it exists, and a venture that is deleted
              takes its six with it. Press a worker to give it a brief, change
              its standing instructions or read what it has already done.
            </p>
            {doc.data.roles.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {doc.data.roles.map((r) => (
                  <span
                    key={r.role}
                    title={r.what}
                    className="text-muted-foreground text-[11.5px]"
                  >
                    {r.title} · {r.kind}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </PageShell>
    </>
  );
}

/** What the chat agent is, in one line, with "not connected" said out loud
 *  rather than left as a grey dot to interpret. */
function chiefLine(c: OrgDoc["chiefOfStaff"]): string {
  const skills = `${c.skills} ${c.skills === 1 ? "skill" : "skills"}`;
  if (!c.backend) return `No agent connected · ${skills}`;
  const name = c.label ?? c.backend;
  return c.connected
    ? `${name} · ${skills}`
    : `${name}, not answering · ${skills}`;
}

/**
 * Where everything goes, given the width of the page and how many ventures
 * there are.
 *
 * ONE FUNCTION, BECAUSE THE SVG AND THE CARDS MUST AGREE. Both read `cardX`
 * and `rowTop`; neither computes a coordinate of its own. The grid is centred
 * rather than left-aligned so the owner and the chief — which are centred on
 * the whole block — sit over the middle of it at every width.
 */
function geometry(width: number, count: number) {
  const usable = Math.max(width - PAD_L * 2, CARD_W);
  const cols = Math.max(1, Math.floor((usable + GAP_X) / (CARD_W + GAP_X)));
  const rows = Math.ceil(count / cols) || 0;
  const gridW = cols * CARD_W + (cols - 1) * GAP_X;
  const gridLeft = Math.max(PAD_L, Math.round((width - gridW) / 2));
  const centerX = gridLeft + gridW / 2;
  const chiefBottom = OWNER_H + DROP + CHIEF_H;
  const gridTop = chiefBottom + DROP + ROW_GAP / 2;

  const rowTop = (r: number) => gridTop + r * (CARD_H + ROW_GAP);
  return {
    cols,
    rows,
    centerX,
    chiefBottom,
    /** The left gutter, where the spine between one row's bus and the next
     *  runs. Outside the cards, inside the page. */
    spineX: Math.max(6, gridLeft - GAP_X),
    rowTop,
    busY: (r: number) => rowTop(r) - ROW_GAP / 2,
    cardX: (i: number) => gridLeft + (i % cols) * (CARD_W + GAP_X),
    height: rows
      ? rowTop(rows - 1) + CARD_H + PAD_B
      : chiefBottom + PAD_B,
  };
}
