/**
 * THE RUN LEDGER, as rows and as documents.
 *
 * Every read and write of `agent_runs` and the three tables that hang off it
 * is here, so the executor and the routes cannot disagree about what a run is.
 * The split is the one the rest of this codebase keeps: snake_case stays in
 * the database, the shaping functions produce the wire shapes, and null on the
 * wire means "asked and not told" rather than zero.
 *
 * `RunSummary` IS THE ONE SHAPE THE PAGE EVER SEES IN A LIST. It carries
 * `steps` as a COUNT and not as the array, and `outputChars` rather than the
 * output. A history list of fifty runs that shipped every report would be
 * megabytes to draw a table of dates; the whole document is one request away
 * at `/api/runs/:id`, which is the only place the words are sent.
 */
import type { RunStatus } from "../../../../shared/runStatus.ts";
import { db, now, ventureRowById } from "../../db.ts";
import { NOW, settleOpenRows } from "../../shared/settle.ts";
import { forgetVideo } from "../video/execute.ts";

/* ------------------------------------------------------------------- rows */

export type RunKind =
  | "research"
  | "competitors"
  | "seo"
  | "demand"
  | "geo"
  | "papers"
  | "shotsqa"
  | "video"
  | "serp"
  | "aso"
  | "campaign"
  /* THE FIRST KIND THAT IS ABOUT A PERSON RATHER THAN A BUSINESS, and the
     first whose worker belongs to no venture at all. Its `venture_id` is NULL
     on every row by construction — see integrations/subagents/store.ts on the
     portfolio roster — which is why `lastRuns` there had to stop filtering
     NULL ventures out. */
  | "dossier";
/* The five states, declared once for the whole box in `shared/runStatus.ts`
   and re-exported here so this area's own callers keep one import for
   everything about a run. It was declared five times — twice on the server,
   three times on the client — which is how `agent_runs` came to carry `paused`
   as a bare column: the enum could not be extended in one place. */
export type { RunStatus };

export type RunRow = {
  paused: number;
  queue_priority: number;
  resume_checkpoints: number;
  id: string;
  kind: string;
  venture_id: string | null;
  title: string;
  input: string;
  status: RunStatus;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  backend: string | null;
  model: string | null;
  steps: string;
  output: string;
  output_chars: number;
  error: string | null;
  ms: number | null;
  usage_prompt: number | null;
  usage_completion: number | null;
};

/**
 * ONE THING THE RUN DID WHILE IT WAS WORKING.
 *
 * The shape is `ChatToolEvent`'s minus what a run has no use for. A tool call
 * an agent reports arrives twice — running, then completed — and is merged
 * into one record with two timestamps, exactly as routes/chat.ts merges them,
 * because the page draws one line per call and not two.
 *
 * THE STEPS A RUN MAKES ITSELF ARE IN HERE TOO, and they are not disguised as
 * tool calls. Scouting OpenAlex, rendering a PDF and asking a judge are things
 * this server did, they take real time, and a progress list that showed only
 * what the AGENT did would go silent for the ninety seconds a paper spends
 * being scouted and printed. `tool` names what it was; there is no field
 * claiming an agent asked for it, because none did.
 */
