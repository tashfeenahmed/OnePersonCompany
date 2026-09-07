import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
/* THE AXIS AND THE HOVER ARE THE SAME NUMBERS AS THE TILES BESIDE THEM.
   `usd` here used to write a bare `$`, which also reads as Canadian and
   Australian dollars on a board that carries all three; bytes were divided
   by 1000 while the panels divided by 1024, so one disk read 5.0 GB and 5.4
   GB on adjacent cards. The `/s` stays local — it is part of the claim, not
   part of the number. */
import { bytes, count, money, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ModelMark } from "@/components/ModelMark";
import type {
  ChartSeries,
  DonutSlice,
  Meter,
  RankedRow,
  RunwayRow,
  StatusTone,
} from "@/data/widgets";

/**
 * EVERY PICTURE A WIDGET CAN DRAW, AND THE HOVER THAT MAKES IT READABLE.
 *
 * These were all inside WidgetCard until the day they grew a pointer. A card
 * shell that decides which of eight kinds to render is a switch statement and
 * should read like one; a chart that has to measure itself, snap a pointer to
 * the nearest sample and place a tooltip that does not hang off the card is
 * three hundred lines of geometry, and mixing the two made the file impossible
 * to scan for either.
 *
 * The table lives here too even though it is not a chart. It is the FIGURES
 * BEHIND the pictures — the thing a reader falls back to when a hover is not
 * enough — and it has exactly as much to do with the card shell as the rest of
 * this file does, which is nothing.
 *
 * THE ONE RULE THAT RUNS THROUGH ALL OF IT: colour is reserved for a reading
 * that is past a limit, or for telling one series from another. Bars and
 * sparklines are drawn in `currentColor` and inherit the card's ink, so every
 * one of them is correct in both themes for free and none of them can
 * accidentally shout. The hues here are the three status tokens, which only
 * appear where something is being judged, and the four series tokens, which
 * only appear where two lines share a plot or four groups share a whole — the
 * donut and the ranked bars below, which are the cost board's forms and are
 * drawn the way the money pages they are modelled on draw them.
 */

/* ------------------------------------------------------------ primitives */

type TipState = {
  /** Pixels from the left of the HOST box — the nearest positioned ancestor
   *  the tooltip is rendered into — at the mark being described. */
  x: number;
  /** Pixels from the top of that same box. */
  y: number;
  title: ReactNode;
  rows: ReactNode;
  /**
   * Put the tooltip UNDER the mark instead of over it.
   *
   * The caller decides, because only the caller knows what is above the mark:
   * a point at the top of a 108px plot has the chart's own axis label there
   * and wants the flip, while a bar sits at the bottom of its card with the
   * whole title row above it and would rather cover that than cover the bars
   * it is describing.
   */
  below?: boolean;
} | null;

/**
 * The tooltip's state and the two callbacks every mark wires to a pointer.
 *
 * A hook rather than a component prop so a chart with several hoverable marks
 * (fourteen runway rows, ten bars) shares one tooltip instead of mounting one
 * per mark and fighting over which is visible.
 */
function useTip() {
  const [tip, setTip] = useState<TipState>(null);
  const hide = useCallback(() => setTip(null), []);
  return { tip, show: setTip, hide };
}

/**
 * The width the chart is ACTUALLY drawn at, in CSS pixels.
 *
 * The charts here used to stretch one fixed `viewBox` to whatever width the
 * card had, which is why none of them could grow a hover: a stretched
 * coordinate space scales the STROKES with the box — the same 1.4px line is a
 * hairline on a four-column card and fat on a one-column one — and a circle
 * drawn in it renders as an oval, so a hover marker or a peak dot was never
 * going to look right. Measure once, redraw on resize, and 2px is 2px
 * everywhere.
 *
 * useLayoutEffect rather than useEffect: the first paint should already have
 * the real width rather than flashing an empty box and then jumping. Callers
 * still reserve the plot's height with a style so the card does not resize on
 * the frame the measurement lands.
 */
function useMeasuredWidth<T extends HTMLElement = HTMLDivElement>(): [
  RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setWidth(Math.round(node.getBoundingClientRect().width));
    read();
    // A ResizeObserver rather than a window listener: a widget also changes
    // width when it is dragged into a different column, when the sidebar
    // collapses, or when its own span is cycled from 1 to 4 — and none of
    // those is a window resize.
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * The one tooltip, shared by every picture in the file.
 *
 * A plain absolutely-positioned div and not the app's Radix tooltip: the thing
 * it points at is a coordinate inside an SVG rather than an element, it moves
 * on every pointer move, and it must never take a hover of ITS own — a tooltip
 * that can be hovered steals the pointer from the mark underneath it and the
 * pair flicker at each other. `pointer-events-none` is the whole reason this is
 * not a popover.
 *
 * IT MEASURES ITSELF BECAUSE THE CARD HAS AN EDGE. Clamping against a guessed
 * half-width — the cheap version — either lets "Fleet mean CPU 12.8%" hang off
 * a one-column card or wastes a third of a four-column one on a tooltip that
 * says "4". The read happens in a layout effect, so the corrected position is
 * in the same frame as the first one and there is nothing to see.
 *
 * IT SITS ABOVE THE MARK UNLESS THE CALLER SAYS OTHERWISE. Pushing a tooltip
 * down to a floor when its mark is near the top of the plot lands it on top of
 * the reading it is quoting, so the flip is a decision and not a fallback —
 * see `below`.
 */
function ChartTip({ tip, width }: { tip: TipState; width: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [half, setHalf] = useState(0);

  // Keyed on the tip itself — every `show` builds a new object, so the width
  // is re-read exactly when the content that sets it changes, and not on the
  // frames where only the anchor moved. The guard is what stops a sub-pixel
  // difference setting state forever.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !tip) return;
    const next = node.offsetWidth / 2;
    setHalf((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
  }, [tip]);

  if (!tip) return null;

  // On a card narrower than the tooltip the two bounds cross; centring is the
  // least-bad answer and it keeps the overflow symmetrical rather than dumping
  // all of it over one edge.
  const lo = Math.min(half, width / 2);
  const hi = Math.max(width - half, width / 2);
  const below = tip.below ?? false;

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "bg-foreground text-background pointer-events-none absolute z-20 w-max -translate-x-1/2 rounded-md px-2 py-1.5 text-[12px] leading-[1.45] whitespace-nowrap shadow-lg",
        !below && "-translate-y-full",
      )}
      style={{ left: clamp(tip.x, lo, hi), top: below ? tip.y + 14 : tip.y - 12 }}
    >
      <div className="font-medium">{tip.title}</div>
      {/* A tip whose whole answer fits in its title — one bar, one figure —
          has no second block and must not reserve a line of air for one. */}
      {tip.rows != null && (
        <div className="text-background/70">{tip.rows}</div>
      )}
    </div>
  );
}

/** One "Label 1,234" line inside a tooltip. */
function TipRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      {label} <b className="text-background font-medium tabular-nums">{value}</b>
    </div>
  );
}

/* ------------------------------------------------------------- formatting */

const TONE_COLOR: Record<StatusTone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  bad: "var(--destructive)",
};

