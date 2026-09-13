import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { Bars } from "@/components/charts";
import { cn } from "@/lib/utils";
import { ago, count, day } from "@/lib/format";
import { activityApi, type ActivityEvent } from "@/lib/api/activity";

/**
 * THE FEED.
 *
 * ONE VISUAL DECISION RUNS THROUGH THIS WHOLE COMPONENT: an event whose
 * timestamp was DERIVED from a daily row must never be drawn as if somebody had
 * observed a clock time. Stripe's charge and ledger tables are one row per UTC
 * day, so a refund's time is the start of its day and nothing more — those rows
 * print the date and the word "day" where the exact ones print a time. Drawing
 * "00:00" would be the dashboard inventing a moment, which is the one thing the
 * feed exists to avoid.
 *
 * THE BARS COUNT EVENTS AND NOT MONEY. Four refunds is four bars' worth whether
 * they were four dollars or four thousand — a chart that scaled with currency
 * would be a revenue chart with the currencies added together.
 *
 * THE KIND CHIPS COME FROM WHAT IS ACTUALLY IN THE WINDOW, not from a fixed
 * list, so a box with no Stripe account does not offer a "refund" filter that
 * can only ever return nothing.
 */

const KIND_LABEL: Record<string, string> = {
  infrastructure: "Infrastructure",
  signup: "Signups",
  charge: "Payments",
  payment_failed: "Declines",
  refund: "Refunds",
  dispute: "Disputes",
  run: "Runs",
  card: "Cards done",
  push: "Pushes",
  alert: "Alerts",
};

/** Colour is reserved for something being judged, the same rule the charts
 *  keep. Only the three kinds that are money going the wrong way get a hue. */
const KIND_TONE: Record<string, string> = {
  payment_failed: "text-amber-500",
  refund: "text-amber-500",
  dispute: "text-destructive",
  alert: "text-destructive",
};

function when(e: ActivityEvent): string {
  const at = new Date(e.ts);
  const d = day(at);
  /* THE WHOLE POINT. An exact event gets a clock; a day-resolution one gets the
     date and the word, because there is no clock to print. */
  return e.exact
    ? `${d} ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : `${d} · day`;
}

export function Feed({ days, onlyKind }: { days: number; onlyKind?: string }) {
  const [kinds, setKinds] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const report = useApi(
    () => activityApi.activity({ days, kind: onlyKind || kinds.join(",") || undefined }),
    [days, onlyKind, kinds.join(",")],
  );
  const all = useApi(() => activityApi.activity({ days, kind: onlyKind, limit: 1 }), [days, onlyKind]);

  async function refresh() {
    setRefreshing(true);
    try {
      await activityApi.refreshActivity();
      report.reload();
      all.reload();
    } finally {
      setRefreshing(false);
    }
  }

  if (report.error)
    return <p className="text-muted-foreground text-[14px]">The API is not answering: {report.error}</p>;
  if (!report.data || !all.data)
    return <p className="text-muted-foreground text-[14px]">Reading the feed…</p>;

  const d = report.data;
  /* The chips are built from the UNFILTERED window, so choosing "refunds" does
     not make every other chip disappear and strand the reader. */
  const available = all.data.counts.byKind;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {available.map((k) => {
          const on = kinds.includes(k.kind);
          return (
            <button
              key={k.kind}
              type="button"
              onClick={() =>
                setKinds((was) => (on ? was.filter((x) => x !== k.kind) : [...was, k.kind]))
              }
              className={cn(
                "hover:bg-accent rounded-lg border px-2.5 py-1 text-[13px]",
                on && "bg-accent border-foreground/25 font-medium",
              )}
            >
              {KIND_LABEL[k.kind] ?? k.kind}
              <span className="text-muted-foreground ml-1.5 text-[12px] tabular-nums">{k.n}</span>
            </button>
          );
        })}
        {!!kinds.length && (
          <button
            type="button"
            onClick={() => setKinds([])}
            className="text-muted-foreground hover:text-foreground text-[13px] underline underline-offset-2"
          >
            clear
          </button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} strokeWidth={1.8} />
          {refreshing ? "Deriving…" : "Derive now"}
        </Button>
      </div>

      <div className="bg-card mb-4 rounded-[14px] px-4.5 py-3.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[20px] font-normal tracking-[-0.03em] tabular-nums">
            {count(d.counts.matching)}
          </span>
          <span className="text-muted-foreground text-[12.5px]">
            event{d.counts.matching === 1 ? "" : "s"} in {d.window.days} days
          </span>
          <span className="text-muted-foreground ml-auto text-[12.5px]">
            last derived {ago(d.coverage.lastPassAt)}
          </span>
        </div>
        <Bars
          values={d.counts.byDay.map((b) => b.n)}
          barLabels={d.counts.byDay.map(
            (b) =>
              `${b.day} — ${b.n} event${b.n === 1 ? "" : "s"}${
                Object.keys(b.kinds).length
                  ? `: ${Object.entries(b.kinds)
                      .map(([k, n]) => `${n} ${(KIND_LABEL[k] ?? k).toLowerCase()}`)
                      .join(", ")}`
                  : ""
              }`,
          )}
          labels={`Events per day. Counts of events, never of money — four refunds is four whether they were four dollars or four thousand.`}
        />
      </div>

      {!d.events.length && (
        <p className="text-muted-foreground text-[14px]">
          {d.coverage.lastPassAt
            ? "Nothing happened in this window that any of the six sources can date. That is an answer, not a gap."
            : "The derivation has not run yet. Press “Derive now”, or wait for the next collection."}
        </p>
      )}

      {!!d.events.length && (
        <div className="overflow-hidden rounded-[14px] bg-card">
          {d.events.map((e, i) => (
            <div
              key={e.key}
              className={cn("flex gap-3 px-3.5 py-2.5", i > 0 && "border-line-soft border-t")}
            >
              <span
                className={cn(
                  "text-muted-foreground w-[92px] shrink-0 pt-px text-[12.5px] tabular-nums",
                  !e.exact && "italic",
                )}
                title={
                  e.exact
                    ? "The source published this moment."
                    : "The source publishes a UTC day, not a moment. This is the start of that day and nobody observed a time."
                }
              >
                {when(e)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={cn("text-[14px]", KIND_TONE[e.kind])}>{e.title}</span>
                  {e.product && (
                    <span className="text-muted-foreground truncate font-mono text-[12px]">
                      {e.product}
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto shrink-0 text-[12px]">
                    {KIND_LABEL[e.kind] ?? e.kind}
                  </span>
                </div>
                {typeof e.detail.note === "string" && (
                  <p className="text-muted-foreground mt-0.5 text-[12.5px]">{e.detail.note}</p>
                )}
                {e.kind === "payment_failed" && typeof e.detail.blocked === "number" && (
                  <p className="text-muted-foreground mt-0.5 text-[12.5px]">
                    {e.detail.blocked} more were blocked by Radar and are not counted with these —
                    card testing stopped before a bank saw it.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {d.counts.truncated && (
        <p className="text-muted-foreground mt-2.5 text-[12.5px]">
          Showing the newest {d.counts.returned} of {d.counts.matching}. The chart above is over the
          whole window regardless.
        </p>
      )}

      <p className="text-muted-foreground mt-2.5 text-[12.5px] leading-relaxed">
        {d.coverage.note} Exact: {d.coverage.exactKinds.join(", ")}. Day resolution:{" "}
        {d.coverage.dayResolutionKinds.join(", ")}. A first derivation only reaches back{" "}
        {d.coverage.derivesBackDays} days.
      </p>
    </>
  );
}
