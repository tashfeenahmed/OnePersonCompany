import { measuredWidget } from "@/lib/widgetView";
import { Trash2, UnfoldHorizontal } from "lucide-react";
import { BrandTile } from "@/components/BrandTile";
import { useMemo } from "react";
import {
  Bars,
  Chart,
  Donut,
  Dumbbell,
  Feed,
  Figures,
  MeterRow,
  Profile,
  Proportion,
  Ranked,
  Runway,
  Sparkline,
  Waterfall,
} from "@/components/charts";
import { ago, splitMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BRAND_ICONS } from "@/data/brandIcons";
import { ModelMark } from "@/components/ModelMark";
import { SOURCES, WIDGETS, type Widget } from "@/data/widgets";
import { useStore, type PlacedWidget } from "@/lib/store";
import { collectedAt, deltaOver, useLive, type LiveData } from "@/lib/live";
import { LIVE_BUILDERS, type LiveInputs, type ProjectScope } from "@/lib/liveWidgets";
import { isScopedWidget, narrowLive, useScope } from "@/lib/scope";
import { hasPrevious, widgetName } from "@/lib/window";

/** Every document a builder reads, off one live context. The same list the
 *  fetch layer and the scope hand over; kept in one place here so a card
 *  narrowed to a venture and a card that is not are fed identically. */
