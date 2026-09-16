import { requireOwner } from "../security/gate.ts";
import { budgets, saveBudgets, queuePaused, setQueuePaused, usageReport } from "../../runtime/budgets.ts";
/**
 * THE RUN ROUTES — start work, watch it, read what it wrote.
 *
 * FOUR ROUTERS IN ONE FILE because they are four views of one thing. `/api/runs`
 * is the ledger; `/api/competitors`, `/api/papers` and `/api/geo` are the three
 * things runs ACCUMULATE, and each of them is meaningless without the run that
 * produced it. Splitting them would mean four files importing the same store
 * and agreeing four times about what a venture key is.
 *
 * THE THREE FILE ROUTES ARE THE ONLY PLACE A FILE ON THIS DISK IS SERVED.
 * `/markdown` is the run's own report and is an attachment; `/pdf` and `/typ`
 * are a paper's PDF and the Typst source it was set from, and both are INLINE
 * — the page shows the paper rather than downloading it. None of them takes a
 * path from the caller: the row says where the file is, and a row with no path
 * 404s with the sentence saying why rather than with "not found".
 *
 * A LIST NEVER CARRIES A REPORT. `GET /api/runs` ships `RunSummary`, which has
 * `outputChars` and not `output` — fifty finished runs is megabytes of markdown
 * to draw a table of dates. The words are at `GET /api/runs/:id` and nowhere
 * else, which is the request the page makes when one is opened.
 *
 * `partial` IS ON THE SINGLE-RUN DOCUMENT AND IT IS NOT DERIVED BY THE CLIENT.
 * A running run's `output` is half a report. The flag says so explicitly rather
 * than leaving every reader to work it out from `status`, because a client that
 * got that wrong would render an unfinished document as a finished one — which
 * is the exact failure the chat route's `partial` column exists to prevent.
 *
 * DELETING A RUNNING RUN IS A 409 AND NOT A CANCEL-AND-DELETE. They are two
 * different intentions and the second one is destructive in a way the first is
 * not: "stop this" leaves the record of what happened, "delete this" does not.
 * A route that quietly did both would let a mis-click destroy a report that was
 * two minutes from finishing.
 */
import { Hono } from "hono";
import { sourceDeletionProblem } from "../publishing/sourceDeletion.ts";
import { existsSync, readFileSync } from "node:fs";
import { db, now, ventureRow, ventureRowById } from "../../db.ts";
import { activeBackend } from "../../chat/backend.ts";
import { activeProvider } from "../../models/provider.ts";
import { KINDS, dossierTitle, fencedJson, kindDef } from "./kinds.ts";
import { cancelRun, pump } from "./executor.ts";
import { libraryRows } from "./scout.ts";
import { lastFocus, openFocus, readChanges, type FocusRow } from "./competitors.ts";
import { daysSince, hostOf } from "./competitorsMerge.ts";
import {
  deleteRun,
  insertRun,
  mintRunId,
  queuePosition,
  queuedCount,
  readInput,
  readSteps,
  runRow,
  runRows,
  runTallies,
  runningRow,
  shapeRun,
} from "./store.ts";

export const runRoutes = new Hono();
export const competitorRoutes = new Hono();
export const paperRoutes = new Hono();
export const geoRoutes = new Hono();

/** Longest an input field may be. A brief is a paragraph; a paste of a whole
 *  document is refused here rather than at the model, where it arrives as an
 *  opaque failure after a long wait and a token bill — routes/chat.ts's rule
 *  about `MAX_MESSAGE`, applied to the same problem. */
const MAX_INPUT = 8_000;

/* ------------------------------------------------------------------ shapes */

function kindInfos() {
  /* Per-kind tallies for the app cards. The fold is `runTallies` in store.ts,
     shared with the worker roster — the two used to be separate copies and one
     of them quietly excluded portfolio-wide runs, so the same kind showed two
     different totals on two pages with nothing saying why. */
  const counts = runTallies({ groupBy: ["kind"] });
  return KINDS.map((k) => ({
    kind: k.kind,
    name: k.name,
    what: k.what,
    needsVenture: k.needsVenture,
    inputs: k.inputs,
    counts: counts.get(k.kind) ?? { done: 0, failed: 0, running: 0, queued: 0 },
  }));
}

