import { budgets, budgeted, runContext, queuePaused, assertMeterable } from "../../runtime/budgets.ts";
import { runPage } from "../../../../shared/runRoutes.ts";
/**
 * THE EXECUTOR — one piece of long work at a time, on whatever will answer.
 *
 * ONE AT A TIME, AND THE QUEUE IS THE TABLE. Two runs at once would be two
 * agents on one model provider whose policy is `series` by default, which is
 * not concurrency, it is two calls taking twice as long each; and it would put
 * two long completions on the owner's account for work nobody is watching. So
 * there is a single slot, the line is `status = 'queued'` ordered by
 * `queued_at`, and the tick starts the oldest when the slot is free. Keeping
 * the queue in the table rather than in an array means a run submitted at
 * 11:58 is still in the line at 12:01 after a restart — the array's version of
 * that is a run that silently never happens.
 *
 * ON BOOT, EVERY `running` ROW BECOMES `failed`. It did not finish, nothing is
 * doing it any more, and a ledger that said otherwise would be a ledger.
 * `error: "interrupted by a restart"` is the whole explanation and it is a true
 * one; the partial output that was flushed is kept, because it is what was
 * actually written.
 *
 * THE OUTPUT IS FLUSHED AT MOST ONCE A SECOND. Every delta hitting SQLite
 * would be a few hundred writes a minute of a growing string — the same row,
 * rewritten whole, for a page that polls every couple of seconds and could not
 * show the difference. A second is under the poll interval, so the page never
 * sees a stale document it could have had, and the last flush is unconditional
 * so nothing is lost at the end.
 *
 * WHO ANSWERS, AND THE TWO KINDS THAT REFUSE TO ASK AN AGENT. Every kind takes
 * the chat route's order — an agent if one is live, because it is what the
 * owner chose and can go and look; the raw provider underneath if not, with a
 * brief that says in terms that it has no tools. Two kinds override that, and
 * both overrides are about what is being MEASURED rather than about capability:
 *
 *   geo     asks the provider ALWAYS, because the measurement IS what a model
 *           says unaided. Routing it through an agent with a web search would
 *           measure the search engine.
 *   papers  asks the provider for its PLAN and its FIGURES. Both are one
 *           artefact said out loud — a short JSON object, a standalone SVG —
 *           and the agent, asked for the first on 2026-09-05, wrote it to
 *           /tmp/proposal.json instead of saying it. A turn that wants a thing
 *           rather than a file goes to the thing that only says things.
 *
 * THE PAPER'S WRITE TURN GOES TO THE AGENT, AND THAT IS A DEADLINE DECISION
 * rather than a capability one. It was tried on the provider first, which is
 * the obvious place for a turn that must not fetch anything, and it does not
 * fit: `complete()` is not streamed, so a six-page paper is one request that
 * has to finish inside the provider's 120-second policy timeout, and on
 * 2026-09-05 it did not — `FreeLLMAPI did not answer within 120 seconds`, with
 * nothing to show for two and a half minutes of work. The agent's path is
 * streamed and its deadlines are the right shape for this: ninety seconds of
 * SILENCE, ten minutes overall. So the paper is written there, and the thing
 * the provider was protecting — the closed citation set — is protected by
 * saying so in the brief instead: the write turn is told, in terms, to use no
 * tools and to fetch nothing. It is also checked afterwards, which is the part
 * that does not depend on a model obeying: every `@key` in the finished body is
 * resolved against the library, one that does not resolve is REMOVED before the
 * document is compiled, and only what survives is in `cited`.
 *
 * A PAPER IS TYPESET WHEN THERE IS A TYPESETTER, AND PRINTED WHEN THERE IS NOT.
 * typst.ts is the first machine — a plan, drawn figures, a body in a checked
 * Typst subset, a preamble this server writes, one repair pass shown the
 * compiler's own error — and pdf.ts is the second, which is the markdown this
 * feature shipped with printed by headless Chrome. Discovery decides which:
 * the configured path, then /opt/homebrew/bin/typst, /usr/local/bin/typst and
 * PATH. The row records which one ran, because a browser print is not a typeset
 * paper and a page drawing them identically would be claiming otherwise.
 *
 * The SCOUT still reaches the internet, and that is not a contradiction — it is
 * this server fetching two indexes and writing down what they said, which is a
 * measurement, not a model's recollection.
 *
 * CANCELLING IS AN ABORT, NOT A FLAG SOMEBODY CHECKS. The signal goes down to
 * the fetch, so a cancelled run stops costing tokens immediately rather than
 * at the next convenient loop iteration. A queued run is cancelled by writing
 * the row: there is nothing running to stop.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ask, activeBackend, type ChatTurn } from "../../chat/backend.ts";
import { activeProvider, complete, type ProviderId } from "../../models/provider.ts";
import { ventureContext } from "../../routes/ventures.ts";
import { appendChatMessage, db, now, ventureRowById, type VentureRow } from "../../db.ts";
import {
  auditBlock,
  backlinksBlock,
  bingBlock,
  competitorBlock,
  demandBlock,
  historyBlock,
  presenceBlock,
  renderBlocks,
  searchConsoleBlock,
  ventureBlock,
  type Block,
} from "./context.ts";
import { fencedJson, kindDef, systemBrief, type KindDef } from "./kinds.ts";
import { growthRun } from "../growth/runs.ts";
import { videoRun } from "../video/execute.ts";
/* The screenshot-QA kind's whole implementation, which asks no model — see
   integrations/security/shotsqa.ts. */
import { report as shotsqaReport, runQaAsync, storeQa } from "../security/shotsqa.ts";
import { printPdf, writePaperFiles } from "./pdf.ts";
import { libraryRows, saveLibrary, scout, type Paper } from "./scout.ts";
import {
  DRAFTSMAN,
  PLANNER,
  WRITER,
  bibKey,
  bibliographyCall,
  cleanBody,
  cleanSvg,
  compile,
  defaultColumns,
  figureCall,
  figureFault,
  figureLabel,
  findTypst,
  paperAuthor,
  paperDir,
  pdfPages,
  quoteUnknownVariable,
  placeOrphans,
  planJson,
  preamble,
  renderBib,
  spanWideFigures,
  trimToSentence,
  unfinished,
  validatePlan,
  wideFigure,
  type BibSource,
  type PaperPlan,
} from "./typst.ts";
import {
  finishRunRow,
  readInput,
  runRow,
  runningRow,
  writeProgress,
  type RunRow,
  type Step,
} from "./store.ts";

/**
 * RECORDING A PROVIDER'S OUTCOME, THROUGH AN IMPORT THAT IS DELIBERATELY LATE.
 *
 * `routes/models.ts` owns `noteOutcome` — which account answered and whether it
 * worked, so the Integrations page can draw a red line on the credential that
 * stopped working — and it is the right function to call. It cannot be imported
 * at the top of this file, and the reason is a real cycle rather than a taste:
 * that module reaches `routes/pluginConfig.ts`, which calls
 * `manifestCollectors()` AT IMPORT TIME, which reads the manifest list that
 * this area's own manifest is an entry in. A static import here asks
 * `integrations/index.ts` for `MANIFESTS` while it is still being evaluated,
 * and the process does not start — measured, not theorised.
 *
 * So it is imported on first use and remembered. That costs one module
 * resolution on the first completion of the process's life and nothing
 * afterwards, which is a price a run measured in minutes cannot notice.
 */
let noteOutcomeFn: ((id: ProviderId, endpointLabel: string | null, error: string | null) => void) | null = null;
async function noteOutcome(id: ProviderId, endpointLabel: string | null, error: string | null) {
  noteOutcomeFn ??= (await import("../../routes/models.ts")).noteOutcome;
  noteOutcomeFn(id, endpointLabel, error);
}

/** How often the queue is looked at. Five seconds is well under the time any
 *  of this work takes and is invisible to a page that polls at all. */
const TICK_MS = 5_000;
/** The floor between two writes of a growing report. See the header. */
const FLUSH_MS = 1_000;

/* ------------------------------------------------------------------ session */

/**
 * One run's working state — what has been written, what was done while
 * writing it, and who is writing.
 *
 * It exists so that the six kind implementations below share exactly one
 * notion of "append this and let the page see it", rather than each one
 * remembering to write the row.
 */
class Session {
  output = "";
  steps: Step[] = [];
  backend: string | null = null;
  model: string | null = null;
  usage = { prompt: 0, completion: 0 };
  /** Whether anything reported usage at all. Null on the wire beats 0 — a
   *  backend that counts no tokens has told us nothing, not that it used
   *  none. */
  sawUsage = false;
  private lastFlush = 0;
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  append(text: string) {
    this.output += text;
    if (Date.now() - this.lastFlush >= FLUSH_MS) this.flush();
  }

  /** Something this server did rather than something the model said. Flushed
   *  at once: these are the lines that tell the owner the run is alive during
   *  the ninety seconds a scout or a print takes. */
  say(text: string) {
    this.output += text;
    this.flush();
  }

  startStep(tool: string, label: string | null): Step {
    const step: Step = {
      toolCallId: `${this.id}-${this.steps.length + 1}`,
      tool,
      label,
      startedAt: now(),
      finishedAt: null,
    };
    this.steps.push(step);
    this.flush();
    return step;
  }

  endStep(step: Step, label?: string | null) {
    step.finishedAt = now();
    if (label) step.label = label;
    this.flush();
  }