export type Step = {
  toolCallId: string;
  tool: string;
  label: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/* ------------------------------------------------------------------ reads */

export function runRow(id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function runRows(opts: { kind?: string | null; ventureId?: string | null; limit?: number }): RunRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  args.push(limit);
  return db
    .prepare(
      `SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY queued_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...args) as unknown as RunRow[];
}

/** The one that is working, if any. There is at most one by construction —
 *  see executor.ts — and this is the read that proves it rather than assumes
 *  it: a second row in this state after a crash would show up here. */
export function runningRow(): RunRow | undefined {
  return db
    .prepare("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at LIMIT 1")
    .get() as RunRow | undefined;
}

export function queuedCount(): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'queued'").get() as
    | { n: number }
    | undefined;
  return r?.n ?? 0;
}

/** Where a queued run is in the line, 1-based. Null for anything not queued —
 *  a finished run has no position and 0 would read as "next". */
export function queuePosition(id: string): number | null {
  const rows = db
    .prepare("SELECT id FROM agent_runs WHERE status = 'queued' AND paused = 0 ORDER BY queue_priority DESC, queued_at, rowid")
    .all() as unknown as { id: string }[];
  const i = rows.findIndex((r) => r.id === id);
  return i < 0 ? null : i + 1;
}

/** How many runs landed which way, in one of the four buckets a card draws. */
export type RunTally = { done: number; failed: number; running: number; queued: number };

/**
 * FOLDING `agent_runs` INTO done / failed / running / queued.
 *
 * There were two of these — one grouped by kind for the app cards, one by
 * (kind, venture) for the worker roster — and the second quietly added
 * `WHERE venture_id IS NOT NULL`, so the two answers for one kind differed by
 * exactly the portfolio-wide runs with nothing anywhere saying so. Worse, a
 * fifth status would have been dropped by whichever fold was not updated.
 *
 * One fold now, and the grouping is the parameter. The filter is GONE rather
 * than made an option: grouping by `venture_id` puts the portfolio-wide runs
 * in their own group, which a roster keyed by venture simply never asks for.
 * A count nobody reads is better than a count that silently differs.
 *
 * Counted in SQL rather than by filtering a page of runs in JavaScript,
 * because the page is capped and the counts are about every run there has
 * ever been. One statement whatever the grouping: with a hundred workers, a
 * round trip each to count four statuses would be the page's whole budget
 * spent on arithmetic SQLite does in one pass.
 */
export function runTallies(opts: { groupBy: readonly ("kind" | "venture_id")[] }): Map<string, RunTally> {
  const cols = opts.groupBy.join(", ");
  const rows = db
    .prepare(`SELECT ${cols}, status, COUNT(*) AS n FROM agent_runs GROUP BY ${cols}, status`)
    .all() as unknown as (Record<string, string | null> & { status: string; n: number })[];
  const out = new Map<string, RunTally>();
  for (const r of rows) {
    const key = opts.groupBy.map((c) => r[c]).join(":");
    const t = out.get(key) ?? { done: 0, failed: 0, running: 0, queued: 0 };
    if (r.status === "done") t.done += r.n;
    else if (r.status === "failed") t.failed += r.n;
    else if (r.status === "running") t.running += r.n;
    else if (r.status === "queued") t.queued += r.n;
    /* `cancelled` is counted nowhere on purpose: it is neither an outcome nor
       work outstanding, and folding it into `failed` would say the run broke
       when somebody stopped it. */
    out.set(key, t);
  }
  return out;
}

/** Past runs of one kind for one venture, oldest facts first — what the brief
 *  quotes so a new run knows what has already been said. */
export function pastRuns(kind: string, ventureId: string | null, limit = 8): RunRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_runs
        WHERE kind = ? AND status = 'done' AND ${ventureId ? "venture_id = ?" : "venture_id IS NULL"}
        ORDER BY finished_at DESC LIMIT ?`,
    )
    .all(...(ventureId ? [kind, ventureId, limit] : [kind, limit])) as unknown as RunRow[];
}

/* ----------------------------------------------------------------- writes */

/** A run id the owner can read out loud. Six characters of base 36 after
 *  `r-`, minted until one is free — the same shape and the same loop the
 *  venture ids use. */
export function mintRunId(): string {
  for (;;) {
    const id = `r-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!runRow(id)) return id;
  }
}

export function insertRun(input: {
  id: string;
  kind: string;
  ventureId: string | null;
  title: string;
  input: Record<string, string>;
}): RunRow {
  db.prepare(
    `INSERT INTO agent_runs (id, kind, venture_id, title, input, status, queued_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(input.id, input.kind, input.ventureId, input.title, JSON.stringify(input.input), now());
  return runRow(input.id)!;
}

/** The progress write, called at most once a second by the executor. Deliberately
 *  narrow: it touches only what grows while a run is working, so it can never
 *  reopen a run that another path has already finished. */
export function writeProgress(id: string, patch: { output: string; steps: Step[]; backend?: string | null; model?: string | null }) {
  db.prepare(
    `UPDATE agent_runs
        SET output = ?, output_chars = ?, steps = ?,
            backend = COALESCE(?, backend), model = COALESCE(?, model)
      WHERE id = ? AND status = 'running'`,
  ).run(
    patch.output,
    patch.output.length,
    JSON.stringify(patch.steps),
    patch.backend ?? null,
    patch.model ?? null,
    id,
  );
}

export function finishRunRow(
  id: string,
  patch: {
    status: "done" | "failed" | "cancelled";
    output: string;
    steps: Step[];
    backend: string | null;
    model: string | null;
    error: string | null;
    ms: number | null;
    usage: { prompt: number; completion: number } | null;
  },
) {
  db.prepare(
    `UPDATE agent_runs
        SET status = ?, finished_at = ?, output = ?, output_chars = ?, steps = ?,
            backend = ?, model = ?, error = ?, ms = ?, usage_prompt = ?, usage_completion = ?
      WHERE id = ?`,
  ).run(
    patch.status,
    now(),
    patch.output,
    patch.output.length,
    JSON.stringify(patch.steps),
    patch.backend,
    patch.model,
    patch.error,
    patch.ms,
    patch.usage?.prompt ?? null,
    patch.usage?.completion ?? null,
    id,
  );
}

export function deleteRun(id: string): boolean {
  // A video owns its entire run directory and previews. Remove these before
  // any records, so a filesystem error leaves the generation available to retry.
  forgetVideo(id);
  /* The rows that only exist because of this run go with it. `paper_library`
     does NOT: a paper that exists in the world is not un-published by deleting
     the run that found it, and the next scout would only fetch it again. */
  db.prepare("DELETE FROM geo_answers WHERE run_id = ?").run(id);
  db.prepare("DELETE FROM papers WHERE run_id = ?").run(id);
  const res = db.prepare("DELETE FROM agent_runs WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** Every `running` row, failed, with the reason. Called once at boot — see
 *  the migration header: a ledger must not say work is in progress that
 *  nothing is doing. The rule itself is `shared/settle.ts`; this names the
 *  table and the sentence, which are the only parts that are this area's. */
export function failInterrupted(): number {
  return settleOpenRows({
    table: "agent_runs",
    openWhen: "status = 'running'",
    set: { status: "failed", finished_at: NOW },
    /* COALESCE, so a run that had already written why it broke keeps its own
       reason rather than being retold as a restart. */
    note: { column: "error", text: "interrupted by a restart" },
  });
}

/* ---------------------------------------------------------------- shaping */

export function readSteps(raw: string): Step[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Step[]) : [];
  } catch {
    /* A hand-edited row costs its progress list, not the report. */
    return [];
  }
}

export function readInput(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function shapeRun(r: RunRow) {
  const venture = r.venture_id ? ventureRowById(r.venture_id) : undefined;
  return {
    id: r.id,
    kind: r.kind,
    ventureId: r.venture_id,
    /* Null when the id names nothing — a venture deleted after the run. The
       page draws the run unfiled rather than inventing a name for it. */
    ventureName: venture?.name ?? null,
    title: r.title,
    status: r.status,
    paused: !!r.paused,
    canResume: r.kind === "geo" && ["failed", "cancelled"].includes(r.status) && !!db.prepare("SELECT 1 FROM run_checkpoints WHERE run_id=? LIMIT 1").get(r.id),
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ms: r.ms,
    backend: r.backend,
    model: r.model,
    /* A COUNT here and the array on the single-run document. See the header. */
    steps: readSteps(r.steps).length,
    outputChars: r.output_chars,
    error: r.error,
  };
}