/** A JSON array column, read back. A hand-edited row costs the list, not the
 *  document it hangs off. */
const readList = (raw: string): string[] => {
  try {
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? (p as string[]) : [];
  } catch {
    return [];
  }
};

/**
 * THE PAPER BEHIND A RUN, as the wire wants it.
 *
 * One reader and one shaper, used by `GET /api/runs/:id`, by the file routes
 * and by `GET /api/papers`, so the three cannot disagree about what a paper is
 * — which they would, because each of them wants a slightly different subset
 * and each of them would grow its own idea of what `typeset` means.
 *
 * `typeset` IS THE FIELD THAT MUST NOT BE GUESSED AT. `typst` is a compiled
 * document; `chrome` is markdown printed by a browser; null is a paper that
 * produced no PDF, or one written before the distinction was recorded. Null is
 * NOT "probably chrome" and a client that drew it as either would be making a
 * claim this server did not make. Same for `pages`, which is read off the
 * finished file and is null when it could not be read.
 */
type PaperRow = {
  run_id: string;
  venture_id: string | null;
  topic: string;
  title: string;
  thesis: string;
  contributions: string;
  md_path: string | null;
  pdf_path: string | null;
  cited: string;
  ts: string;
  typeset: string | null;
  columns: number | null;
  pages: number | null;
  typ_path: string | null;
};

function paperRow(runId: string): PaperRow | undefined {
  return db.prepare("SELECT * FROM papers WHERE run_id = ?").get(runId) as PaperRow | undefined;
}

function shapePaper(r: PaperRow) {
  return {
    runId: r.run_id,
    ventureId: r.venture_id,
    ventureName: r.venture_id ? (ventureRowById(r.venture_id)?.name ?? null) : null,
    topic: r.topic,
    title: r.title,
    thesis: r.thesis,
    contributions: readList(r.contributions),
    /* Which machine set it, and what it produced. */
    typeset: r.typeset === "typst" || r.typeset === "chrome" ? r.typeset : null,
    columns: r.columns,
    pages: r.pages,
    /* The paths are reported on the disk side and the FILES are served from
       the run — a client must not be handed a local path to fetch. Null says
       there is nothing to fetch; the route says why. */
    markdown: `/api/runs/${r.run_id}/markdown`,
    pdf: r.pdf_path ? `/api/runs/${r.run_id}/pdf` : null,
    source: r.typ_path ? `/api/runs/${r.run_id}/typ` : null,
    pdfOnDisk: r.pdf_path !== null && existsSync(r.pdf_path),
    cited: readList(r.cited),
    ts: r.ts,
  };
}

/* -------------------------------------------------------------- /api/runs */

runRoutes.get("/", (c) => {
  const kind = c.req.query("kind") ?? null;
  const ventureKey = c.req.query("venture") ?? null;
  /* A venture is addressed by id OR slug everywhere on this box, so a filter
     that only understood one of them would silently return nothing for the
     other. An unknown key filters to nothing rather than being ignored: a
     page asking about a venture that does not exist should see an empty list,
     not the whole portfolio. */
  const venture = ventureKey ? ventureRow(ventureKey) : undefined;
  const ventureId = ventureKey ? (venture?.id ?? "\u0000none") : null;
  const limit = Number(c.req.query("limit") ?? 50);

  const running = runningRow();
  return c.json({
    runs: runRows({ kind, ventureId, limit: Number.isFinite(limit) ? limit : 50 }).map(shapeRun),
    /* THE RUNNING ONE IS NOT FILTERED. It is the answer to "is this box busy",
       which is a question about the machine and not about the filter the page
       happens to have applied — a Papers page that showed "idle" while an SEO
       run held the only slot would be lying about why nothing was starting. */
    running: running ? shapeRun(running) : null,
    queued: queuedCount(),
    kinds: kindInfos(),
  });
});

runRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { kind?: unknown; ventureId?: unknown; input?: unknown }
    | null;
  const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
  const def = kindDef(kind);
  if (!def)
    return c.json(
      { error: `"${kind || "(nothing)"}" is not a kind of run. The kinds are ${KINDS.map((k) => k.kind).join(", ")}.` },
      400,
    );

  const key = typeof body?.ventureId === "string" ? body.ventureId.trim() : "";
  const venture = key ? ventureRow(key) : undefined;
  if (key && !venture) return c.json({ error: "No venture by that id or slug." }, 404);
  if (def.needsVenture && !venture)
    return c.json({ error: `${def.name} runs are about one business — send a ventureId.` }, 400);

  const nested = (body?.input ?? {}) as Record<string, unknown>;
  if (typeof nested !== "object" || nested === null || Array.isArray(nested))
    return c.json({ error: "`input` is an object of the kind's fields, or absent." }, 400);

  /*
    THE KIND'S FIELDS ARE ALSO ACCEPTED AT THE TOP LEVEL, and that is for the
    SKILL rather than for the page. A skill action's parameters are scalars by
    construction — see skills/registry.ts, where a parameter has a `type` of
    string or number and nothing else — so an agent calling `runs/start` cannot
    send a nested object without the registry describing something it cannot
    describe. Flattening here costs one merge and keeps the published contract
    (`input`) exactly as it is for the page, which does send the object.

    The nested object WINS on a collision. A client that sent both meant the
    one it built deliberately.
  */
  const raw: Record<string, unknown> = {};
  const top = (body ?? {}) as Record<string, unknown>;
  for (const spec of def.inputs) if (spec.key in top) raw[spec.key] = top[spec.key];
  Object.assign(raw, nested);

  const input: Record<string, string> = {};
  for (const spec of def.inputs) {
    const v = raw[spec.key];
    if (v === undefined || v === null) {
      if (spec.required) return c.json({ error: `${spec.label} is required. ${spec.hint}` }, 400);
      continue;
    }
    if (typeof v !== "string") return c.json({ error: `${spec.label} is text.` }, 400);
    if (v.length > MAX_INPUT)
      return c.json(
        {
          error:
            `${spec.label} is ${v.length.toLocaleString()} characters. The limit is ` +
            `${MAX_INPUT.toLocaleString()} — anything longer is a document rather than a brief.`,
        },
        413,
      );
    if (v.trim()) input[spec.key] = v.trim();
  }

  /* THE ONE CROSS-FIELD RULE, and it is here rather than in `required`
     because it is genuinely a rule about the PAIR: a paper needs a subject,
     and either a venture or a typed topic is one. Marking `topic` required
     would forbid the venture-only case that the app is built around. */
  if (def.kind === "papers" && !venture && !input.topic)
    return c.json({ error: "A paper needs something to be about: choose a venture, or type a topic." }, 400);

  const id = mintRunId();
  /* A DOSSIER IS TITLED AFTER THE PERSON, and by the SAME function the
     dispatch door uses — see `dossierTitle` in kinds.ts. `Dossier — portfolio`
     would have been the fall-through here, which is both useless in a ledger
     of twenty dossiers and, worse, identical for all of them: the previous
     dossier on a person is found by title, so one title for every person would
     have every dossier reporting on the last unrelated one as "what changed". */
  const title =
    def.kind === "papers"
      ? `Paper — ${input.topic ?? venture?.name ?? "untitled"}`
      : def.kind === "dossier"
        ? dossierTitle(input.person ?? "")
        : `${def.name} — ${venture?.name ?? "portfolio"}`;

  insertRun({ id, kind: def.kind, ventureId: venture?.id ?? null, title, input });
  /* Started here rather than left to the next tick, so a box with a free slot
     answers "running" instead of "queued five seconds ago". `pump` is a no-op
     when something else holds the slot. */
  pump();
  const row = runRow(id)!;
  return c.json({ ...shapeRun(row), queuePosition: queuePosition(id) }, 201);
});

