import { useMemo } from "react";
import { Download, FileText, Loader2, Square, Trash2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { RunCards } from "@/components/runs/RunCards";
import { RunSteps } from "@/components/runs/RunSteps";
import {
  backendPhrase,
  duration,
  since,
  statusTone,
  statusWord,
} from "@/components/runs/format";
import { readCards, runFileUrl, type RunDetail } from "@/lib/api/runs";
import { cn } from "@/lib/utils";

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
 * A FAILED RUN KEEPS ITS PARTIAL REPORT. The error is drawn above it, not
 * instead of it: half a research report and the sentence that says why it
 * stopped are both worth having, and throwing the text away because the run
 * ended badly is destroying the only thing the run produced.
 */
export function RunReport({
  run,
  onCancel,
  onDelete,
  busy,
}: {
  run: RunDetail;
  onCancel: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  /* Parsed on the text, so a partial report reparses at most as often as it
     grows — and a half-written fence simply does not match, which is what
     makes the panel appear the moment the block closes. */
  const { cards, body } = useMemo(() => readCards(run.output), [run.output]);

  const live = run.status === "queued" || run.status === "running";
  const took = duration(run.ms) ?? (run.status === "running" ? since(run.startedAt) : null);

  return (
    <div className="bg-card rounded-[10px] border p-3.5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))}
        />
        <span className="text-[13.5px] font-medium tracking-tight">
          {run.title}
        </span>
        <span className="text-muted-foreground text-[12px]">
          {statusWord(run.status)}
          {run.ventureName && ` · ${run.ventureName}`}
          {took && ` · ${took}`}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {live && (
            <button
              onClick={onCancel}
              disabled={busy}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] disabled:opacity-50"
            >
              <Square className="size-3.5" strokeWidth={1.6} />
              Stop
            </button>
          )}
          {!live && run.output.trim() && (
            <a
              href={runFileUrl(run.id, "markdown")}
              download
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]"
            >
              <Download className="size-3.5" strokeWidth={1.6} />
              Markdown
            </a>
          )}
          {run.kind === "papers" && run.status === "done" && (
            /* Offered on every finished paper and 404s with a sentence when
               Chrome never printed one. A link that is only drawn when the PDF
               is known to exist would need the papers list loaded here to know
               it — and the honest failure is one page saying why, not a
               control that quietly is not there. */
            <a
              href={runFileUrl(run.id, "pdf")}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]"
            >
              <FileText className="size-3.5" strokeWidth={1.6} />
              PDF
            </a>
          )}
          {!live && (
            <button
              onClick={onDelete}
              disabled={busy}
              className="text-muted-foreground hover:bg-accent hover:text-destructive flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] disabled:opacity-50"
            >
              <Trash2 className="size-3.5" strokeWidth={1.6} />
              Delete
            </button>
          )}
        </div>
      </div>

      {run.error && (
        <p className="text-destructive mb-3 text-[12.5px] leading-relaxed">
          {run.error}
        </p>
      )}

      <RunSteps steps={run.steps} />

      {run.status === "queued" ? (
        <p className="text-muted-foreground text-[13px]">
          Waiting its turn. Runs execute one at a time on this box, so this one
          starts when the one before it finishes — the tab can be closed and the
          work carries on.
        </p>
      ) : body.trim() ? (
        <>
          {run.partial && (
            <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[11.5px]">
              <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
              Still being written — this is the report so far, not the finished
              one.
            </div>
          )}
          <Markdown text={body} />
        </>
      ) : run.status === "running" ? (
        <p className="text-muted-foreground flex items-center gap-2 text-[13px]">
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
          Working. Nothing has been written yet.
        </p>
      ) : (
        <p className="text-muted-foreground text-[13px]">
          This run wrote nothing.
        </p>
      )}

      {cards.length > 0 && <RunCards cards={cards} ventureId={run.ventureId} />}

      <div className="text-muted-foreground border-line-soft mt-3.5 border-t pt-2.5 text-[11.5px]">
        {backendPhrase(run)}
        {run.steps.length > 0 &&
          ` · ${run.steps.length} ${run.steps.length === 1 ? "tool call" : "tool calls"}`}
        {run.outputChars > 0 && ` · ${run.outputChars.toLocaleString()} characters`}
        {" · "}
        {run.id}
      </div>
    </div>
  );
}
