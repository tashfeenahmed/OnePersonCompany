import { ArtifactDownload } from "@/components/runs/ArtifactDownload";
import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Loader2, Square, TriangleAlert } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { ExportPdf } from "@/components/runs/ExportPdf";
import { PaperFacts, PaperFrame, PaperLinks } from "@/components/runs/PaperView";
import { ReportFrame } from "@/components/runs/ReportFrame";
import { RunCards } from "@/components/runs/RunCards";
import { RunSteps } from "@/components/runs/RunSteps";
import { backendPhrase, ordinal, since, statusTone } from "@/components/runs/format";
import { runAddress } from "@/components/org/roleLook";
import { runLabel } from "@/components/org/dossiers";
import { useApi } from "@/hooks/useApi";
import { ago, count, duration, when } from "@/lib/format";
import { isHtmlReport, reportText, titleOfHtml } from "@/lib/report";
import { wordCount, type ReportFact } from "@/lib/reportDocument";
import { runBelongsToWorker, signature } from "@/lib/runChat";
import { cn } from "@/lib/utils";
import { isLive, readCards, runsApi } from "@/lib/api/runs";

/**
 * ONE RUN, DRAWN AS THE EXCHANGE IT IS: the brief, then what the worker did,
 * then what it wrote.
 *
 * ---------------------------------------------------------------------------
 * THERE USED TO BE TWO OF THESE AND THAT WAS THE BUG. The worker's page drew a
 * conversation — briefs on the right, reports on the left, a count of tool
 * calls in the signature and nothing else about them — and a row in the rail
 * swapped that whole middle for a DOCUMENT: a stat strip, a folded "how this
 * run was made", the report, a Back link. Two layouts for one thing, and the
 * tool calls only existed on the one you had to leave the conversation to
 * reach. The owner's words for it: "it does not show tool calls although tool
 * calls are being made — they appear on the run view I get to from the
 * sidebar". So there is one layout now, it is the conversation's, and this is
 * it. `RunView` is deleted rather than kept beside it.
 *
 * THE TOOL CALLS ARE IN THE REPLY, UNFOLDED, one grey line each — the same
 * lines the chat draws for the Chief of Staff's own tools (see
 * `components/ToolCallLine` for the argument about emoji, mono and chevrons,
 * and `RunSteps`, which is that look over a run's step rows). They are ABOVE
 * the report rather than threaded through it because a run's report is one
 * document written at the end of the work: the tools all ran first, and
 * putting them at positions in the prose would be inventing an order the
 * server never claimed.
 *
 * NOT FOLDED BEHIND A "WORKED · 44 STEPS" ROW, which is what the chat does.
 * The chat's turn is mostly words with a little scaffolding; a run is ten
 * minutes of tool calls and a report at the end, and while it is going the
 * tool lines ARE the answer — they are the only thing on the page that moves.
 * A live line shimmers, a finished one settles.
 *
 * THE SIGNATURE IS THE OLD FACTS STRIP, SAID AS ONE LINE. Who wrote it, with
 * which agent and model, how long it took, how many tool calls, how many
 * words, how many board suggestions — see `lib/runChat`'s `signature`, which
 * leaves out a fact it does not have rather than drawing it as a zero. Export
 * PDF and the way through to the Outputs page sit at the end of the same line,
 * because that is where a document is signed and filed.
 *
 * A PAPER RUN PUTS THE PAPER FIRST AND THE REPORT SECOND — the one place this
 * reply is not the same for every kind, and it is a fork on whether the server
 * sent a `paper`, not on the kind. For every other worker the report IS the
 * work; for the discovery scientist the report is a note about a document ("5 pages,
 * at /data/papers/…"), and a reply that led with the note was exactly the bug
 * the owner saw: "it didn't show the pdf here on this page". The old run page
 * drew the paper and this view did not, so the paper is drawn here the way it
 * is drawn everywhere else — `PaperFrame`, the PDF inline in the browser's own
 * viewer — and the note goes under a "How it was made" label, which is what it
 * is. The signature swaps Export PDF for the paper's own three links, because
 * for a paper the PDF is the document and a second "PDF" button would be the
 * page arguing with itself about which file that is.
 *
 * IT POLLS ITS OWN RUN, every second and a half while the run is moving —
 * `runsApi.get` is the only read that carries the STEPS, which the worker
 * document's run summaries only count. `reload` keeps the last document on
 * screen between ticks, so nothing blinks, and `onGrew` lets the page keep the
 * scroll stuck to the bottom while the reader is at the bottom.
 *
 * THE BRIEF COMES FROM THE WORKER'S TRANSCRIPT WHEN THE RUN IS IN THE NEWEST
 * TWENTY — that is the owner's words as typed, with where they were typed —
 * and from the run's own stored input when it is not, which for a dispatched
 * run is the same words with the worker's standing instructions in front of
 * them. Said in the bubble's own line rather than left for the reader to
 * notice. The transcript is no longer DRAWN anywhere; it is an index.
 */