runRoutes.get("/controls", c => c.json({ paused: queuePaused(), budgets: budgets(), usage: usageReport(), queue: db.prepare("SELECT id,title,kind,paused FROM agent_runs WHERE status='queued' ORDER BY queue_priority DESC,queued_at,rowid").all() }));
runRoutes.put("/controls", async c => {
  const body = await c.req.json().catch(() => null) as { paused?: unknown; budgets?: unknown } | null;
  if (!body) return c.json({ error: "Expected JSON." }, 400);
  if (body.paused !== undefined && typeof body.paused !== "boolean") return c.json({ error: "paused must be boolean." }, 400);
  if (body.budgets !== undefined) { const denied = await requireOwner(c, async () => {}); if (denied) return denied; const error = saveBudgets(body.budgets); if (error) return c.json({ error }, 400); }
  if (typeof body.paused === "boolean") setQueuePaused(body.paused);
  pump(); return c.json({ ok: true });
});
runRoutes.put("/order", async c => {
  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
  const current = db.prepare("SELECT id FROM agent_runs WHERE status='queued'").all() as {id: string}[];
  if (!Array.isArray(body?.ids) || body.ids.length !== current.length || new Set(body.ids).size !== current.length || !current.every(r => (body.ids as unknown[]).includes(r.id))) return c.json({ error: "The queue changed. Refresh and try again." }, 409);
  const ids = body.ids as string[];
  db.exec("BEGIN IMMEDIATE");
  try { ids.forEach((id,i) => db.prepare("UPDATE agent_runs SET queue_priority=? WHERE id=? AND status='queued'").run(ids.length-i,id)); db.exec("COMMIT"); }
  catch(error) { db.exec("ROLLBACK"); throw error; }
  return c.json({ ok: true });
});
runRoutes.post("/:id/pause", async c => {
  const body = await c.req.json().catch(() => null) as { paused?: unknown } | null;
  if (typeof body?.paused !== "boolean") return c.json({ error: "paused must be boolean." }, 400);
  const result = db.prepare("UPDATE agent_runs SET paused=? WHERE id=? AND status='queued'").run(Number(body.paused),c.req.param("id"));
  if (!result.changes) return c.json({ error: "Only a queued job can be paused. Stop a running job before retrying it." },409);
  pump(); return c.json({ ok: true });
});
runRoutes.post("/:id/retry", c => {
  const row = runRow(c.req.param("id"));
  if (!row) return c.json({ error: "No run by that id." },404);
  if (["running","queued"].includes(row.status)) return c.json({ error: "This job is still active." },409);
  const next = insertRun({ id: mintRunId(), kind: row.kind, title: row.title, ventureId: row.venture_id, input: readInput(row.input) });
  pump(); return c.json(shapeRun(next),201);
});
runRoutes.post("/:id/resume", c => {
  const row = runRow(c.req.param("id"));
  if (!row || !shapeRun(row).canResume) return c.json({ error: "This job has no safely replayable checkpoints. Retry from its saved inputs instead." },409);
  db.prepare("UPDATE agent_runs SET status='queued', resume_checkpoints=1, paused=0, error=NULL, finished_at=NULL WHERE id=? AND status IN ('failed','cancelled')").run(row.id);
  pump(); return c.json(shapeRun(runRow(row.id)!));
});

runRoutes.get("/:id", (c) => {
  const row = runRow(c.req.param("id"));
  if (!row) return c.json({ error: "No run by that id." }, 404);
  const cards = fencedJson(row.output, "cards");
  const paper = row.kind === "papers" ? paperRow(row.id) : undefined;
  return c.json({
    ...shapeRun(row),
    input: readInput(row.input),
    steps: readSteps(row.steps),
    output: row.output,
    /* The words so far are half a document while this is true. See the header. */
    partial: row.status === "running",
    queuePosition: row.status === "queued" ? queuePosition(row.id) : null,
    /* The board suggestions, parsed out of the report the model wrote so every
       client does not have to write the same fence parser. Null when the run
       proposed none — which is different from an empty array, and a page that
       drew "0 suggestions" for a run that never got that far would be
       reporting a result it does not have. */
    cards: Array.isArray(cards) ? cards : null,
    /* THE PAPER, ON THE RUN THAT WROTE IT. A papers run's `output` is a note
       ABOUT the paper — the paper is the PDF and the source beside it — so a
       page that only had the markdown would have to guess whether there is a
       document to show and what engine set it. Null for every other kind, and
       for a paper run that has not written one yet, which is a different thing
       from a paper with no PDF. */
    paper: row.kind === "papers" ? (paper ? shapePaper(paper) : null) : null,
  });
});

