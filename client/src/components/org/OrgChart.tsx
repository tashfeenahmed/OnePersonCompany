import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { SubagentRow } from "@/components/org/SubagentRow";
import { shortName, teamAddress } from "@/components/org/roleLook";
import type { Org as OrgDoc, OrgVentureTeam } from "@/lib/api/subagents";
import { cn } from "@/lib/utils";

/**
 * THE ORG CHART: the owner, the chief of staff, and every worker under them.
 *
 * ---------------------------------------------------------------------------
 * DRAWN IN TWO PLACES, WRITTEN ONCE. The Org page draws it with a filter box
 * over it; the Sub-agents page draws it as its roster. A second copy of the
 * geometry would be a second place for a bus line to end up eight pixels off
 * the card it feeds, so both hand this component a list of ventures and it
 * does the rest. It owns nothing about WHICH ventures — filtering is the
 * caller's — and nothing about polling.
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
 * in `geometry`, the connectors are drawn into an absolutely positioned SVG
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
 * A CARD'S HEIGHT IS COMPUTED FROM THE LARGEST TEAM, and it is one height for
 * every card: the SVG computes where a card's top edge is, so a card that
 * grew by a line on its own would take its stem with it. It was a constant
 * sized for exactly six rows, and when a seventh role was provisioned the
 * chart quietly clipped four workers off every venture — a roster that says
 * the Video Producer does not exist. The header is measured in the same
 * units the rows are drawn in; the slack at the foot is where a line-height
 * change goes instead of into the last row.
 */
const CARD_HEAD = 38;
const ROW_H = 26.5;
const CARD_FOOT = 8;
const cardHeight = (rows: number) => CARD_HEAD + Math.max(1, rows) * ROW_H + CARD_FOOT;
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

