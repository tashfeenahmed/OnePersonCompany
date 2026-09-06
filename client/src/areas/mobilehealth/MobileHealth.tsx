import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Loader2, RefreshCw, Send } from "lucide-react";
import { SubTabs } from "@/components/TabStrip";
import { PageShell } from "@/components/PageShell";
import { RankedBars, type RankedRow } from "@/components/RankedBars";
import { Button } from "@/components/ui/button";
import { Failed, Loading, Num, Rules, SectionCard } from "@/components/ui/state";
import { WindowPicker } from "@/components/WindowPicker";
import { useApi } from "@/hooks/useApi";
import { pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  mobileHealthApi,
  type Conversion,
  type Readiness,
  type Retention,
  type ReviewTrend,
  type Reviews,
  type Segments,
  type Stability,
  type Versions,
} from "./api";

/**
 * MOBILE HEALTH — the four tabs, and what each is forbidden to do.
 *
 * WHY IT SITS BESIDE ASO RATHER THAN REPLACING ANYTHING. /api/mobile has the
 * money and the headline units and is drawn on the dashboard's widgets; this
 * is the half that says which segments acquire, which release crashes, what
 * the reviews say and where each version is. Both are live at once and the
 * page never adds a figure from one to a figure from the other.
 *
 * THE RULES THIS PAGE MAY NEVER BREAK, and each is a way to draw a confident
 * lie out of an honest document:
 *
 *   * NEVER DRAW A NULL AS A ZERO. A retention curve that was not collected, a
 *     crash rate no report answered, a rating nobody gave — all of them are
 *     "—" with the server's own reason printed beside them, never an empty bar
 *     that reads as good news.
 *   * NEVER PUT TWO UNITS ON ONE AXIS. Every series prints its unit and its
 *     kind. Devices, users and events are three counts in one Play file, and a
 *     crash COUNT and a crash RATE are two measurements of two different
 *     things.
 *   * NEVER SUM A LEVEL. Active devices and average ratings are marked `level`
 *     by the server and the page prints the newest reading rather than a total
 *     of thirty days of the same phone.
 *   * NEVER OFFER A REPLY. Answering a review happens in the store's own
 *     console; the only write here files a board card carrying the review ids.
 */

const TABS = [
  { key: "health", label: "Health" },
  { key: "reviews", label: "Reviews" },
  { key: "acquisition", label: "Acquisition" },
  { key: "versions", label: "Versions" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * THE TAB AND THE WINDOW LIVE IN THE QUERY STRING, so every view of this page
 * is a link somebody can send — the same decision the Growth page made, for
 * the same reason: "the reviews tab over sixty days" is a thing to point at,
 * and a page whose state is only in React has no address for it.
 */
export function MobileHealth() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "health") as TabKey;
  const days = Math.min(Math.max(Number(params.get("days") ?? 30) || 30, 1), 60);
  const set = (next: { tab?: TabKey; days?: number }) => {
    const t = next.tab ?? tab;
    const d = next.days ?? days;
    const out: Record<string, string> = {};
    if (t !== "health") out.tab = t;
    if (d !== 30) out.days = String(d);
    setParams(out);
  };

  return (
    <PageShell
      title="Mobile health"
      wide
      sub="What the apps do, beside what they earn: which segments install and stay, which release crashes, what the reviews say, and where each version is. Nothing here is added across the two stores — Google counts devices, Apple counts privacy-thresholded events."
      action={<CollectButton />}
    >
      <div className="border-line-soft mb-5 flex flex-wrap items-center gap-1 border-b pb-2">
        <SubTabs
          tabs={TABS}
          activeKey={tab}
          onSelect={(k) => set({ tab: k as TabKey })}
          className="mb-0"
        />
        <WindowPicker
          value={days}
          onChange={(d) => set({ days: Number(d) })}
          options={[7, 14, 30, 60]}
          label="Window in days"
          className="ml-auto"
        />
      </div>

      {tab === "health" && <HealthTab days={days} />}
      {tab === "reviews" && <ReviewsTab days={days} />}
      {tab === "acquisition" && <AcquisitionTab days={days} />}
      {tab === "versions" && <VersionsTab days={days} />}
    </PageShell>
  );
}