runRoutes.post("/:id/cancel", (c) => {
  const res = cancelRun(c.req.param("id"));
  if (!res.ok) return c.json({ error: res.error }, res.status === "missing" ? 404 : 409);
  const row = runRow(c.req.param("id"))!;
  return c.json({ ...shapeRun(row), cancelling: res.status === "cancelling" });
});

runRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  const row = runRow(id);
  if (!row) return c.json({ error: "No run by that id." }, 404);
  if (row.status === "running" || row.status === "queued")
    return c.json(
      {
        error:
          "That run is queued or still working. Cancel it first — stopping a run and " +
          "deleting the record of it are two different things.",
      },
      409,
    );
  const problem = row.kind === "video" ? sourceDeletionProblem("video_job", id) : null;
  if (problem) return c.json({ error: problem }, 409);
  try {
    return c.json({ id, deleted: deleteRun(id) });
  } catch (error) {
    console.error("Run deletion failed", id, error);
    return c.json({ error: "Could not remove all generation files. The generation was kept so you can retry." }, 500);
  }
});

runRoutes.get("/:id/markdown", (c) => {
  const row = runRow(c.req.param("id"));
  if (!row) return c.json({ error: "No run by that id." }, 404);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${row.id}.md"`);
  return c.body(row.output);
});

/**
 * The printed paper.
 *
 * FOUR DIFFERENT 404s WITH FOUR DIFFERENT SENTENCES, because "there is no PDF"
 * has four causes and only one of them is the owner's to fix: this is not a
 * paper run, the paper has not finished, no browser was found on the box, or
 * the file has been deleted from under the row. A single "not found" would send
 * somebody looking for a bug in three of those four cases.
 */
runRoutes.get("/:id/pdf", (c) => {
  const row = runRow(c.req.param("id"));
  if (!row) return c.json({ error: "No run by that id." }, 404);
  if (row.kind !== "papers")
    return c.json(
      {
        error: `Only a paper run has a PDF, and this is a ${row.kind} run. Its report is at /api/runs/${row.id}/markdown.`,
      },
      404,
    );
  const paper = paperRow(row.id);
  if (!paper)
    return c.json(
      {
        error:
          row.status === "done"
            ? "That paper run finished without writing a paper — read its report for why."
            : `That paper run is ${row.status}. There is nothing to print yet.`,
      },
      404,
    );
  if (!paper.pdf_path)
    return c.json(
      {
        error:
          paper.typ_path
            ? `That paper has no PDF: the typesetter refused the document when it was written. ` +
              `The Typst source is at /api/runs/${row.id}/typ and the run's report says what the ` +
              `compiler objected to.`
            : `That paper has no PDF: no Chrome or Chromium was found on this box when it was ` +
              `written, and there was no typesetter either. The markdown is at ` +
              `/api/runs/${row.id}/markdown.`,
      },
      404,
    );
  if (!existsSync(paper.pdf_path))
    return c.json({ error: `The PDF was written to ${paper.pdf_path} and is not there now.` }, 404);
  /* INLINE, NOT AN ATTACHMENT. The page shows the paper in a frame rather than
     handing over a download nobody asked for; a browser that would rather save
     it still can, and the markdown route beside this one is the one that is
     deliberately an attachment. */
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `inline; filename="${row.id}.pdf"`);
  return c.body(new Uint8Array(readFileSync(paper.pdf_path)));
});

/**
 * THE SOURCE THE PAPER WAS SET FROM.
 *
 * Served for the same reason pdf.ts kept the HTML it printed: when a document
 * comes out looking wrong, the source is the only way to tell a bad render
 * from a bad paper — and here it is more than that. The .typ is the artefact;
 * the PDF is a rendering of it. A compile that FAILED has a source and no PDF,
 * which is a real state, and this is the route that can still show what was
 * written.
 *
 * Text, and inline: it is read, not installed.
 */
