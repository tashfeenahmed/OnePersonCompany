/**
 * `/api/migrate` — what came across, and what an adapter would publish.
 *
 * TWO HALVES, ONE PATH, and they are one area because they are one job: moving
 * off a predecessor. The adapter half is about the products, which have to keep
 * publishing after the move; the batch half is about the data, which has to
 * arrive once. Somebody doing this is doing both in the same afternoon.
 *
 * THE IMPORT IS NOT HERE AND CANNOT BE. There is no route that starts one, and
 * that is the same decision `cli/restore.ts` makes for the same reason: an
 * import reads a directory on the machine's filesystem, takes a database
 * backup, and writes to every table in one transaction. A route that did that
 * would take a path from the network and hand it to `readFileSync` — and the
 * only correct answer to "which directory may this application read" is "the
 * one somebody typed into a shell on the box". So this route LISTS and it
 * REVERSES, and `npm run import-workdash` does the rest.
 *
 * ROLLBACK IS A ROUTE, THOUGH, and the asymmetry is deliberate. Undoing takes
 * no path and no input the caller could have made up: it takes a batch id that
 * this database already holds, and deletes exactly the rows named in that
 * batch's id map. It is destructive and it is published as destructive.
 */
import { Hono } from "hono";
import { rmSync, statSync } from "node:fs";
import { MAX_DOC } from "../activity/users.ts";
import { endpoints, populationCounts, recordValidation, validateSample, validations } from "./adapters.ts";
import { batch, batchCounts, batches, mapRows, rollback } from "./store.ts";
import { db } from "../../db.ts";
import { SERIES } from "./mapper.ts";

export const migrateRoutes = new Hono();

/* ------------------------------------------------------------- batches */

/** Every import, newest first, with what it created. */
migrateRoutes.get("/batches", (c) => {
  const rows = batches(100).map((b) => ({
    id: b.id,
    source: b.source,
    kind: b.kind,
    dryRun: b.dry_run === 1,
    startedAt: b.started_at,
    finishedAt: b.finished_at,
    kinds: b.kinds ? b.kinds.split(",") : [],
    counts: JSON.parse(b.counts || "{}") as Record<string, unknown>,
    /** What is actually in the database because of this batch, counted from
     *  the id map rather than from what the run reported. The two can differ
     *  after a rollback, and the id map is the one that is true. */
    created: batchCounts(b.id),
    problems: JSON.parse(b.problems || "[]") as string[],
    backup: b.backup,
    ok: b.ok === null ? null : b.ok === 1,
    error: b.error,
    rolledBackAt: b.rolled_back_at,
    /** A dry run wrote nothing and a rolled-back one no longer holds anything;
     *  both are undoable only in the sense that there is nothing to undo. */
    reversible: b.dry_run === 0 && !b.rolled_back_at,
  }));
  return c.json({
    batches: rows,
    note:
      "One row is one run of `npm run import-workdash`. `counts` is what the run reported; `created` is what the id map says is in the database now, " +
      "which is the number a rollback would remove. A dry run writes nothing anywhere and is recorded because the counts it produced are what a decision was made on.",
  });
});

/** One batch, with the id map itself — every source row and what it became. */
migrateRoutes.get("/batches/:id", (c) => {
  const id = c.req.param("id");
  const row = batch(id);
  if (!row) return c.json({ error: `There is no batch ${id}.` }, 404);
  const map = mapRows(id);
  const history = db
    .prepare("SELECT source, metric, subject, COUNT(*) AS n, MIN(period) AS from_, MAX(period) AS to_, reason FROM migrate_history WHERE batch = ? GROUP BY source, metric, subject")
    .all(id) as unknown as { source: string; metric: string; subject: string; n: number; from_: string; to_: string; reason: string }[];
  const files = db
    .prepare("SELECT path, bytes, target_kind, target_id FROM migrate_files WHERE batch = ?")
    .all(id) as unknown as { path: string; bytes: number; target_kind: string; target_id: string }[];

  return c.json({
    batch: {
      id: row.id, source: row.source, dryRun: row.dry_run === 1,
      startedAt: row.started_at, finishedAt: row.finished_at,
      kinds: row.kinds ? row.kinds.split(",") : [],
      counts: JSON.parse(row.counts || "{}") as Record<string, unknown>,
      problems: JSON.parse(row.problems || "[]") as string[],
      backup: row.backup, ok: row.ok === null ? null : row.ok === 1,
      error: row.error, rolledBackAt: row.rolled_back_at,
    },
    map: map.map((m) => ({
      sourceKind: m.source_kind, sourceId: m.source_id,
      targetKind: m.target_kind, targetId: m.target_id,
      created: m.created === 1,
    })),
    history: history.map((h) => ({ ...h, from: h.from_, to: h.to_, from_: undefined, to_: undefined })),
    files,
    note:
      "`created: false` on a mapping means this batch pointed at a row that was already here — a venture the owner had typed — and did NOT make it. " +
      "A rollback deletes what it created and leaves what it matched.",
  });
});

/**
 * Undo one batch.
 *
 * DESTRUCTIVE AND SAID SO. It deletes rows, and the rows it deletes may have
 * been edited since they arrived — a card somebody rewrote is still a card this
 * batch created, and undoing the import takes it. That is the honest meaning of
 * "undo an import" and there is no version of it that keeps the edits.
 */
