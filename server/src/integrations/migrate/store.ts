/**
 * BATCHES, THE ID MAP, AND UNDO.
 *
 * Everything the importer writes goes through here, and it exists as its own
 * module for one reason: the CLI and the routes must agree about what a batch
 * IS. `cli/import-workdash.ts` creates them and `routes.ts` lists and reverses
 * them, and if those two had their own idea of which tables a batch touched,
 * the rollback button would leave rows behind and nobody would find out for a
 * year.
 *
 * THE ID MAP IS THE WHOLE MECHANISM. A row of `migrate_id_map` says "WorkDash's
 * project `example-app-1` became this box's venture `v-a1b2c3`, in batch `b-…`, and
 * this batch CREATED it". Three things fall out of that one row:
 *
 *   - the import is idempotent, because a second run finds the mapping and
 *     updates instead of inserting a second venture;
 *   - it is referential, because a card naming a project resolves through the
 *     map without the importer holding the graph in memory;
 *   - it is reversible, because undo is "delete the target rows this batch
 *     created", in an order that respects the foreign keys.
 *
 * `created = 0` IS THE ONE SUBTLETY AND IT IS LOAD-BEARING. When an import
 * finds a venture that already exists — same slug, typed by the owner months
 * ago — it maps onto it rather than making a second one, and records that it
 * did NOT create it. A rollback then leaves that venture alone. Without the
 * column, undoing an import would delete a business because a folder in another
 * application happened to share its name.
 */
import { rmSync, statSync } from "node:fs";
import { db, now } from "../../db.ts";

export type Batch = {
  id: string;
  source: string;
  kind: string;
  dry_run: number;
  started_at: string;
  finished_at: string | null;
  kinds: string;
  counts: string;
  problems: string;
  backup: string | null;
  ok: number | null;
  error: string | null;
  rolled_back_at: string | null;
};

/** Every kind of thing the importer can carry across, in the order a rollback
 *  must delete them: children first, so no foreign key is ever left dangling.
 *  `studio_post` references `ventures`, so it goes before them; `venture` is
 *  last for the same reason. */
export const TARGETS: { kind: string; table: string; key: string; rows?: string }[] = [
  { kind: "studio_post", table: "studio_posts", key: "id" },
  { kind: "video_job", table: "video_jobs", key: "run_id" },
  { kind: "board_card", table: "board_cards", key: "id" },
  /* A chat SESSION is not a row anywhere: chat_messages carries a session_id
     and that is the whole of it. So the map's target for a chat is the session
     id, and undoing one deletes every message under it — which is right,
     because the batch created every one of them. `rows` says what the delete
     count means for this one; see rollback. */
  { kind: "chat_session", table: "chat_messages", key: "session_id", rows: "message" },
  { kind: "memory", table: "chief_memory", key: "id" },
  { kind: "outcome", table: "chief_outcomes", key: "id" },
  { kind: "outbox", table: "mailflow_outbox", key: "id" },
  /* chief_goals has a COMPOSITE key — (scope, venture_id) — so its target id is
     the two joined by GOAL_KEY, and `rollback` splits it back out. It is the
     only entry here whose id is not one column's value, which is why `key` is
     empty on it. */
  { kind: "goal", table: "chief_goals", key: "" },
  { kind: "venture", table: "ventures", key: "id" },
];

const TARGET_KINDS = new Set(TARGETS.map((t) => t.kind));

/** How a goal's two key columns are joined into one target id. A pipe because
 *  neither a scope ("global" | "venture") nor a venture id ("v-" and six
 *  base36) can contain one — a separator that CAN appear in the thing it
 *  separates is a rollback that deletes the wrong row. */
export const GOAL_KEY = "|";
export const goalTarget = (scope: string, ventureId: string) => `${scope}${GOAL_KEY}${ventureId}`;

/* ------------------------------------------------------------------ ids */

/** `b-` and eight base36 characters. Short enough to type into a rollback
 *  command, long enough that two imports a second apart cannot collide. */