runRoutes.get("/:id/typ", (c) => {
  const row = runRow(c.req.param("id"));
  if (!row) return c.json({ error: "No run by that id." }, 404);
  if (row.kind !== "papers")
    return c.json({ error: `Only a paper run has a Typst source, and this is a ${row.kind} run.` }, 404);
  const paper = paperRow(row.id);
  if (!paper)
    return c.json(
      {
        error:
          row.status === "done"
            ? "That paper run finished without writing a paper — read its report for why."
            : `That paper run is ${row.status}. Nothing has been set yet.`,
      },
      404,
    );
  if (!paper.typ_path)
    return c.json(
      {
        error:
          `That paper was not typeset — it is markdown printed by the browser, because no ` +
          `typesetter was found on this box when it was written. The markdown is at ` +
          `/api/runs/${row.id}/markdown.`,
      },
      404,
    );
  if (!existsSync(paper.typ_path))
    return c.json({ error: `The source was written to ${paper.typ_path} and is not there now.` }, 404);
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition", `inline; filename="${row.id}.typ"`);
  return c.body(readFileSync(paper.typ_path, "utf8"));
});

/* ------------------------------------------------------- /api/competitors */

type ProfileRow = {
  venture_id: string;
  name: string;
  domain: string | null;
  url: string | null;
  positioning: string | null;
  pricing: string | null;
  strengths: string;
  weaknesses: string;
  sources: string;
  changes: string;
  last_verified: string;
  first_seen: string;
  run_id: string | null;
};

/**
 * One rival on the wire.
 *
 * `verifiedAgo` IS COMPUTED HERE RATHER THAN ON THE CLIENT, and it is the one
 * derived field on this document. Every reader of this route has to decide the
 * same thing — is this row still worth believing — and a browser with a clock
 * eleven minutes off, or one in a timezone that has just crossed midnight,
 * would answer it differently from the box that recorded the date. It is whole
 * days, it is never negative, and it is null only where the date cannot be
 * read at all.
 *
 * `domain` FALLS BACK TO THE URL for rows recorded before that column existed.
 * The migration deliberately back-filled nothing — SQLite has no URL parser
 * and a hand-rolled one in SQL would be a second, worse copy of `hostOf` — so
 * the derivation lives in the one place that owns it and every reader gets the
 * same answer.
 */
function shapeProfile(r: ProfileRow) {
  const v = ventureRowById(r.venture_id);
  return {
    ventureId: r.venture_id,
    ventureName: v?.name ?? null,
    name: r.name,
    domain: r.domain ?? hostOf(r.url),
    url: r.url,
    positioning: r.positioning,
    pricing: r.pricing,
    strengths: readList(r.strengths),
    weaknesses: readList(r.weaknesses),
    sources: readList(r.sources),
    /* WHAT MOVED, AND WHEN, with the sentence the badge prints. Written by the
       merge at sweep time rather than derived here, because the note compares
       against a value only the merge could see. */
    changes: readChanges(r.changes),
    /* WHEN A SWEEP LAST NAMED IT, which is not when it was last written to:
       an owner's edit does not verify anything. See the migration. */
    lastVerified: r.last_verified,
    verifiedAgo: daysSince(r.last_verified),
    firstSeen: r.first_seen,
    runId: r.run_id,
  };
}

/** One "look at this next time" item on the wire, with whatever became of it.
 *  `done` is null-checked rather than sent as a string, because "open" and
 *  "looked at and could not be established" are different answers and a
 *  boolean with a note says both. */
function shapeFocus(f: FocusRow) {
  return {
    id: f.id,
    runId: f.run_id,
    title: f.title,
    detail: f.detail,
    createdAt: f.created_at,
    done: f.done_at !== null,
    doneAt: f.done_at,
    note: f.done_note,
  };
}