  /** A tool the AGENT reported. Merged on the way through exactly as
   *  routes/chat.ts merges them: two wire events, one record, two timestamps.
   *  A `completed` for a call that was never announced still makes a record —
   *  a tool that finished is a thing that happened, and losing it to a missing
   *  first half would lose a fact to a wire glitch. */
  toolEvent(e: { toolCallId: string; tool: string; label: string | null; status: "running" | "completed"; at: string }) {
    const existing = this.steps.find((s) => s.toolCallId === e.toolCallId);
    if (existing) {
      if (e.status === "completed") existing.finishedAt = e.at;
      if (!existing.label && e.label) existing.label = e.label;
    } else {
      this.steps.push({
        toolCallId: e.toolCallId,
        tool: e.tool,
        label: e.label,
        startedAt: e.at,
        finishedAt: e.status === "completed" ? e.at : null,
      });
    }
    if (Date.now() - this.lastFlush >= FLUSH_MS) this.flush();
  }

  flush() {
    this.lastFlush = Date.now();
    writeProgress(this.id, {
      output: this.output,
      steps: this.steps,
      backend: this.backend,
      model: this.model,
    });
  }
}

/* --------------------------------------------------------------- the slot */

type Live = { id: string; abort: AbortController; cancelling: boolean };
let live: Live | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function isRunning(id: string): boolean {
  return live?.id === id;
}

/**
 * Take the next run if the slot is free — SYNCHRONOUSLY, which is what lets
 * `POST /api/runs` answer 201 with `status: "running"` rather than always
 * "queued" and a page that has to poll to find out it started immediately.
 *
 * The table is checked as well as the in-process flag. They agree in every
 * normal case; where they would not — a `running` row left by something this
 * process did not start — the TABLE wins, because it is the thing the ledger
 * is.
 */
