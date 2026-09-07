import { measuredWidget } from "@/lib/widgetView";
import { Trash2, UnfoldHorizontal } from "lucide-react";
import { BrandTile } from "@/components/BrandTile";
import {
  Bars,
  Chart,
  Figures,
  MeterRow,
  Runway,
  Sparkline,
} from "@/components/charts";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BRAND_ICONS } from "@/data/brandIcons";
import { ModelMark } from "@/components/ModelMark";
import { SOURCES, WIDGETS, type Widget } from "@/data/widgets";
import type { PlacedWidget } from "@/lib/store";
import { collectedAt, deltaOver, useLive } from "@/lib/live";
import { LIVE_BUILDERS } from "@/lib/liveWidgets";
import { isScopedWidget, useScope } from "@/lib/scope";

/**
 * ONE WIDGET, ON ONE CARD.
 *
 * This file is the shell and the switch: which source, which numbers, and
 * which of eight pictures. Every picture itself — and the pointer work that
 * makes it readable — lives in components/charts, because a renderer that has
 * to be scanned for "what does the runway kind draw" should not have three
 * hundred lines of SVG geometry between its branches.
 */
export function WidgetCard({
  placed,
  editing,
  onCycleWidth,
  onRemove,
  onMove,
  dragHandlers,
  dropSide,
  dragging,
}: {
  placed: PlacedWidget;
  editing: boolean;
  onCycleWidth: () => void;
  onRemove: () => void;
  onMove?: (direction: number) => void;
  /** The grab handle's attributes — a pointerdown and a data id, from BoardView. */
  dragHandlers?: React.HTMLAttributes<HTMLDivElement>;
  dropSide?: "before" | "after" | null;
  dragging?: boolean;
}) {
  const base = WIDGETS[placed.type];
  const all = useLive();
  /*
    INSIDE A VENTURE, THIS CARD IS ONE OF TWO KINDS.

    A SCOPED card draws numbers narrowed to the venture's hosts — the ones
    already in `useLive()`, which the scope provider has replaced. A
    PORTFOLIO-WIDE card draws a figure that cannot be split per site at all (a
    Hetzner bill, a Cloudflare daily line summed across zones), so it reads the
    unnarrowed document deliberately and wears a tag in its header saying so.
    Silently showing a portfolio number under a venture's name is the failure
    this pair exists to prevent; see lib/scope.ts for which cards are which.
  */
  const scope = useScope();
  const narrowed = !!scope && isScopedWidget(placed.type);
  const live = scope && !narrowed ? scope.base : all;
  if (!base) return null;
  const src = SOURCES[base.src];

  // Real numbers replace the sample ones in place, so the card's layout does
  // not change when a provider connects — only what it is showing.
  const isLive = live.liveTypes.has(placed.type);
  const points = base.live?.metric
    ? (live.metrics[base.live.metric] ?? [])
    : [];
  // Live values are merged OVER the catalog entry, so the sample definition
  // still supplies the name, the kind and the width — only the numbers change.
  const patch = isLive
    ? LIVE_BUILDERS[placed.type]?.({
        points,
        summary: live.hetzner,
        fleet: live.fleet,
        load: live.load,
        volumes: live.volumes,
        domains: live.domains,
        domainSummary: live.domainSummary,
        github: live.github,
        npm: live.npm,
        costs: live.costs,
        stock: live.stock,
        mobile: live.mobile,
        stripe: live.stripe,
        adsense: live.adsense,
        cloudflare: live.cloudflare,
        gsc: live.gsc,
        bing: live.bing,
        meta: live.meta,
        demand: live.demand,
        mail: live.mail,
        umami: live.umami,
        calendar: live.calendar,
        pypi: live.pypi,
        bluesky: live.bluesky,
        uptime: live.uptime,
        boxes: live.boxes,
        products: live.products,
        backlinks: live.backlinks,
        presence: live.presence,
        audit: live.audit,
        runs: live.runs,
        llm: live.llm,
        competitors: live.competitors,
      })
    : null;
  // Presentation metadata is reusable; sample data never enters a live card.
  const def: Widget = measuredWidget(base, patch);

  // "No change" and "not enough history to say" are different claims. A sample
  // widget with delta 0 means the first; a live one measured twice in an hour
  // means the second, and it should say nothing rather than imply a flat line.
  const trend = isLive ? (patch?.delta ?? deltaOver(points)) : null;

  // Positive is not always good: churn, spend and latency read the other way.
  const good = trend ? (def.invert ? trend < 0 : trend > 0) : null;

  /*
    A SCOPED CARD WITH NOTHING BEHIND IT SAYS SO, INSTEAD OF SHOWING A SAMPLE.

    On the global board a catalog sample is a placeholder for a provider that
    is not connected yet, and everybody reads it as one. Under a venture's name
    it is not a placeholder at all — it is "this venture had 60,912
    impressions", in the same typeface as the cards that measured something.
    So a narrowed card whose builder could not answer draws a sentence instead,
    and the sentence separates the two reasons: the provider measured the
    portfolio and none of it was this venture's, or the provider has never
    reported anything to narrow.
  */
  const report = Object.keys(base.live ?? {}).find(key => key !== "metric");
  const sourceKey = report ?? (base.live?.metric ? `metric:${base.live.metric}` : base.src);
  const sourceState = live.sourceStates[sourceKey];
  const unavailable = live.error ? `Server unavailable: ${live.error}`
    : sourceState === "error" ? `Could not refresh ${src.name}: ${live.sourceErrors[sourceKey] ?? "Try again."}`
    : sourceState === "disconnected" ? `Connect ${src.name} to see this metric.`
    : live.loading ? "Loading…" : `No measurements collected from ${src.name} yet.`;
  const empty =
    narrowed && !isLive && scope
      ? scope.base.liveTypes.has(placed.type)
        ? `Nothing for ${scope.label} in ${src.name}.`
        : `Nothing collected from ${src.name} yet, so there is nothing to narrow.`
      : !isLive ? unavailable : null;
  const brand = src.icon ? BRAND_ICONS[src.icon]?.hex : src.tint;

  return (
    <div
      {...dragHandlers}

      className={cn(
        placed.w === 4 ? "col-span-2 xl:col-span-4" : placed.w === 2 ? "col-span-2" : "col-span-1",
        "bg-card relative flex min-h-[116px] flex-col rounded-[14px] p-4.5 transition-colors",
        editing && "hover:border-line-strong cursor-grab touch-none select-none",
        dragging && "cursor-grabbing opacity-35",
        dropSide === "before" &&
          "before:bg-foreground before:absolute before:top-1.5 before:-left-1.5 before:bottom-1.5 before:w-0.5 before:rounded-sm before:content-['']",
        dropSide === "after" &&
          "after:bg-foreground after:absolute after:top-1.5 after:-right-1.5 after:bottom-1.5 after:w-0.5 after:rounded-sm after:content-['']",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <BrandTile
          icon={src.icon}
          name={src.name}
          mono={src.mono}
          tint={src.tint}
          className="size-5 rounded-md"
          glyphClassName="size-[11px] text-[10px]"
        />
        <span className="text-[12.5px]">{def.name}</span>
        {scope && !narrowed && (
          <span
            title={`This figure has no per-site breakdown, so it is the whole portfolio rather than ${scope.label}.`}
            className="text-muted-foreground shrink-0 rounded-[7px] border px-1 py-px text-[10.5px] leading-[1.35]"
          >
            portfolio
          </span>
        )}
        {isLive && (
          <span
            className="bg-ok size-1.5 shrink-0 rounded-full"
            title={`Live — ${describeCollected(collectedAt(base.src, live))}`}
          />
        )}

        {editing && (
          <div className="ml-auto flex gap-px">
            <button aria-label={`Move ${def.name} earlier`} className="p-1" onClick={() => onMove?.(-1)}>←</button>
            <button aria-label={`Move ${def.name} later`} className="p-1" onClick={() => onMove?.(1)}>→</button>
            <button
              title="Cycle width"
              onClick={(e) => {
                e.stopPropagation();
                onCycleWidth();
              }}
              className="text-muted-foreground hover:bg-accent hover:text-foreground grid place-items-center rounded-[9px] p-1"
            >
              <UnfoldHorizontal className="size-3.5" strokeWidth={1.6} />
            </button>
            <button
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="text-muted-foreground hover:bg-accent hover:text-foreground grid place-items-center rounded-[9px] p-1"
            >
              <Trash2 className="size-3.5" strokeWidth={1.6} />
            </button>
          </div>
        )}
      </div>

      <div
        className={cn(
          "pt-2.5",
          def.kind === "metric" || def.kind === "bars" ? "mt-auto" : "mt-2.5",
        )}
      >
        {empty && (
          <p className="text-muted-foreground text-[12.5px] leading-snug">
            {empty}
          </p>
        )}

        {!empty && def.kind === "metric" && (
          <>
            <div className="text-[28px] leading-tight font-normal tracking-[-0.03em] tabular-nums">
              {def.value}
            </div>
            {/*
              THE JUDGEMENT ON ITS OWN LINE, THE SENTENCE UNDER IT. "watch" and
              the subtitle used to share one flex row, and a long subtitle
              beside a tone word wrapped mid-phrase in the width a single tile
              has. The word is a verdict and the sentence is its reason; they
              read better as two lines than as one that breaks wherever it
              happens to run out of room.
            */}
            {(trend !== null || (def.tone && def.tone !== "ok")) && (
            <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[12.5px]">
              {trend !== null && trend !== 0 && (
                <span
                  className={cn(
                    "font-medium",
                    good ? "text-ok" : "text-destructive",
                  )}
                >
                  {trend > 0 ? "+" : ""}
                  {trend}
                  {isLive ||
                  (def.series &&
                    Math.abs(trend) >= 1 &&
                    !String(def.value).includes("%"))
                    ? "%"
                    : ""}
                </span>
              )}
              {trend === 0 && <span>no change</span>}
              {/* A judged figure carries the word as well as the colour, the
                  same reason the status dots are never alone. */}
              {def.tone && def.tone !== "ok" && (
                <span
                  className={cn(
                    "font-medium",
                    def.tone === "warn" ? "text-warn" : "text-destructive",
                  )}
                >
                  {def.tone === "bad" ? "act" : "watch"}
                </span>
              )}
            </div>
            )}
            {def.sub && (
              <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
                {def.sub}
              </div>
            )}
            {def.series && (
              <Sparkline
                series={def.series}
                at={def.seriesAt}
                unit={def.unit}
              />
            )}
          </>
        )}

        {!empty && def.kind === "bars" && def.bars && (
          <Bars
            values={def.bars}
            barLabels={def.barLabels}
            labels={def.labels}
            marks={def.marks}
            tint={brand}
          />
        )}

        {!empty && def.kind === "rows" && def.rows && (
          <div className="mt-2 flex flex-col gap-1.5">
            {def.rows.map(([k, v], i) => (
              <div key={k} className="flex items-baseline gap-2 text-[13px]">
                {def.marks?.[i] && <ModelMark name={def.marks[i]!} size={14} className="self-center" />}
                <span className="truncate">{k}</span>
                <span className="text-muted-foreground ml-auto text-[12.5px] whitespace-nowrap tabular-nums">
                  {v}
                </span>
              </div>
            ))}
          </div>
        )}

        {!empty && def.kind === "chart" && (
          <Chart
            series={def.chart ?? []}
            unit={def.unit ?? "percent"}
            caption={def.caption}
          />
        )}

        {!empty && def.kind === "meters" &&
          (def.meters?.length ? (
            <div className="mt-1 flex flex-col gap-1.5">
              {/* Tighter than the old gap-2.5 because the rows now carry
                  their own padding for the hover highlight: 2px + 6px + 2px
                  is the same ten pixels of air the column had before. */}
              {def.meters.map((m) => (
                <MeterRow key={m.label} meter={m} />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              No samples yet — the collector writes these the first time it runs.
            </p>
          ))}

        {!empty && def.kind === "runway" &&
          (def.runway?.length ? (
            <Runway
              rows={def.runway}
              thresholds={def.thresholds ?? { warn: 30, crit: 7 }}
              cap={def.cap ?? 400}
              caption={def.caption}
            />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              No dated renewals yet.
            </p>
          ))}

        {!empty && def.kind === "table" &&
          (def.table?.length ? (
            <Figures headers={def.headers ?? []} rows={def.table} marks={def.marks} />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              Nothing measured yet.
            </p>
          ))}

        {!empty && def.kind === "statuses" && def.statuses && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {def.statuses.map(([label, tone]) => (
              <span
                key={label}
                className="flex items-center gap-1.5 text-[12.5px]"
              >
                <i
                  className={cn(
                    "size-1.5 rounded-full",
                    tone === "ok" && "bg-ok",
                    tone === "warn" && "bg-warn",
                    tone === "bad" && "bg-destructive",
                  )}
                />
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A collection time in words, or the honest absence of one. */
function describeCollected(at: string | null): string {
  return at ? `collected ${ago(at)}` : "when this was collected is not reported";
}