competitorRoutes.get("/", (c) => {
  const key = c.req.query("venture") ?? null;
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);

  const profiles = (
    v
      ? (db
          .prepare("SELECT * FROM competitor_profiles WHERE venture_id = ? ORDER BY last_verified DESC, name")
          .all(v.id) as unknown as ProfileRow[])
      : (db
          .prepare("SELECT * FROM competitor_profiles ORDER BY last_verified DESC, name")
          .all() as unknown as ProfileRow[])
  ).map(shapeProfile);

  const runsRow = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(finished_at) AS last FROM agent_runs
        WHERE kind = 'competitors' AND status = 'done'${v ? " AND venture_id = ?" : ""}`,
    )
    .get(...(v ? [v.id] : [])) as { n: number; last: string | null } | undefined;

  /*
    THE FOCUS LIST, AND IT IS ONLY ON THE PER-VENTURE READ. `open` is what
    every sweep so far has left unanswered; `resolved` is the MOST RECENT
    sweep's list with what became of each item. Across the whole portfolio
    neither means anything — six ventures' open questions in one array is a
    list nobody can act on — so the field is an empty pair there rather than a
    mixture, and the shape stays the same either way so no reader has to fork.
  */
  const focus =
    v
      ? { open: openFocus(v.id).map(shapeFocus), resolved: lastFocus(v.id).map(shapeFocus) }
      : { open: [], resolved: [] };

  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    profiles,
    focus,
    runs: runsRow?.n ?? 0,
    lastRun: runsRow?.last ?? null,
    note:
      "`lastVerified` moves only when a sweep NAMED the profile. A rival the " +
      "newest sweep did not mention keeps its old date — silence is not " +
      "verification, and a stale date is the honest record of one. The same " +
      "rule holds for `focus.open`: an item the newest sweep did not answer " +
      "stays open rather than being closed quietly.",
  });
});

competitorRoutes.patch("/:ventureKey/:name", async (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const name = decodeURIComponent(c.req.param("name"));
  const row = db
    .prepare("SELECT * FROM competitor_profiles WHERE venture_id = ? AND name = ?")
    .get(v.id, name) as ProfileRow | undefined;
  if (!row) return c.json({ error: `No profile called "${name}" for ${v.name}.` }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON object." }, 400);

  const sets: string[] = [];
  const args: (string | null)[] = [];
  const text = (key: string, column: string): string | null => {
    if (!(key in body)) return null;
    const value = body[key];
    if (value !== null && typeof value !== "string") return `${key} is text, or null to clear it.`;
    if (typeof value === "string" && value.length > 2_000) return `${key} is at most 2000 characters.`;
    sets.push(`${column} = ?`);
    args.push(value === null ? null : (value as string).trim() || null);
    return null;
  };
  const list = (key: string, column: string): string | null => {
    if (!(key in body)) return null;
    const value = body[key];
    if (!Array.isArray(value)) return `${key} is an array of strings.`;
    sets.push(`${column} = ?`);
    args.push(
      JSON.stringify(
        value.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 400)).slice(0, 12),
      ),
    );
    return null;
  };
  for (const err of [
    text("url", "url"),
    text("positioning", "positioning"),
    text("pricing", "pricing"),
    list("strengths", "strengths"),
    list("weaknesses", "weaknesses"),
  ])
    if (err) return c.json({ error: err }, 400);

  if (!sets.length)
    return c.json({ error: "Nothing to change. Send url, positioning, pricing, strengths or weaknesses." }, 400);

  /*
    `last_verified` IS NOT TOUCHED BY AN EDIT, deliberately. The owner
    correcting a price has not re-verified the rival against its website, and a
    column that moved on every write would stop meaning what the competitors
    app says it means.
  */
  db.prepare(`UPDATE competitor_profiles SET ${sets.join(", ")} WHERE venture_id = ? AND name = ?`).run(
    ...args,
    v.id,
    name,
  );
  const after = db
    .prepare("SELECT * FROM competitor_profiles WHERE venture_id = ? AND name = ?")
    .get(v.id, name) as ProfileRow;
  return c.json(shapeProfile(after));
});

competitorRoutes.delete("/:ventureKey/:name", (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const name = decodeURIComponent(c.req.param("name"));
  const res = db.prepare("DELETE FROM competitor_profiles WHERE venture_id = ? AND name = ?").run(v.id, name);
  if (Number(res.changes) === 0) return c.json({ error: `No profile called "${name}" for ${v.name}.` }, 404);
  return c.json({
    ventureId: v.id,
    name,
    deleted: true,
    note:
      "The next sweep can find it again — deleting a profile forgets what was " +
      "known about it, it does not tell the sweep to ignore it.",
  });
});

/* ------------------------------------------------------------ /api/papers */

paperRoutes.get("/library", (c) => {
  const key = c.req.query("venture") ?? null;
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);
  const topic = c.req.query("topic") ?? null;
  const rows = libraryRows({ ventureId: v?.id ?? null, topic, limit: 300 });
  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    topic,
    papers: rows.map((r) => ({
      source: r.source,
      extId: r.ext_id,
      ventureId: r.venture_id,
      topic: r.topic,
      doi: r.doi,
      title: r.title,
      authors: readList(r.authors),
      year: r.year,
      url: r.url,
      abstract: r.abstract,
      seenAt: r.seen_at,
    })),
    note:
      "The library is what two keyword searches of OpenAlex and arXiv returned " +
      "for a topic in the last year. It is not a systematic review, and a paper " +
      "missing from it was not judged irrelevant — it was not returned.",
  });
});

paperRoutes.get("/", (c) => {
  const key = c.req.query("venture") ?? null;
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);
  const rows = (
    v
      ? db.prepare("SELECT * FROM papers WHERE venture_id = ? ORDER BY ts DESC").all(v.id)
      : db.prepare("SELECT * FROM papers ORDER BY ts DESC").all()
  ) as unknown as PaperRow[];
  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    papers: rows.map(shapePaper),
    note:
      "A paper with `typeset: \"typst\"` was compiled by the typesetter — columns, " +
      "numbered headings and figures, an IEEE bibliography built from the library " +
      "entries its body actually cites. One with `typeset: \"chrome\"` is markdown " +
      "printed by a browser, which is a readable document and is not a typeset " +
      "paper. Null is a paper that produced no PDF, or one written before this " +
      "server recorded the difference — it is not a third engine and it is not a " +
      "guess to be resolved.",
  });
});