function claim(): RunRow | null {
  if (live || queuePaused()) return null;
  if (runningRow()) return null;
  const next = db
    .prepare("SELECT * FROM agent_runs WHERE status = 'queued' AND paused = 0 ORDER BY queue_priority DESC, queued_at, rowid LIMIT 1")
    .get() as RunRow | undefined;
  if (!next) return null;
  const res = db
    .prepare("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
    .run(now(), next.id);
  if (Number(res.changes) === 0) return null;
  live = { id: next.id, abort: new AbortController(), cancelling: false };
  return runRow(next.id) ?? null;
}

/** Start the next run if there is one, and go round again when it ends. Safe
 *  to call at any time from anywhere — it is a no-op when the slot is busy. */
/**
 * THE RESULT, BACK IN THE CHAT THAT ASKED FOR IT.
 *
 * A run dispatched from a conversation used to end in silence there: the rail's
 * child turned from "running" to "done" and the owner had to go and find the
 * report. So a finished run whose row names a parent session writes one
 * assistant turn into that session — what finished, how long it took, the
 * opening of the report, and where the whole thing and its artefacts are. A
 * failure writes the same turn with the reason, because a run that failed
 * quietly is a run the owner thinks is still going.
 *
 * WRITTEN, NOT ASKED FOR. This is not the agent summarising the report — it is
 * the report's own first paragraphs, cut at a paragraph boundary, so nothing
 * in the chat says something the report does not. The links are relative to
 * this app: the run page, and for a paper its PDF.
 */
function reportToParent(runId: string, ms: number) {
  const row = runRow(runId);
  if (!row) return;
  /* The parent is a dispatch's column, written beside `insertRun` rather than
     through it — see subagents/routes.ts — so `RunRow` does not carry it. */
  const parent = (
    db.prepare("SELECT parent_session_id AS p FROM agent_runs WHERE id = ?").get(runId) as { p: string | null } | undefined
  )?.p;
  if (!parent || parent.startsWith("run:")) return;
  const def = kindDef(row.kind);
  const what = def?.name ?? row.kind;
  const took = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
  const page = runPage(row.kind, row.id);
  const lines: string[] = [];

  if (row.status === "done") {
    lines.push(`**${what} finished — ${row.title}** · ${took} · [open the run](${page})`);
    const paper =
      row.kind === "papers"
        ? (db.prepare("SELECT title, thesis, pdf_path, typeset, pages FROM papers WHERE run_id = ?").get(row.id) as
            | { title: string; thesis: string; pdf_path: string | null; typeset: string | null; pages: number | null }
            | undefined)
        : undefined;
    if (paper) {
      lines.push("", `*${paper.title}*`);
      if (paper.thesis) lines.push("", paper.thesis);
      if (paper.pdf_path)
        lines.push(
          "",
          `[Paper PDF](/api/runs/${row.id}/pdf)` +
            (paper.typeset === "typst" ? " — typeset with Typst" : " — printed from markdown") +
            (paper.pages ? `, ${paper.pages} page${paper.pages === 1 ? "" : "s"}` : "") +
            `. [Typst source](/api/runs/${row.id}/typ).`,
        );
    } else {
      const opening = openingOf(row.output ?? "");
      if (opening) lines.push("", opening);
      lines.push("", `The whole report is on the run page.`);
    }
  } else {
    lines.push(
      `**${what} ${row.status} — ${row.title}** · ${took} · [open the run](${page})`,
      "",
      row.error ? `It stopped because: ${row.error}` : "It was stopped before it finished.",
    );
  }

  try {
    appendChatMessage({
      sessionId: parent,
      role: "assistant",
      content: lines.join("\n"),
      channel: "run",
      backend: null,
      model: null,
      ms,
    });
  } catch (err) {
    console.error(`[runs] ${row.id}: could not report to ${parent} — ${String(err)}`);
  }
}

/** The report's first paragraphs, up to about 700 characters, cut at a
 *  paragraph and never mid-sentence; the H1 the writer put on top is dropped
 *  because the turn already names the run. */
function openingOf(output: string): string {
  /* From the first section heading on, when there is one: what comes before
     it is the writer clearing its throat — "Now I have everything I need.
     Let me write the report." — and the report starts at "## Findings". */
  const firstH2 = output.search(/^##\s/m);
  const body = firstH2 > 0 ? output.slice(firstH2) : output;
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#\s/.test(p));
  const out: string[] = [];
  let n = 0;
  for (const p of paras) {
    if (n + p.length > 700 && out.length) break;
    out.push(p);
    n += p.length;
    if (n > 700) break;
  }
  return out.join("\n\n");
}

export function pump() {
  const row = claim();
  if (!row) return;
  const started = Date.now();
  const session = new Session(row.id);
  const abort = live!.abort;
  const timeout = setTimeout(() => abort.abort(new Error("Job runtime budget exceeded.")), budgets().runSeconds * 1000);
  timeout.unref();
  const parent = db.prepare("SELECT parent_session_id AS id FROM agent_runs WHERE id=?").get(row.id) as {id: string | null} | undefined;
  void runContext.run({ id: row.id, venture: row.venture_id, automation: parent?.id === "rounds", signal: abort.signal, sequence: 0, resume: !!row.resume_checkpoints }, async () => {
    assertMeterable(row.kind);
    await execute(row, session);
    abort.signal.throwIfAborted();
  }).then(() => {
      finishRunRow(row.id, {
        status: "done",
        output: session.output,
        steps: session.steps,
        backend: session.backend,
        model: session.model,
        error: null,
        ms: Date.now() - started,
        usage: session.sawUsage ? session.usage : null,
      });
      reportToParent(row.id, Date.now() - started);
    })
    .catch((err: unknown) => {
      const cancelled = live?.cancelling === true;
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "The run stopped for a reason it did not give.";
      finishRunRow(row.id, {
        status: cancelled ? "cancelled" : "failed",
        /* The partial output is KEPT on both. Words that were written were
           written, and deleting them because the run ended badly would throw
           away the only evidence of how far it got. */
        output: session.output,
        steps: session.steps,
        backend: session.backend,
        model: session.model,
        error: cancelled ? null : message,
        ms: Date.now() - started,
        usage: session.sawUsage ? session.usage : null,
      });
      if (!cancelled) console.error(`[runs] ${row.id} (${row.kind}) failed — ${message}`);
      reportToParent(row.id, Date.now() - started);
    })
    .finally(() => {
      clearTimeout(timeout);
      live = null;
      /* Straight on to the next one rather than waiting for the tick: a queue
         of three should not take fifteen seconds of nothing between them. */
      pump();
    });
}

export function startQueue() {
  if (timer) return;
  timer = setInterval(pump, TICK_MS);
  /* Unreferenced so this timer alone cannot hold the process open. */
  timer.unref?.();
  pump();
}

/** Stop a run. A queued one is cancelled by writing the row; a running one is
 *  aborted, and its own catch writes `cancelled`. */
export function cancelRun(id: string): { ok: boolean; status: string; error?: string } {
  const row = runRow(id);
  if (!row) return { ok: false, status: "missing", error: "No run by that id." };
  if (row.status === "queued") {
    db.prepare("UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now(), id);
    return { ok: true, status: "cancelled" };
  }
  if (row.status === "running") {
    if (live?.id === id) {
      live.cancelling = true;
      live.abort.abort();
      return { ok: true, status: "cancelling" };
    }
    /* Running in the table with nothing in this process doing it — the same
       state boot repairs, reached here by a row this process did not start. */
    db.prepare("UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), id);
    return { ok: true, status: "cancelled" };
  }
  return { ok: false, status: row.status, error: `That run is already ${row.status}.` };
}

/* ------------------------------------------------------------------ turns */

type TurnResult = { text: string; backend: string; model: string | null };

/**
 * One turn, on whoever is answering, with the deltas going to the report when
 * the caller wants them there.
 *
 * `toOutput` IS FALSE FOR THE WORKING TURNS — a paper's plan, a GEO judge —
 * and true for the one that writes the report. The alternative, letting every
 * turn stream into `output`, would put a JSON plan and a scoring table in the
 * middle of the document the owner reads.
 */
async function turn(
  s: Session,
  turns: ChatTurn[],
  opts: { toOutput: boolean; forceProvider?: boolean },
): Promise<TurnResult> {
  const backend = opts.forceProvider ? null : activeBackend();
  if (backend) return budgeted(turns, () => agentTurn(s, turns, opts), true);
  return agentTurn(s, turns, opts);
}
async function agentTurn(s: Session, turns: ChatTurn[], opts: { toOutput: boolean; forceProvider?: boolean }): Promise<TurnResult & { usage?: {prompt: number; completion: number} | null }> {
  const before = { ...s.usage };
  const signal = live?.id === s.id ? live.abort.signal : undefined;
  const backend = opts.forceProvider ? null : activeBackend();

  if (backend?.stream) {
    let text = "";
    let model: string | null = null;
    s.backend = backend.id;
    s.flush();
    for await (const ev of backend.stream(turns, { channel: "run", sessionId: `run:${s.id}`, signal })) {
      switch (ev.type) {
        case "delta":
          text += ev.text;
          if (opts.toOutput) s.append(ev.text);
          break;
        case "reasoning":
          /* Dropped. The model's scratchpad is not the report, and a document
             with the working in it is not what the owner asked for. The steps
             say what it DID; this says what it was thinking about doing. */
          break;
        case "tool":
          s.toolEvent(ev);
          break;
        case "done":
          /* `ev.text` and not the accumulator, for routes/chat.ts's reason: the
             adapter may have applied a rule this loop cannot see — Hermes falls
             back to the model's reasoning when the content came back empty,
             which is a whole answer that arrived as no deltas at all. */
          if (opts.toOutput && ev.text !== text) {
            s.output = s.output.slice(0, s.output.length - text.length) + ev.text;
          }
          text = ev.text;
          model = ev.model;
          if (ev.usage) {
            s.usage.prompt += ev.usage.prompt;
            s.usage.completion += ev.usage.completion;
            s.sawUsage = true;
          }
          break;
      }
    }
    s.model = model ?? s.model;
    s.flush();
    return { text, backend: backend.id, model, usage: s.sawUsage ? { prompt: s.usage.prompt - before.prompt, completion: s.usage.completion - before.completion } : null };
  }

  if (backend) {
    const reply = await ask(turns, { channel: "run", sessionId: `run:${s.id}`, signal });
    s.backend = backend.id;
    s.model = reply.model ?? s.model;
    if (reply.usage) {
      s.usage.prompt += reply.usage.prompt;
      s.usage.completion += reply.usage.completion;
      s.sawUsage = true;
    }
    if (opts.toOutput) s.say(reply.text);
    return { text: reply.text, backend: backend.id, model: reply.model, usage: reply.usage };
  }

  const provider = activeProvider();
  if (!provider)
    throw new Error(
      "Nothing will answer: no agent is live and no model provider is chosen. Connect one under Integrations and pick a default under Models.",
    );
  const r = await complete(turns, { signal });
  await noteOutcome(r.provider, r.endpoint, null);
  s.backend = `provider:${r.provider}`;
  s.model = r.model ?? s.model;
  if (r.usage) {
    s.usage.prompt += r.usage.prompt;
    s.usage.completion += r.usage.completion;
    s.sawUsage = true;
  }
  if (opts.toOutput) s.say(r.text);
  return { text: r.text, backend: `provider:${r.provider}`, model: r.model };
}

/* ------------------------------------------------------------ the six kinds */

async function execute(row: RunRow, s: Session) {
  const def = kindDef(row.kind);
  if (!def) throw new Error(`“${row.kind}” is not a kind of run this server knows how to do.`);
  const input = readInput(row.input);
  const venture = row.venture_id ? ventureRowById(row.venture_id) : undefined;
  if (def.needsVenture && !venture)
    throw new Error("The venture this run was for is not in the table any more, so there is nothing to work on.");

  if (row.kind === "geo") return geoRun(row, s, venture!);
  if (row.kind === "papers") return papersRun(row, s, venture ?? null, input);
  /* NO MODEL AT ALL — the only branch here that asks nothing. See kinds.ts and
     integrations/security/shotsqa.ts for why a deterministic audit is still a
     run: the queue, the ledger and a report with an address. */
  if (row.kind === "shotsqa") return shotsqaRun(row, s);
  /* THE ONE BRANCH THAT WRITES A FILE. Everything behind it is in
     integrations/video/, including the abort signal — an encode that is not
     killed on cancel is a minute of CPU spent on a video nobody will watch. */
  if (row.kind === "video")
    return videoRun({
      runId: row.id,
      session: s,
      venture: venture ?? null,
      input,
      signal: live?.id === s.id ? live.abort.signal : undefined,
    });
  /* THE TWO GROWTH KINDS. Both fetch what they need themselves — a search
     node, competitors' HTML, a store's public listing — so what they borrow
     from here is only the ability to be WATCHED while they do it: the report,
     the steps and one turn on whoever is answering. integrations/growth/runs.ts
     is the seam, and it is an interface in that direction because an import
     back into this file would be a cycle through integrations/index.ts. */
  if (row.kind === "serp" || row.kind === "aso")
    return growthRun(row.kind, row.id, venture!, input, {
      say: (text) => s.say(text),
      startStep: (tool, label) => s.startStep(tool, label),
      endStep: (step, label) => s.endStep(step, label),
      turn: (turns, opts) => turn(s, turns, opts),
      hasTools: activeBackend() !== null,
    });
  return reportRun(row, s, def, venture!, input);
}

/**
 * SCREENSHOT QA — the one run on this box that never asks anything to think.
 *
 * It reads every venture's newest capture, decodes the PNG, checks it against
 * the audit and the rendered title, writes a row per venture and says what it
 * found. `s.say` rather than a model's stream: the report IS the output, it is
 * written by shotsqa.ts, and there is nothing to summarise that would not be a
 * paraphrase of arithmetic. `backend` and `model` stay null on the row for the
 * same reason — claiming a model answered would be claiming a model answered.
 */
async function shotsqaRun(row: RunRow, s: Session) {
  const step = s.startStep("shotsqa", "reading every venture's capture");
  const pass = await runQaAsync();
  storeQa(row.id, pass);
  s.endStep(step, `${pass.ventures.length} venture(s) examined`);
  s.say(shotsqaReport(pass));
}

/** What each kind is handed. Only what the kind needs: a demand report does
 *  not want the backlink table, and every block costs a thousand characters of
 *  a model's attention. */
async function blocksFor(def: KindDef, v: VentureRow, ventureId: string | null): Promise<Block[]> {
  const stage = ventureContext(v.id)?.stageMeans ?? "";
  const base = [ventureBlock(v, stage)];
  switch (def.kind) {
    case "research":
      return [
        ...base,
        await auditBlock(v),
        await presenceBlock(v),
        await backlinksBlock(v),
        await demandBlock(),
        competitorBlock(v),
        historyBlock(def.kind, ventureId),
      ];
    case "competitors":
      return [...base, competitorBlock(v), await presenceBlock(v), historyBlock(def.kind, ventureId)];
    case "seo":
      return [
        ...base,
        await auditBlock(v),
        await searchConsoleBlock(v),
        await bingBlock(v),
        await backlinksBlock(v),
        await presenceBlock(v),
        historyBlock(def.kind, ventureId),
      ];
    case "demand":
      return [...base, await demandBlock(), competitorBlock(v), historyBlock(def.kind, ventureId)];
    default:
      return [...base, historyBlock(def.kind, ventureId)];
  }
}

/** The four kinds that are one turn: assemble, ask, write. `competitors` adds
 *  the upsert afterwards; everything else stops when the words stop. */
async function reportRun(row: RunRow, s: Session, def: KindDef, v: VentureRow, input: Record<string, string>) {
  const gather = s.startStep("context", "reading what this box already knows");
  const blocks = await blocksFor(def, v, v.id);
  s.endStep(gather, `${blocks.length} sources read`);

  const hasTools = activeBackend() !== null;

  /* The sweep's second block, written into the SHAPE rather than into the
     rules — see `systemBrief`'s `shapeExtra` for the failure that moved it —
     and placed BEFORE the cards block, because the shape above calls the cards
     block the end of the document and two instructions cannot both be last. */
  const shapeExtra =
    def.kind === "competitors"
      ? "IMMEDIATELY BEFORE the `json cards` block, write a SECOND fenced block whose info string is exactly `json competitors`, holding an array of " +
        '`{"name", "url", "positioning", "pricing", "strengths": [], "weaknesses": []}` — one entry for EVERY rival you can describe, both the ones already ' +
        "on file that you verified and the ones you found. This block is not decoration: it is the only thing that updates the profile table, and a report " +
        "without it changes nothing. A rival you leave out keeps its old verified date, so omitting one does not say it is gone — it says you did not check it. " +
        "Both blocks must be present, competitors first, cards last."
      : undefined;

  const system = systemBrief({
    def,
    ventureName: v.name,
    hasTools,
    data: renderBlocks(blocks),
    shapeExtra,
  });
  const focus = (input.focus ?? "").trim();
  const user =
    focus ||
    `Do the ${def.name.toLowerCase()} for ${v.name}. Nothing in particular has been singled out, so cover what matters most.`;

  const t = s.startStep("write", `${def.name} — ${v.name}`);
  const res = await turn(s, [{ role: "system", content: system }, { role: "user", content: user }], { toOutput: true });
  s.endStep(t, `${res.text.length} characters`);

  if (def.kind === "competitors") upsertCompetitors(row.id, v.id, res.text, s);
}

/* --------------------------------------------------------- competitors */

type ParsedCompetitor = {
  name: string;
  url: string | null;
  positioning: string | null;
  pricing: string | null;
  strengths: string[];
  weaknesses: string[];
};

function readCompetitors(markdown: string): ParsedCompetitor[] {
  const raw = fencedJson(markdown, "competitors");
  if (!Array.isArray(raw)) return [];
  const out: ParsedCompetitor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name || name.length > 120) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2_000) : null);
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 400)).slice(0, 12) : [];
    out.push({
      name,
      url: str(o.url),
      positioning: str(o.positioning),
      pricing: str(o.pricing),
      strengths: list(o.strengths),
      weaknesses: list(o.weaknesses),
    });
  }
  return out;
}