export function newBatchId(): string {
  for (;;) {
    const id = `b-${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
    if (!db.prepare("SELECT 1 FROM migrate_batches WHERE id = ?").get(id)) return id;
  }
}

/* -------------------------------------------------------------- batches */

export function openBatch(input: {
  id: string;
  source: string;
  kind?: string;
  dryRun: boolean;
  kinds: string[];
}): void {
  db.prepare(
    `INSERT INTO migrate_batches (id, source, kind, dry_run, started_at, kinds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.source, input.kind ?? "workdash", input.dryRun ? 1 : 0, now(), input.kinds.join(","));
}

export function closeBatch(
  id: string,
  fields: { ok: boolean; counts: unknown; problems: string[]; backup?: string | null; error?: string | null },
): void {
  db.prepare(
    `UPDATE migrate_batches
        SET finished_at = ?, ok = ?, counts = ?, problems = ?, backup = ?, error = ?
      WHERE id = ?`,
  ).run(
    now(),
    fields.ok ? 1 : 0,
    JSON.stringify(fields.counts ?? {}),
    JSON.stringify(fields.problems ?? []),
    fields.backup ?? null,
    fields.error ?? null,
    id,
  );
}

export function batch(id: string): Batch | undefined {
  return db.prepare("SELECT * FROM migrate_batches WHERE id = ?").get(id) as unknown as Batch | undefined;
}

export function batches(limit = 50): Batch[] {
  return db
    .prepare("SELECT * FROM migrate_batches ORDER BY started_at DESC LIMIT ?")
    .all(limit) as unknown as Batch[];
}

/* --------------------------------------------------------------- id map */

export type MapRow = {
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  batch: string;
  imported_at: string;
  created: number;
};

/** What a source id already became, if anything. The importer's first question
 *  about every record it reads. */
export function mapped(sourceKind: string, sourceId: string): MapRow | undefined {
  return db
    .prepare("SELECT * FROM migrate_id_map WHERE source_kind = ? AND source_id = ?")
    .get(sourceKind, sourceId) as unknown as MapRow | undefined;
}

export function remember(input: {
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  batch: string;
  created: boolean;
}): void {
  if (!TARGET_KINDS.has(input.targetKind))
    throw new Error(
      `“${input.targetKind}” is not a target kind this can undo. Add it to TARGETS in migrate/store.ts, ` +
        `or the rollback will silently leave its rows behind — which is worse than not importing them.`,
    );
  db.prepare(
    `INSERT INTO migrate_id_map (source_kind, source_id, target_kind, target_id, batch, imported_at, created)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(source_kind, source_id) DO UPDATE SET
       target_kind = excluded.target_kind,
       target_id = excluded.target_id,
       batch = excluded.batch,
       imported_at = excluded.imported_at,
       -- A re-import of something an EARLIER batch created keeps created = 1,
       -- because it is still a row no human typed and still a row this
       -- machinery is responsible for removing. Only a mapping that never
       -- created anything stays at 0.
       created = MAX(migrate_id_map.created, excluded.created)`,
  ).run(
    input.sourceKind,
    input.sourceId,
    input.targetKind,
    input.targetId,
    input.batch,
    now(),
    input.created ? 1 : 0,
  );
}

export function mapRows(batchId: string): MapRow[] {
  return db
    .prepare("SELECT * FROM migrate_id_map WHERE batch = ?")
    .all(batchId) as unknown as MapRow[];
}

/** How many of each target kind a batch created — what the page shows beside
 *  the rollback button, so nobody presses it without knowing the size. */
export function batchCounts(batchId: string): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT target_kind, COUNT(*) AS n FROM migrate_id_map WHERE batch = ? AND created = 1 GROUP BY target_kind",
    )
    .all(batchId) as unknown as { target_kind: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.target_kind] = r.n;
  const history = (
    db.prepare("SELECT COUNT(*) AS n FROM migrate_history WHERE batch = ?").get(batchId) as { n: number }
  ).n;
  if (history) out.history = history;
  const files = (
    db.prepare("SELECT COUNT(*) AS n FROM migrate_files WHERE batch = ?").get(batchId) as { n: number }
  ).n;
  if (files) out.file = files;
  return out;
}

/* ---------------------------------------------------------------- files */