migrateRoutes.post("/batches/:id/rollback", (c) => {
  const id = c.req.param("id");
  const result = rollback(id, (path) => {
    /* A file whose size no longer matches what was copied is somebody's
       replacement and is left alone. See 294's header. */
    const recorded = db
      .prepare("SELECT bytes FROM migrate_files WHERE path = ? ORDER BY imported_at DESC LIMIT 1")
      .get(path) as { bytes: number } | undefined;
    try {
      const size = statSync(path).size;
      if (recorded && size !== recorded.bytes)
        return { ok: false, why: `it is ${size} bytes now and was ${recorded.bytes} when it was copied in, so something has replaced it.` };
      rmSync(path);
      return { ok: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return { ok: true };
      return { ok: false, why: err instanceof Error ? err.message : String(err) };
    }
  });
  if (!result.ok) return c.json({ error: result.error, problems: result.problems }, 409);
  return c.json({
    ...result,
    note:
      "Deleted exactly what this batch created, by its id map, in an order that respects the foreign keys. " +
      "Rows it only MATCHED — a venture that already existed — are untouched. A copied file that has since changed size was kept and is named.",
  });
});

/* ------------------------------------------------------------ history */

/** The provenance-tagged history, and the reason each series is in here rather
 *  than in a live table. */
migrateRoutes.get("/history", (c) => {
  const source = (c.req.query("source") ?? "").trim();
  const rows = db
    .prepare(
      `SELECT source, metric, subject, window, unit, reason, COUNT(*) AS rows_, MIN(period) AS from_, MAX(period) AS to_
         FROM migrate_history ${source ? "WHERE source = ?" : ""}
        GROUP BY source, metric, subject ORDER BY source, metric, subject`,
    )
    .all(...(source ? [source] : [])) as unknown as {
    source: string; metric: string; subject: string; window: string;
    unit: string | null; reason: string; rows_: number; from_: string; to_: string;
  }[];
  return c.json({
    series: rows.map((r) => ({
      source: r.source, metric: r.metric, subject: r.subject || null,
      window: r.window, unit: r.unit, rows: r.rows_, from: r.from_, to: r.to_, reason: r.reason,
    })),
    plan: SERIES.map((s) => ({ series: s.series, window: s.window, wouldGoTo: s.target, reason: s.reason })),
    note:
      "NOTHING IN THIS TABLE IS JOINED INTO A CHART, and that is the point of it. `plan` is the table of reasoning: for each of the predecessor's series, " +
      "the table it would have gone into and why it did not. Two reasons recur — this box's daily tables are keyed by the plugin account that fetched them, " +
      "and the one that is not (gsc_days) holds a DAY's clicks where the source holds a rolling 28-day total. `window` says what a row means: " +
      "`day` is one day, `rolling` is a window ending that day, `level` is a snapshot, `cumulative` only rises.",
  });
});

/* ----------------------------------------------------------- adapters */

/** Every configured product endpoint, with its last read and last validation. */
migrateRoutes.get("/adapters", (c) =>
  c.json({
    endpoints: endpoints(),
    populations: populationCounts(),
    validated: validations().length,
    note:
      "`lastRead` is the collector; `validated` is a sample somebody checked here, which is a different thing and can exist before an endpoint is connected. " +
      "A `metrics` entry with a `why` is a MAPPING ERROR and never a zero — the path matches nothing in the document the endpoint actually answers with. " +
      "`populations` is what is in the users table right now; a product that never sends the field counts entirely as `customer`, which is the documented default.",
  }),
);

/**
 * A sample payload against the live contract.
 *
 * `{ "endpoint": "Example App 1", "payload": { … } }`, or the document itself as
 * the body. It calls the collector's own validator — see adapters.ts — so the
 * sentences here are the sentences that would be stored, not a second opinion.
 */
migrateRoutes.post("/adapters/validate", async (c) => {
  const raw = await c.req.text();
  if (!raw.trim()) return c.json({ error: "Send the sample document as the body, or { endpoint, payload }." }, 400);
  if (raw.length > MAX_DOC)
    return c.json(
      { error: `That is ${Math.round(raw.length / 1024)} KB and the contract's cap is ${MAX_DOC / 1024} KB — the collector would refuse it unparsed, so this does too.` },
      413,
    );

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return c.json({ error: `That is not JSON: ${err instanceof Error ? err.message : String(err)}` }, 400);
  }

  const wrapper = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const wrapped = wrapper && wrapper.payload !== undefined;
  const doc = wrapped ? wrapper.payload : body;
  const endpoint = wrapper && typeof wrapper.endpoint === "string" ? wrapper.endpoint.trim() : "";

  const result = validateSample(doc);
  if (endpoint) recordValidation(endpoint, "users", result, raw.length);

  return c.json({
    ...result,
    endpoint: endpoint || null,
    stored: !!endpoint,
    note:
      (endpoint
        ? `Recorded against “${endpoint}”. Only the counts and the problems are kept — not the rows, not the addresses, not the document. `
        : "Not recorded: pass { endpoint, payload } to keep the result beside that endpoint on the migration page. ") +
      result.note,
  });
});