/**
 * Upsert, and the rule that makes the table worth keeping: `last_verified`
 * moves ONLY for the profiles this run named. A sweep that forgot about a
 * rival has not re-verified it.
 *
 * `first_seen` is preserved by COALESCE against the existing row rather than
 * by reading it first, so two of these cannot race into disagreeing about when
 * a competitor was first heard of.
 */
function upsertCompetitors(runId: string, ventureId: string, markdown: string, s: Session) {
  const found = readCompetitors(markdown);
  if (!found.length) {
    s.say(
      `\n\n<!-- No \`json competitors\` block was found in this report, so no profile was created or re-verified. The report above stands; the table did not change. -->\n`,
    );
    return;
  }
  const step = s.startStep("profiles", `${found.length} competitor profiles`);
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO competitor_profiles
       (venture_id, name, url, positioning, pricing, strengths, weaknesses, last_verified, first_seen, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(venture_id, name) DO UPDATE SET
       url = COALESCE(excluded.url, competitor_profiles.url),
       positioning = COALESCE(excluded.positioning, competitor_profiles.positioning),
       pricing = COALESCE(excluded.pricing, competitor_profiles.pricing),
       strengths = excluded.strengths,
       weaknesses = excluded.weaknesses,
       last_verified = excluded.last_verified,
       run_id = excluded.run_id`,
  );
  for (const c of found)
    stmt.run(
      ventureId,
      c.name,
      c.url,
      c.positioning,
      c.pricing,
      JSON.stringify(c.strengths),
      JSON.stringify(c.weaknesses),
      ts,
      ts,
      runId,
    );
  s.endStep(step, `${found.length} upserted`);
}

/* ----------------------------------------------------------------- geo */

/**
 * WHAT A MODEL SAYS ABOUT THE BUSINESS WHEN IT IS NOT ALLOWED TO LOOK.
 *
 * Every question goes through `complete()` — the raw provider — even when an
 * agent is live, because the thing being measured is the model's own
 * knowledge. An agent with a web search would answer all three questions
 * correctly and the run would have measured the search engine.
 *
 * MENTION IS MEASURED, ACCURACY AND RECOMMENDATION ARE JUDGED. The first is
 * string presence of the name or the host, which is mechanical and checkable.
 * The other two need a reader, so there is one more completion — the judge —
 * and where it does not answer usably both stay NULL. Null is "asked and not
 * told"; it is not "no".
 *
 * THE REPORT'S `## Findings` AND `## Evidence` ARE COMPOSED HERE, not written
 * by a model, because they are the measurement: a score table the model wrote
 * from its own answers would be the instrument marking its own paper, and the
 * evidence for this kind IS the answers, verbatim, which no summary improves.
 * Only the recommendations are asked for.
 */
async function geoRun(row: RunRow, s: Session, v: VentureRow) {
  const provider = activeProvider();
  if (!provider)
    throw new Error(
      "AI visibility asks the model provider directly, and no provider is chosen. Pick one under Models — an agent cannot stand in for it, because the measurement is what a model says with no tools.",
    );

  const input = readInput(row.input);
  const category =
    (input.category ?? "").trim() ||
    (v.description ? v.description.split(/[.!?\n]/)[0]!.trim().slice(0, 120) : v.name);
  const questions = [
    `What is ${v.name}?`,
    v.host ? `What does the website ${v.host} do?` : `What is the website of ${v.name}?`,
    `Recommend a tool for ${category}. Name specific products.`,
    ...(input.questions ?? "")
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 7),
  ];

  const ASK_SYSTEM =
    "Answer from your own knowledge only. You have no tools, no web access and no documents. " +
    "If you have not heard of something, say so plainly — a guess presented as knowledge is the " +
    "one answer that is useless here. Two or three sentences.";

  type Answer = { question: string; answer: string; mentioned: boolean; accurate: boolean | null; recommended: boolean | null };
  const answers: Answer[] = [];

  s.say(`# AI visibility — ${v.name}\n\nAsked of ${provider.label}, with no tools and no web access.\n\n`);

  for (const question of questions) {
    const step = s.startStep("ask", question);
    const res = await turn(
      s,
      [
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: question },
      ],
      { toOutput: false, forceProvider: true },
    );
    const hay = res.text.toLowerCase();
    const mentioned = hay.includes(v.name.toLowerCase()) || (v.host ? hay.includes(v.host.toLowerCase()) : false);
    answers.push({ question, answer: res.text, mentioned, accurate: null, recommended: null });
    s.endStep(step, mentioned ? "mentioned" : "not mentioned");
  }

  /* THE JUDGE — one completion, which is what makes accuracy and
     recommendation answerable at all. It is given the venture record as the
     ground truth and the answers to mark against it. */
  const judgeStep = s.startStep("judge", "scoring accuracy and recommendation");
  try {
    const truth = [
      `Name: ${v.name}`,
      `Website: ${v.website ?? "unknown"}`,
      `Host: ${v.host ?? "unknown"}`,
      `What it is: ${v.description || "not written down"}`,
    ].join("\n");
    const judgeUser = answers
      .map((a, i) => `[${i + 1}] QUESTION: ${a.question}\nANSWER: ${a.answer}`)
      .join("\n\n");
    const res = await turn(
      s,
      [
        {
          role: "system",
          content:
            `You are marking another model's answers against a record of the truth. Here is the truth:\n\n${truth}\n\n` +
            `For each numbered answer, decide two things.\n` +
            `accurate: true if what the answer says ABOUT THIS PRODUCT is correct, false if it says something wrong about it (confusing it with something else counts as wrong), null if the answer does not describe this product at all.\n` +
            `recommended: true if the answer recommends or suggests this product by name, false if it recommends other things instead, null if it is not a question where anything is recommended.\n` +
            `Reply with ONLY a fenced block, info string \`json scores\`, holding [{"n": 1, "accurate": true, "recommended": null}, …]. No prose.`,
        },
        { role: "user", content: judgeUser },
      ],
      { toOutput: false, forceProvider: true },
    );
    const scores = fencedJson(res.text, "scores");
    if (Array.isArray(scores))
      for (const item of scores) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const n = typeof o.n === "number" ? o.n : Number(o.n);
        const a = answers[n - 1];
        if (!a) continue;
        a.accurate = typeof o.accurate === "boolean" ? o.accurate : null;
        a.recommended = typeof o.recommended === "boolean" ? o.recommended : null;
      }
    s.endStep(judgeStep, Array.isArray(scores) ? `${scores.length} scored` : "the judge did not answer usably — accuracy and recommendation stay null");
  } catch (err) {
    /* A judge that fails costs two columns, not the run. The answers are the
       measurement and they are already in hand. */
    s.endStep(judgeStep, `failed — ${err instanceof Error ? err.message : String(err)}; accuracy and recommendation stay null`);
  }

  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO geo_answers (run_id, venture_id, provider, model, question, answer, mentioned, accurate, recommended, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of answers)
    stmt.run(
      row.id,
      v.id,
      provider.id,
      s.model,
      a.question,
      a.answer,
      a.mentioned ? 1 : 0,
      a.accurate === null ? null : a.accurate ? 1 : 0,
      a.recommended === null ? null : a.recommended ? 1 : 0,
      ts,
    );

  const bool = (b: boolean | null) => (b === null ? "not told" : b ? "yes" : "no");
  const mentions = answers.filter((a) => a.mentioned).length;
  s.say(
    [
      `## Findings`,
      ``,
      `${mentions} of ${answers.length} answers mentioned ${v.name}${v.host ? ` or ${v.host}` : ""}.`,
      ``,
      `READ THAT NUMBER WITH ITS DEFINITION. "Mentioned" is string presence of the name or the host in the answer, which is mechanical and checkable and is therefore the only part of this that is MEASURED — and it counts an answer that repeats the name back while saying it has never heard of it. A high mention count over answers that all say "I do not know this" is a model echoing the question, not a model that knows the product. The answers are printed in full below precisely so that this cannot be read off the table alone.`,
      ``,
      `Accuracy and recommendation were judged by a second completion. "not told" means the judge did not answer for that row — never that the answer was wrong.`,
      ``,
      `| Question | Mentioned | Accurate | Recommended |`,
      `| --- | --- | --- | --- |`,
      ...answers.map((a) => `| ${a.question.replace(/\|/g, "\\|")} | ${a.mentioned ? "yes" : "no"} | ${bool(a.accurate)} | ${bool(a.recommended)} |`),
      ``,
      `## Evidence`,
      ``,
      `The answers as they were given, in full. There are no URLs here and there cannot be: nothing fetched anything, and every word below is ${provider.label} answering out of its own weights.`,
      ``,
      ...answers.flatMap((a) => [`**${a.question}**`, ``, a.answer, ``]),
    ].join("\n"),
  );

  const recStep = s.startStep("write", "recommendations");
  const rec = await turn(
    s,
    [
      {
        role: "system",
        content:
          `You are advising the owner of ${v.name} (${v.website ?? "no site recorded"}) on how models talk about it.\n\n` +
          `THE RECORD:\n${v.description || "nothing written down"}\n\n` +
          `WHAT WAS MEASURED: a model with no tools was asked ${answers.length} questions. ${mentions} answers mentioned the product. ` +
          `Here is what it said:\n\n${answers.map((a) => `Q: ${a.question}\nA: ${a.answer}\nmentioned: ${a.mentioned}, accurate: ${bool(a.accurate)}, recommended: ${bool(a.recommended)}`).join("\n\n")}\n\n` +
          `Write ONLY the following, starting with the heading, and nothing else:\n\n` +
          `## Recommendations\n` +
          `Ranked, each a thing that could be started this week, aimed at what a model would have to READ somewhere for the answer to improve — the places it learns from, not the site's own copy alone. Say what each would cost and what it would change.\n\n` +
          `Then a final fenced block, info string exactly \`json cards\`, with 3 to 8 board-card suggestions as [{"title": "…", "body": "…", "urgency": 0-3}].\n\n` +
          `Never invent a figure. The only measurements you have are the ones above.`,
      },
      { role: "user", content: `What should be done about how models describe ${v.name}?` },
    ],
    { toOutput: true, forceProvider: true },
  );
  s.endStep(recStep, `${rec.text.length} characters`);
}