export function OrgChart({
  owner,
  chiefOfStaff,
  ventures,
}: {
  owner: OrgDoc["owner"];
  chiefOfStaff: OrgDoc["chiefOfStaff"];
  /** The ventures to draw, in order — already filtered if the caller has a
   *  filter. The chart draws exactly these. */
  ventures: OrgVentureTeam[];
}) {
  /**
   * The measured width of the space the chart has. Zero until the first
   * observation lands, which is one frame — the chart simply is not drawn
   * until then rather than being drawn once at a guessed width and jumping.
   *
   * A CALLBACK REF RATHER THAN AN EFFECT OVER `useRef`, and that is a bug
   * fixed rather than a preference. An effect with an empty dependency list
   * can run while the ref is still null, find nothing to observe, and never
   * run again: a chart that stays blank forever on a page whose data loaded
   * fine. A callback ref fires when the node actually attaches, whenever that
   * is.
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

  const rows = ventures.reduce((n, v) => Math.max(n, v.subagents.length), 0);
  const layout = useMemo(
    () => (width > 0 ? geometry(width, ventures.length, cardHeight(rows)) : null),
    [width, ventures.length, rows],
  );

  return (
    <div ref={frame} className="w-full">
      {layout && (
        <div className="relative mx-auto" style={{ width, height: layout.height }}>
          <svg width={width} height={layout.height} className="absolute inset-0" aria-hidden>
            {/* Owner to chief of staff, and chief down to the first bus. Two
                straight drops, because this half of the chart is a chain
                rather than a fan. */}
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

            {/* One bus per row, joined by a spine down the left gutter. Every
                segment is in a gap between cards, which is what makes a
                wrapping grid drawable as a tree. */}
            {Array.from({ length: layout.rows }, (_, r) => {
              const n = Math.min(layout.cols, ventures.length - r * layout.cols);
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

          {/* ------------------------------------------------- the owner */}
          <div
            style={{ left: layout.centerX - OWNER_W / 2, top: 0, width: OWNER_W, height: OWNER_H }}
            className="bg-card absolute flex items-center justify-center gap-2 rounded-[14px]"
          >
            <div className="bg-muted text-foreground grid size-[22px] shrink-0 place-items-center rounded-full text-[11.5px] font-semibold">
              {owner.name.trim()[0]?.toUpperCase() ?? "?"}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium">{owner.name}</div>
              <div className="text-muted-foreground text-[12px]">The one person</div>
            </div>
          </div>

          {/* ------------------------------------------- the chief of staff */}
          <Link
            to="/"
            title={
              chiefOfStaff.connected
                ? "The chat agent. Everything below is dispatched through it."
                : "Nothing is connected, so a chat here falls back to one completion with no tools — or to nothing at all."
            }
            style={{ left: layout.centerX - CHIEF_W / 2, top: OWNER_H + DROP, width: CHIEF_W, height: CHIEF_H }}
            className="bg-card hover:bg-card-hover absolute flex items-center gap-2.5 rounded-[14px] px-4 transition-colors"
          >
            <span
              className={cn("size-1.5 shrink-0 rounded-full", chiefOfStaff.connected ? "bg-ok" : "bg-border")}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">Chief of staff</span>
              <span className="text-muted-foreground block truncate text-[12.5px]">
                {chiefLine(chiefOfStaff)}
              </span>
            </span>
            <span className="text-muted-foreground shrink-0 text-[12.5px]">Open chat</span>
          </Link>

          {/* ------------------------------------------------- the ventures */}
          {ventures.map((v, i) => (
            <div
              key={v.id}
              style={{
                left: layout.cardX(i),
                top: layout.rowTop(Math.floor(i / layout.cols)),
                width: CARD_W,
                height: layout.cardH,
              }}
              className="bg-card absolute flex flex-col overflow-hidden rounded-[14px]"
            >
              <Link
                to={`/ventures/${v.slug}`}
                /* The venture's own colour behind its own name, which is the
                   same tint the map uses and the only place colour appears on
                   this card — the six rows under it are the same six
                   everywhere and must not read as nineteen palettes. */
                style={{ background: `${v.color}12` }}
                className="hover:bg-accent border-line-soft flex items-center gap-2 border-b px-2.5 py-1.5 transition-colors"
              >
                <VentureMark
                  venture={{ name: v.name, color: v.color, brand: { favicon: v.favicon } }}
                  size={16}
                />
                <span className="truncate text-[13.5px] font-medium">{v.name}</span>
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
                  <p className="text-muted-foreground px-1.5 py-1 text-[12.5px]">
                    Nobody provisioned yet.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the chat agent is, in one line, with "not connected" said out loud
 *  rather than left as a grey dot to interpret. */
function chiefLine(c: OrgDoc["chiefOfStaff"]): string {
  const skills = `${c.skills} ${c.skills === 1 ? "skill" : "skills"}`;
  if (!c.backend) return `No agent connected · ${skills}`;
  const name = c.label ?? c.backend;
  return c.connected ? `${name} · ${skills}` : `${name}, not answering · ${skills}`;
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
function geometry(width: number, count: number, cardH: number) {
  const usable = Math.max(width - PAD_L * 2, CARD_W);
  const cols = Math.max(1, Math.floor((usable + GAP_X) / (CARD_W + GAP_X)));
  const rows = Math.ceil(count / cols) || 0;
  const gridW = cols * CARD_W + (cols - 1) * GAP_X;
  const gridLeft = Math.max(PAD_L, Math.round((width - gridW) / 2));
  const centerX = gridLeft + gridW / 2;
  const chiefBottom = OWNER_H + DROP + CHIEF_H;
  const gridTop = chiefBottom + DROP + ROW_GAP / 2;

  const rowTop = (r: number) => gridTop + r * (cardH + ROW_GAP);
  return {
    cols,
    rows,
    cardH,
    centerX,
    chiefBottom,
    /** The left gutter, where the spine between one row's bus and the next
     *  runs. Outside the cards, inside the page. */
    spineX: Math.max(6, gridLeft - GAP_X),
    rowTop,
    busY: (r: number) => rowTop(r) - ROW_GAP / 2,
    cardX: (i: number) => gridLeft + (i % cols) * (CARD_W + GAP_X),
    height: rows ? rowTop(rows - 1) + cardH + PAD_B : chiefBottom + PAD_B,
  };
}