export function rememberFile(input: {
  batch: string;
  path: string;
  sourcePath: string;
  bytes: number;
  targetKind: string;
  targetId: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO migrate_files (batch, path, source_path, bytes, target_kind, target_id, imported_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(input.batch, input.path, input.sourcePath, input.bytes, input.targetKind, input.targetId, now());
}

/* ------------------------------------------------------------- history */

export function writeHistory(input: {
  batch: string;
  source: string;
  metric: string;
  subject: string;
  period: string;
  window: string;
  value: number;
  unit: string | null;
  reason: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO migrate_history
       (batch, source, metric, subject, period, window, value, unit, reason, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.batch, input.source, input.metric, input.subject, input.period,
    input.window, input.value, input.unit, input.reason, now(),
  );
}

/* -------------------------------------------------------------- undoing */

/**
 * The file half of an undo, written once because two callers do it.
 *
 * A FILE THAT IS NO LONGER THE BYTES THAT WERE COPIED IS SOMEBODY'S
 * REPLACEMENT and is kept, named, and reported. An undo is allowed to fail
 * loudly and is never allowed to delete something it did not put there. A file
 * that is already gone is a success: the outcome asked for is that it not be
 * there.
 */
export function removeCopied(path: string, bytes: number): { ok: boolean; why?: string } {
  try {
    const size = statSync(path).size;
    if (size !== bytes)
      return { ok: false, why: `it is ${size} bytes now and was ${bytes} when it was copied in, so something has replaced it.` };
    rmSync(path);
    return { ok: true };
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { ok: true };
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

export type RollbackResult = {
  ok: boolean;
  batch: string;
  deleted: Record<string, number>;
  filesRemoved: number;
  filesKept: { path: string; why: string }[];
  problems: string[];
  error?: string;
};

/**
 * Undo one batch, exactly.
 *
 * ONE TRANSACTION FOR THE ROWS. A rollback that deleted the ventures and then
 * failed on the cards would leave a database in a state neither the import nor
 * the undo describes, and there is no third command to run.
 *
 * FILES ARE REMOVED AFTER THE COMMIT AND ONLY WHEN THEY ARE UNCHANGED. Undo is
 * allowed to fail loudly and is never allowed to delete something it did not
 * put there — an image somebody has since replaced keeps its bytes and is
 * reported by name, which is a nuisance the owner can resolve and a deletion
 * they could not.
 */
export function rollback(
  batchId: string,
  /** Take the file away, unless it is no longer the `bytes` that were copied. */
  remove: (path: string, bytes: number) => { ok: boolean; why?: string },
): RollbackResult {
  const row = batch(batchId);
  if (!row)
    return { ok: false, batch: batchId, deleted: {}, filesRemoved: 0, filesKept: [], problems: [], error: `There is no batch ${batchId}.` };
  if (row.rolled_back_at)
    return {
      ok: false, batch: batchId, deleted: {}, filesRemoved: 0, filesKept: [], problems: [],
      error: `Batch ${batchId} was already rolled back at ${row.rolled_back_at}. Rolling it back twice would delete rows a later import created.`,
    };
  if (row.dry_run)
    return {
      ok: false, batch: batchId, deleted: {}, filesRemoved: 0, filesKept: [], problems: [],
      error: `Batch ${batchId} was a dry run. It wrote nothing, so there is nothing to undo.`,
    };

  const rows = mapRows(batchId).filter((r) => r.created === 1);
  const deleted: Record<string, number> = {};
  const problems: string[] = [];

  db.exec("BEGIN");
  try {
    for (const target of TARGETS) {
      const mine = rows.filter((r) => r.target_kind === target.kind);
      if (!mine.length) continue;

      if (target.kind === "goal") {
        /* The composite key, split back out. See TARGETS. */
        const stmt = db.prepare("DELETE FROM chief_goals WHERE scope = ? AND venture_id = ?");
        let n = 0;
        for (const r of mine) {
          const [scope, venture = ""] = r.target_id.split(GOAL_KEY);
          n += Number(stmt.run(scope!, venture).changes);
        }
        if (n) deleted.goal = n;
        continue;
      }

      /* An outcome's READINGS have no foreign key onto it — see 143's header:
         a reading is evidence and survives the claim being deleted by hand.
         That is right for a delete somebody makes on purpose and wrong for an
         undo, which has to leave nothing behind, so they go first and here
         rather than by a constraint. */
      if (target.kind === "outcome") {
        const cut = db.prepare("DELETE FROM chief_outcome_readings WHERE outcome_id = ?");
        let readings = 0;
        for (const r of mine) readings += Number(cut.run(r.target_id).changes);
        if (readings) deleted.outcome_reading = readings;
      }

      const stmt = db.prepare(`DELETE FROM ${target.table} WHERE ${target.key} = ?`);
      let n = 0;
      for (const r of mine) n += Number(stmt.run(r.target_id).changes);

      /* ONE DELETE IS NOT ONE ROW OF THIS KIND FOR EVERY TARGET. A chat session
         is one mapping and N messages, so `changes` counts messages — and
         reporting 3 under `chat_session`, where every other key means "rows of
         that kind", makes one conversation look like three. Both numbers are
         given, under names that say which is which. */
      if (target.rows) {
        if (mine.length) deleted[target.kind] = mine.length;
        if (n) deleted[`${target.kind}_${target.rows}`] = n;
        continue;
      }

      if (n) deleted[target.kind] = n;
      if (n < mine.length)
        problems.push(
          `${mine.length - n} ${target.kind} row(s) named by the id map were already gone from ${target.table}. ` +
            `Something else deleted them between the import and now; nothing was left behind.`,
        );
    }

    const history = Number(db.prepare("DELETE FROM migrate_history WHERE batch = ?").run(batchId).changes);
    if (history) deleted.history = history;

    db.prepare("DELETE FROM migrate_id_map WHERE batch = ?").run(batchId);
    db.prepare("UPDATE migrate_batches SET rolled_back_at = ? WHERE id = ?").run(now(), batchId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return {
      ok: false, batch: batchId, deleted: {}, filesRemoved: 0, filesKept: [], problems,
      error: `Nothing was deleted: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const files = db
    .prepare("SELECT path, bytes FROM migrate_files WHERE batch = ?")
    .all(batchId) as unknown as { path: string; bytes: number }[];
  let filesRemoved = 0;
  const filesKept: { path: string; why: string }[] = [];
  for (const f of files) {
    /* THE BYTE COUNT IS PASSED IN RATHER THAN LOOKED UP AGAIN. Two batches can
       copy to the same target path — a second import of the same directory
       does exactly that — and a lookup by path alone finds whichever row was
       written last, which is not necessarily this batch's. Comparing against
       the wrong number either deletes a file that changed or keeps one that
       did not. */
    const got = remove(f.path, f.bytes);
    if (got.ok) filesRemoved += 1;
    else filesKept.push({ path: f.path, why: got.why ?? "it could not be removed" });
  }
  db.prepare("DELETE FROM migrate_files WHERE batch = ?").run(batchId);

  return { ok: true, batch: batchId, deleted, filesRemoved, filesKept, problems };
}