function inputsOf(live: LiveData, points: LiveInputs["points"], extra: Pick<LiveInputs, "param" | "project">): LiveInputs {
  return {
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
    finance: live.finance,
    leakage: live.leakage,
    disputes: live.disputes,
    queue: live.queue,
    seo: live.seo,
    ads: live.ads,
    window: live.window,
    ...extra,
  };
}

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
  onSetParam,
  dragHandlers,
  dropSide,
  dragging,
}: {
  placed: PlacedWidget;
  editing: boolean;
  onCycleWidth: () => void;
  onRemove: () => void;
  onMove?: (direction: number) => void;
  /** A per-project card's venture, chosen from its header in edit mode.
   *  Undefined clears it back to "pick a venture". */
  onSetParam?: (param: string | undefined) => void;
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

  /*
    A PER-PROJECT CARD IS A THIRD KIND, and it is narrowed HERE rather than
    by the page: the venture is on the card (`PlacedWidget.param`), so the
    same rule a venture board runs — lib/scope's `narrowLive` over the
    venture's hosts — runs for this one card, from the PORTFOLIO document
    whichever page the card is on. Inside a venture board the page's own
    scope is set aside for it: a card that says "Example App 1" draws Example App 1
    even on FreeLLMAPI's board, because that is what it was placed to do.

    Narrowed once per venture and per refresh, not per render: the pass is
    a filter over every report the page holds.
  */
  const { state } = useStore();
  const perProject = !!base?.perProject;
  const venture = perProject && placed.param
    ? (state.ventures.find((v) => v.id === placed.param) ?? null)
    : null;
  const portfolio = scope ? scope.base : all;
  const projectLive = useMemo(
    () => (venture?.host ? narrowLive(portfolio, [venture.host]) : null),
    [portfolio, venture],
  );
  if (!base) return null;
  const src = SOURCES[base.src];
  const project: ProjectScope | null = venture
    ? { id: venture.id, name: venture.name, hosts: venture.host ? [venture.host] : [] }
    : null;

  const points = base.live?.metric
    ? (live.metrics[base.live.metric] ?? [])
    : [];
  // Live values are merged OVER the catalog entry, so the sample definition
  // still supplies the name, the kind and the width — only the numbers change.
  //
  // A PER-PROJECT CARD ASKS ITS BUILDER ITSELF. The context's `liveTypes`
  // was decided over the portfolio with no venture, which is exactly the
  // call a per-project builder declines, so the verdict is made here from
  // the narrowed document instead: live if the builder answered.
  const build = LIVE_BUILDERS[placed.type];
  const patch = perProject
    ? project && projectLive && build
      ? build(inputsOf(projectLive, points, { param: placed.param, project }))
      : null
    : live.liveTypes.has(placed.type) && build
      ? build(inputsOf(live, points, {}))
      : null;
  // Real numbers replace the sample ones in place, so the card's layout does
  // not change when a provider connects — only what it is showing.
  const isLive = perProject ? patch !== null : live.liveTypes.has(placed.type);
  // Presentation metadata is reusable; sample data never enters a live card.
  // THE NAME CARRIES THE PICKER'S WINDOW before the patch is laid over it, so
  // a builder that has to say a different span — churn under "all" is the
  // ninety-day row — can still name it; see lib/window.
  const def: Widget = measuredWidget({ ...base, name: widgetName(base, live.window) }, patch);
  /* THE VENTURE'S NAME GOES ON THE CARD HERE, after the builder has had its
     say, so "Search · 28d" reads "Search · 28d · Example App 1" whether the
     builder answered or declined — a card with nothing to draw still has to
     say whose nothing it is. */
  const title = venture ? `${def.name} · ${venture.name}` : def.name;

  // "No change" and "not enough history to say" are different claims. A sample
  // widget with delta 0 means the first; a live one measured twice in an hour
  // means the second, and it should say nothing rather than imply a flat line.
  // Over ALL TIME there is no previous window to have changed against, so a
  // live card says nothing there too — a dash rather than a zero.
  const trend = isLive && hasPrevious(live.window) ? (patch?.delta ?? deltaOver(points)) : null;

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
  /*
    A PER-PROJECT CARD HAS FOUR WAYS TO BE EMPTY, and they are four different
    sentences: no venture chosen yet, a venture that has since been deleted,
    a venture with no website to narrow to, and a venture the source has
    nothing for. The last is told apart from "the source has nothing at all"
    by whether the portfolio document is there — a builder declining over a
    narrowed document with the portfolio one present means this venture had
    no rows, which is a finding rather than a fault.
  */
  const hasPortfolioDoc = !!report && !!(portfolio as unknown as Record<string, unknown>)[report];
  const empty = perProject
    ? !placed.param
      ? "Pick a venture: edit the board and choose one in this card's header."
      : !venture
        ? "This card's venture is no longer in the workspace — pick another in edit mode."
        : !venture.host
          ? `${venture.name} has no website yet, so there is nothing to narrow to.`
          : isLive
            ? null
            : hasPortfolioDoc
              ? `Nothing for ${venture.name} (${venture.host}) in ${src.name}.`
              : unavailable
    : narrowed && !isLive && scope
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
        {/* NAME, TAG AND LIVE DOT STAY ON ONE LINE. The header wraps, and a
            one-column tile is narrow enough that a tag pushed the dot onto a
            line of its own under the name. The three are one group with the
            name the only thing allowed to give, so a long name truncates
            rather than the dot dropping. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[12.5px]">{title}</span>
          {/* WHAT KIND OF NUMBER, in a word — "measured", "est.", "metered".
              Only a builder sets one, so it is only ever on a live card; see
              Widget.tag. */}
          {/* Not beside the venture picker: in edit mode a per-project
              card's header holds the picker, and a tag as well left the
              name four letters long. The tag is for reading, not editing. */}
          {isLive && def.tag && !(editing && perProject) && (
            <span className="text-muted-foreground bg-muted shrink-0 rounded-[5px] px-1.5 py-px font-mono text-[10px] font-medium">
              {def.tag}
            </span>
          )}
          {isLive && (
            <span
              className="bg-ok size-1.5 shrink-0 rounded-full"
              title={`Live — ${describeCollected(collectedAt(base.src, live))}`}
            />
          )}
        </span>
        {scope && !narrowed && !perProject && (
          <span
            title={`This figure has no per-site breakdown, so it is the whole portfolio rather than ${scope.label}.`}
            className="text-muted-foreground shrink-0 rounded-[7px] border px-1 py-px text-[10.5px] leading-[1.35]"
          >
            portfolio
          </span>
        )}
        {/* THE VENTURE PICKER, in edit mode, on a per-project card. A select
            rather than a dialog because there are twenty ventures and one
            choice; it stops the pointer so the grab handle around it does
            not start a drag. */}
        {editing && perProject && (
          <select
            aria-label={`Venture for ${def.name}`}
            value={placed.param ?? ""}
            onChange={(e) => onSetParam?.(e.target.value || undefined)}
            onPointerDown={(e) => e.stopPropagation()}
            className="bg-muted text-foreground h-6 max-w-[124px] shrink-0 rounded-[7px] border-0 px-1.5 text-[11.5px]"
          >
            <option value="">Pick a venture…</option>
            {state.ventures.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
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
            {/* MONEY IS SET LARGER AND HEAVIER than any other figure — 36px
                semibold against 28px regular — the way the money pages
                headline a bill: a dollar amount on a cost board is the thing
                the card exists for, and it is read from across the room. A
                count, a duration or a percentage keeps the quieter size. */}
            <div
              className={cn(
                "leading-tight tracking-[-0.03em] tabular-nums",
                splitMoney(def.value ?? "")
                  ? "text-[36px] font-semibold tracking-[-0.035em]"
                  : "text-[28px] font-normal",
              )}
            >
              <Figure text={def.value ?? ""} />
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

        {!empty && def.kind === "donut" &&
          (def.slices?.length ? (
            <Donut slices={def.slices} center={def.center} caption={def.caption} />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">Nothing measured yet.</p>
          ))}

        {!empty && def.kind === "ranked" &&
          (def.ranked?.length ? (
            <Ranked rows={def.ranked} caption={def.caption} max={def.rankedMax} />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">Nothing measured yet.</p>
          ))}

        {!empty && def.kind === "dumbbell" &&
          (def.dumbbell?.length ? (
            <Dumbbell rows={def.dumbbell} names={def.names} log={def.log} caption={def.caption} />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">Nothing measured yet.</p>
          ))}

        {!empty && def.kind === "profile" &&
          (def.figures?.length ? (
            <Profile
              figures={def.figures}
              series={def.series}
              at={def.seriesAt}
              unit={def.unit}
              rows={def.rows}
              caption={def.caption}
            />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">Nothing measured yet.</p>
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

        {!empty && def.kind === "proportion" && (
          <>
            {/* The hero, when the builder gave one, at the metric's own
                sizes: a proportion tile IS a metric tile with the whole the
                figure divides drawn under it. */}
            {def.value && (
              <div
                className={cn(
                  "leading-tight tracking-[-0.03em] tabular-nums",
                  splitMoney(def.value)
                    ? "text-[36px] font-semibold tracking-[-0.035em]"
                    : "text-[28px] font-normal",
                )}
              >
                <Figure text={def.value} />
              </div>
            )}
            {def.tone && def.tone !== "ok" && (
              <div className={cn("mt-1 text-[12.5px] font-medium", def.tone === "warn" ? "text-warn" : "text-destructive")}>
                {def.tone === "bad" ? "act" : "watch"}
              </div>
            )}
            {def.sub && (
              <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">{def.sub}</div>
            )}
            {def.parts?.length ? (
              <Proportion parts={def.parts} label={def.partsLabel} />
            ) : (
              <p className="text-muted-foreground mt-2 text-[12.5px]">Nothing to divide yet.</p>
            )}
            {def.series && def.series.length > 1 && (
              <div className="mt-2.5">
                {def.seriesLabel && (
                  <p className="text-muted-foreground text-[11.5px] leading-snug">{def.seriesLabel}</p>
                )}
                <Sparkline series={def.series} at={def.seriesAt} unit={def.unit} />
              </div>
            )}
            {!!def.ranked?.length && (
              <div className="mt-2.5">
                <Ranked rows={def.ranked} />
              </div>
            )}
            {/* Two columns only on a card wide enough to hold them: a
                narrow tile folds a pair of columns into unreadable halves. */}
            {!!def.rows?.length && (
              <div className={cn("mt-3 grid gap-x-6 gap-y-1.5", placed.w === 4 && "sm:grid-cols-2")}>
                {def.rows.map(([k, v]) => (
                  <div key={k} className="flex items-baseline gap-2 text-[13px]">
                    <span className="truncate">{k}</span>
                    <span className="text-muted-foreground ml-auto text-[12.5px] whitespace-nowrap tabular-nums">{v}</span>
                  </div>
                ))}
              </div>
            )}
            {def.caption && (
              <p className="text-muted-foreground mt-2 text-[12px] leading-snug">{def.caption}</p>
            )}
          </>
        )}

        {!empty && def.kind === "waterfall" &&
          (def.steps?.length ? (
            <>
              <Waterfall steps={def.steps} />
              {!!def.rows?.length && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {def.rows.map(([k, v]) => (
                    <div key={k} className="flex items-baseline gap-2 text-[13px]">
                      <span className="truncate">{k}</span>
                      <span className="text-muted-foreground ml-auto text-[12.5px] whitespace-nowrap tabular-nums">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              {def.caption && (
                <p className="text-muted-foreground mt-2 text-[12px] leading-snug">{def.caption}</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">Nothing moved yet.</p>
          ))}

        {!empty && def.kind === "feed" &&
          (def.feed?.length ? (
            <Feed items={def.feed} caption={def.caption} />
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              {/* A builder that measured an EMPTY feed says what it found
                  ("nothing has run in this window") rather than the default. */}
              {def.caption ?? "Nothing published in this window."}
            </p>
          ))}

        {!empty && def.kind === "table" &&
          (def.table?.length ? (
            <>
              <Figures headers={def.headers ?? []} rows={def.table} marks={def.marks} tones={def.rowTones} />
              {def.caption && (
                <p className="text-muted-foreground mt-2 text-[12px] leading-snug">{def.caption}</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              {/* A builder that measured an EMPTY table says what it found
                  ("No charges in this window") rather than the default. */}
              {def.caption ?? "Nothing measured yet."}
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

/**
 * A tile's headline, with the cents a size down when it is money.
 *
 * The cost pages this board is modelled on set the dollars at full size and
 * the cents at about half, in the softer ink: the dollars are the message and
 * the cents are the audit trail, and at one size "US$1,015.36" reads as a
 * bigger number than it is. Anything `splitMoney` does not recognise — a
 * count, a duration, a percentage, a dash — is drawn exactly as it came.
 */
function Figure({ text }: { text: string }) {
  const parts = splitMoney(text);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.whole}
      <span className="text-muted-foreground text-[0.5em] font-medium">{parts.cents}</span>
    </>
  );
}

/** A collection time in words, or the honest absence of one. */
function describeCollected(at: string | null): string {
  return at ? `collected ${ago(at)}` : "when this was collected is not reported";
}