/* ------------------------------------------------------------ small parts */

/**
 * A slice bar over the shared ranked list.
 *
 * THE REMAINDER IS A ROW THE SERVER COMPUTED, not `total` minus what is drawn.
 * `other` is null for a LEVEL metric, where slices are states on a day and
 * subtracting them from the total would invent a figure; so the caller passes
 * the row it was given and this never derives one.
 *
 * Amounts keep two decimal places because a Play export's "amount" is not
 * always a count — some series are averages — and rounding one to an integer
 * here would be this file deciding what the store measured.
 */
function Bars({ rows, total }: { rows: RankedRow[]; total: number }) {
  return (
    <RankedBars
      rows={rows}
      total={total}
      format={(n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })}
    />
  );
}

function CollectButton() {
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-muted-foreground max-w-[420px] truncate text-[12.5px]">{note}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={state === "running"}
        onClick={() => {
          setState("running");
          setNote(null);
          mobileHealthApi
            .collect()
            .then((r) => {
              setState("done");
              setNote(r.note);
            })
            .catch((e: unknown) => {
              setState("failed");
              setNote(e instanceof Error ? e.message : String(e));
            });
        }}
      >
        {state === "running" ? (
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} />
        ) : state === "done" ? (
          <Check className="size-3.5" strokeWidth={1.6} />
        ) : (
          <RefreshCw className="size-3.5" strokeWidth={1.6} />
        )}
        Collect
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------- health tab */

