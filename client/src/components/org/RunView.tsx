import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, ChevronRight, Loader2, Square, TriangleAlert } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { ExportPdf } from "@/components/runs/ExportPdf";
import { ReportFrame } from "@/components/runs/ReportFrame";
import { RunCards } from "@/components/runs/RunCards";
import { RunSteps } from "@/components/runs/RunSteps";
import { backendPhrase, ordinal, since, statusTone, statusWord } from "@/components/runs/format";
import { runAddress } from "@/components/org/roleLook";
import { runLabel } from "@/components/org/dossiers";
import { useApi } from "@/hooks/useApi";
import { count, duration, when } from "@/lib/format";
import { isHtmlReport, reportText } from "@/lib/report";
import { wordCount, type ReportFact } from "@/lib/reportDocument";
import { cn } from "@/lib/utils";
import { isLive, readCards, runsApi } from "@/lib/api/runs";

/**
 * ONE RUN, OPEN ON THE WORKER'S OWN PAGE.
 *
 * ---------------------------------------------------------------------------
 * THE RAIL USED TO DO ONE OF TWO THINGS, AND OFTEN NEITHER. A row for a run in
 * the transcript scrolled the page to it; a row for an older run left the page
 * for the Outputs tab. On the People Analyst the transcript is the UNFILED
 * pile, so a filed dossier was "in the transcript" by the server's count and
 * not in the DOM — and the click did nothing at all. Now every row means the
 * same thing: this run, here, in place of the conversation, at an address
 * (`?run=<id>`) the back button understands.
 *
 * THE SHAPE IS WORKDASH'S REPORT PANE. A title, then the facts as a stat strip
 * — the date, how long it took, how many tool calls, how many words, which
 * model — then the brief it was written under, then the report, with Export
 * on the right of the title where Workdash puts it. The facts are the SERVER'S
 * (queued, started and finished stamps, the ms it recorded, the steps it
 * logged); the one this side works out is the word count, which is a size and
 * not a claim.
 *
 * IT POLLS ITS OWN RUN while the run is moving, on the same cadence as the
 * transcript, so a report opened mid-write grows here the way it grows there.
 * `reload` keeps the last document on screen between ticks; the page does not
 * blink and the scroll stays where the reader put it.
 *
 * THE BRIEF COMES FROM THE TRANSCRIPT WHEN THE RUN IS IN IT — that is the
 * owner's words as typed — and from the run's own stored input when it is
 * not, which for a dispatched run is the same words with the worker's standing
 * instructions in front of them. Said in words under the heading rather than
 * left for the reader to notice.
 */