function toneOf(m: Meter): StatusTone {
  if (m.value >= m.crit) return "bad";
  if (m.value >= m.warn) return "warn";
  return "ok";
}

/** Bytes per second at human size, for a chart's own axis label. Kept here
 *  rather than imported from the builders: this one formats an axis maximum,
 *  which is a rounder number than a reading. */
/**
 * What a number on a chart IS.
 *
 * Declared once and shared by the axis and the tooltip, because the two must
 * never disagree about the unit — an axis reading "25000%" over a tooltip
 * reading "24,999 requests" is worse than either alone. `count` exists because
 * not every series is a rate or a proportion: a remaining request allowance is
 * a plain quantity, and rendering it as a percentage was the bug that added
 * this. `usd` exists so a spend series can be drawn as a line rather than
 * pushed into bars for want of a currency axis.
 */
export type ChartUnit = "percent" | "bytes" | "count" | "usd";

function axisLabel(v: number, unit: ChartUnit): string {
  if (unit === "percent") return pct(v / 100, { digits: 0 });
  if (unit === "usd") return money(v, "USD", { digits: v < 10 ? 2 : 0 });
  if (unit === "count") return count(v);
  return `${bytes(v, { base: 1000 })}/s`;
}

/**
 * ONE reading, at the precision a person hovering actually asked for.
 *
 * The axis label rounds because an axis is a scale; a tooltip is the answer to
 * "what was it at four this morning" and rounding 12.8% to 13% there throws
 * away the only thing the hover was for. The trailing ".0" still goes: "12.0%"
 * reads as false precision, not as more of it.
 */
function reading(v: number, unit: ChartUnit | undefined): string {
  if (unit === "bytes") return `${bytes(v, { base: 1000 })}/s`;
  if (unit === "percent") return pct(v / 100);
  // Money keeps its cents at hover size: a spend card's whole reason for a
  // tooltip is the figure the axis rounded away.
  if (unit === "usd") return money(v, "USD");
  if (unit === "count") return count(v);
  // No unit declared — a sample widget from the catalog. Say the number and
  // nothing about what it is, rather than guessing a unit onto it.
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * A window longer than a day and a half is labelled by DAY, not by clock. The
 * fleet's windows are a day long at a fifteen-minute grain, so "18:15" is the
 * right end label there; a fortnight of daily pageviews in a chat answer is
 * not, and "01:00 AM" at both ends of it is the engine parsing `2026-08-23` as
 * UTC midnight and this file reading it back in local time. Day-grained points
 * are calendar days, so they are read back in UTC — dateLong's reasoning.
 */
const DAY_GRAIN_MS = 36 * 3600 * 1000;
const dayShort = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const endLabel = (ms: number, domain: number) => (domain >= DAY_GRAIN_MS ? dayShort(ms) : clock(ms));
const stampFor = (iso: string, domain: number) =>
  domain >= DAY_GRAIN_MS
    ? new Date(iso).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : stamp(iso);

/**
 * The moment a sample was taken, weekday included.
 *
 * These windows are a day long and the grain is fifteen minutes, so "18:15" on
 * its own is ambiguous the moment the window crosses midnight — which it does
 * for every one of them.
 */
const stamp = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** "31 May 2027". A bare `yyyy-mm-dd` is parsed as UTC midnight by the engine
 *  and would print as the day before west of Greenwich, so it is read back in
 *  UTC too — a registrar's expiry date is a calendar day, not an instant. */
function dateLong(iso: string): string {
  const utcDay = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(utcDay ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(utcDay ? { timeZone: "UTC" } : {}),
  });
}

/** The index of the point nearest a moment. A linear scan: these series are
 *  ninety-five points long and the alternative is a binary search that has to
 *  be right, which is a worse trade at this size. */
function nearestIndex(stamps: number[], ms: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < stamps.length; i += 1) {
    const gap = Math.abs(stamps[i]! - ms);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/** The unit of time a mean is quoted per, from the sampling grain — daily
 *  lines say "/day", hourly ones "/hour", and anything else says nothing
 *  rather than the wrong thing. */
function perWord(ms: number): string {
  const hour = 3_600_000;
  const day = 24 * hour;
  if (Math.abs(ms - day) < day * 0.2) return "/day";
  if (Math.abs(ms - 7 * day) < day) return "/week";
  if (Math.abs(ms - hour) < hour * 0.2) return "/hour";
  if (ms < hour) return "/sample";
  return "";
}

/** The typical spacing between samples, as a median rather than a mean: one
 *  gap left by a collector that was down for an hour must not widen the idea
 *  of "a grain" for the whole series. */
function grain(stamps: number[]): number {
  if (stamps.length < 2) return 0;
  const gaps = stamps.slice(1).map((v, i) => v - stamps[i]!);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

/* ------------------------------------------------------------------ chart */

/** Room for the hover marker's ring at the top, and half a stroke at the
 *  sides so the first and last points are not sliced in half by the viewport. */
const PLOT = { t: 8, r: 5, b: 4, l: 5 };
const PLOT_H = 108;

/**
 * One or two lines over time, drawn against a shared scale.
 *
 * BOTH SERIES SHARE ONE Y-AXIS AND IT STARTS AT ZERO. Two lines on two scales
 * in one box is a picture that can show traffic in exceeding traffic out when
 * it is a tenth of it, and a y-axis that starts at its own minimum turns a
 * fleet idling between 8% and 11% into a mountain range. The zero is the whole
 * reason the picture is worth more than the number beside it.
 *
 * X IS TIME, NOT POSITION IN THE ARRAY. The old version spread each line
 * evenly across the box, which is the same picture only while every series has
 * the same number of points at the same instants. It also made the hover
 * impossible to state honestly: a crosshair at 60% of the width has to mean a
 * MOMENT before it can ask the second series what it read then.
 *
 * THE AREA IS A GRADIENT AND THE FILL IS `currentColor`. A flat wash at one
 * opacity fights the line for attention and reads as a solid shape; a fade to
 * nothing at the baseline lets the line stay the mark and the fill stay the
 * magnitude. Drawn in the card's own ink, it is a dark veil on paper and a
 * light one on near-black without a second palette or a media query — and it
 * is deliberately NOT the source's brand hue: Hetzner's mark is a strong red,
 * and a red line climbing across a load chart says "something is wrong" before
 * anybody has read the axis.
 *
 * The axis figures and the times sit in HTML around the SVG rather than inside
 * it, so they are set at the card's own type size and are selectable.
 */
/** The hue of the nth series — green, blue, purple, then round again. */
const seriesColour = (i: number) => `var(--chart-line-${(i % 4) + 1})`;

/** A figure written on the plot: small, in the ink, with a halo of the card
 *  colour so it stays legible over the line it labels. */
function PlotLabel({ x, y, anchor, children }: { x: number; y: number; anchor: "start" | "middle" | "end"; children: string }) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={10.5}
      fill="var(--foreground)"
      stroke="var(--card)"
      strokeWidth={3}
      paintOrder="stroke"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {children}
    </text>
  );
}

