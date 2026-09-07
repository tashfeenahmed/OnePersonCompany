import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Play, Search, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago, pct } from "@/lib/format";
import { seoopsApi, type SeoBaseline, type SeoReading, type SeoVerdict } from "@/lib/api/seoops";

/**
 * DID THE PAGE MOVE AFTER THE WORK — one row per tracked URL.
 *
 * IT SITS BESIDE OUTCOMES BECAUSE IT IS THE SAME QUESTION AT A DIFFERENT
 * ADDRESS. Outcomes asks "did a number in a document move"; this asks "did
 * THAT page move", which no document on this box could answer until a
 * per-URL reading existed. Every baseline here also files an outcome, so a
 * URL tracked from a card appears on both tabs and the figures agree — they
 * are the same reading, read once.
 *
 * NOTHING ON THIS PAGE DRAWS AN UNMEASURED READING AS A ZERO. A page Search
 * Console has no row for gets the word "not measured" and the reason, in the
 * place a number would have been. That is the whole feature: the alternative
 * is a chart with a cliff in it that the owner reads as a collapse.
 *
 * POSITION IS DRAWN WITH ITS SIGN FLIPPED IN THE COLOUR ONLY. A delta of -2.5
 * is printed as -2.5 because that is the arithmetic, and it is coloured green
 * because a rank going down is a rank going up. Printing "+2.5 better" would
 * be a second number nobody could reconcile with the API.
 */
const TONE: Record<SeoVerdict, ComponentProps<typeof Badge>["variant"]> = {
  up: "ok",
  down: "destructive",
  flat: "secondary",
  /* Neither good nor bad: there was not enough traffic to compare. */
  thin: "secondary",
  /* Grey and never green. Nothing was measured, which is not "no change" — the
     dashed edge is what says "no reading" rather than "a reading of nought". */
  unmeasured: "outline",
};

const DASHED: Partial<Record<SeoVerdict, string>> = { unmeasured: "border-dashed" };

function Figure({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="tabular-nums">
      {Number.isInteger(value) ? value : value.toFixed(2)}
      {suffix}
    </span>
  );
}

function Delta({ value, percent, invert }: { value: number | null; percent?: number | null; invert?: boolean }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  return (
    <span className={cn("tabular-nums", good && "text-ok", bad && "text-destructive")}>
      {value > 0 ? "+" : ""}
      {Number.isInteger(value) ? value : value.toFixed(2)}
      {percent !== null && percent !== undefined && (
        <span className="opacity-70">
          {" "}
          ({percent > 0 ? "+" : ""}
          {pct(percent / 100)})
        </span>
      )}
    </span>
  );
}

function ReadingLine({ r, label }: { r: SeoReading; label: string }) {
  if (!r.measured)
    return (
      <div className="text-muted-foreground border-line-soft border-l-2 border-dashed py-1 pl-2.5 text-[13px]">
        <span className="font-medium">{label}</span> — not measured. {r.error}
      </div>
    );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-1 text-[13px]">
      <span className="font-medium">{label}</span>
      <span>
        <Figure value={r.clicks} /> <span className="text-muted-foreground">clicks</span>
      </span>
      <span>
        <Figure value={r.impressions} /> <span className="text-muted-foreground">impressions</span>
      </span>
      <span>
        <Figure value={r.ctr} suffix="%" /> <span className="text-muted-foreground">ctr</span>
      </span>
      <span>
        <Figure value={r.position} /> <span className="text-muted-foreground">avg position</span>
      </span>
      <span className="text-muted-foreground ml-auto text-[12px]">
        {r.window.days}d to {r.window.end} · {r.source === "stored-capped" ? "stored, capped" : "exact, filtered"}
      </span>
    </div>
  );
}