export function RunView({
  runId,
  worker,
  ventureName,
  brief: typedBrief,
  onBack,
  onStop,
  stopping,
  pollKey,
}: {
  runId: string;
  worker: { name: string; title: string };
  ventureName: string | null;
  /** The brief as typed, when the transcript has it; null when it does not. */
  brief: string | null;
  onBack: () => void;
  onStop: (id: string) => void;
  stopping: boolean;
  /** Bumped by the page when it hears that work changed, so a stop or a
   *  dispatch elsewhere reaches this document without waiting for a tick. */
  pollKey: number;
}) {
  const open = useApi(() => runsApi.get(runId), [runId]);
  const run = open.data;
  const reload = open.reload;
  const live = !!run && isLive(run.status);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [live, reload]);
  useEffect(() => {
    if (pollKey > 0) reload();
  }, [pollKey, reload]);

  const { cards, body } = useMemo(
    () => (run ? readCards(run.output) : { cards: [], body: "" }),
    [run],
  );
  const text = body.trim();
  /* WHICH RENDERER, decided on the text rather than on the kind — see
     `lib/report.ts`. A dossier is a designed HTML document and goes in the
     frame; everything else on this box is markdown and goes where it always
     went. The word count is the document's WORDS either way, which is why it
     goes through `reportText` rather than counting the markup. */
  const html = useMemo(() => isHtmlReport(text), [text]);
  const words = useMemo(() => wordCount(reportText(text)), [text]);
  const reportRef = useRef<HTMLDivElement>(null);
  const [howOpen, setHowOpen] = useState(false);

  /* The brief the run carries: the typed words when the transcript has them,
     the stored input's first filled field when it does not. */
  const stored = run ? Object.values(run.input).find((v) => v && v.trim()) ?? null : null;
  const brief = typedBrief?.trim() || stored?.trim() || null;
  const briefIsStored = !typedBrief?.trim() && !!stored?.trim();

  /* The heading: the brief's first line, or the title with its kind off the
     front — the same name the rail's row uses, so the two agree. */
  const first = typedBrief?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  const heading = run ? (first ?? runLabel(run.title)) : "…";

  const took = run
    ? duration(run.ms, { nullText: "" }) ||
      (run.status === "running" ? since(run.startedAt) : null)
    : null;
  const stamp = run ? (run.finishedAt ?? run.startedAt ?? run.queuedAt) : null;

  const facts: ReportFact[] = run
    ? [
        {
          label: run.finishedAt ? "Finished" : run.startedAt ? "Started" : "Queued",
          value: when(stamp, { year: true }),
        },
        { label: "Took", value: took ?? "" },
        { label: "Tool calls", value: run.steps.length ? count(run.steps.length) : "" },
        { label: "Words", value: words ? count(words) : "" },
        { label: "Model", value: backendPhrase(run) },
        { label: "Board suggestions", value: cards.length ? count(cards.length) : "" },
      ]
    : [];

  const subtitle = run
    ? `${worker.name}${ventureName ? ` · for ${ventureName}` : ""} · ${statusWord(run.status)}`
    : null;

  return (
    <div className="flex flex-col gap-4 pb-2">
      {/* ------------------------------------------------------ the way back */}
      <button
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground -ml-1 flex w-fit items-center gap-1 rounded-lg px-1 py-0.5 text-[13px]"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.8} />
        Back to the conversation
      </button>

      {open.error ? (
        <p className="text-muted-foreground text-[14px]">
          No run at this address. <span className="text-destructive">{open.error}</span>
        </p>
      ) : !run ? (
        <p className="text-muted-foreground text-[14px]">Reading the run…</p>
      ) : (
        <article className="bg-card rounded-[14px] p-5">
          {/* ------------------------------------------------- the heading */}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-[20px] leading-snug font-normal tracking-[-0.02em]">
                {heading}
              </h2>
              <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px]">
                <span className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))} />
                {subtitle}
                {run.status === "queued" && run.queuePosition
                  ? ` · ${ordinal(run.queuePosition)} in the queue`
                  : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {live && (
                <button
                  onClick={() => onStop(run.id)}
                  disabled={stopping}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] disabled:opacity-50"
                >
                  <Square className="size-3.5" strokeWidth={1.6} />
                  Stop
                </button>
              )}
              {/* THE HTML REPORT CARRIES ITS OWN EXPORT, above the frame:
                   the print call needs the frame's window, so it can only
                   live where the frame does. This one builds a document out
                   of the rendered markdown, which an HTML report does not
                   need — it already is one. */}
              {!html && (
                <ExportPdf
                  title={heading}
                  subtitle={subtitle}
                  facts={facts}
                  brief={brief}
                  footer={`${worker.name} · ${backendPhrase(run)} · ${run.id}`}
                  body={reportRef}
                  disabled={live || !text}
                />
              )}
              <Link
                to={runAddress(run)}
                title="The same run on the Outputs page, where it can be retried or deleted"
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1 rounded-lg px-2 py-1 text-[13px]"
              >
                Outputs
                <ArrowUpRight className="size-3" strokeWidth={1.8} />
              </Link>
            </div>
          </div>

          {/* ------------------------------------------------ the facts */}
          {/* Workdash's tally, as a dl: the label recessive, the reading in
              tabular figures. An empty fact is left off rather than drawn as
              a dash — a queued run has not "taken" anything yet. */}
          <dl className="border-line-soft mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-[12.5px]">
            {facts
              .filter((f) => f.value)
              .map((f) => (
                <div key={f.label} className="flex items-baseline gap-1.5">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="tabular-nums">{f.value}</dd>
                </div>
              ))}
          </dl>

          {/* ------------------------------------------------ the brief */}
          {brief && (
            <div className="border-line-strong text-muted-foreground mt-4 border-l-2 pl-3 text-[13px] leading-relaxed whitespace-pre-wrap">
              <span className="text-foreground font-medium">
                {briefIsStored ? "Written under this input:" : "Written under this brief:"}
              </span>{" "}
              {brief}
            </div>
          )}

          {run.error && (
            <p className="text-destructive mt-4 text-[13.5px] leading-relaxed">{run.error}</p>
          )}

          {/* ---------------------------------------- how it was made */}
          {/* Folded, the way Workdash folds provenance: the tool calls are the
              first thing a surprising report gets asked about and the last
              thing anybody reads first. */}
          {run.steps.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setHowOpen((v) => !v)}
                aria-expanded={howOpen}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-lg text-[12.5px]"
              >
                <ChevronRight
                  className={cn("size-3.5 transition-transform", howOpen && "rotate-90")}
                  strokeWidth={1.8}
                />
                How this run was made
                <span className="tabular-nums">
                  · {run.steps.length} {run.steps.length === 1 ? "tool call" : "tool calls"}
                  {run.model ? ` · ${run.model}` : ""}
                </span>
              </button>
              {howOpen && (
                <div className="mt-2">
                  <RunSteps steps={run.steps} />
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------ the report */}
          <div className="mt-4">
            {run.status === "queued" ? (
              <p className="text-muted-foreground text-[14px]">
                Waiting its turn. One run at a time on this box — it starts when the
                one before it finishes, and carries on with this tab shut.
              </p>
            ) : text ? (
              <>
                {run.partial && (
                  <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[12.5px]">
                    <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
                    Still being written — this is the report so far.
                  </div>
                )}
                {html ? (
                  <ReportFrame html={text} title={heading} fileName={heading} />
                ) : (
                  <div ref={reportRef}>
                    <Markdown text={text} />
                  </div>
                )}
              </>
            ) : run.status === "running" ? (
              <p className="text-muted-foreground flex items-center gap-2 text-[14px]">
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                {worker.name} is working. Nothing has been written yet.
              </p>
            ) : (
              <p className="text-muted-foreground text-[14px]">Nothing was written.</p>
            )}
            {run.status === "failed" && text && (
              <p className="text-muted-foreground mt-2 text-[12.5px]">
                <TriangleAlert className="mr-1 inline size-3 align-[-1px]" strokeWidth={1.8} />
                Stopped before it finished — this is what it had written.
              </p>
            )}
          </div>

          {cards.length > 0 && <RunCards cards={cards} ventureId={run.ventureId} />}
        </article>
      )}
    </div>
  );
}
