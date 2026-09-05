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
 *   papers  asks the provider for its PLAN turn only. The plan is a short JSON
 *           object and the agent, asked for one on 2026-09-05, wrote it to
 *           /tmp/proposal.json instead of saying it — so the turn that wants
 *           three sentences goes to the thing that only says sentences.
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
 * that does not depend on a model obeying: every `[n]` in the finished paper is
 * resolved against the library, and one that does not resolve is simply not in
 * `cited`.
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
import { ask, activeBackend, type ChatTurn } from "../../chat/backend.ts";
import { activeProvider, complete, type ProviderId } from "../../models/provider.ts";
import { ventureContext } from "../../routes/ventures.ts";
import { db, now, ventureRowById, type VentureRow } from "../../db.ts";
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
import { printPdf, writePaperFiles } from "./pdf.ts";
import { libraryRows, saveLibrary, scout, type Paper } from "./scout.ts";
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
  if (live) return null;
  if (runningRow()) return null;
  const next = db
    .prepare("SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY queued_at, rowid LIMIT 1")
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
export function pump() {
  const row = claim();
  if (!row) return;
  const started = Date.now();
  const session = new Session(row.id);
  void execute(row, session)
    .then(() => {
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
    })
    .finally(() => {
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
    return { text, backend: backend.id, model };
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
    return { text: reply.text, backend: backend.id, model: reply.model };
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
  return reportRun(row, s, def, venture!, input);
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

async function papersRun(row: RunRow, s: Session, v: VentureRow | null, input: Record<string, string>) {
  const topic =
    (input.topic ?? "").trim() ||
    (v ? `${v.name} — ${v.description || "the field this product is in"}`.slice(0, 200) : "");
  if (!topic) throw new Error("A paper needs a topic or a venture, and this run has neither.");

  /* THE SCOUT, FIRST AND ALWAYS. See scout.ts: the citation list has to be a
     closed set handed to the model, or the citations are invented. */
  const scoutStep = s.startStep("scout", `OpenAlex and arXiv for “${topic}”`);
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

  const numbered = library
    .map(
      (p, i) =>
        `[${i + 1}] ${p.title} — ${p.authors.slice(0, 4).join(", ") || "authors not listed"}${p.year ? `, ${p.year}` : ""} (${p.source}:${p.extId}${p.doi ? `, doi ${p.doi}` : ""})${p.url ? ` ${p.url}` : ""}\n     ${(p.abstract ?? "no abstract in the index").slice(0, 400)}`,
    )
    .join("\n");

  const priorRows = db
    .prepare("SELECT title, thesis, contributions FROM papers ORDER BY ts DESC LIMIT 20")
    .all() as unknown as { title: string; thesis: string; contributions: string }[];
  const prior = priorRows.length
    ? priorRows.map((p) => `- ${p.title} — ${p.thesis}`).join("\n")
    : "None. This is the first paper written here.";

  s.say(
    `# ${topic}\n\n_Scouting: ${found.notes
      .map((n) => `${n.source} ${n.error ? `failed (${n.error})` : `${n.found} results${n.note ? ` by ${n.note}` : ""}`}`)
      .join(", ")}; ${library.length} papers in the library for this topic. Two keyword searches, not a systematic review._\n\n`,
  );

  /* THE PLAN TURN. A title, a thesis and the contributions, before a word of
     the paper is written — so that "is this the same paper as last time?" is a
     question asked of three sentences rather than of six pages. */
  const planSystem =
    `You are planning a short research paper. The topic is: ${topic}\n\n` +
    `THE LIBRARY — these are the only works you may cite, by their number:\n${numbered}\n\n` +
    `PAPERS ALREADY WRITTEN HERE. Yours must be NET-NEW against every one of them: a different question, not the same question restated.\n${prior}\n\n` +
    `Reply with ONLY a fenced block, info string exactly \`json plan\`, holding ` +
    `{"title": "…", "thesis": "one sentence saying what you will argue", "contributions": ["…", "…"], "cite": [1, 4, 7]}. ` +
    `\`cite\` is the numbers from the library you intend to use. No prose outside the block.`;

  let plan = await askPlan(s, planSystem, topic);

  /* PUSHED BACK ONCE, and once only. A second rejection would be an argument
     with a model about novelty that neither side can win, and the owner would
     rather have a close paper than no paper. */
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
    /* The AGENT when one is live, for its streamed deadlines — see the file
       header. What keeps the citation set closed here is the instruction above
       and the resolution check below, not the absence of tools. */
    { toOutput: true },
  );
  s.endStep(writeStep, `${written.text.length} characters`);

  /* Which numbers were actually used, resolved back to library ids. This is
     the check the whole design exists for: a citation that does not resolve is
     visible here rather than in a bibliography nobody verified. */
  const used = [...new Set([...written.text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))]
    .filter((n) => n >= 1 && n <= library.length)
    .sort((a, b) => a - b);
  const cited = used.map((n) => `${library[n - 1]!.source}:${library[n - 1]!.extId}`);

  const files = writePaperFiles(row.id, plan.title, written.text);
  const printStep = s.startStep("chrome", "printing the PDF");
  const printed = await printPdf(row.id, files.html);
  s.endStep(printStep, printed.ok ? printed.path : `no PDF — ${printed.error}`);

  db.prepare(
    `INSERT OR REPLACE INTO papers (run_id, venture_id, topic, title, thesis, contributions, md_path, pdf_path, cited, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    v?.id ?? null,
    topic,
    plan.title,
    plan.thesis,
    JSON.stringify(plan.contributions),
    files.md,
    printed.ok ? printed.path : null,
    JSON.stringify(cited),
    now(),
  );

  s.say(
    `\n\n---\n\n_${cited.length} of ${library.length} library works cited. Markdown at ${files.md}. ` +
      (printed.ok
        ? `PDF at ${printed.path}, rendered by the installed Chrome — this is markdown printed by a browser, not a typeset paper._\n`
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