export function SeoFollowUpsTab() {
  const doc = useApi(() => seoopsApi.followUps(), []);
  const cands = useApi(() => seoopsApi.candidates(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  async function run(fn: () => Promise<unknown>, key: string) {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
      doc.reload();
      cands.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (doc.error) return <p className="text-muted-foreground text-[14px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14px]">Reading…</p>;
  const d = doc.data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[14px]">
          {d.count} URL{d.count === 1 ? "" : "s"} tracked · follow-ups at {d.schedule.offsetsDays.join(", ")} days ·{" "}
          {d.schedule.windowDays}-day windows
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "sweep"}
            onClick={() => void run(() => seoopsApi.sweep(), "sweep")}
          >
            {busy === "sweep" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Search className="size-3.5" strokeWidth={1.8} />
            )}
            Sweep finished cards
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "due"}
            onClick={() => void run(() => seoopsApi.runDue(), "due")}
          >
            {busy === "due" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Play className="size-3.5" strokeWidth={1.8} />
            )}
            Take the readings that are due
          </Button>
        </div>
      </div>

      {problem && <p className="text-destructive mb-3 text-[13.5px]">{problem}</p>}

      <div className="mb-5 flex flex-wrap gap-2">
        <input
          className="border-line-soft bg-card min-w-[260px] flex-1 rounded-[11px] px-3 py-2 text-[13.5px]"
          placeholder={`Track a URL by hand — for work that never went through a card tagged ${d.schedule.tag}`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!url.trim() || busy === "track"}
          onClick={() =>
            void run(async () => {
              await seoopsApi.track({ url: url.trim() });
              setUrl("");
            }, "track")
          }
        >
          Capture a baseline
        </Button>
      </div>

      {cands.data && cands.data.tagged > 0 && (
        <p className="text-muted-foreground mb-4 text-[13px]">
          {cands.data.tagged} finished card{cands.data.tagged === 1 ? " carries" : "s carry"} {cands.data.tag} out of{" "}
          {cands.data.doneCardsScanned} in Done.{" "}
          {cands.data.candidates.reduce((n, c) => n + c.urls.filter((_, i) => !c.tracked[i]).length, 0)} URL(s) on them
          are not tracked yet.
        </p>
      )}

      {!d.count ? (
        <p className="text-muted-foreground text-[14px]">
          Nothing is tracked yet. Mark a board card done with {d.schedule.tag} in it and a URL in its body, then press
          Sweep — or paste a URL above.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[14px] bg-card">
          {d.baselines.map((b: SeoBaseline, i) => {
            const latest = b.diagnoses.at(-1) ?? null;
            const overdue = b.due.filter((x) => x.overdue).length;
            return (
              <div key={b.id} className={cn(i > 0 && "border-line-soft border-t")}>
                <button
                  onClick={() => setOpen(open === b.id ? null : b.id)}
                  className="hover:bg-accent flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-left text-[13.5px]"
                >
                  {latest ? (
                    <Badge variant={TONE[latest.verdict]} className={DASHED[latest.verdict]}>
                      {latest.verdict}
                      {latest.verdict !== "unmeasured" && latest.verdict !== "thin" ? ` · ${latest.diagnosis}` : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-dashed">
                      no reading yet
                    </Badge>
                  )}
                  <span className="font-medium">{b.title}</span>
                  {b.ventureName && <span className="text-muted-foreground">{b.ventureName}</span>}
                  <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]">
                    {overdue > 0 && <span className="text-warn">{overdue} due · </span>}
                    day {b.daysSinceAction} · {ago(b.actionAt)}
                  </span>
                </button>

                {open === b.id && (
                  <div className="border-line-soft border-t px-3.5 py-3">
                    <a
                      href={b.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground block truncate font-mono text-[12.5px]"
                    >
                      {b.url}
                    </a>
                    <p className="text-muted-foreground mt-0.5 text-[12px]">
                      {b.property ? `Measured under ${b.property}.` : "No Search Console property covers this URL."}
                      {b.source.kind === "card" ? ` From board card #${b.source.ref}.` : " Tracked by hand."}
                      {b.outcomeId && (
                        <>
                          {" "}
                          Also filed as an{" "}
                          <Link to="/workflows/outcomes" className="underline">
                            outcome
                          </Link>
                          .
                        </>
                      )}
                    </p>

                    <div className="mt-2.5">
                      {b.baseline && <ReadingLine r={b.baseline} label="before" />}
                      {b.followUps.map((f) => (
                        <ReadingLine key={`${f.at}-${f.dayOffset}`} r={f} label={`day ${f.dayOffset}`} />
                      ))}
                    </div>

                    {b.diagnoses.map((dg) => (
                      <div key={dg.dayOffset} className="border-line-soft mt-2.5 rounded-[11px] border px-2.5 py-2">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
                          <Badge variant={TONE[dg.verdict]} className={DASHED[dg.verdict]}>
                            {dg.verdict}
                          </Badge>
                          <span className="font-medium">{dg.diagnosis}</span>
                          <span className="text-muted-foreground text-[12px]">
                            at day {dg.dayOffset} · decided by {dg.decidedBy === "model" ? `a model${dg.model ? ` (${dg.model})` : ""}` : `rule ${dg.rule}`}
                          </span>
                        </div>
                        {dg.delta && (
                          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px]">
                            <span>
                              <span className="text-muted-foreground">clicks </span>
                              <Delta value={dg.delta.clicks} percent={dg.delta.clicksPct} />
                            </span>
                            <span>
                              <span className="text-muted-foreground">impressions </span>
                              <Delta value={dg.delta.impressions} percent={dg.delta.impressionsPct} />
                            </span>
                            <span>
                              <span className="text-muted-foreground">ctr </span>
                              <Delta value={dg.delta.ctr} />
                            </span>
                            <span title="A rank: going down is going up.">
                              <span className="text-muted-foreground">position </span>
                              <Delta value={dg.delta.position} invert />
                            </span>
                          </div>
                        )}
                        <p className="mt-1.5 text-[13px]">{dg.next}</p>
                        {dg.modelNote && (
                          <p className="text-muted-foreground mt-1 text-[12.5px] italic">{dg.modelNote}</p>
                        )}
                        {dg.note && <p className="text-muted-foreground mt-1 text-[12px]">{dg.note}</p>}
                      </div>
                    ))}

                    {b.missedOffsets.length > 0 && (
                      <p className="text-muted-foreground mt-2.5 text-[12px] leading-relaxed">
                        The day {b.missedOffsets.join(", ")} reading{b.missedOffsets.length === 1 ? "" : "s"} can never
                        be taken: {b.missedOffsets.length === 1 ? "that day" : "those days"} had already passed when
                        this URL was first tracked, so there is no window to measure. Nothing was lost — there was
                        never anything there to read.
                      </p>
                    )}
                    <p className="text-muted-foreground mt-2.5 text-[12px] leading-relaxed">{b.window}</p>
                    <p className="text-muted-foreground text-[12px] leading-relaxed">{b.caveat}</p>

                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {b.due.some((x) => x.overdue) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === b.id}
                          onClick={() => void run(() => seoopsApi.runOne(b.id), b.id)}
                        >
                          {busy === b.id ? (
                            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                          ) : (
                            <Play className="size-3.5" strokeWidth={1.8} />
                          )}
                          Take the day-{b.due.find((x) => x.overdue)!.dayOffset} reading
                        </Button>
                      )}
                      {!b.closedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void run(() => seoopsApi.closeOne(b.id), `close-${b.id}`)}
                        >
                          <X className="size-3.5" strokeWidth={1.8} />
                          Stop following this one
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6">
        {d.notes.map((n) => (
          <p key={n} className="text-muted-foreground mb-1.5 max-w-[760px] text-[12.5px] leading-relaxed">
            {n}
          </p>
        ))}
      </div>
    </>
  );
}
