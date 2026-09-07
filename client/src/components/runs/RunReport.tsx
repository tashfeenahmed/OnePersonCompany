import { useMemo, useRef } from "react";
import { Loader2, Square, Trash2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { PaperFacts, PaperFrame, PaperLinks } from "@/components/runs/PaperView";
import { ExportPdf } from "@/components/runs/ExportPdf";
import { RunCards } from "@/components/runs/RunCards";
import { RunSteps } from "@/components/runs/RunSteps";
import {
  backendPhrase,
  since,
  statusTone,
  statusWord,
} from "@/components/runs/format";
import { readCards, type RunDetail } from "@/lib/api/runs";
import { cn } from "@/lib/utils";
import { count, duration, when } from "@/lib/format";
import { wordCount } from "@/lib/reportDocument";

/**
 * ONE RUN, OPEN.
 *
 * THE REPORT IS DRAWN WHILE IT IS STILL BEING WRITTEN, which is the whole
 * reason the server flushes partial markdown to the row once a second. A
 * spinner over an empty panel for four minutes is indistinguishable from a
 * hang; a report growing a paragraph at a time is the same wait with the work
 * visible in it. `partial` is what says which state this is, and it is said in
 * words above the text rather than left for the reader to infer from a cursor.
 *
 * WHAT THE FOOTER LINE CLAIMS AND WHAT IT DOES NOT. Backend, model, duration,
 * tool count — four facts the server recorded. There is no cost here and there
 * will not be one: nothing on this box knows what a token cost on whichever
 * provider answered, and a number that looked like money would be believed.
 * Usage counts are on the wire and are also not drawn, for the smaller reason
 * that "31,402 prompt tokens" is not a fact anybody acts on.
 *
 * THE EXPORT IS A PDF, NOT A MARKDOWN FILE. The button here used to hand out
 * the raw `.md` — the run's text as the model wrote it — which is an export
 * for pasting into another model and for nobody else. A report is read on
 * paper or sent on, so the button prints the rendered report on its own paper
 * and the browser's dialog is where "Save as PDF" is chosen; see
 * `components/runs/ExportPdf`. The papers kind keeps its own three links,
 * because for a paper the PDF is the document and the markdown is its source.
 *
 * A FAILED RUN KEEPS ITS PARTIAL REPORT. The error is drawn above it, not
 * instead of it: half a research report and the sentence that says why it
 * stopped are both worth having, and throwing the text away because the run
 * ended badly is destroying the only thing the run produced.
 *
 * A PAPER RUN PUTS THE PAPER FIRST AND THE REPORT SECOND, which is the one
 * place this panel is not the same for every kind — and it is not a fork on
 * `kind`, it is a fork on whether the server sent a `paper`. For the other five
 * kinds the report IS the work; for a paper the report is a note about a
 * document, and a page that led with the note would be burying the thing the
 * run exists to produce under a paragraph about how it was made.
 */
export function RunReport({
  run,
  onCancel,
  onDelete,
  onRetry,
  onResume,
  busy,
}: {
  run: RunDetail;
  onCancel: () => void;
  onDelete: () => void;
  onRetry?: () => void;
  onResume?: () => void;
  busy: boolean;
}) {
  /* Parsed on the text, so a partial report reparses at most as often as it
     grows — and a half-written fence simply does not match, which is what
     makes the panel appear the moment the block closes. */
  const { cards, body } = useMemo(() => readCards(run.output), [run.output]);

  const live = run.status === "queued" || run.status === "running";
  const took = duration(run.ms, { nullText: "" }) || (run.status === "running" ? since(run.startedAt) : null);
  const reportRef = useRef<HTMLDivElement>(null);
  const text = body.trim();

  return (
    <div className="bg-card rounded-[14px] p-4.5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))}
        />
        <span className="text-[14.5px] font-medium tracking-tight">
          {run.title}
        </span>
        <span className="text-muted-foreground text-[13px]">
          {statusWord(run.status)}
          {run.ventureName && ` · ${run.ventureName}`}
          {took && ` · ${took}`}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {!live && onRetry && <button className="rounded-md px-2.5 py-1.5 text-xs bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50" disabled={busy} onClick={onRetry}>Retry saved inputs</button>}
          {run.canResume && onResume && <button className="rounded-md px-2.5 py-1.5 text-xs bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50" disabled={busy} onClick={onResume}>Resume checkpoints</button>}
          {live && (
            <button
              onClick={onCancel}
              disabled={busy}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] disabled:opacity-50"
            >
              <Square className="size-3.5" strokeWidth={1.6} />
              Stop
            </button>
          )}
          {/* The paper's own three links replace this one when there is a
              paper — for a paper the PDF is the document, and a second
              "PDF" button beside `PaperLinks` would be a page arguing with
              itself about which file that is. */}
          {!live && !run.paper && text && (
            <ExportPdf
              title={run.title}
              subtitle={`${run.ventureName ? `for ${run.ventureName} · ` : ""}${statusWord(run.status)}`}
              facts={[
                { label: "Finished", value: when(run.finishedAt ?? run.startedAt ?? run.queuedAt, { year: true }) },
                { label: "Took", value: took ?? "" },
                { label: "Tool calls", value: run.steps.length ? count(run.steps.length) : "" },
                { label: "Words", value: count(wordCount(text)) },
                { label: "Model", value: backendPhrase(run) },
              ]}
              brief={Object.values(run.input).find((v) => v && v.trim()) ?? null}
              footer={`${backendPhrase(run)} · ${run.id}`}
              body={reportRef}
            />
          )}
          {run.paper && <PaperLinks paper={run.paper} />}
          {!live && (
            <button
              onClick={onDelete}
              disabled={busy}
              className="text-muted-foreground hover:bg-accent hover:text-destructive flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] disabled:opacity-50"
            >
              <Trash2 className="size-3.5" strokeWidth={1.6} />
              Delete
            </button>
          )}
        </div>
      </div>

      {run.error && (
        <p className="text-destructive mb-3 text-[13.5px] leading-relaxed">
          {run.error}
        </p>
      )}

      <RunSteps steps={run.steps} />

      {/* --------------------------------------------------------- the paper */}
      {run.paper && (
        <div className="mb-4">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[15px] leading-snug font-medium tracking-tight">
              {run.paper.title}
            </span>
            <PaperFacts paper={run.paper} />
          </div>
          {run.paper.thesis && (
            <p className="text-muted-foreground mb-2 text-[13.5px] leading-relaxed">
              {run.paper.thesis}
            </p>
          )}
          {run.paper.contributions.length > 0 && (
            <ul className="text-muted-foreground mb-2.5 list-disc pl-4 text-[13.5px] leading-relaxed">
              {run.paper.contributions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          <PaperFrame paper={run.paper} />
          <div className="text-muted-foreground mt-3 mb-1 text-[12px] tracking-[0.06em] uppercase">
            How it was made
          </div>
        </div>
      )}

      {run.status === "queued" ? (
        <p className="text-muted-foreground text-[14px]">
          Waiting its turn. Runs execute one at a time on this box, so this one
          starts when the one before it finishes — the tab can be closed and the
          work carries on.
        </p>
      ) : text ? (
        <>
          {run.partial && (
            <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[12.5px]">
              <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
              Still being written — this is the report so far, not the finished
              one.
            </div>
          )}
          <div ref={reportRef}>
            <Markdown text={body} />
          </div>
        </>
      ) : run.status === "running" ? (
        <p className="text-muted-foreground flex items-center gap-2 text-[14px]">
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
          Working. Nothing has been written yet.
        </p>
      ) : (
        <p className="text-muted-foreground text-[14px]">
          This run wrote nothing.
        </p>
      )}

      {cards.length > 0 && <RunCards cards={cards} ventureId={run.ventureId} />}

      <div className="text-muted-foreground border-line-soft mt-3.5 border-t pt-2.5 text-[12.5px]">
        {backendPhrase(run)}
        {run.steps.length > 0 &&
          ` · ${run.steps.length} ${run.steps.length === 1 ? "tool call" : "tool calls"}`}
        {run.outputChars > 0 && ` · ${count(run.outputChars)} characters`}
        {" · "}
        {run.id}
      </div>
    </div>
  );
}