/* -------------------------------------------------------------- papers */

/**
 * A PAPER, AND THE TWO MACHINES THAT CAN MAKE ONE.
 *
 * The scout, the library and the closed citation set are the same whichever
 * machine sets the document, so they are done once here and the two paths
 * below are handed the result. What differs is everything after the plan:
 *
 *   TYPST, when the typesetter is installed. A PLAN pass picks the
 *   contribution and the shape; a DRAFTSMAN pass draws each figure as an SVG;
 *   a BODY pass writes the sections in a small checked subset of Typst; and,
 *   only when the compiler refuses the result, a REPAIR pass is shown the
 *   compiler's own error. The preamble — geometry, columns, fonts, the title
 *   block, the abstract frame, the bibliography — is generated by typst.ts
 *   and never by the model. The result is a typeset paper.
 *
 *   CHROME, when it is not. The path this feature shipped with: the paper is
 *   markdown, cited as `[n]` against the numbered library, and the PDF is that
 *   markdown printed by the browser that takes the screenshots. It is a
 *   readable document and nothing calls it a typeset paper.
 *
 * WHICH ONE RAN IS ON THE ROW, in `typeset`, because the two are not the same
 * artefact and a page that drew them identically would be claiming something
 * about the second that is only true of the first.
 */

/**
 * THE SEARCH SUBJECT, OUT OF WHATEVER WAS TYPED.
 *
 * The topic goes to OpenAlex and arXiv as a query, and a query is a phrase.
 * The first paper dispatched from the chat arrived as a paragraph — "Conduct
 * academic research on…, scout…, build a library…, prepare a write-up with
 * figures using Typst. Parent session: s-…" — which both indexes answered
 * with nothing, and the run failed one second in with no library to cite
 * from. The pack now says the brief is a subject; this is the floor under
 * that rule. A short topic is used as typed. A long one is reduced to its
 * subject by the model — three to ten words, the field and the angle, no
 * verbs — and the step label says so, because the phrase that was searched
 * is a fact about the run a reader is entitled to. If the model's phrase is
 * unusable the first ten words of the brief are the fallback: worse than a
 * subject, better than a paragraph.
 */