export function RunChat({
  runId,
  worker,
  ventureName,
  sent,
  onStop,
  stopping,
  pollKey,
  onGrew,
}: {
  runId: string;
  /** The worker's short name and title — who signs the reply. */
  worker: { name: string; title: string; kind: string; ventureId: string | null };
  ventureName: string | null;
  /** How the brief got here, from the worker's transcript. Null for a run
   *  older than the newest twenty, where the stored input is all there is. */
  sent: { brief: string; dispatched: boolean; parentSessionId: string | null } | null;
  onStop: (id: string) => void;
  stopping: boolean;
  /** Bumped by the page when it hears that work changed, so a stop or a
   *  dispatch elsewhere reaches this document without waiting for a tick. */
  pollKey: number;
  /** Called whenever this document grows, so the page can stay stuck to the
   *  bottom. Must be stable — it is a dependency of the effect that calls it. */
  onGrew: () => void;
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

  /* WHAT COUNTS AS GROWTH, and why it is these four. The report getting
     longer, a tool call starting or finishing, and the run ending are the
     only things that make this taller; a poll that changed nothing must not
     yank a reader back to the bottom. */
  const grown = `${run?.output.length ?? 0}:${run?.steps.length ?? 0}:${
    run?.steps.filter((s) => !s.finishedAt).length ?? 0
  }:${run?.status ?? ""}`;
  useEffect(() => {
    onGrew();
  }, [grown, onGrew]);

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

  /* The brief the run carries: the typed words when the transcript has them,
     the stored input's first filled field when it does not. */
  const typed = sent?.brief.trim() || null;
  const stored = run ? (Object.values(run.input).find((v) => v && v.trim()) ?? null) : null;
  const brief = typed || stored?.trim() || null;
  const briefIsStored = !typed && !!stored?.trim();

  /* WHERE THE BRIEF CAME FROM, when it was not typed on this page. A run this
     page has no transcript row for is one nobody can say that about, so it
     says nothing rather than guessing "started from the app". */
  const origin = !sent
    ? null
    : !sent.dispatched
      ? "started from the app"
      : sent.parentSessionId === "rounds"
        ? "asked by the scheduled round"
        : sent.parentSessionId
          ? "asked by the chief of staff"
          : null;

  /* The document's own name, for the print dialog and the frame: the brief's
     first line, what an HTML report calls itself, or the title with its kind
     off the front — the same name the rail's row uses, so the two agree. */
  const first = typed?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  const named = html ? titleOfHtml(text) : null;
  const heading = run ? (first ?? named ?? runLabel(run.title)) : "…";

  const took = run
    ? duration(run.ms, { nullText: "" }) ||
      (run.status === "running" ? (since(run.startedAt) ?? "") : "")
    : "";
  const stamp = run ? (run.finishedAt ?? run.startedAt ?? run.queuedAt) : null;
  const subtitle = run
    ? `${worker.name}${ventureName ? ` · for ${ventureName}` : ""}`
    : null;

  /* THE PRINTED DOCUMENT'S STRIP, which is not the signature: on paper the
     facts go above the report as a table with labels, because the reader has
     no page around them to say what they are. See `lib/reportDocument`. */
  const facts: ReportFact[] = run
    ? [
        {
          label: run.finishedAt ? "Finished" : run.startedAt ? "Started" : "Queued",
          value: when(stamp, { year: true }),
        },
        { label: "Took", value: took },
        { label: "Tool calls", value: run.steps.length ? count(run.steps.length) : "" },
        { label: "Words", value: words ? count(words) : "" },
        { label: "Model", value: backendPhrase(run) },
        { label: "Board suggestions", value: cards.length ? count(cards.length) : "" },
      ].filter((f) => f.value)
    : [];

  if (run && !runBelongsToWorker(run, worker))
    return <p className="text-muted-foreground pb-2 text-[14px]">This run does not belong to this sub-agent. Choose a conversation from their history.</p>;
  if (open.error)
    return (
      <p className="text-muted-foreground pb-2 text-[14px]">
        No run at this address. <span className="text-destructive">{open.error}</span>
      </p>
    );
  if (!run && !brief)
    return <p className="text-muted-foreground pb-2 text-[14px]">Reading the run…</p>;

  return (
    <div className="flex flex-col gap-3 pb-2">
      {/* ------------------------------------------------- the brief, right */}
      <div className="flex flex-col items-end">
        <div className="bg-card max-w-[85%] rounded-[16px] px-4.5 py-3 text-[14.5px] whitespace-pre-wrap">
          {brief || (
            <span className="text-muted-foreground italic">
              No brief — the run was started with the field left empty.
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-[12.5px]">
          {run ? ago(run.queuedAt) : "just now"}
          {origin && ` · ${origin}`}
          {sent?.parentSessionId && sent.parentSessionId !== "rounds" && (
            <>
              {" "}
              <Link
                to={`/chat/${encodeURIComponent(sent.parentSessionId)}`}
                className="hover:text-foreground underline"
              >
                in this chat
              </Link>
            </>
          )}
          {/* Said once, quietly: these are not the owner's words but the form
              the run was started from, with the standing instructions on it. */}
          {briefIsStored && " · the run's own input"}
        </p>
      </div>

      {/* -------------------------------------------------- the reply, left */}
      {run && (
        <div>
          {run.status === "queued" && (
            <p className="text-muted-foreground text-[14px]">
              {worker.name} is waiting its turn
              {run.queuePosition ? `, ${ordinal(run.queuePosition)} in the queue` : ""}.
              One run at a time on this box — it starts when the one before it
              finishes, and carries on with this tab shut.
            </p>
          )}

          {run.error && (
            <p className="text-destructive mb-2 text-[13.5px] leading-relaxed">
              {run.error}
            </p>
          )}

          {/* WHAT IT DID, BEFORE WHAT IT WROTE. In order, and unfolded. */}
          <RunSteps steps={run.steps} />

          {/* ------------------------------------------------- the paper */}
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
              {text && (
                <div className="text-muted-foreground mt-3 mb-1 text-[12px] tracking-[0.06em] uppercase">
                  How it was made
                </div>
              )}
            </div>
          )}

          {text ? (
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
              {worker.name} is working
              {since(run.startedAt) ? ` — ${since(run.startedAt)} so far` : ""}. Nothing
              has been written yet.
            </p>
          ) : run.status === "queued" ? null : (
            <p className="text-muted-foreground text-[14px]">Nothing was written.</p>
          )}

          {run.status === "failed" && text && (
            <p className="text-muted-foreground mt-1.5 text-[12.5px]">
              <TriangleAlert className="mr-1 inline size-3 align-[-1px]" strokeWidth={1.8} />
              Stopped before it finished — this is what it had written.
            </p>
          )}

          {/*
            SIGNED BY THE WORKER, the way the chat signs every answer with its
            backend — and for the same reason. Which agent or provider actually
            wrote it comes after the name, because a report from a raw provider
            with no tools is not the same piece of work as one from a live
            agent. Export and Outputs are on the end of the line rather than up
            beside a heading: this is where the document finishes.
          */}
          <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]">
            <span className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))} />
            <span className="min-w-0">
              {live
                ? [
                    worker.name,
                    run.status === "running" ? "working" : "waiting its turn",
                    took,
                    run.steps.length
                      ? `${count(run.steps.length)} tool call${run.steps.length === 1 ? "" : "s"} so far`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : signature({
                    worker: worker.name,
                    backend: backendPhrase(run),
                    took,
                    steps: run.steps.length,
                    words,
                    cards: cards.length,
                  }).join(" · ")}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {live && (
                <button
                  onClick={() => onStop(run.id)}
                  disabled={stopping}
                  className="hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] disabled:opacity-50"
                >
                  <Square className="size-3.5" strokeWidth={1.6} />
                  Stop
                </button>
              )}
              {/* THE HTML REPORT CARRIES ITS OWN EXPORT, above the frame: the
                  print call needs the frame's window, so it can only live
                  where the frame does. This one builds a document out of the
                  rendered markdown, which an HTML report does not need — it
                  already is one. */}
              {!live && !run.paper && ["research", "seo", "competitors"].includes(run.kind) && <ArtifactDownload runId={run.id} />}
              {run.paper ? (
                <PaperLinks paper={run.paper} />
              ) : !html ? (
                <ExportPdf
                  title={heading}
                  subtitle={subtitle}
                  facts={facts}
                  brief={brief}
                  footer={`${worker.name} · ${backendPhrase(run)} · ${run.id}`}
                  body={reportRef}
                  disabled={live || !text}
                />
              ) : null}
              <Link
                to={runAddress(run)}
                title="The same run on the Outputs page, where it can be retried or deleted"
                className="hover:bg-accent hover:text-foreground flex items-center gap-1 rounded-lg px-2 py-1 text-[13px]"
              >
                Outputs
                <ArrowUpRight className="size-3" strokeWidth={1.8} />
              </Link>
            </span>
          </div>

          {cards.length > 0 && <RunCards cards={cards} ventureId={run.ventureId} filedByServer={run.cardsFiled} />}
        </div>
      )}
    </div>
  );
}