/* --------------------------------------------------------------- /api/geo */

geoRoutes.get("/", (c) => {
  const key = c.req.query("venture") ?? null;
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);

  const rows = (
    v
      ? db.prepare("SELECT * FROM geo_answers WHERE venture_id = ? ORDER BY ts DESC, rowid").all(v.id)
      : db.prepare("SELECT * FROM geo_answers ORDER BY ts DESC, rowid LIMIT 500").all()
  ) as unknown as {
    run_id: string;
    venture_id: string;
    provider: string;
    model: string | null;
    question: string;
    answer: string;
    mentioned: number;
    accurate: number | null;
    recommended: number | null;
    ts: string;
  }[];

  const answers = rows.map((r) => ({
    runId: r.run_id,
    ventureId: r.venture_id,
    ventureName: ventureRowById(r.venture_id)?.name ?? null,
    provider: r.provider,
    model: r.model,
    question: r.question,
    answer: r.answer,
    /* Booleans on the wire; 0/1 is SQLite's spelling and the browser should
       not have to know that. Null stays null on the two that are judged. */
    mentioned: r.mentioned === 1,
    accurate: r.accurate === null ? null : r.accurate === 1,
    recommended: r.recommended === null ? null : r.recommended === 1,
    ts: r.ts,
  }));

  /* Grouped by provider, because "which model does not know you exist" is the
     question this data answers and a flat list makes the reader group it. */
  const byProvider: Record<
    string,
    { asked: number; mentioned: number; accurate: number; recommended: number; judged: number }
  > = {};
  for (const a of answers) {
    const b = (byProvider[a.provider] ??= { asked: 0, mentioned: 0, accurate: 0, recommended: 0, judged: 0 });
    b.asked += 1;
    if (a.mentioned) b.mentioned += 1;
    if (a.accurate !== null || a.recommended !== null) b.judged += 1;
    if (a.accurate === true) b.accurate += 1;
    if (a.recommended === true) b.recommended += 1;
  }

  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    answers,
    byProvider,
    live: { provider: activeProvider()?.id ?? null, agent: activeBackend()?.id ?? null },
    generatedAt: now(),
    note:
      "`mentioned` is measured — the name or the host appearing in the answer. " +
      "`accurate` and `recommended` were judged by a second completion and are " +
      "null where it did not answer for that row: null means asked and not " +
      "told, never no. Every answer was given with no tools and no web access.",
  });
});