function HealthTab({ days }: { days: number }) {
  const stability = useApi<Stability>(() => mobileHealthApi.stability({ days }), [days]);
  const readiness = useApi<Readiness>(() => mobileHealthApi.readiness(), []);

  return (
    <>
      {stability.loading && <Loading what="crash and ANR figures" />}
      {stability.error && <Failed error={stability.error} />}
      {stability.data && (
        <>
          <SectionCard
            title="Crash rates"
            meta={`weighted by the distinct users each day had · the vitals window ends at the metric set's own freshness, not today`}
          >
            {stability.data.rates.length === 0 ? (
              <p className="text-muted-foreground text-[13.5px]">
                No crash or ANR RATE was measured. That is not a rate of zero — see the readiness
                table below for which report said what.
              </p>
            ) : (
              <table className="w-full text-[13.5px]">
                <thead className="text-muted-foreground text-[12.5px]">
                  <tr className="border-line-soft border-b">
                    <th className="py-1 text-left font-normal">app</th>
                    <th className="py-1 text-left font-normal">metric</th>
                    <th className="py-1 text-right font-normal">window rate</th>
                    <th className="py-1 text-right font-normal">days</th>
                  </tr>
                </thead>
                <tbody>
                  {stability.data.rates.map((r) => (
                    <tr key={`${r.app}-${r.metric}`} className="border-line-soft border-b last:border-0">
                      <td className="py-1.5">{r.app}</td>
                      <td className="py-1.5">{r.metric}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {r.window === null ? "—" : `${pct(r.window, { digits: 3 })} of users`}
                      </td>
                      <td className="text-muted-foreground py-1.5 text-right tabular-nums">
                        {r.days.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard
            title="Crash and ANR counts"
            meta="from the console's own export — counts with no denominator, never a rate"
          >
            {stability.data.counts.length === 0 ? (
              <p className="text-muted-foreground text-[13.5px]">
                No crash COUNT report answered in this window.
              </p>
            ) : (
              <div className="space-y-4">
                {stability.data.counts.map((s) => (
                  <div key={`${s.store}-${s.app}-${s.source}-${s.metric}`}>
                    <p className="mb-1 text-[13.5px]">
                      <span className="font-medium">{s.app}</span>{" "}
                      <span className="text-muted-foreground">
                        {s.metric} · {s.source} · <Num value={s.total} /> {s.unit}
                      </span>
                    </p>
                    {s.byVersion.length > 0 && (
                      <Bars
                        rows={s.byVersion.slice(0, 8).map((v) => ({
                          label: `version ${v.version}`,
                          value: v.amount,
                        }))}
                        total={s.total}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            <Rules rules={stability.data.rules} />
          </SectionCard>
        </>
      )}

      {readiness.data && (
        <SectionCard
          title="What was asked for, and what each store said"
          meta="a report that is absent, processing or refused produces a null above — never a zero"
        >
          <div className="mb-3 flex flex-wrap gap-2">
            {readiness.data.probes.map((p) => (
              <span
                key={`${p.store}-${p.accountId}-${p.probe}`}
                className={cn(
                  "rounded border px-2 py-1 text-[12.5px]",
                  p.ok ? "border-line-soft" : "text-destructive border-destructive/40",
                )}
                title={p.error ?? undefined}
              >
                {p.probe} {p.ok ? "ok" : "refused"}
              </span>
            ))}
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="text-muted-foreground text-[12.5px]">
                <tr className="border-line-soft border-b">
                  <th className="py-1 text-left font-normal">app</th>
                  <th className="py-1 text-left font-normal">report</th>
                  <th className="py-1 text-left font-normal">state</th>
                  <th className="py-1 text-right font-normal">rows</th>
                </tr>
              </thead>
              <tbody>
                {readiness.data.reports.map((r) => (
                  <tr key={`${r.store}-${r.app}-${r.report}`} className="border-line-soft border-b last:border-0">
                    <td className="py-1 pr-2">{r.app}</td>
                    <td className="py-1 pr-2">{r.report}</td>
                    <td className="py-1 pr-2">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[12px]",
                          r.state === "present" || r.state === "available"
                            ? "bg-ok/20"
                            : r.state === "unauthorized" || r.state === "error"
                              ? "bg-destructive/20"
                              : "bg-warn/20",
                        )}
                        title={r.detail ?? undefined}
                      >
                        {r.state}
                      </span>
                    </td>
                    <td className="text-muted-foreground py-1 text-right tabular-nums">
                      <Num value={r.rows} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-3 text-[12.5px]">{readiness.data.note}</p>
        </SectionCard>
      )}
    </>
  );
}

/* ------------------------------------------------------------ reviews tab */

function ReviewsTab({ days }: { days: number }) {
  const [minRating, setMinRating] = useState<number | undefined>(undefined);
  const [picked, setPicked] = useState<string[]>([]);
  const [filing, setFiling] = useState<string | null>(null);
  const reviews = useApi<Reviews>(
    () => mobileHealthApi.reviews({ days, minRating, maxRating: minRating === undefined ? undefined : minRating }),
    [days, minRating],
  );
  /* The star filter is deliberately NOT a dependency here: the themes are a
     reading of what people said, and re-asking for them every time somebody
     narrows to one-star reviews would be a different question each click. The
     server caches by the exact set of review ids, so this costs a model call
     only when a new review has arrived. */
  const trend = useApi<ReviewTrend>(() => mobileHealthApi.trend({ days }), [days]);

  return (
    <>
      {reviews.loading && <Loading what="reviews" />}
      {reviews.error && <Failed error={reviews.error} />}
      {reviews.data && (
        <>
          <SectionCard
            title="Stars"
            meta={`${reviews.data.inWindow} review(s) in the window · average ${
              reviews.data.average === null ? "not rated" : reviews.data.average
            }`}
          >
            <Bars
              rows={[5, 4, 3, 2, 1].map((s) => ({
                label: `${s} star`,
                value: reviews.data!.stars[String(s)] ?? 0,
              }))}
              total={Object.values(reviews.data.stars).reduce((n, v) => n + v, 0)}
            />
            {reviews.data.byVersion.length > 0 && (
              <div className="mt-4">
                <p className="text-muted-foreground mb-1 text-[12.5px]">
                  by app version — Android only, because Apple's review resource carries no version
                </p>
                <table className="text-[13.5px]">
                  <tbody>
                    {reviews.data.byVersion.map((v) => (
                      <tr key={v.version}>
                        <td className="pr-4 py-0.5">{v.version}</td>
                        <td className="pr-4 py-0.5 tabular-nums">{v.average}★</td>
                        <td className="text-muted-foreground py-0.5 tabular-nums">{v.reviews}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!reviews.data.aggregatesComplete && (
              <p className="text-warn mt-3 text-[12.5px]">
                These figures cover the newest {reviews.data.aggregateCap} reviews in the window
                only — they are a floor, not a total.
              </p>
            )}
            {reviews.data.window.clampedFrom !== null && (
              <p className="text-muted-foreground mt-3 text-[12.5px]">
                Asked for {reviews.data.window.clampedFrom} days; answered over{" "}
                {reviews.data.window.days}, which is as far back as this area ingests.
              </p>
            )}
            <p className="text-muted-foreground mt-4 text-[12.5px]">{reviews.data.basis.play}</p>
            <p className="text-muted-foreground mt-1 text-[12.5px]">{reviews.data.basis.appstore}</p>
          </SectionCard>

          <SectionCard
            title="What they are about"
            meta={
              trend.data
                ? `a model's reading of ${trend.data.read} review(s) with text${
                    trend.data.model ? ` · ${trend.data.model}` : ""
                  }${trend.data.cached ? " · cached" : ""}`
                : "a model's reading of the recent texts"
            }
          >
            {trend.loading && <Loading what="themes" />}
            {trend.error && <Failed error={trend.error} />}
            {trend.data && trend.data.themes.length === 0 && (
              <p className="text-muted-foreground text-[13.5px]">
                {trend.data.themeNote ?? "No theme was published."}
              </p>
            )}
            {/* EVERY THEME SHOWS THE REVIEWS IT CAME FROM. A theme with no
                citation is dropped by the server; printing the ids here is
                what lets a reader check the claim rather than take it. */}
            <ul className="space-y-2">
              {(trend.data?.themes ?? []).map((t) => (
                <li key={t.theme} className="text-[13.5px]">
                  <span className="font-medium">{t.theme}</span>{" "}
                  <span className="text-muted-foreground">{t.sentiment}</span>
                  <span className="text-muted-foreground block text-[12.5px]">
                    from {t.reviewIds.length} review(s): {t.reviewIds.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-3 text-[12.5px]">
              A model's reading, not a measurement. Every theme cites the reviews it came from and
              an id the model invented is dropped before it is shown.
            </p>
          </SectionCard>

          <SectionCard title="The reviews" meta="replying happens in the store's own console — this box cannot">
            <div className="mb-3 flex flex-wrap items-center gap-1">
              {[undefined, 1, 2, 3, 4, 5].map((s) => (
                <button
                  key={String(s)}
                  type="button"
                  onClick={() => setMinRating(s)}
                  className={cn(
                    "rounded border px-2 py-0.5 text-[12.5px]",
                    minRating === s ? "bg-accent" : "border-line-soft text-muted-foreground",
                  )}
                >
                  {s === undefined ? "all" : `${s}★`}
                </button>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={!picked.length}
                onClick={() => {
                  setFiling("filing…");
                  mobileHealthApi
                    .sendToBoard(picked)
                    .then((r) => {
                      setFiling(
                        `filed ${r.filed.length} onto card ${r.cardId}` +
                          (r.alreadyFiled.length
                            ? ` · ${r.alreadyFiled.length} left on card(s) ${[
                                ...new Set(r.alreadyFiled.map((a) => a.cardId)),
                              ].join(", ")}`
                            : ""),
                      );
                      setPicked([]);
                      reviews.reload();
                    })
                    .catch((e: unknown) => setFiling(e instanceof Error ? e.message : String(e)));
                }}
              >
                <Send className="size-3.5" strokeWidth={1.6} /> Send {picked.length || ""} to board
              </Button>
            </div>
            {filing && <p className="text-muted-foreground mb-2 text-[12.5px]">{filing}</p>}
            {reviews.data.reviews.length === 0 ? (
              <p className="text-muted-foreground text-[13.5px]">
                No review matches. On the Android side that is the seven-day API window, not the
                app's review count.
              </p>
            ) : (
              <ul className="space-y-3">
                {reviews.data.reviews.map((r) => (
                  <li key={`${r.store}-${r.id}`} className="border-line-soft border-b pb-3 last:border-0">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.includes(r.id)}
                        onChange={(e) =>
                          setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-muted-foreground flex flex-wrap gap-2 text-[12.5px]">
                          <span>{r.rating === null ? "no star" : `${r.rating}★`}</span>
                          <span>{r.store}</span>
                          <span>{r.app}</span>
                          {r.appVersion && <span>v{r.appVersion}</span>}
                          {r.territory && <span>{r.territory}</span>}
                          {r.created && <span>{r.created.slice(0, 10)}</span>}
                          {r.filed && <span className="text-ok">on the board</span>}
                        </span>
                        {r.title && <span className="block text-[14px] font-medium">{r.title}</span>}
                        <span className="block text-[14px]">{r.body ?? "(no text)"}</span>
                        {r.author && (
                          <span className="text-muted-foreground block text-[12.5px]">— {r.author}</span>
                        )}
                        {r.reply && (
                          <span className="text-muted-foreground mt-1 block text-[12.5px]">
                            already answered in the console: {r.reply}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <Rules rules={reviews.data.rules} />
          </SectionCard>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------- acquisition tab */

function AcquisitionTab({ days }: { days: number }) {
  const [dimension, setDimension] = useState("country");
  const segments = useApi<Segments>(
    () => mobileHealthApi.segments({ days, dimension, limit: 10 }),
    [days, dimension],
  );
  const conversion = useApi<Conversion>(() => mobileHealthApi.conversion({ days }), [days]);
  const retention = useApi<Retention>(() => mobileHealthApi.retention({ days }), [days]);

  const dimensions = [...new Set((segments.data?.available ?? []).map((a) => a.dimension))]
    .filter((d) => d !== "(all)")
    .sort();

  return (
    <>
      {conversion.data && (
        <SectionCard
          title="Listing conversion"
          meta={`${conversion.data.source}${
            conversion.data.totalsFrom ? ` · totals from the ${conversion.data.totalsFrom} cut` : ""
          }`}
        >
          {!conversion.data.measured ? (
            <p className="text-muted-foreground text-[13.5px]">{conversion.data.reason}</p>
          ) : (
            <>
              <table className="w-full text-[13.5px]">
                <thead className="text-muted-foreground text-[12.5px]">
                  <tr className="border-line-soft border-b">
                    <th className="py-1 text-left font-normal">app</th>
                    <th className="py-1 text-right font-normal">store visitors</th>
                    <th className="py-1 text-right font-normal">acquisitions</th>
                    <th className="py-1 text-right font-normal">conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {conversion.data.apps.map((a) => (
                    <tr key={a.app} className="border-line-soft border-b last:border-0">
                      <td className="py-1.5">{a.app}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        <Num value={a.visitors} />
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        <Num value={a.acquisitions} />
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {pct(a.rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {Object.entries(conversion.data.by).map(([dim, rows]) => (
                <div key={dim} className="mt-4">
                  <p className="text-muted-foreground mb-1 text-[12.5px]">
                    by {dim} — {dim === conversion.data!.totalsFrom ? "the cut the totals above come from" : "a different cut of the SAME visitors"}, never added to the others
                  </p>
                  <Bars
                    rows={rows.slice(0, 8).map((r) => ({
                      label: `${r.value} · ${pct(r.rate, { digits: 0 })}`,
                      value: r.visitors ?? 0,
                    }))}
                    total={rows.reduce((n, r) => n + (r.visitors ?? 0), 0)}
                  />
                </div>
              ))}
            </>
          )}
          <Rules rules={conversion.data.rules} />
        </SectionCard>
      )}

      <SectionCard title="Segments" meta={`ranked over ${days} days, with the remainder named`}>
        <div className="mb-3 flex flex-wrap gap-1">
          {dimensions.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDimension(d)}
              className={cn(
                "rounded border px-2 py-0.5 text-[12.5px]",
                dimension === d ? "bg-accent" : "border-line-soft text-muted-foreground",
              )}
            >
              {d}
            </button>
          ))}
        </div>
        {segments.loading && <Loading what="segments" />}
        {segments.error && <Failed error={segments.error} />}
        {segments.data && segments.data.groups.length === 0 && (
          <p className="text-muted-foreground text-[13.5px]">
            Nothing was ingested for that dimension. The readiness table on the Health tab says why.
          </p>
        )}
        <div className="space-y-5">
          {(segments.data?.groups ?? [])
            .filter((g) => g.top.length)
            .slice(0, 12)
            .map((g) => (
              <div key={`${g.store}-${g.app}-${g.dimension}-${g.metric}`}>
                <p className="mb-1 text-[13.5px]">
                  <span className="font-medium">{g.app}</span>{" "}
                  <span className="text-muted-foreground">
                    {g.metric} · {g.store} · <Num value={g.total} /> {g.unit} ·{" "}
                    <span title={g.metricKind === "level" ? "a state on a day — never summed over days" : "an event — summable"}>
                      {g.metricKind}
                    </span>{" "}
                    · {g.slices} slice(s)
                  </span>
                </p>
                <Bars
                  rows={[
                    ...g.top.map((s) => ({ label: s.value, value: s.amount })),
                    ...(g.other ? [{ label: "(other slices)", value: g.other }] : []),
                  ]}
                  total={g.total}
                />
              </div>
            ))}
        </div>
        {segments.data && <Rules rules={segments.data.rules} />}
      </SectionCard>

      {retention.data && (
        <SectionCard title="Retention" meta={retention.data.source}>
          {!retention.data.measured ? (
            <p className="text-muted-foreground text-[13.5px]">{retention.data.reason}</p>
          ) : (
            retention.data.apps.map((a) => (
              <div key={a.app} className="mb-3">
                <p className="mb-1 text-[13.5px] font-medium">{a.app}</p>
                <Bars
                  rows={a.curve.map((p) => ({
                    label: `day ${p.day} · ${pct(p.rate, { digits: 0 })}`,
                    value: p.retained,
                  }))}
                  total={a.curve[0]?.installers ?? 0}
                />
              </div>
            ))
          )}
        </SectionCard>
      )}
    </>
  );
}

/* ----------------------------------------------------------- versions tab */

function VersionsTab({ days }: { days: number }) {
  const versions = useApi<Versions>(() => mobileHealthApi.versions({ days }), [days]);

  return (
    <>
      {versions.loading && <Loading what="version history" />}
      {versions.error && <Failed error={versions.error} />}
      {versions.data && (
        <SectionCard
          title="Version states"
          meta="observed once per collection — Apple publishes no change dates, so a gap is a day nobody looked"
        >
          {!versions.data.measured ? (
            <p className="text-muted-foreground text-[13.5px]">
              Nothing has been observed yet. Press Collect.
            </p>
          ) : (
            versions.data.apps.map((a) => (
              <div key={a.app} className="mb-4">
                <p className="mb-1 text-[13.5px] font-medium">{a.app}</p>
                <table className="w-full text-[13px]">
                  <thead className="text-muted-foreground text-[12.5px]">
                    <tr className="border-line-soft border-b">
                      <th className="py-1 text-left font-normal">version</th>
                      <th className="py-1 text-left font-normal">phase</th>
                      <th className="py-1 text-left font-normal">Apple's own state</th>
                      <th className="py-1 text-left font-normal">created</th>
                      <th className="py-1 text-right font-normal">days seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.versions.map((v) => (
                      <tr key={v.version} className="border-line-soft border-b last:border-0">
                        <td className="py-1 pr-2">{v.version}</td>
                        <td className="py-1 pr-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[12px]",
                              v.phase === "live"
                                ? "bg-ok/20"
                                : v.phase === "rejected"
                                  ? "bg-destructive/20"
                                  : "bg-warn/20",
                            )}
                          >
                            {v.phase}
                          </span>
                        </td>
                        <td className="text-muted-foreground py-1 pr-2">
                          {v.state ?? "—"}
                          {v.storeState && v.storeState !== v.state ? ` / ${v.storeState}` : ""}
                        </td>
                        <td className="text-muted-foreground py-1 pr-2">{v.created ?? "—"}</td>
                        <td className="text-muted-foreground py-1 text-right tabular-nums">
                          {v.daysObserved}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
          <Rules rules={versions.data.rules} />
        </SectionCard>
      )}
    </>
  );
}