export function Chart({
  series,
  unit,
  caption,
}: {
  series: ChartSeries[];
  unit: ChartUnit;
  caption?: string;
}) {
  const [host, w] = useMeasuredWidth<HTMLDivElement>();
  // The hovered index on the PRIMARY series, which is what defines the moment
  // every other series is then read at. Storing an index rather than a pixel
  // means the crosshair is always on a real sample: a guide line hovering
  // between two readings invites a reader to interpolate a number that was
  // never measured.
  const [at, setAt] = useState<number | null>(null);
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");

  const lines = series.filter((s) => s.points.length > 1);
  if (!lines.length)
    return (
      <p className="text-muted-foreground mt-2 text-[12.5px]">
        {caption ?? "Nothing measured yet."}
      </p>
    );

  const stamps = lines.map((l) => l.points.map((p) => Date.parse(p.ts)));
  const prim = lines[0]!;
  const primStamps = stamps[0]!;
  const t0 = Math.min(...stamps.map((s) => s[0]!));
  const t1 = Math.max(...stamps.map((s) => s[s.length - 1]!));
  const domain = t1 - t0 || 1;
  const max = Math.max(...lines.flatMap((l) => l.points.map((p) => p.value)), 1);

  const iw = Math.max(1, w - PLOT.l - PLOT.r);
  const ih = PLOT_H - PLOT.t - PLOT.b;
  const X = (ms: number) => PLOT.l + ((ms - t0) / domain) * iw;
  const Y = (v: number) => PLOT.t + ih - (v / max) * ih;
  const baseline = PLOT.t + ih;

  // The series can be replaced under a live refresh while a pointer is resting
  // on it, and the new one may be shorter than the index we are holding.
  const cursor =
    at === null ? null : Math.min(at, primStamps.length - 1);
  const cursorMs = cursor === null ? null : primStamps[cursor]!;

  /** What a line read at the hovered MOMENT, or null if it has nothing within
   *  a grain of it. A series that stopped reporting an hour ago must not have
   *  its last reading quietly paired with a timestamp from now. */
  const readAt = (i: number): number | null => {
    if (cursorMs === null) return null;
    const s = stamps[i]!;
    const j = nearestIndex(s, cursorMs);
    const tol = Math.max(grain(s) * 0.75, 60_000);
    return Math.abs(s[j]! - cursorMs) <= tol ? j : null;
  };

  const peak = prim.points.reduce(
    (best, p, i) => (p.value > prim.points[best]!.value ? i : best),
    0,
  );
  const last = prim.points.length - 1;

  /*
    THE THREE FIGURES EVERY LINE IS READ FOR — where it spiked, where it
    bottomed, and what a typical sample was — said in words under the plot and
    drawn as a dashed line across it, on every chart rather than on the ones
    whose builder thought of it. The mean is per SAMPLE, and the word after it
    is the sampling grain the series actually has ("/day" for a daily line,
    "/hour" for an hourly one), because "mean 19k" with no unit of time is a
    number that invites the wrong denominator.
  */
  const primValues = prim.points.map((p) => p.value);
  const low = primValues.reduce((best, v, i) => (v < primValues[best]! ? i : best), 0);
  const mean = primValues.reduce((n, v) => n + v, 0) / primValues.length;
  const per = perWord(grain(primStamps));
  /*
    WHICH END OF THE MEAN LINE IS CLEAR OF THE OTHER TWO LABELS. Each label's
    footprint is estimated from its text — six and a bit pixels a character
    at this size — and anchored the way it will be drawn; the mean label goes
    left unless that box crosses the peak's or the low's, and right when the
    right end is the clearer one. A figure that lands on another figure says
    neither, which is worse than a label on the less obvious side.
  */
  const CH = 6.3;
  const meanText = `mean ${reading(mean, unit)}${per}`;
  const anchorFor = (x: number): "start" | "middle" | "end" =>
    x < PLOT.l + 40 ? "start" : x > PLOT.l + iw - 40 ? "end" : "middle";
  const box = (x: number, text: string, anchor: "start" | "middle" | "end"): [number, number] => {
    const wd = text.length * CH;
    return anchor === "start" ? [x, x + wd] : anchor === "end" ? [x - wd, x] : [x - wd / 2, x + wd / 2];
  };
  /* Where each label's baseline will be drawn — above its dot unless the dot
     is at the top, below the low unless it is on the baseline — because the
     clash that matters is between the LABELS, not between the dots. */
  const peakLabelY = Y(prim.points[peak]!.value) < PLOT.t + 14 ? Y(prim.points[peak]!.value) + 14 : Y(prim.points[peak]!.value) - 6;
  const lowLabelY = Y(prim.points[low]!.value) > baseline - 14 ? Y(prim.points[low]!.value) - 6 : Y(prim.points[low]!.value) + 13;
  const others = [
    { box: box(X(primStamps[peak]!), `peak ${reading(prim.points[peak]!.value, unit)}`, anchorFor(X(primStamps[peak]!))), y: peakLabelY },
    { box: box(X(primStamps[low]!), `low ${reading(prim.points[low]!.value, unit)}`, anchorFor(X(primStamps[low]!))), y: lowLabelY },
  ];
  const meanLabelY = Y(mean) - 4;
  const clashes = ([a, b]: [number, number]) =>
    // Fourteen, not the label's own eleven: two baselines twelve apart at this
    // size leave the ascenders of one touching the descenders of the other.
    // And eight pixels of side room, because two labels on one baseline that
    // merely do not overlap read as one sentence — "mean $1.50/day low $0.16".
    others.some(
      (o) => a < o.box[1] + 8 && b + 8 > o.box[0] && Math.abs(o.y - meanLabelY) < 14,
    );
  const meanAtRight = clashes(box(PLOT.l + 2, meanText, "start")) && !clashes(box(PLOT.l + iw - 2, meanText, "end"));

  /** The top of the hover's own marks — the y the tooltip hangs off. Falls to
   *  the baseline when nothing on the crosshair has a reading to show. */
  const crest =
    cursorMs === null
      ? 0
      : Math.min(
          ...lines.map((l, i) => {
            const j = readAt(i);
            return j === null ? baseline : Y(l.points[j]!.value);
          }),
        );

  const move = (clientX: number, box: DOMRect) => {
    const ms = t0 + clamp((clientX - box.left - PLOT.l) / iw, 0, 1) * domain;
    setAt(nearestIndex(primStamps, ms));
  };

  const key = (e: React.KeyboardEvent) => {
    // Arrow keys walk the same cursor the pointer moves, so the reading is
    // reachable without one. Home and End are the two a reader actually wants
    // on a time series: the start of the window and now.
    const step =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) {
      e.preventDefault();
      setAt((prev) => clamp((prev ?? last) + step, 0, last));
    } else if (e.key === "Home") {
      e.preventDefault();
      setAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setAt(last);
    }
  };

  return (
    <div className="mt-1">
      <div className="text-muted-foreground flex items-baseline justify-between text-[11.5px] tabular-nums">
        <span>{axisLabel(max, unit)}</span>
        {lines.length > 1 && (
          <span className="flex items-center gap-2.5">
            {lines.map((l, i) => (
              <span key={l.label} className="flex items-center gap-1">
                <i className="h-[2px] w-3 rounded" style={{ background: seriesColour(i) }} />
                {l.label}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* The plot's own box: the tooltip is positioned against THIS, so its
          coordinates are the SVG's coordinates and no offset arithmetic has to
          agree with a layout. The height is reserved so the card does not
          resize on the frame the width measurement lands. */}
      {/* `color` here is what every `currentColor` below resolves to, and it is
          a TOKEN rather than an inherited ink so an alternate palette can tint
          the series. `--chart-1` is the foreground in the default palette, so
          this changes nothing about how the chart has always looked; it just
          stops the plot being the only colour on the page a palette cannot
          reach. See lib/palettes.ts for why the rest of the ramp stays grey. */}
      <div
        ref={host}
        className="relative mt-1"
        style={{ height: PLOT_H, color: "var(--chart-line-1)" }}
      >
        {w > 0 && (
          <svg
            width={w}
            height={PLOT_H}
            viewBox={`0 0 ${w} ${PLOT_H}`}
            role="img"
            tabIndex={0}
            aria-label={`${lines
              .map(
                (l) =>
                  `${l.label}: ${reading(l.points[l.points.length - 1]!.value, unit)} latest`,
              )
              .join(", ")}. ${prim.label} peaked at ${reading(
              prim.points[peak]!.value,
              unit,
            )} on ${stampFor(prim.points[peak]!.ts, domain)}, across ${
              prim.points.length
            } samples. Use the arrow keys to read a point.`}
            className="focus-visible:ring-ring block touch-pan-y rounded-[8px] outline-none focus-visible:ring-1"
            onPointerMove={(e) =>
              move(e.clientX, e.currentTarget.getBoundingClientRect())
            }
            onPointerLeave={() => setAt(null)}
            onFocus={() => setAt((prev) => prev ?? last)}
            onBlur={() => setAt(null)}
            onKeyDown={key}
          >
            <defs>
              <linearGradient id={`fade-${gid}`} x1="0" y1="0" x2="0" y2="1">
                {/* Three stops, not two: a straight fade from 22% to 0 spends
                    most of its length in the middle greys and reads as a
                    smudge. Falling faster at the top leaves the ink near the
                    line, where it is describing something. */}
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
                <stop offset="55%" stopColor="currentColor" stopOpacity={0.07} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* The zero line, so the scale is visibly anchored rather than
                implied. Nothing else: at this height a grid is noise. */}
            <line
              x1={PLOT.l}
              x2={PLOT.l + iw}
              y1={baseline}
              y2={baseline}
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.16}
              shapeRendering="crispEdges"
            />

            {lines.map((l, i) => {
              const s = stamps[i]!;
              const xy = l.points.map(
                (p, j) => `${X(s[j]!).toFixed(1)},${Y(p.value).toFixed(1)}`,
              );
              const d = `M${xy.join("L")}`;
              return (
                <g key={l.label}>
                  {/* The fill is the same run of points, dropped to the
                      baseline at each end and closed. Only the FIRST series
                      gets one: two overlapping washes make a third value out
                      of their intersection that stands for nothing. */}
                  {i === 0 && (
                    <path
                      d={
                        `M${X(s[0]!).toFixed(1)},${baseline}` +
                        `L${xy.join("L")}` +
                        `L${X(s[s.length - 1]!).toFixed(1)},${baseline}Z`
                      }
                      fill={`url(#fade-${gid})`}
                    />
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke={seriesColour(i)}
                    strokeWidth={i === 0 ? 1.75 : 1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.95}
                  />
                </g>
              );
            })}

            {/* The mean, as a dashed rule the eye can hold the line against,
                with its figure written at the left end. Drawn under the
                series so a flat run along it stays legible. */}
            {mean > 0 && (
              <g>
                <line
                  x1={PLOT.l}
                  x2={PLOT.l + iw}
                  y1={Y(mean)}
                  y2={Y(mean)}
                  stroke="currentColor"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.45}
                />
                {/* At whichever end is clear of the peak and low labels: a
                    figure that lands on another figure says neither. */}
                <PlotLabel x={meanAtRight ? PLOT.l + iw - 2 : PLOT.l + 2} y={meanLabelY} anchor={meanAtRight ? "end" : "start"}>
                  {meanText}
                </PlotLabel>
              </g>
            )}

            {/* Two direct labels rather than a number on every point: when it
                was worst, and where it is now. The card-coloured ring is the
                spacer that keeps a dot legible on top of its own line. */}
            {peak !== last && (
              <circle
                cx={X(primStamps[peak]!)}
                cy={Y(prim.points[peak]!.value)}
                r={2.2}
                fill="currentColor"
                opacity={0.45}
              />
            )}
            {/*
              THE PEAK AND THE LOW, WRITTEN WHERE THEY HAPPENED. A figure on
              the plot is read in the same glance as the shape; one under it
              has to be matched back to a point by eye. Each label sits on
              the side of its dot that has room — above the peak unless the
              peak is at the top, below the low unless the low is on the
              baseline — and leans away from whichever edge it is near.
            */}
            {(() => {
              const px = X(primStamps[peak]!);
              const lx = X(primStamps[low]!);
              return (
                <g>
                  <PlotLabel x={px} y={peakLabelY} anchor={anchorFor(px)}>
                    {`peak ${reading(prim.points[peak]!.value, unit)}`}
                  </PlotLabel>
                  {low !== peak && (
                    <PlotLabel x={lx} y={lowLabelY} anchor={anchorFor(lx)}>
                      {`low ${reading(prim.points[low]!.value, unit)}`}
                    </PlotLabel>
                  )}
                </g>
              );
            })()}
            <circle
              cx={X(primStamps[last]!)}
              cy={Y(prim.points[last]!.value)}
              r={2.6}
              fill="currentColor"
              stroke="var(--card)"
              strokeWidth={1.5}
            />

            {cursorMs !== null && (
              <g>
                <line
                  x1={X(cursorMs)}
                  x2={X(cursorMs)}
                  y1={PLOT.t}
                  y2={baseline}
                  stroke="currentColor"
                  strokeWidth={1}
                  opacity={0.28}
                  shapeRendering="crispEdges"
                />
                {lines.map((l, i) => {
                  const j = readAt(i);
                  if (j === null) return null;
                  return (
                    <circle
                      key={l.label}
                      cx={X(cursorMs)}
                      cy={Y(l.points[j]!.value)}
                      r={3.2}
                      fill={seriesColour(i)}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  );
                })}
              </g>
            )}
          </svg>
        )}

        <ChartTip
          tip={
            cursorMs === null
              ? null
              : {
                  x: X(cursorMs),
                  // Anchored to the HIGHEST mark on the crosshair, so with two
                  // series the tooltip clears both rather than sitting on the
                  // one it happens to list second.
                  y: crest,
                  // And flipped under the crosshair when that mark is high
                  // enough in the plot that a tooltip above it would cover the
                  // axis figure and the legend.
                  below: crest < 52,
                  title: stampFor(prim.points[cursor!]!.ts, domain),
                  rows: lines.map((l, i) => {
                    const j = readAt(i);
                    return (
                      <TipRow
                        key={l.label}
                        label={l.label}
                        // A series with nothing within a grain of this moment
                        // says so. It did not read zero.
                        value={j === null ? "no sample" : reading(l.points[j]!.value, unit)}
                      />
                    );
                  }),
                }
          }
          width={w}
        />
      </div>

      <div className="text-muted-foreground mt-1 flex justify-between text-[11.5px] tabular-nums">
        <span>{endLabel(t0, domain)}</span>
        <span>{endLabel(t1, domain)}</span>
      </div>

      {caption && (
        <p className="text-muted-foreground mt-1.5 text-[12px] leading-snug">
          {caption}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- sparkline */

const SPARK = { t: 4, r: 3, b: 3, l: 3 };
const SPARK_H = 34;

/**
 * The shape of the window the figure above it is quoting.
 *
 * DELIBERATELY NOT A FILLED AREA, unlike the chart above. A sparkline is scaled
 * from its own minimum to its own maximum — that is what makes it able to show
 * the shape of a fleet idling between 8% and 11% in thirty-four pixels — and an
 * area under a line whose baseline is not zero draws a quantity of ink that
 * stands for nothing. The line alone is honest at this size; the gradient is
 * for the chart, which is anchored at zero and has earned it.
 *
 * The hover gives it what the figure above cannot: not "the mean was 11.9%"
 * but "and at four this morning it was 21%".
 */
export function Sparkline({
  series,
  at,
  unit,
}: {
  series: number[];
  /** When each value was taken, if the builder knew. Sample widgets from the
   *  catalog have no timestamps and the hover says which sample instead. */
  at?: string[];
  unit?: ChartUnit;
}) {
  const [host, w] = useMeasuredWidth<HTMLDivElement>();
  const [i, setI] = useState<number | null>(null);

  if (series.length < 2) return null;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const iw = Math.max(1, w - SPARK.l - SPARK.r);
  const ih = SPARK_H - SPARK.t - SPARK.b;
  const X = (j: number) => SPARK.l + (j / (series.length - 1)) * iw;
  const Y = (v: number) => SPARK.t + ih - ((v - min) / span) * ih;

  const cursor = i === null ? null : Math.min(i, series.length - 1);

  return (
    <div
      ref={host}
      className="relative mt-2"
      style={{ height: SPARK_H }}
      onPointerLeave={() => setI(null)}
    >
      {w > 0 && (
        <svg
          width={w}
          height={SPARK_H}
          viewBox={`0 0 ${w} ${SPARK_H}`}
          role="img"
          style={{ color: "var(--chart-line-1)" }}
          aria-label={`${series.length} samples, from ${reading(series[0]!, unit)} to ${reading(
            series[series.length - 1]!,
            unit,
          )}, low ${reading(min, unit)}, high ${reading(max, unit)}`}
          className="block touch-pan-y"
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const t = clamp((e.clientX - box.left - SPARK.l) / iw, 0, 1);
            setI(Math.round(t * (series.length - 1)));
          }}
        >
          <polyline
            points={series.map((v, j) => `${X(j).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.5}
          />
          {cursor !== null && (
            <g>
              <line
                x1={X(cursor)}
                x2={X(cursor)}
                y1={SPARK.t - 2}
                y2={SPARK_H - SPARK.b + 2}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.25}
                shapeRendering="crispEdges"
              />
              <circle
                cx={X(cursor)}
                cy={Y(series[cursor]!)}
                r={2.6}
                fill="currentColor"
                stroke="var(--card)"
                strokeWidth={1.5}
              />
            </g>
          )}
        </svg>
      )}

      <ChartTip
        tip={
          cursor === null
            ? null
            : {
                x: X(cursor),
                y: Y(series[cursor]!),
                title: reading(series[cursor]!, unit),
                rows: at?.[cursor]
                  ? stamp(at[cursor]!)
                  : `sample ${cursor + 1} of ${series.length}`,
              }
        }
        width={w}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- bars */

/**
 * A count or an amount per category, ordered largest first by its builder.
 *
 * The bars are HTML rather than SVG: every height here is a percentage of a
 * fixed box and every width a flex share, so the row is responsive at any card
 * width without this component knowing any of those numbers. The only thing
 * that needs a pixel is the tooltip, and it takes the one measurement it
 * cannot do without — how wide the card is, so it can stay inside it — while
 * reading the hovered bar's own position off the bar itself on enter.
 *
 * THE HOVERED BAR IS THE ONLY ONE AT FULL STRENGTH. The tint is carried at a
 * third of its opacity so a row of bars is a shape rather than a stripe of
 * colour; lifting only the hovered one is what makes the tooltip's subject
 * unambiguous when nine bars are three pixels apart.
 */
export function Bars({
  values,
  barLabels,
  labels,
  marks,
  tint,
}: {
  values: number[];
  /** A model name per bar, for the mark drawn under it. See ModelMark. */
  marks?: (string | null)[];
  /** One phrase per bar, same order — "nbg1 · 4 servers". Absent for the
   *  catalog's sample widgets, whose bars are shapes rather than readings; the
   *  hover then says the value and nothing it cannot stand behind. */
  barLabels?: string[];
  /** The one-line summary under the bars, which every widget still has. */
  labels?: string;
  /** The source's brand hue, at low opacity. */
  tint?: string;
}) {
  const [host, w] = useMeasuredWidth<HTMLDivElement>();
  const { tip, show, hide } = useTip();
  const [hot, setHot] = useState<number | null>(null);

  const max = Math.max(...values, 0) || 1;

  return (
    <div ref={host} className="relative">
      <div
        className="mt-2 flex h-[46px] items-end gap-1"
        onPointerLeave={() => {
          setHot(null);
          hide();
        }}
      >
        {values.map((v, i) => (
          <div
            key={i}
            role="img"
            aria-label={barLabels?.[i] ?? `bar ${i + 1}: ${v}`}
            className={cn(
              "bg-border min-h-[3px] max-w-[30px] flex-1 rounded-t-sm transition-[opacity,background]",
              hot !== null && hot !== i && "opacity-55",
            )}
            style={{
              height: `${Math.round((v / max) * 100)}%`,
              background: tint
                ? hot === i
                  ? `${tint}bb`
                  : `${tint}55`
                : undefined,
            }}
            onPointerEnter={(e) => {
              const hostBox = host.current?.getBoundingClientRect();
              if (!hostBox) return;
              // Read off the bar itself: its width is a flex share of a box
              // this component never measures, and the tooltip has to point at
              // its middle rather than at the pointer, which is somewhere
              // arbitrary inside it.
              const box = e.currentTarget.getBoundingClientRect();
              const row = e.currentTarget.parentElement?.getBoundingClientRect();
              setHot(i);
              show({
                x: box.left - hostBox.left + box.width / 2,
                // Above the whole ROW, not above this bar. Anchored to the bar
                // itself, a short one puts the tooltip down among the tall
                // ones and hides half the picture; from up here it clears
                // every bar and only its x has to move.
                y: (row?.top ?? box.top) - hostBox.top,
                // The whole answer, in the title, or the bare figure when the
                // builder had no phrase for this bar. Never a percentage of
                // the tallest bar — that is a fact about the picture rather
                // than about the thing it is drawing.
                title: barLabels?.[i] ?? v.toLocaleString(),
                rows: null,
              });
            }}
          />
        ))}
      </div>
      {/* One mark under each bar, in the same flex arithmetic as the bars
          so the two rows cannot disagree about where a column is. */}
      {marks?.some(Boolean) && (
        <div className="mt-1 flex gap-1">
          {values.map((_, i) => (
            <div key={i} className="flex max-w-[30px] flex-1 justify-center">
              {marks[i] && <ModelMark name={marks[i]!} size={11} />}
            </div>
          ))}
        </div>
      )}
      <div className="text-muted-foreground mt-1 text-[12.5px]">{labels}</div>
      <ChartTip tip={tip} width={w} />
    </div>
  );
}

/* ------------------------------------------------------------------ donut */

/**
 * Parts of one whole, with the whole written in the hole.
 *
 * A DONUT, because the total is worth reading. The bars this replaces on the
 * cost board were two or three fills sharing a track with no figure between
 * them, which draws the shares and hides the thing they are shares OF — and
 * on a card called "Where the dollars go" that figure is the point. Four
 * slices is where the form is still honest; a fifth is the moment for
 * `Ranked` instead, and the builders keep to that.
 *
 * THE LEGEND IS THE TABLE OF FIGURES. It sits beside the ring as text rather
 * than as labels on the arcs, because a legend that carries money wants to be
 * selectable, tabular and readable at 13px, and hovering a row lights its
 * slice and the other way round so the two are one control rather than a
 * picture and a caption. Colour follows the ENTITY in slice order and never
 * the rank: a month in which OpenRouter outspends OpenAI must not repaint
 * them.
 *
 * A 2px GAP between slices, subtracted in angle so it stays 2px at the rim
 * whatever the radius: adjacent fills that touch bleed into one another and
 * the eye reads two segments as one. A slice with no value is left out of the
 * ring but kept in the legend, because "€0.00 of volumes" is a fact about the
 * bill and a hairline nobody can hover is not.
 */
/**
 * The arc paths, walked in slice order from twelve o'clock. Out of the
 * component so the running angle is a loop's own variable rather than a
 * render-scope `let` reassigned inside a map.
 */
function donutArcs(
  slices: DonutSlice[],
  sum: number,
  g: { cx: number; cy: number; R: number; rIn: number; gap: number },
): { i: number; d: string }[] {
  const { cx, cy, R, rIn } = g;
  const out: { i: number; d: string }[] = [];
  let a0 = -Math.PI / 2;
  slices.forEach((s, i) => {
    const v = Math.max(s.value, 0);
    if (!(v > 0) || !(sum > 0)) return;
    const sweep = (v / sum) * Math.PI * 2;
    // One slice is the whole ring: a gap would cut a notch out of a circle.
    const gap = sweep >= Math.PI * 2 - 1e-6 ? 0 : g.gap;
    const s0 = a0 + gap / 2;
    const s1 = a0 + sweep - gap / 2;
    a0 += sweep;
    const large = s1 - s0 > Math.PI ? 1 : 0;
    const d =
      gap === 0
        ? `M${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}Z` +
          `M${cx + rIn},${cy}A${rIn},${rIn} 0 1 0 ${cx - rIn},${cy}A${rIn},${rIn} 0 1 0 ${cx + rIn},${cy}Z`
        : `M${(cx + R * Math.cos(s0)).toFixed(2)},${(cy + R * Math.sin(s0)).toFixed(2)}` +
          `A${R},${R} 0 ${large} 1 ${(cx + R * Math.cos(s1)).toFixed(2)},${(cy + R * Math.sin(s1)).toFixed(2)}` +
          `L${(cx + rIn * Math.cos(s1)).toFixed(2)},${(cy + rIn * Math.sin(s1)).toFixed(2)}` +
          `A${rIn},${rIn} 0 ${large} 0 ${(cx + rIn * Math.cos(s0)).toFixed(2)},${(cy + rIn * Math.sin(s0)).toFixed(2)}Z`;
    out.push({ i, d });
  });
  return out;
}

export function Donut({
  slices,
  center,
  caption,
}: {
  slices: DonutSlice[];
  center?: { value: string; note: string };
  caption?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const sum = slices.reduce((n, s) => n + Math.max(s.value, 0), 0);
  const SIZE = 132;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const R = SIZE / 2 - 2;
  const rIn = R * 0.64;
  const gap = 2 / R;

  const arcs = donutArcs(slices, sum, { cx, cy, R, rIn, gap });

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`${center?.value ?? ""} ${center?.note ?? ""}: ${slices
            .map((s) => `${s.label} ${s.text}`)
            .join(", ")}`}
          className="shrink-0"
          onPointerLeave={() => setActive(null)}
        >
          {arcs.map((a) => (
              <path
                key={a.i}
                d={a.d}
                fill={seriesColour(a.i)}
                fillRule="evenodd"
                opacity={active !== null && active !== a.i ? 0.32 : 1}
                className="transition-opacity duration-150"
                onPointerEnter={() => setActive(a.i)}
              >
                <title>{`${slices[a.i]!.label} · ${slices[a.i]!.text} · ${pct(
                  Math.max(slices[a.i]!.value, 0) / (sum || 1),
                  { digits: 0 },
                )}`}</title>
              </path>
          ))}
          {/* An empty ring when nothing has a value: the hole still carries the
              total, which is then a real zero rather than an absence. */}
          {!(sum > 0) && (
            <circle cx={cx} cy={cy} r={(R + rIn) / 2} fill="none" stroke="var(--border)" strokeWidth={R - rIn} />
          )}
          {center && (
            <>
              <text
                x={cx}
                y={cy - 1}
                textAnchor="middle"
                fill="var(--foreground)"
                fontSize={17}
                fontWeight={500}
                letterSpacing="-0.02em"
                className="tabular-nums"
              >
                {center.value}
              </text>
              <text x={cx} y={cy + 14} textAnchor="middle" fill="var(--muted-foreground)" fontSize={10}>
                {center.note}
              </text>
            </>
          )}
        </svg>
        <div className="flex min-w-0 flex-1 flex-col" onPointerLeave={() => setActive(null)}>
          {slices.map((s, i) => (
            <div
              key={s.label}
              onPointerEnter={() => setActive(i)}
              className={cn(
                "grid grid-cols-[10px_1fr_auto] items-baseline gap-x-2.5 gap-y-0.5 rounded-[8px] px-2 py-1 transition-colors",
                active === i && "bg-muted",
              )}
            >
              <span
                aria-hidden="true"
                className="size-2.5 self-center rounded-sm"
                style={{ background: seriesColour(i) }}
              />
              <span className="truncate text-[13px]">{s.label}</span>
              <span className="text-[13px] tabular-nums">{s.text}</span>
              <span className="text-muted-foreground col-span-2 col-start-2 flex justify-between gap-2 text-[12px] leading-snug">
                <span className="truncate">{s.sub}</span>
                <span className="shrink-0 tabular-nums">
                  {sum > 0 ? pct(Math.max(s.value, 0) / sum, { digits: 0 }) : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
      {caption && (
        <p className="text-muted-foreground mt-2 text-[12px] leading-snug">{caption}</p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- ranked */

/**
 * Ranked horizontal bars: which of these is biggest, and by how much.
 *
 * HORIZONTAL because the categories are NAMES — model ids, project names —
 * and a row of upright bars with nine model names under it either rotates the
 * labels or truncates them to a mark. This is what the cost board's "Spend by
 * model" used to do: nine grey nubs, a brand mark under each, and a caption
 * that named four of them. The name is on the row now, in full.
 *
 * THE FIGURE SITS AT THE TIP OF ITS OWN BAR, which is the whole reason this
 * form needs no value axis: the number is already on the mark, and a row of
 * gridlines would be a second reading of the same quantity. Scaled to the
 * biggest row rather than to the total — one model is most of an account,
 * and against a 100% scale every other bar would be a line one pixel long.
 * The bar stops at 78% of the track so the figure always has room at the
 * tip; the ranking is in the lengths, which a shared scale preserves.
 *
 * ONE COLOUR ACROSS EVERY BAR. This is a single measurement over many names,
 * so a palette here would encode nothing but rank — which the order and the
 * length already say. `sub` is right-aligned on the name's line: a long bar
 * over a small token count is an expensive model, and the two are read in
 * the same glance.
 */
export function Ranked({ rows, caption }: { rows: RankedRow[]; caption?: string }) {
  const top = Math.max(1, ...rows.map((r) => Math.max(r.value, 0)));
  return (
    <div className="mt-1 flex flex-col gap-2">
      {rows.map((r) => {
        const share = (Math.max(r.value, 0) / top) * 78;
        return (
          <div key={r.label} className="min-w-0">
            <div className="flex items-baseline gap-2 text-[13px]">
              {r.mark && <ModelMark name={r.mark} size={13} className="self-center" />}
              <span className="truncate">{r.label}</span>
              {r.sub && (
                <span className="text-muted-foreground ml-auto shrink-0 text-[12px] tabular-nums">
                  {r.sub}
                </span>
              )}
            </div>
            <div
              className="relative mt-1 h-[14px]"
              role="img"
              aria-label={`${r.label}: ${r.text}`}
              title={`${r.label} · ${r.text}${r.sub ? ` · ${r.sub}` : ""}`}
            >
              <div
                className="absolute inset-y-0 left-0 min-w-[3px] rounded-sm"
                style={{ width: `${share}%`, background: seriesColour(0), opacity: 0.85 }}
              />
              <span
                className="absolute top-1/2 -translate-y-1/2 text-[12px] leading-none whitespace-nowrap tabular-nums"
                style={{ left: `calc(${Math.max(share, 0.5)}% + 6px)` }}
              >
                {r.text}
              </span>
            </div>
          </div>
        );
      })}
      {caption && (
        <p className="text-muted-foreground mt-0.5 text-[12px] leading-snug">{caption}</p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- meters */

/**
 * One reading, its track, and the two lines it is being judged against.
 *
 * The fill and the track are ONE hue: a percentage is a part of a whole, so
 * the unfilled remainder is the rest of that whole rather than a neutral
 * gutter, and the row reads as one object going amber instead of a bar sitting
 * in a groove. The hairlines are what turn a number into a position — the eye
 * sees the fill past the second one before it reads the figure.
 *
 * The hover is a native `title` and not the tooltip the rest of this file uses,
 * which is a deliberate step down. Everything a meter knows is already ON the
 * row except the two limits, the row is full-card-width so there is no mark to
 * point at, and a floating panel that repeats the label back at you is worse
 * than the delay on a title.
 */
export function MeterRow({ meter }: { meter: Meter }) {
  const tone = toneOf(meter);
  const color = TONE_COLOR[tone];
  const said = `${meter.label} — ${Math.round(meter.value)}% now${
    meter.note ? ` · ${meter.note}` : ""
  } · watch at ${meter.warn}%, act at ${meter.crit}%`;

  return (
    <div
      className="hover:bg-muted/50 -mx-1 min-w-0 rounded-md px-1 py-0.5 transition-colors"
      title={said}
    >
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="truncate">{meter.label}</span>
        {tone !== "ok" && (
          <span
            className={cn(
              "shrink-0 text-[11.5px] font-medium",
              tone === "warn" ? "text-warn" : "text-destructive",
            )}
          >
            {tone === "bad" ? "act" : "watch"}
          </span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 text-[12px] tabular-nums">
          {meter.note}
        </span>
        <span className="shrink-0 text-[13px] tabular-nums">
          {Math.round(meter.value)}%
        </span>
      </div>
      <div
        className="relative mt-1 h-1.5 overflow-hidden rounded-full"
        role="meter"
        aria-valuenow={Math.round(meter.value)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={said}
        style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }}
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(0, Math.min(100, meter.value))}%`,
            background: color,
          }}
        />
        {[meter.warn, meter.crit].map((t) => (
          <span
            key={t}
            aria-hidden="true"
            className="bg-foreground/20 absolute inset-y-0 w-px"
            style={{ left: `${t}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ table */

/** The figures behind the pictures. Scrolled sideways rather than wrapped —
 *  a six-column row folded onto three lines stops being a row. */
export function Figures({
  headers,
  rows,
  marks,
}: {
  headers: string[];
  rows: string[][];
  /** A model name per row, for the mark before the first cell. */
  marks?: (string | null)[];
}) {
  return (
    <div className="-mx-1 mt-1 overflow-x-auto px-1">
      <table className="w-full min-w-[420px] border-collapse text-[12.5px]">
        <thead>
          <tr className="text-muted-foreground">
            {headers.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={cn(
                  "border-line-soft border-b pb-1 font-normal",
                  i === 0 ? "text-left" : "text-right",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r[0]} className="hover:bg-muted/40 transition-colors">
              {r.map((cell, i) => (
                <td
                  key={i}
                  className={cn(
                    "border-line-soft/60 border-b py-1 whitespace-nowrap",
                    i === 0 ? "pr-3 text-left" : "pl-3 text-right tabular-nums",
                  )}
                >
                  {i === 0 && marks?.[ri] ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ModelMark name={marks[ri]!} size={13} />
                      {cell}
                    </span>
                  ) : (
                    cell
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- runway */

/**
 * Deadlines on one axis, soonest first.
 *
 * WHY A LENGTH AND NOT A LIST OF DATES. "5 Dec" and "3 Feb" are two facts a
 * reader has to convert into a distance before either means anything; drawn as
 * lengths against the same axis, the fortnight and the two years are the shape
 * of the thing rather than arithmetic. The two rules are the lines every dot is
 * being judged against, and they are labelled — an unlabelled rule on a time
 * axis reads as a gridline.
 *
 * STILL BUILT IN HTML, NOW THAT IT HAS A HOVER. An SVG version of this exists
 * elsewhere because it draws its labels inside the plot, where a long name has no
 * ellipsis and no way to be truncated; here every length is a percentage of the
 * track, so the chart is responsive at any card width with no measurement and
 * the names truncate the way the rest of the card's type does. The only pixels
 * anything here needs are the tooltip's: how wide the card is, so it can stay
 * inside it, and where the hovered row's dot landed — which it reads off that
 * row's own track when the pointer arrives rather than by repeating the flex
 * arithmetic that placed it.
 *
 * THE HOVER IS THE POINT OF THE ROW, NOT A DECORATION. A row is a name, a
 * length and a countdown; the date it is counting to, who holds the name and
 * whether it renews itself were in a `title` attribute, which is to say they
 * were in a tooltip nobody waits for. They are the three facts that decide
 * whether "18d" is fine or an emergency.
 *
 * PAST THE CAP A ROW SITS AT THE END AND SAYS SO. A name bought until 2028
 * pushes a raw axis past six hundred days and collapses the fortnight and the
 * month — the two windows the chart exists to show — onto the origin.
 *
 * A DATE THAT HAS PASSED IS DRAWN AT ZERO, in the crit colour, with the word
 * rather than a minus sign: "-2d" skims as "2 days" and it is the opposite.
 */
export function Runway({
  rows,
  thresholds,
  cap,
  caption,
}: {
  rows: RunwayRow[];
  thresholds: { warn: number; crit: number };
  cap: number;
  /** What is NOT drawn, when the list was trimmed to fit. */
  caption?: string;
}) {
  const [host, w] = useMeasuredWidth<HTMLDivElement>();
  const { tip, show, hide } = useTip();
  const [hot, setHot] = useState<string | null>(null);

  // Never below the warn line — a list where everything renews next week must
  // still show the week as a distance rather than as the whole axis.
  const furthest = Math.min(
    Math.max(thresholds.warn * 1.5, ...rows.map((r) => r.days)),
    cap,
  );
  const top = niceCeiling(furthest);
  const pos = (d: number) => (Math.max(0, Math.min(d, top)) / top) * 100;
  const toneOfDays = (d: number): StatusTone =>
    d <= thresholds.crit ? "bad" : d <= thresholds.warn ? "warn" : "ok";

  /**
   * The countdown as a phrase. Written once and used by both the tooltip and
   * the read-aloud label, so the two can never drift apart — and past the
   * deadline it says the WORD rather than a negative number, because "-2 days
   * left" is a sentence nobody parses on the way past.
   */
  const countdown = (r: RunwayRow) =>
    r.days < 0
      ? `lapsed ${Math.abs(r.days)} day${r.days === -1 ? "" : "s"} ago`
      : r.days === 0
        ? "expires today"
        : `${r.days} day${r.days === 1 ? "" : "s"} left`;

  const said = (r: RunwayRow) =>
    [countdown(r), r.at ? `expires ${dateLong(r.at)}` : null, r.sub]
      .filter(Boolean)
      .join(" · ");

  return (
    <div ref={host} className="relative mt-1">
      <div className="flex flex-col gap-1" role="list">
        {rows.map((r) => {
          const tone = toneOfDays(r.days);
          const color = TONE_COLOR[tone];
          const x = pos(r.days);
          return (
            <div
              key={r.label}
              role="listitem"
              aria-label={`${r.label} — ${said(r)}`}
              className={cn(
                "-mx-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-[12.5px] transition-colors",
                hot === r.label && "bg-muted/60",
              )}
              onPointerEnter={(e) => {
                const hostBox = host.current?.getBoundingClientRect();
                // The track rather than the row: the tooltip points at the DOT,
                // which is the mark carrying the reading, and the dot's pixel
                // position is a percentage of a box only the DOM knows the
                // width of. Reading it here rather than duplicating the row's
                // flex arithmetic means the two cannot disagree.
                const track = e.currentTarget.querySelector<HTMLElement>(
                  "[data-runway-track]",
                );
                if (!hostBox || !track) return;
                const box = track.getBoundingClientRect();
                setHot(r.label);
                const y = box.top - hostBox.top + box.height / 2;
                show({
                  x: box.left - hostBox.left + (box.width * x) / 100,
                  y,
                  // The top two rows flip under the dot: a tooltip above them
                  // clears the top of the card and lands in the gutter between
                  // widgets. Lower down it goes over the rows above, which the
                  // hovered row's own highlight keeps unambiguous.
                  below: y < 34,
                  title: r.label,
                  rows: (
                    <>
                      <div>
                        <b className="text-background font-medium tabular-nums">
                          {countdown(r)}
                        </b>
                        {/* The date the countdown is TO. It is the fact the
                            row cannot show and the one you need before you can
                            do anything about it. */}
                        {r.at ? ` · ${dateLong(r.at)}` : ""}
                      </div>
                      {r.sub && <div>{r.sub}</div>}
                    </>
                  ),
                });
              }}
              onPointerLeave={() => {
                setHot(null);
                hide();
              }}
            >
              <span className="w-[34%] max-w-[168px] shrink-0 truncate">
                {r.label}
              </span>

              <div data-runway-track className="relative h-3.5 min-w-0 flex-1">
                {/* The two lines every dot is judged against. */}
                {[thresholds.crit, thresholds.warn].map((t) => (
                  <span
                    key={t}
                    aria-hidden="true"
                    className="absolute inset-y-0 w-px"
                    style={{
                      left: `${pos(t)}%`,
                      background: `color-mix(in srgb, ${TONE_COLOR[t === thresholds.crit ? "bad" : "warn"]} 55%, transparent)`,
                    }}
                  />
                ))}
                {/* The time left, as a length. */}
                <span
                  className="absolute top-1/2 h-px -translate-y-1/2"
                  style={{
                    left: 0,
                    width: `${x}%`,
                    background: color,
                    opacity: hot === r.label ? 0.75 : 0.4,
                  }}
                />
                <span
                  className="absolute top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height]"
                  style={{
                    left: `${x}%`,
                    background: color,
                    // The card-coloured ring is the spacer that keeps the dot
                    // legible where it lands on its own bar. It grows on hover
                    // rather than changing colour, because the colour is the
                    // reading and must not move for a pointer.
                    boxShadow: "0 0 0 2px var(--card)",
                    width: hot === r.label ? 9 : 7,
                    height: hot === r.label ? 9 : 7,
                  }}
                />
              </div>

              <span className="text-muted-foreground w-[52px] shrink-0 text-right tabular-nums">
                {r.days < 0
                  ? "lapsed"
                  : r.days > top
                    ? `${top}+d`
                    : `${r.days}d`}
              </span>
            </div>
          );
        })}
      </div>

      {/* The axis, said once under the rows it applies to. */}
      <div className="text-muted-foreground mt-1.5 flex items-center gap-3 text-[11.5px] tabular-nums">
        <span>today</span>
        <span className="flex items-center gap-1">
          <i
            className="size-1.5 rounded-full"
            style={{ background: TONE_COLOR.bad }}
          />
          {thresholds.crit}d
        </span>
        <span className="flex items-center gap-1">
          <i
            className="size-1.5 rounded-full"
            style={{ background: TONE_COLOR.warn }}
          />
          {thresholds.warn}d
        </span>
        <span className="ml-auto">{top}d</span>
      </div>

      {caption && (
        <p className="text-muted-foreground mt-1.5 text-[12px] leading-snug">
          {caption}
        </p>
      )}

      <ChartTip tip={tip} width={w} />
    </div>
  );
}

/**
 * The next round number at or above n. An axis that ends at 322 is an axis
 * nobody can read a position off.
 *
 * The step list is finer than the usual 1/2/5 because this axis is in DAYS and
 * a coarse one wastes the plot: 322 rounded up the coarse way is 500, which
 * spends a third of the width on time no row occupies.
 */
function niceCeiling(n: number): number {
  if (n <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * power;
    if (candidate >= n) return Math.round(candidate);
  }
  return Math.round(10 * power);
}