async function searchSubject(s: Session, asked: string): Promise<string> {
  const words = asked.split(/\s+/).filter(Boolean);
  if (words.length <= 10 && asked.length <= 90) return asked;
  const fallback = words.slice(0, 10).join(" ");
  try {
    const r = await turn(
      s,
      [
        {
          role: "system",
          content:
            "You turn a research brief into the subject of a literature search. Answer with " +
            "one phrase of three to ten words naming the field and its specific angle — no " +
            "verbs, no instructions, no quotes, nothing else.",
        },
        { role: "user", content: asked },
      ],
      { toOutput: false, forceProvider: true },
    );
    const phrase = r.text
      .split("\n")
      .map((l) => l.trim().replace(/^["“'`]+|["”'`.]+$/g, "").trim())
      .find((l) => l.length > 0);
    const n = phrase ? phrase.split(/\s+/).length : 0;
    return phrase && n >= 2 && n <= 14 ? phrase : fallback;
  } catch {
    return fallback;
  }
}

async function papersRun(row: RunRow, s: Session, v: VentureRow | null, input: Record<string, string>) {
  const asked =
    (input.topic ?? "").trim() ||
    (v ? `${v.name} — ${v.description || "the field this product is in"}`.slice(0, 200) : "");
  if (!asked) throw new Error("A paper needs a topic or a venture, and this run has neither.");
  const topic = await searchSubject(s, asked);

  /* THE SCOUT, FIRST AND ALWAYS. See scout.ts: the citation list has to be a
     closed set handed to the model, or the citations are invented. */
  const scoutStep = s.startStep(
    "scout",
    topic === asked
      ? `OpenAlex and arXiv for “${topic}”`
      : `OpenAlex and arXiv for “${topic}” — the brief, condensed to a subject`,
  );
  const found = await scout(topic);
  saveLibrary(found.papers, topic, v?.id ?? null);
  s.endStep(
    scoutStep,
    found.notes
      .map((n) => `${n.source}: ${n.error ? `failed — ${n.error}` : `${n.found}${n.note ? ` (${n.note})` : ""}`}`)
      .join(", "),
  );

  /* The library is read back from the table rather than used from memory, so
     the paper cites what is actually stored and a citation can always be
     resolved to a row. */
  const stored = libraryRows({ topic, limit: 60 });
  const library: Paper[] = stored.map((r) => ({
    source: r.source as "openalex" | "arxiv",
    extId: r.ext_id,
    doi: r.doi,
    title: r.title,
    authors: (() => {
      try {
        const a = JSON.parse(r.authors) as unknown;
        return Array.isArray(a) ? (a as string[]) : [];
      } catch {
        return [];
      }
    })(),
    year: r.year,
    url: r.url,
    abstract: r.abstract,
  }));

  if (!library.length)
    throw new Error(
      `Neither OpenAlex nor arXiv returned anything for “${topic}”, so there is no library to cite from and no paper can honestly be written. ${found.notes
        .map((n) => `${n.source}: ${n.error ?? `${n.found} results`}`)
        .join("; ")}`,
    );

  const priorRows = db
    .prepare("SELECT title, thesis, contributions FROM papers ORDER BY ts DESC LIMIT 20")
    .all() as unknown as { title: string; thesis: string; contributions: string }[];
  const prior = priorRows.length
    ? priorRows.map((p) => `- “${p.title}” — ${p.thesis}`).join("\n")
    : "None. This is the first paper written here.";

  const scouting = found.notes
    .map((n) => `${n.source} ${n.error ? `failed (${n.error})` : `${n.found} results${n.note ? ` by ${n.note}` : ""}`}`)
    .join(", ");

  const engine = findTypst();
  s.say(
    `# ${topic}\n\n_Scouting: ${scouting}; ${library.length} papers in the library for this topic. ` +
      `Two keyword searches, not a systematic review._\n\n` +
      (engine.found
        ? `_Typesetting with ${engine.path}._\n\n`
        : `_No typesetter: ${engine.error} The paper will be markdown printed by the browser instead._\n\n`),
  );

  const common = { row, s, v, topic, library, priorRows, prior, scouting };
  if (engine.found) await typstPaper({ ...common, typst: engine.path });
  else await chromePaper(common);
}

type PaperCommon = {
  row: RunRow;
  s: Session;
  v: VentureRow | null;
  topic: string;
  library: Paper[];
  priorRows: { title: string; thesis: string }[];
  prior: string;
  scouting: string;
};

/** One paper's row, written by whichever machine made it. One statement rather
 *  than two so the two paths cannot disagree about what a paper record is. */
function shelvePaper(p: {
  row: RunRow;
  v: VentureRow | null;
  topic: string;
  title: string;
  thesis: string;
  contributions: string[];
  mdPath: string | null;
  typPath: string | null;
  pdfPath: string | null;
  cited: string[];
  typeset: "typst" | "chrome" | null;
  columns: number | null;
  pages: number | null;
}) {
  db.prepare(
    `INSERT OR REPLACE INTO papers
       (run_id, venture_id, topic, title, thesis, contributions, md_path, pdf_path, cited, ts,
        typeset, columns, pages, typ_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.row.id,
    p.v?.id ?? null,
    p.topic,
    p.title,
    p.thesis,
    JSON.stringify(p.contributions),
    p.mdPath,
    p.pdfPath,
    JSON.stringify(p.cited),
    now(),
    p.typeset,
    p.columns,
    p.pages,
    p.typPath,
  );
}

/* ------------------------------------------------------------ papers: typst */

/** How long the whole drawing phase may take. Each figure is one or two
 *  completions on the provider and the plan is allowed three of them, so a
 *  slow provider could otherwise spend six calls before a word of the paper is
 *  written. When the budget is gone the remaining figures are simply not drawn
 *  — `cleanBody` removes them from the body and the report says how many. */
const DRAW_BUDGET_MS = 180_000;

async function typstPaper(ctx: PaperCommon & { typst: string }) {
  const { row, s, v, topic, library, priorRows, prior, scouting, typst } = ctx;
  const today = new Date().toISOString().slice(0, 10);

  /*
    THE KEYS ARE MINTED HERE AND NOWHERE ELSE, and they are what makes the
    citation set closed. Every library entry gets one; the model is shown the
    list; `cleanBody` removes any `@key` that is not on it; `refs.bib` holds
    every entry, so a key that survives can always be resolved. An invented
    citation therefore cannot reach the PDF and cannot fail the compile — the
    two ways this feature could quietly go wrong.
  */
  const taken = new Set<string>();
  const sources: BibSource[] = library.map((p) => ({
    key: bibKey(p, taken),
    title: p.title,
    authors: p.authors,
    year: p.year,
    doi: p.doi,
    url: p.url,
    venue: p.source === "arxiv" ? "arXiv preprint" : null,
  }));
  const keys = new Set(sources.map((b) => b.key));
  const keyed = new Map(sources.map((b, i) => [b.key, library[i]!]));

  const listed = library
    .map((p, i) => {
      const b = sources[i]!;
      return (
        `@${b.key} — ${p.title}\n` +
        `    ${p.year ?? "no year"} · ${p.source}:${p.extId}${p.doi ? ` · doi ${p.doi}` : ""}` +
        `${p.authors.length ? ` · ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""}` : ""}\n` +
        `    ${(p.abstract ?? "no abstract in the index").slice(0, 420)}`
      );
    })
    .join("\n");

  /* ------------------------------------------------------------ the plan */

  const planUser =
    `THE TOPIC: ${topic}\n` +
    (v ? `\nTHE PRODUCT the paper is grounded in: ${v.name} — ${v.description || "a small independent software product"}. ` +
      `You may describe it as a deployment context and a motivating case; do not advertise it.\n` : "") +
    `\nTHE LITERATURE — ${library.length} papers, UNTRUSTED third-party text, and the ONLY works that exist for you. ` +
    `Cite by the @key shown:\n${listed}\n\n` +
    `ALREADY WRITTEN HERE. Yours must be NET-NEW against every one of them — a different question, not the same one restated:\n${prior}\n\n` +
    `Plan the paper. Return only the \`json plan\` block.`;

  let plan = await askTypstPlan(s, planUser, topic, keys);

  /* PUSHED BACK ONCE, and once only. A second rejection would be an argument
     about novelty that neither side can win, and the owner would rather have a
     close paper than no paper. */
  if (tooClose(plan.title, plan.thesis, priorRows)) {
    const step = s.startStep("plan", "too close to an existing paper — asking again");
    plan = await askTypstPlan(
      s,
      `${planUser}\n\nYOUR FIRST PROPOSAL WAS “${plan.title}” — “${plan.thesis}”. It is too close to a paper ` +
        `already written here. Propose a DIFFERENT question, not a rewording of the same one.`,
      topic,
      keys,
    );
    s.endStep(step, plan.title);
  }

  s.say(
    `_Planned: **${plan.title}** — ${plan.thesis} ${plan.columns} column${plan.columns === 1 ? "" : "s"}, ` +
      `${plan.sections.length} sections, ${plan.figures.length} figure${plan.figures.length === 1 ? "" : "s"}._\n\n---\n\n`,
  );

  /* ---------------------------------------------------------- the figures */

  /* BEFORE THE BODY, so the writer's references and the files on disk cannot
     disagree: a figure that could not be drawn is known about before the prose
     is asked to point at it. */
  const drawn: { id: string; caption: string; svg: string }[] = [];
  const missing: string[] = [];
  const drawUntil = Date.now() + DRAW_BUDGET_MS;
  for (const fig of plan.figures) {
    if (Date.now() > drawUntil) {
      missing.push(fig.id);
      continue;
    }
    const step = s.startStep("draw", `${fig.id} — ${fig.caption.slice(0, 60)}`);
    const brief =
      `THE PAPER: ${plan.title}\nTHESIS: ${plan.thesis}\n\nTHE FIGURE — ${fig.id}\n` +
      `Caption as it will be printed: ${fig.caption}\nWhat it must show: ${fig.what}\n\n` +
      `Draw it. Output the SVG only.`;
    /* Two attempts, and the second is only ever asked for a NAMED fault — the
       drawing was portrait, or its labels sat on top of one another.
       `fallback` holds the flawed drawing throughout, because a blemished
       diagram still explains more than an absent one: the retry can only
       improve the figure, never cost it. */
    let good: string | null = null;
    let fallback: string | null = null;
    /* What to tell the retry. Either the drawing was REFUSED — it would have
       printed blank, or arrived truncated — or it was kept and is merely the
       wrong shape. Both are things a second attempt can act on, and both are
       written onto the step so a figure that never appears says why. */
    let fault: string | null = null;
    for (let attempt = 0; attempt < 2 && !good; attempt += 1) {
      if (attempt === 1 && Date.now() > drawUntil) break;
      const reply = await turn(
        s,
        [
          { role: "system", content: DRAFTSMAN },
          {
            role: "user",
            content:
              attempt === 0
                ? brief
                : `${brief}\n\nYOUR FIRST ATTEMPT COULD NOT BE USED: ${fault}.\n\nDraw the SAME diagram ` +
                  `again, fixing that. Output nothing but the SVG element, and keep the viewBox between ` +
                  `320 and 560 wide and 150 and 300 tall.`,
          },
        ],
        /*
          THE PROVIDER FIRST, THE AGENT SECOND, and the order is the whole
          argument. `askTypstPlan`'s reason applies here too — this turn wants
          one artefact said out loud, and an agent asked for a file's contents
          writes the file — so the tool-less path is tried first. But an SVG is
          two and a half thousand tokens through an unstreamed `complete()`,
          and on 2026-09-05 all three figures of a run came back
          "FreeLLMAPI did not answer within 120 seconds": a paper with no
          diagram at all, every time, which is not the room this is. The
          agent's path is streamed and has the deadlines for it. It is told, in
          the draftsman's own brief, to use no tools and to answer with the
          element — and if it writes a file instead, `cleanSvg` finds no <svg>
          in the reply and the figure is dropped, which is exactly where the
          provider's timeout left it anyway. The fallback can only help.
        */
        { toOutput: false, forceProvider: attempt === 0 },
      ).catch((e: unknown) => {
        fault = e instanceof Error ? e.message : String(e);
        return null;
      });
      if (!reply) continue;
      const candidate = cleanSvg(reply.text);
      if ("error" in candidate) {
        fault = candidate.error;
        continue;
      }
      fault = figureFault(candidate.svg);
      if (fault) fallback ??= candidate.svg;
      else good = candidate.svg;
    }
    const chosen = good ?? fallback;
    if (chosen) drawn.push({ id: fig.id, caption: fig.caption, svg: chosen });
    else missing.push(fig.id);
    s.endStep(
      step,
      chosen
        ? `${chosen.length} bytes of SVG${good ? "" : ` — kept despite: ${fault}`}`
        : `not drawn — ${fault ?? "the model answered with nothing"}`,
    );
  }

  /* ------------------------------------------------------------ the body */

  const writeUser =
    `THE PLAN — follow it:\n` +
    JSON.stringify(
      {
        title: plan.title,
        thesis: plan.thesis,
        novelty: plan.novelty,
        contributions: plan.contributions,
        sections: plan.sections,
        figures: drawn.map((f) => ({
          file: `${f.id}.svg`,
          label: `<${figureLabel(f.id)}>`,
          caption: f.caption,
          line: figureCall(f.id, f.caption),
        })),
      },
      null,
      1,
    ) +
    `\n\n` +
    (v
      ? `THE PRODUCT the paper is grounded in: ${v.name} — ${v.description || "a small independent software product"}. ` +
        `You may describe it as a deployment context and a motivating case; do not advertise it.\n\n`
      : "") +
    (plan.cite.length
      ? `THE KEYS YOUR OWN PLAN CHOSE. Every one of these must appear in the body, as @key:\n` +
        `${plan.cite.map((k) => `@${k}`).join(", ")}\n\n`
      : "") +
    `CITATION KEYS — the only citations that exist, and the ONLY thing the printed bibliography is ` +
    `built from. Cite as @key:\n${listed}\n\n` +
    `USE NO TOOLS. Do not search the web, do not fetch a URL, do not run a command and do not write to a file. ` +
    `The library above is everything you are allowed to draw on, and the body is your reply — not a document you ` +
    `save somewhere.\n\n` +
    `Write the body now. Start with the first \`=\` heading. Output Typst only — no commentary, no code fence.`;

  const writeStep = s.startStep("write", plan.title);
  const written = await turn(
    s,
    [
      { role: "system", content: WRITER },
      { role: "user", content: writeUser },
    ],
    /* The AGENT when one is live, for the file header's reason: `complete()`
       is not streamed and a whole paper does not fit inside the provider's
       policy timeout. What keeps the citation set closed here is the key list
       above and `cleanBody` below, not the absence of tools. */
    { toOutput: true },
  );
  s.endStep(writeStep, `${written.text.length} characters`);

  let { body, dropped } = cleanBody(written.text, keys, missing);
  if (!/^\s*=\s+\S/m.test(body) || body.length < 800)
    throw new Error(
      "The write turn did not come back with a paper body — nothing in it is a Typst heading. It began: " +
        written.text.slice(0, 300),
    );

  /*
    ONE CONTINUATION, AND ONLY WHEN THE TEXT DID NOT END.

    A completion cut off at its output ceiling is not an error and nothing
    downstream can tell: it cleans, it compiles, it shelves, and the result is
    a beautifully typeset fragment that stops mid-word. `unfinished` is the two
    tests that catch it — the last planned section never appeared, or the text
    has no closing punctuation — and the continuation is shown what has been
    written and asked only for what is left. One pass, not three: a body still
    unfinished after two completions is not running out of budget, it is
    failing to end.
  */
  if (unfinished(body, plan)) {
    const step = s.startStep("write", "the body stopped short — continuing it");
    const done = [...body.matchAll(/^=\s+(.+)$/gm)].map((m) => (m[1] ?? "").trim());
    const placed = new Set([...body.matchAll(/image\("(fig-\d+)\.svg"/g)].map((m) => m[1]!));
    const waiting = drawn.filter((f) => !placed.has(f.id));
    const more = await turn(
      s,
      [
        { role: "system", content: WRITER },
        {
          role: "user",
          content:
            `You are CONTINUING a paper you have already started. Write ONLY what is still missing, ` +
            `beginning at a \`=\` heading. Do not repeat, re-title or summarise what is already written, ` +
            `and do not write an abstract or a references section.\n\n` +
            `THE PLAN — unchanged:\n${JSON.stringify({ title: plan.title, thesis: plan.thesis, sections: plan.sections }, null, 1)}\n\n` +
            `SECTIONS ALREADY WRITTEN: ${done.join(" · ") || "(none)"}\n\n` +
            (waiting.length
              ? `FIGURES NOT YET PLACED — put each one where it belongs, exactly as written here:\n${waiting
                  .map((f) => `  ${figureCall(f.id, f.caption)}`)
                  .join("\n")}\n\n`
              : "") +
            `CITATION KEYS — still the only ones that exist: ${[...keys].join(", ")}\n\n` +
            `THE LAST THING YOU WROTE, so you can pick the thread back up:\n…${body.slice(-900)}\n\nContinue.`,
        },
      ],
      { toOutput: false },
    ).catch(() => null);
    const next = more ? cleanBody(more.text, keys, missing) : null;
    if (next && /^\s*=\s+\S/m.test(next.body) && next.body.length > 300) {
      body = `${trimToSentence(body)}\n\n${next.body}`;
      dropped = {
        commands: dropped.commands + next.dropped.commands,
        citations: [...dropped.citations, ...next.dropped.citations],
        figures: [...dropped.figures, ...next.dropped.figures],
      };
      s.endStep(step, `${next.body.length} more characters`);
    } else s.endStep(step, "the continuation added nothing usable");
  }

  body = placeOrphans(body, drawn);
  /* Wide diagrams take the whole page. Only in two-column papers: a one-column
     paper's text block IS the page width, so there is nothing to span and the
     float would only move the figure away from the sentence about it. */
  if (plan.columns === 2)
    body = spanWideFigures(body, new Set(drawn.filter((f) => wideFigure(f.svg)).map((f) => f.id)));

  /* --------------------------------------------------------- the typeset */

  const dir = paperDir(row.id);
  /* Built fresh. A second run under the same id is a re-run, and a figure left
     over from the first would be a file the new source never references. */
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of drawn) writeFileSync(resolve(dir, `${f.id}.svg`), f.svg, "utf8");
  writeFileSync(resolve(dir, "refs.bib"), renderBib(sources), "utf8");

  const author = paperAuthor();
  const assemble = (b: string) => preamble(plan, author, today) + b + bibliographyCall();
  const typPath = resolve(dir, "paper.typ");
  writeFileSync(typPath, assemble(body), "utf8");

  const setStep = s.startStep("typst", `compiling ${plan.columns} column${plan.columns === 1 ? "" : "s"}`);
  let out = await compile(typst, dir);

  /*
    THE MECHANICAL REPAIRS FIRST, AND THEY COST NOTHING. An `unknown variable`
    in a maths span is a word that wanted quoting, and Typst's own hint says so;
    quoting it is a fix with no judgement in it. Four rounds because a formula
    can carry several such words and each compile names only the first, and a
    round that changes nothing stops the loop — a recompile of an identical
    document would otherwise run for ever.
  */
  let quoted = 0;
  for (let i = 0; i < 4 && !out.ok; i += 1) {
    const fixed = quoteUnknownVariable(body, out.error);
    if (!fixed) break;
    body = fixed;
    quoted += 1;
    writeFileSync(typPath, assemble(body), "utf8");
    out = await compile(typst, dir);
  }
  s.endStep(
    setStep,
    `${out.ok ? "compiled" : `refused — ${out.error.split("\n")[0]}`}${
      quoted ? ` (${quoted} unquoted maths word${quoted === 1 ? "" : "s"} quoted first)` : ""
    }`,
  );

  /*
    REPAIR, ONCE, WITH THE COMPILER'S OWN WORDS. Typst's errors name the line
    and the construct, which is exactly the feedback a model can act on — and
    one round is the right number: a second has never fixed what the first
    could not and it costs another completion to find out.

    THE ERROR THAT TRIGGERED IT IS KEPT EVEN WHEN THE REPAIR WORKS. Recording
    only the final state would shelve a paper that failed and was fixed as an
    unqualified success, and the fault would vanish — and a fault nobody
    records is a fault nobody moves into `cleanBody`, where it would cost
    nothing instead of a completion.
  */
  let repairedFrom: string | null = null;
  if (!out.ok) {
    repairedFrom = out.error;
    const step = s.startStep("repair", "the typesetter refused it — one repair pass");
    const fixed = await turn(
      s,
      [
        { role: "system", content: WRITER },
        {
          role: "user",
          content:
            `The Typst compiler REFUSED this body. Fix it and return the corrected body — the whole body, ` +
            `same content, same sections, only the offending markup repaired. Output Typst only.\n\n` +
            `THE COMPILER SAID:\n${out.error}\n\n` +
            `THE BODY (line 1 below is the first line AFTER the preamble, so the compiler's line numbers are ` +
            `offset — find the construct it names rather than counting):\n${body}`,
        },
      ],
      { toOutput: false },
    ).catch(() => null);
    const repaired = fixed ? cleanBody(fixed.text, keys, missing) : null;
    if (repaired && /^\s*=\s+\S/m.test(repaired.body) && repaired.body.length > 800) {
      body = repaired.body;
      dropped = repaired.dropped;
      writeFileSync(typPath, assemble(body), "utf8");
      out = await compile(typst, dir);
      s.endStep(step, out.ok ? "repaired and compiled" : `still refused — ${out.error.split("\n")[0]}`);
    } else s.endStep(step, "the repair pass returned nothing usable");
  }

  const pdfPath = resolve(dir, "paper.pdf");
  const hasPdf = out.ok && existsSync(pdfPath);
  const pages = hasPdf ? pdfPages(pdfPath) : null;

  /* WHICH KEYS THE FINISHED BODY ACTUALLY CITES, resolved back to library ids.
     This is the check the whole design exists for, and it is made on the text
     that was compiled rather than on the text that was written. */
  const cited = [...new Set([...body.matchAll(/@([a-zA-Z][a-zA-Z0-9_.-]*)/g)].map((m) => m[1]!))]
    .filter((k) => keyed.has(k))
    .map((k) => `${keyed.get(k)!.source}:${keyed.get(k)!.extId}`);

  /* The report the owner reads, which is NOT the paper — the paper is the PDF
     and the .typ beside it. Written over the streamed body on purpose: half a
     Typst source is what made the wait visible, and it is not what anybody
     wants left in the ledger once there is a document to read instead. */
  const mdPath = resolve(dir, "paper.md");
  const report = [
    `# ${plan.title}`,
    ``,
    `_${plan.thesis}_`,
    ``,
    `## Abstract`,
    ``,
    plan.abstract,
    ``,
    ...(plan.contributions.length ? [`## Contributions`, ``, ...plan.contributions.map((c) => `- ${c}`), ``] : []),
    `## How it was made`,
    ``,
    `- Scouting: ${scouting}; ${library.length} papers in the library for “${topic}”. Two keyword searches, not a systematic review.`,
    `- Plan: ${plan.columns} column${plan.columns === 1 ? "" : "s"}, ${plan.sections.length} sections — ${plan.sections.map((x) => x.heading).join(", ")}.`,
    `- Figures: ${drawn.length} drawn${missing.length ? `, ${missing.length} could not be drawn and were removed from the body` : ""}.`,
    `- Citations: ${cited.length} of ${library.length} library works cited. ${
      dropped.citations.length
        ? `${dropped.citations.length} invented citation${dropped.citations.length === 1 ? " was" : "s were"} removed before compiling (${[...new Set(dropped.citations)].slice(0, 6).join(", ")}).`
        : "No invented citations."
    }`,
    ...(dropped.commands ? [`- ${dropped.commands} forbidden Typst command${dropped.commands === 1 ? "" : "s"} dropped from the body.`] : []),
    `- Typesetting: Typst at ${typst}.${
      repairedFrom ? ` The first compile was refused and one repair pass was run — the error was: ${repairedFrom.split("\n")[0]}` : ""
    }`,
    hasPdf
      ? `- PDF: ${pages === null ? "written" : `${pages} page${pages === 1 ? "" : "s"}`}, at ${pdfPath}.`
      : `- NO PDF. The typesetter refused the document${out.ok ? "" : ` — ${out.error.split("\n")[0]}`}. The source is kept at ${typPath} and is the only thing that explains it.`,
    ``,
    `## The paper`,
    ``,
    hasPdf
      ? `The paper itself is the PDF, and the Typst source it was set from is beside it. Neither is this text.`
      : `There is no PDF. The Typst source is at ${typPath}; the compiler's own words are above.`,
    ``,
  ].join("\n");
  writeFileSync(mdPath, report, "utf8");
  s.output = report;
  s.flush();

  shelvePaper({
    row,
    v,
    topic,
    title: plan.title,
    thesis: plan.thesis,
    contributions: plan.contributions,
    mdPath,
    typPath,
    pdfPath: hasPdf ? pdfPath : null,
    cited,
    /* NULL WHEN NOTHING WAS SET. `typst` is a claim about the file that
       exists; a compile that failed produced no file and must not carry a
       claim about how it looks. */
    typeset: hasPdf ? "typst" : null,
    columns: plan.columns,
    pages,
  });

  if (!hasPdf)
    throw new Error(
      `Typst refused the document, and the repair pass did not fix it. The source is at ${typPath}. ` +
        `The compiler said: ${out.ok ? "nothing — but no PDF was written" : out.error.split("\n").slice(0, 3).join(" ")}`,
    );
}

/**
 * The plan turn.
 *
 * ON THE PROVIDER FIRST, because an agent asked for a short JSON object on
 * 2026-09-05 wrote it to /tmp/proposal.json instead of saying it: the turn that
 * wants three sentences goes to the thing that only says sentences.
 *
 * AND ON THE AGENT WHEN THE PROVIDER WILL NOT ANSWER. `complete()` is not
 * streamed and the provider's policy timeout is 120 seconds; on 2026-09-05 a
 * run died on "FreeLLMAPI did not answer within 120 seconds" before a word of
 * the paper was planned, having done the scout, spent the slot and produced
 * nothing. A plan that does not arrive ends the whole run, which makes it the
 * cheapest failure in the pipeline and the most expensive to accept — so the
 * last attempt takes the streamed path, told in terms to answer with the block
 * rather than to save it. If it writes a file anyway the answer has no block in
 * it, which is the same nothing the provider's timeout produced.
 *
 * THE RETRY IS TOLD WHAT WAS WRONG. "fewer than three sections", "no usable
 * abstract" — the validator's complaint is a sentence a model can act on, and
 * a retry that only repeats the question is a retry that repeats the answer.
 */
async function askTypstPlan(s: Session, user: string, topic: string, keys: Set<string>): Promise<PaperPlan> {
  const LAST = 2;
  let complaint: string | null = null;
  for (let attempt = 0; attempt <= LAST; attempt += 1) {
    const onAgent = attempt === LAST;
    const step = attempt === 0 ? null : s.startStep("plan", `${complaint ?? "no answer"} — asking again${onAgent ? " on the agent" : ""}`);
    const res: TurnResult | null = await turn(
      s,
      [
        { role: "system", content: PLANNER },
        {
          role: "user",
          content:
            (complaint
              ? `${user}\n\nYOUR PREVIOUS ANSWER COULD NOT BE USED: ${complaint}\nReturn the plan again, ` +
                `complete, as ONE fenced \`json plan\` block and nothing else.`
              : user) +
            (onAgent
              ? `\n\nUSE NO TOOLS. Do not search, do not fetch, do not run anything and do not write a file. ` +
                `The plan is your REPLY — a fenced \`json plan\` block in the message itself.`
              : ""),
        },
      ],
      { toOutput: false, forceProvider: !onAgent },
    ).catch((err: unknown) => {
      /* A provider that did not answer is not a bad plan, and the run should
         not end on it while there is another thing that will answer. */
      complaint = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (res) {
      const checked = validatePlan(planJson(res.text, fencedJson(res.text, "plan")), keys, defaultColumns());
      if (!("error" in checked)) {
        if (step) s.endStep(step, checked.plan.title);
        return checked.plan;
      }
      complaint = `${checked.error}; the answer began: ${res.text.slice(0, 160)}`;
    }
    if (step) s.endStep(step, complaint);
    if (attempt === LAST)
      throw new Error(`No usable plan for “${topic}” after ${LAST + 1} attempts — ${complaint ?? "nothing answered"}`);
  }
  /* Unreachable: the loop returns a plan or throws on its last pass. Written
     out rather than asserted, because a `!` here would be a claim about
     control flow that a later edit could quietly make false. */
  throw new Error(`The plan turn for “${topic}” produced nothing usable.`);
}

/* ----------------------------------------------------------- papers: chrome */

/**
 * The path this feature shipped with, kept whole for the box with no
 * typesetter on it. Markdown, `[n]` citations against the numbered library,
 * and the PDF printed by the browser that takes the screenshots — a readable
 * document, and the row says `chrome` so nothing downstream can call it a
 * typeset paper.
 */
async function chromePaper(ctx: PaperCommon) {
  const { row, s, v, topic, library, priorRows, prior } = ctx;

  const numbered = library
    .map(
      (p, i) =>
        `[${i + 1}] ${p.title} — ${p.authors.slice(0, 4).join(", ") || "authors not listed"}${p.year ? `, ${p.year}` : ""} (${p.source}:${p.extId}${p.doi ? `, doi ${p.doi}` : ""})${p.url ? ` ${p.url}` : ""}\n     ${(p.abstract ?? "no abstract in the index").slice(0, 400)}`,
    )
    .join("\n");

  const planSystem =
    `You are planning a short research paper. The topic is: ${topic}\n\n` +
    `THE LIBRARY — these are the only works you may cite, by their number:\n${numbered}\n\n` +
    `PAPERS ALREADY WRITTEN HERE. Yours must be NET-NEW against every one of them: a different question, not the same question restated.\n${prior}\n\n` +
    `Reply with ONLY a fenced block, info string exactly \`json plan\`, holding ` +
    `{"title": "…", "thesis": "one sentence saying what you will argue", "contributions": ["…", "…"], "cite": [1, 4, 7]}. ` +
    `\`cite\` is the numbers from the library you intend to use. No prose outside the block.`;

  let plan = await askPlan(s, planSystem, topic);

  if (tooClose(plan.title, plan.thesis, priorRows)) {
    const step = s.startStep("plan", "too close to an existing paper — asking again");
    plan = await askPlan(
      s,
      `${planSystem}\n\nYOUR FIRST PROPOSAL WAS “${plan.title}” — “${plan.thesis}”. It is too close to a paper already written here. Propose a DIFFERENT question, not a rewording of the same one.`,
      topic,
    );
    s.endStep(step, plan.title);
  }

  s.say(`_Planned: **${plan.title}** — ${plan.thesis}_\n\n---\n\n`);

  const writeSystem =
    `You are writing a short research paper — three to six pages of markdown.\n\n` +
    `TITLE: ${plan.title}\nTHESIS: ${plan.thesis}\nCONTRIBUTIONS:\n${plan.contributions.map((c) => `- ${c}`).join("\n")}\n\n` +
    `THE LIBRARY — the ONLY works you may cite. Cite as [n] using these numbers and NOTHING ELSE. ` +
    `Do not name a paper, an author or a year that is not on this list; if the argument needs a source that is not here, ` +
    `say in the text that it is not in the library rather than inventing one. Every [n] you write will be checked against this list.\n${numbered}\n\n` +
    `SHAPE: an H1 with the title, then Abstract, Introduction, the body sections your contributions need, Discussion, Limitations, and References — ` +
    `where References lists ONLY the numbers you actually cited, in the form "[n] Title — authors, year. url".\n\n` +
    `Limitations is not optional and it is not a formality: say what this paper cannot show, including that its library is ` +
    `${library.length} works found by two keyword searches of OpenAlex and arXiv rather than a systematic review.\n\n` +
    `USE NO TOOLS. Do not search the web, do not fetch a URL, do not run a command and do not write to a file. ` +
    `The library above is everything you are allowed to draw on, and the paper is your reply — not a document you save somewhere. ` +
    `Reply with the markdown itself and nothing else.\n\n` +
    `No fenced code blocks anywhere in the paper. Markdown only.`;

  const writeStep = s.startStep("write", plan.title);
  const written = await turn(
    s,
    [
      { role: "system", content: writeSystem },
      { role: "user", content: `Write the paper.` },
    ],
    { toOutput: true },
  );
  s.endStep(writeStep, `${written.text.length} characters`);

  const used = [...new Set([...written.text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))]
    .filter((n) => n >= 1 && n <= library.length)
    .sort((a, b) => a - b);
  const cited = used.map((n) => `${library[n - 1]!.source}:${library[n - 1]!.extId}`);

  const files = writePaperFiles(row.id, plan.title, written.text);
  const printStep = s.startStep("chrome", "printing the PDF");
  const printed = await printPdf(row.id, files.html);
  s.endStep(printStep, printed.ok ? printed.path : `no PDF — ${printed.error}`);

  const pages = printed.ok ? pdfPages(printed.path) : null;

  shelvePaper({
    row,
    v,
    topic,
    title: plan.title,
    thesis: plan.thesis,
    contributions: plan.contributions,
    mdPath: files.md,
    typPath: null,
    pdfPath: printed.ok ? printed.path : null,
    cited,
    typeset: printed.ok ? "chrome" : null,
    columns: null,
    pages,
  });

  s.say(
    `\n\n---\n\n_${cited.length} of ${library.length} library works cited. Markdown at ${files.md}. ` +
      (printed.ok
        ? `PDF at ${printed.path}${pages === null ? "" : `, ${pages} page${pages === 1 ? "" : "s"}`}, rendered by the installed Chrome — this is markdown printed by a browser, not a typeset paper, because no typesetter was found on this box._\n`
        : `No PDF: ${printed.error}_\n`),
  );
}

type Plan = { title: string; thesis: string; contributions: string[] };

async function askPlan(s: Session, system: string, topic: string): Promise<Plan> {
  const res = await turn(
    s,
    [
      { role: "system", content: system },
      { role: "user", content: `Propose the paper on: ${topic}` },
    ],
    /* The provider, not the agent. See the file header: an agent asked to
       propose a paper went and wrote the proposal to a file. */
    { toOutput: false, forceProvider: true },
  );
  const raw = fencedJson(res.text, "plan");
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 300) : "";
  if (!title)
    throw new Error(
      "The plan turn did not come back with a title in a `json plan` block, so there is nothing to write. The answer began: " +
        res.text.slice(0, 300),
    );
  return {
    title,
    thesis: typeof o.thesis === "string" ? o.thesis.trim().slice(0, 2_000) : "",
    contributions: Array.isArray(o.contributions)
      ? o.contributions.filter((c): c is string => typeof c === "string").map((c) => c.trim().slice(0, 500)).slice(0, 8)
      : [],
  };
}

/**
 * Is this the same paper as one already written?
 *
 * A WORD-OVERLAP TEST AND NOTHING CLEVERER, and its limits are the reason it
 * only ever triggers ONE push-back rather than a rejection. Two papers about
 * the same subject share most of their title's nouns whether or not they ask
 * the same question, so this over-fires; asking again costs one completion and
 * the second proposal is kept whatever it says.
 */
function tooClose(title: string, thesis: string, prior: { title: string; thesis: string }[]): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const mine = words(`${title} ${thesis}`);
  if (mine.size < 4) return false;
  for (const p of prior) {
    const theirs = words(`${p.title} ${p.thesis}`);
    if (theirs.size < 4) continue;
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared += 1;
    if (shared / Math.min(mine.size, theirs.size) > 0.6) return true;
  }
  return false;
}
