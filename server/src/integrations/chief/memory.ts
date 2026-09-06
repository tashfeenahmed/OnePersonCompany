/**
 * AGENT MEMORY — what the Chief of Staff KNOWS, as opposed to what it can go
 * and look up.
 *
 * THE SKILLS SURFACE ALREADY ANSWERS "WHAT IS THE NUMBER". Nothing on this box
 * held the other half: the durable facts nobody measures. That the owner will
 * not do paid ads. That one venture's churn is mostly trials that never
 * activated. That a venture's host is behind a proxy and the uptime figure is
 * about the proxy. Those are learned once and then either written down or
 * relearned every conversation.
 *
 * A NOTE IS A DATED BELIEF, NOT A FACT, and the whole file is arranged so a
 * reader cannot lose that. Every note carries who formed it (`source`), when
 * (`createdAt`) and when it was last stood behind (`lastConfirmedAt`), and the
 * prompt rendering states all three in words — "you told me, 3 days ago",
 * "I noticed, 4 months ago". A belief presented with its age attached is one an
 * owner can correct; the same belief presented as a fact is one they have to
 * argue with.
 *
 * THE NUMBERS GATE. The most common bad note an assistant writes is a
 * measurement: "MRR is €412". It is true for a day and wrong for ever after,
 * and the collectors already serve the live figure. So a note the AGENT writes
 * that reads as a metrics snapshot is REFUSED, with a refusal that says what to
 * save instead. An owner writing the same sentence is not refused — it is their
 * memory, and being wrong in it is their business.
 *
 * THIS IS NOT HERMES' MEMORY. The managed agent keeps its own MEMORY.md and
 * USER.md in its own directory; those are that backend's and they go with it.
 * This table is the DASHBOARD's, injected into the system turns of every
 * backend — managed agent, remote agent, raw provider — so what the assistant
 * knows about the owner does not change when the owner changes which model is
 * answering.
 *
 * THE CONSOLIDATION PASS IS REVERSIBLE BY CONSTRUCTION. It asks a model to
 * merge duplicates and drop stale notes, and a model asked to delete will
 * sometimes delete the wrong thing. So the entire note set is snapshotted
 * before the pass touches it, and UNDO puts the snapshot back. "The model was
 * quite confident" is not an undo.
 */
import { db, now, ventureRowById } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { ventureClaimRefusal } from "../knowledge/store.ts";
import { textKey } from "../../shared/textkey.ts";

/** A note is a sentence, not a document. Past this it is a report, and a
 *  report belongs in a run. */
export const MAX_NOTE = 600;
/** The whole memory. Past this the oldest-confirmed are dropped by the
 *  consolidation pass rather than silently by an insert — see `prune`. */
export const MAX_NOTES = 400;
/** How many notes go into a system turn. The rest are counted rather than
 *  hidden, so an agent that has been shown thirty of forty knows to read the
 *  rest through the skill instead of assuming it has seen everything. */
export const CONTEXT_NOTES = 30;

export type MemoryRow = {
  id: string;
  text: string;
  scope: string;
  venture_id: string;
  source: string;
  created_at: string;
  last_confirmed_at: string;
};

export type MemoryNote = {
  id: string;
  text: string;
  scope: "global" | "venture";
  ventureId: string | null;
  ventureName: string | null;
  source: "agent" | "owner";
  createdAt: string;
  lastConfirmedAt: string;
  /** How old the belief is, in days since it was last confirmed. Published
   *  rather than left to the caller because every surface that draws a note
   *  draws its age, and two implementations of "days ago" is two answers. */
  ageDays: number;
};

/* ------------------------------------------------------------------ shapes */

export function shapeNote(r: MemoryRow): MemoryNote {
  const v = r.venture_id ? ventureRowById(r.venture_id) : undefined;
  return {
    id: r.id,
    text: r.text,
    scope: r.scope === "venture" ? "venture" : "global",
    ventureId: r.venture_id || null,
    /* Null when the venture has been deleted. The note is kept — a belief
       about a business that no longer exists is still something that was
       believed — and the caller draws it unfiled rather than inventing a
       name. */
    ventureName: v?.name ?? null,
    source: r.source === "owner" ? "owner" : "agent",
    createdAt: r.created_at,
    lastConfirmedAt: r.last_confirmed_at,
    ageDays: daysSince(r.last_confirmed_at),
  };
}

function daysSince(iso: string): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

export function noteRow(id: string): MemoryRow | undefined {
  return db.prepare("SELECT * FROM chief_memory WHERE id = ?").get(id) as MemoryRow | undefined;
}

/** Every note, newest-confirmed first — which is the order a reader wants and
 *  the order the context cap cuts at. */
export function notes(opts: { scope?: string; ventureId?: string } = {}): MemoryNote[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.scope) {
    where.push("scope = ?");
    args.push(opts.scope);
  }
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM chief_memory
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY last_confirmed_at DESC, rowid DESC`,
    )
    .all(...args) as unknown as MemoryRow[];
  return rows.map(shapeNote);
}

export function noteCount(): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS n FROM chief_memory").get() as { n: number }).n,
  );
}

/* ------------------------------------------------------------- the numbers gate */

/**
 * DOES THIS READ AS A MEASUREMENT?
 *
 * Counted rather than judged by a model, because it is asked on every write and
 * a gate that needs a GPU is a gate that fails open when the GPU is off. Three
 * signals: bare figures, money, and percentages. Two or more and it is a
 * snapshot rather than a belief.
 *
 * A DATE IS NOT A MEASUREMENT — "he decided in March 2026 not to do paid ads"
 * is exactly the kind of note this is for — so four-digit years are not
 * counted. Nor is a version number, for the same reason.
 */
export function looksLikeAMeasurement(text: string): boolean {
  const t = text.replace(/\b(19|20)\d{2}\b/g, " ").replace(/\bv?\d+\.\d+(\.\d+)?\b/g, " ");
  let score = 0;
  if (/[€$£]\s?\d/.test(t) || /\d+\s?(usd|eur|gbp)\b/i.test(t)) score += 2;
  if (/\d+(\.\d+)?\s?%/.test(t)) score += 2;
  const figures = t.match(/\b\d[\d,]*(\.\d+)?\b/g) ?? [];
  score += Math.min(3, figures.length);
  return score >= 3;
}

/* ------------------------------------------------------------------ writes */

let seq = 0;
function mintId(): string {
  seq = (seq + 1) % 1_000;
  return `mem-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export type RememberResult =
  | { ok: true; note: MemoryNote; confirmed: boolean }
  | { ok: false; status: 400 | 413 | 422; error: string };

/**
 * Write a note, or confirm the one that already says it.
 *
 * A RESTATEMENT IS A CONFIRMATION AND NOT A DUPLICATE. The same fact arriving
 * again moves `last_confirmed_at` forward, which is what makes "still true in
 * September" expressible at all — and it means an agent that habitually saves
 * what it has just been told does not fill the memory with forty copies of one
 * sentence.
 *
 * THE GATE APPLIES TO THE AGENT AND NOT TO THE OWNER. See the file header.
 */
export function remember(input: {
  text: string;
  scope?: string;
  ventureId?: string | null;
  source?: string;
}): RememberResult {
  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, status: 400, error: "A note is a sentence. Say what to remember." };
  if (text.length > MAX_NOTE)
    return {
      ok: false,
      status: 413,
      error:
        `That is ${text.length} characters. A note is at most ${MAX_NOTE} — ` +
        `longer than that is a report, and a report belongs in a run.`,
    };

  const source = input.source === "owner" ? "owner" : "agent";
  if (source === "agent" && looksLikeAMeasurement(text))
    return {
      ok: false,
      status: 422,
      error:
        "Not saved — that reads as a measurement, and a measurement goes stale " +
        "the day after it is written. Every live figure is already one skill " +
        "call away. Memory is for what does not move: what the owner decided, " +
        "what a thing IS, what was tried and what happened. If there is a " +
        "durable conclusion behind those figures, save that, without them. " +
        /* THE OTHER STORE, named at the moment somebody is looking for it.
           A belief about the OWNER belongs here; a statement about a PRODUCT
           with a source under it belongs in the fact store, where it carries a
           tier, a citation and a date and can be corrected rather than argued
           with. Before the `knowledge` skill existed this refusal had nowhere
           to send anybody, and product facts were written here without their
           evidence. */
        "If it is a fact about a PRODUCT — what it does, what it costs, what it " +
        "integrates with — it belongs in the `knowledge` skill instead, where it " +
        "carries a source and a date.",
    };

  /* THE VENTURE GATE. A note the agent scopes to a venture is a claim about
     that business, and it lands unconfirmed in the system turn of every later
     conversation about it. Claims about a product go to the fact store, which
     holds them behind a kind, a source, a date and the owner's confirmation.
     The owner is never refused — they are that confirmation. */
  const claim = ventureClaimRefusal({ ventureId: input.ventureId, scope: input.scope, source });
  if (claim) return { ok: false, ...claim };

  let scope = input.scope === "venture" ? "venture" : "global";
  let ventureId = (input.ventureId ?? "").trim();
  if (scope === "venture") {
    if (!ventureId)
      return { ok: false, status: 400, error: "A venture-scoped note needs a venture." };
    if (!ventureRowById(ventureId))
      return { ok: false, status: 400, error: `No venture with the id "${ventureId}".` };
  } else {
    /* A global note carries no venture. Silently rather than as an error: a
       caller that sent both meant the note to be global, and the venture is
       the field that contradicts that. */
    ventureId = "";
  }
  if (!ventureId) scope = "global";

  const ts = now();
  /* The dedup key. Storing one sentence twice would let a note win the context
     cap by being repeated, so a restatement confirms rather than inserts.
     `textKey` keeps digits, which is right here: a note that differs by a
     figure is a different note. */
  const k = textKey(text);
  const existing = (
    db.prepare("SELECT * FROM chief_memory WHERE venture_id = ?").all(ventureId) as unknown as MemoryRow[]
  ).find((r) => textKey(r.text) === k);
  if (existing) {
    db.prepare("UPDATE chief_memory SET last_confirmed_at = ? WHERE id = ?").run(ts, existing.id);
    return { ok: true, note: shapeNote(noteRow(existing.id)!), confirmed: true };
  }

  const id = mintId();
  db.prepare(
    `INSERT INTO chief_memory (id, text, scope, venture_id, source, created_at, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, text, scope, ventureId, source, ts, ts);
  return { ok: true, note: shapeNote(noteRow(id)!), confirmed: false };
}

/**
 * Edit a note. THE OWNER'S EDIT WINS AND STAMPS THE NOTE AS THEIRS.
 *
 * An agent's belief the owner has corrected is no longer the agent's belief —
 * it is the owner's, and the next consolidation pass must not be free to merge
 * it away. So an edit through the page sets `source = 'owner'`. An agent's own
 * PATCH keeps the source it had.
 */
export function editNote(
  id: string,
  patch: { text?: string; scope?: string; ventureId?: string | null; by?: "owner" | "agent" },
): { ok: true; note: MemoryNote } | { ok: false; status: 400 | 404 | 413; error: string } {
  const row = noteRow(id);
  if (!row) return { ok: false, status: 404, error: "No note by that id." };

  const sets: string[] = [];
  const args: string[] = [];

  if (patch.text !== undefined) {
    const t = patch.text.trim();
    if (!t) return { ok: false, status: 400, error: "A note cannot be emptied — delete it instead." };
    if (t.length > MAX_NOTE)
      return { ok: false, status: 413, error: `A note is at most ${MAX_NOTE} characters.` };
    sets.push("text = ?");
    args.push(t);
  }
  if (patch.scope !== undefined || patch.ventureId !== undefined) {
    const scope = (patch.scope ?? row.scope) === "venture" ? "venture" : "global";
    const ventureId = scope === "venture" ? (patch.ventureId ?? row.venture_id ?? "").trim() : "";
    if (scope === "venture" && !ventureRowById(ventureId))
      return { ok: false, status: 400, error: "A venture-scoped note needs a venture that exists." };
    sets.push("scope = ?", "venture_id = ?");
    args.push(scope, ventureId);
  }
  if (patch.by === "owner") {
    sets.push("source = ?");
    args.push("owner");
  }
  if (!sets.length) return { ok: false, status: 400, error: "Nothing to change." };

  /* An edit is a confirmation: somebody has just looked at the sentence and
     decided what it should say. */
  sets.push("last_confirmed_at = ?");
  args.push(now(), id);
  db.prepare(`UPDATE chief_memory SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return { ok: true, note: shapeNote(noteRow(id)!) };
}

export function forget(id: string): boolean {
  return Number(db.prepare("DELETE FROM chief_memory WHERE id = ?").run(id).changes) > 0;
}

/* --------------------------------------------------------------- versions */

export type VersionRow = {
  id: number;
  taken_at: string;
  reason: string;
  week: string | null;
  notes: string;
  restored_at: string | null;
};

/** Snapshot the whole set. Cheap — four hundred short rows — and the reason
 *  every pass below is reversible without this file having to be right about
 *  what a merge is. */
export function snapshot(reason: "consolidate" | "undo", week: string | null): number {
  const rows = db.prepare("SELECT * FROM chief_memory").all() as unknown as MemoryRow[];
  const info = db
    .prepare("INSERT INTO chief_memory_versions (taken_at, reason, week, notes) VALUES (?, ?, ?, ?)")
    .run(now(), reason, week, JSON.stringify(rows));
  return Number(info.lastInsertRowid);
}

export function versions(limit = 10): { id: number; takenAt: string; reason: string; week: string | null; notes: number; restoredAt: string | null }[] {
  return (
    db
      .prepare("SELECT * FROM chief_memory_versions ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Math.min(50, Math.floor(limit)))) as unknown as VersionRow[]
  ).map((v) => ({
    id: v.id,
    takenAt: v.taken_at,
    reason: v.reason,
    week: v.week,
    notes: readRows(v.notes).length,
    restoredAt: v.restored_at,
  }));
}

function readRows(raw: string): MemoryRow[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MemoryRow[]) : [];
  } catch {
    return [];
  }
}

/** The newest snapshot nobody has already put back. UNDO always means this
 *  one, so pressing it twice restores two passes rather than fighting over
 *  the same one. */
export function undoable(): VersionRow | undefined {
  return db
    .prepare("SELECT * FROM chief_memory_versions WHERE restored_at IS NULL ORDER BY id DESC LIMIT 1")
    .get() as VersionRow | undefined;
}

/**
 * Put a snapshot back.
 *
 * IT SNAPSHOTS THE CURRENT SET ON ITS WAY OUT, so undoing an undo is possible
 * and no button on this feature destroys anything.
 */
export function undo(): { ok: true; restored: number; from: string } | { ok: false; error: string } {
  const v = undoable();
  if (!v)
    return {
      ok: false,
      error:
        "There is nothing to undo: no consolidation pass has run since the last " +
        "one was put back.",
    };
  const rows = readRows(v.notes);
  snapshot("undo", v.week);
  db.prepare("DELETE FROM chief_memory").run();
  const insert = db.prepare(
    `INSERT INTO chief_memory (id, text, scope, venture_id, source, created_at, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows)
    insert.run(r.id, r.text, r.scope, r.venture_id, r.source, r.created_at, r.last_confirmed_at);
  db.prepare("UPDATE chief_memory_versions SET restored_at = ? WHERE id = ?").run(now(), v.id);
  return { ok: true, restored: rows.length, from: v.taken_at };
}

/* ----------------------------------------------------------- consolidation */

export type PassRow = {
  week: string;
  ran_at: string;
  notes_before: number;
  notes_after: number;
  merged: number;
  dropped: number;
  model: string | null;
  error: string | null;
};

export function passes(limit = 12): PassRow[] {
  return db
    .prepare("SELECT * FROM chief_memory_passes ORDER BY week DESC LIMIT ?")
    .all(Math.max(1, Math.min(52, Math.floor(limit)))) as unknown as PassRow[];
}

/**
 * THE ISO WEEK, which is the unit "once a week" is counted in.
 *
 * A calendar week rather than "seven days since the last pass", because the
 * pass is idempotent per KEY and a key that moves with the last run would let a
 * restart at the wrong moment run two passes three days apart. ISO weeks start
 * on Monday and the year they belong to is the year of their Thursday, which is
 * why this is eight lines rather than a division.
 *
 * THE WEEK IS THE OWNER'S, not UTC's: the day is read off the LOCAL calendar
 * before the Thursday rule is applied. A box east of Greenwich reading UTC
 * would file everything after 22:00 on a Sunday into the week that had just
 * ended, which is the wrong week on the only calendar anybody here looks at.
 * Exported because it is the one implementation — any other weekly pass on
 * this box imports it rather than writing a ninth version of the same rule.
 */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type ConsolidateResult = {
  ran: boolean;
  week: string;
  /** Why it did not run, where it did not. */
  why: string | null;
  before: number;
  after: number;
  merged: number;
  dropped: number;
  model: string | null;
  error: string | null;
  versionId: number | null;
};

/**
 * THE WEEKLY PASS: read the whole memory at once and tidy it.
 *
 * WHAT THE MODEL IS ALLOWED TO DO IS NARROW AND IT IS ENFORCED HERE RATHER
 * THAN ASKED FOR IN THE PROMPT. It returns a list of ids to DROP and a list of
 * merges, each naming a survivor id and a replacement sentence. This function
 * then: refuses any id it does not recognise, refuses to touch a note whose
 * source is `owner`, and refuses a merge whose replacement is longer than a
 * note may be. A model that answered with prose, or with ids it invented,
 * changes nothing and the pass is recorded as having produced no change.
 *
 * OWNER NOTES ARE UNTOUCHABLE. The owner typed them or corrected them; an
 * assistant deciding which of the things it was told are still worth knowing
 * would be editing the owner's mind on a timer.
 *
 * A FAILED PASS IS STILL A PASS. The week is recorded with the error on it, so
 * a provider that is down is retried next week rather than every hour for a
 * week.
 */
export async function consolidate(opts: { force?: boolean; week?: string } = {}): Promise<ConsolidateResult> {
  const week = opts.week ?? isoWeek();
  const before = noteCount();
  const base: ConsolidateResult = {
    ran: false,
    week,
    why: null,
    before,
    after: before,
    merged: 0,
    dropped: 0,
    model: null,
    error: null,
    versionId: null,
  };

  const already = db.prepare("SELECT * FROM chief_memory_passes WHERE week = ?").get(week);
  if (already && !opts.force)
    return { ...base, why: `A pass has already run for ${week}. One a week is the whole point.` };

  /* Nothing to tidy is not a failure and is not worth a model call. It is
     still RECORDED, so the ledger shows the pass happened and found nothing. */
  const rows = db
    .prepare("SELECT * FROM chief_memory ORDER BY last_confirmed_at DESC")
    .all() as unknown as MemoryRow[];
  if (rows.length < 3) {
    writePass(week, { before, after: before, merged: 0, dropped: 0, model: null, error: null });
    return { ...base, ran: true, why: "Fewer than three notes — nothing can be a duplicate of anything." };
  }

  const listing = rows
    .map(
      (r, i) =>
        `${i + 1}. id=${r.id} [${r.source}${r.venture_id ? `, venture ${r.venture_id}` : ", global"}, ` +
        `written ${r.created_at.slice(0, 10)}, last confirmed ${r.last_confirmed_at.slice(0, 10)}] ${r.text}`,
    )
    .join("\n");

  const prompt =
    `You are tidying an assistant's long-term memory about one person's ` +
    `businesses. Today is ${now().slice(0, 10)}.\n\n` +
    `Each line is a NOTE: a dated belief, with who formed it and when.\n\n` +
    `${listing}\n\n` +
    `Do exactly two things and nothing else.\n` +
    `1. MERGE notes that say the same thing. Pick the note to keep and give ` +
    `one sentence that says what all of them said, in the plainest wording.\n` +
    `2. DROP notes that are no longer worth knowing: superseded by a later ` +
    `note, or a one-off that has not been confirmed in months and refers to ` +
    `something finished.\n\n` +
    `Rules. Do NOT drop a note merely because it is old — an old decision is ` +
    `still a decision. Do NOT drop anything marked [owner]; those are the ` +
    `owner's own words. Do NOT invent notes. If nothing needs doing, answer ` +
    `with empty lists — that is the normal outcome.\n\n` +
    `Answer with JSON only, no prose, in this shape:\n` +
    `{"drop":["id",…],"merge":[{"keep":"id","remove":["id",…],"text":"the merged sentence"}]}`;

  let text = "";
  let model: string | null = null;
  try {
    const reply = await complete([{ role: "user", content: prompt }]);
    text = reply.text;
    model = reply.model;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    writePass(week, { before, after: before, merged: 0, dropped: 0, model: null, error: why });
    return { ...base, ran: true, error: why, why: "No model answered, so nothing was changed." };
  }

  const plan = readPlan(text);
  if (!plan) {
    writePass(week, {
      before,
      after: before,
      merged: 0,
      dropped: 0,
      model,
      error: "The model did not answer with the JSON shape asked for.",
    });
    return {
      ...base,
      ran: true,
      model,
      error: "The model did not answer with the JSON shape asked for, so nothing was changed.",
    };
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const owner = (id: string) => byId.get(id)?.source === "owner";

  const versionId = snapshot("consolidate", week);
  let merged = 0;
  let dropped = 0;

  for (const m of plan.merge) {
    const keep = byId.get(m.keep);
    if (!keep || owner(m.keep)) continue;
    const removals = m.remove.filter((id) => id !== m.keep && byId.has(id) && !owner(id));
    if (!removals.length) continue;
    const merge = m.text.trim();
    if (!merge || merge.length > MAX_NOTE) continue;
    db.prepare("UPDATE chief_memory SET text = ?, last_confirmed_at = ? WHERE id = ?").run(
      merge,
      now(),
      m.keep,
    );
    for (const id of removals) {
      db.prepare("DELETE FROM chief_memory WHERE id = ?").run(id);
      byId.delete(id);
      merged += 1;
    }
  }

  for (const id of plan.drop) {
    if (!byId.has(id) || owner(id)) continue;
    db.prepare("DELETE FROM chief_memory WHERE id = ?").run(id);
    byId.delete(id);
    dropped += 1;
  }

  /* The cap, applied here rather than on insert. An insert that silently
     dropped the oldest note would make "remember this" a lie in the one case
     where the memory was full; a weekly pass that says how many it dropped is
     visible. */
  const over = noteCount() - MAX_NOTES;
  if (over > 0) {
    const victims = db
      .prepare(
        `SELECT id FROM chief_memory WHERE source = 'agent'
          ORDER BY last_confirmed_at ASC, rowid ASC LIMIT ?`,
      )
      .all(over) as unknown as { id: string }[];
    for (const v of victims) {
      db.prepare("DELETE FROM chief_memory WHERE id = ?").run(v.id);
      dropped += 1;
    }
  }

  const after = noteCount();
  writePass(week, { before, after, merged, dropped, model, error: null });
  return { ...base, ran: true, after, merged, dropped, model, versionId };
}

function writePass(
  week: string,
  p: { before: number; after: number; merged: number; dropped: number; model: string | null; error: string | null },
) {
  db.prepare(
    `INSERT INTO chief_memory_passes (week, ran_at, notes_before, notes_after, merged, dropped, model, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week) DO UPDATE SET
       ran_at = excluded.ran_at, notes_before = excluded.notes_before, notes_after = excluded.notes_after,
       merged = excluded.merged, dropped = excluded.dropped,
       model = excluded.model, error = excluded.error`,
  ).run(week, now(), p.before, p.after, p.merged, p.dropped, p.model, p.error);
}

type Plan = { drop: string[]; merge: { keep: string; remove: string[]; text: string }[] };

/** Read the model's answer, or nothing. A model that wrapped its JSON in a
 *  fence or in a sentence is accommodated — that is a formatting habit, not a
 *  refusal — but anything this cannot parse changes nothing at all. */
function readPlan(raw: string): Plan | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const drop = Array.isArray(o.drop) ? o.drop.filter((x): x is string => typeof x === "string") : [];
  const merge = Array.isArray(o.merge)
    ? o.merge.flatMap((m) => {
        if (!m || typeof m !== "object") return [];
        const r = m as Record<string, unknown>;
        if (typeof r.keep !== "string" || typeof r.text !== "string") return [];
        const remove = Array.isArray(r.remove)
          ? r.remove.filter((x): x is string => typeof x === "string")
          : [];
        return [{ keep: r.keep, remove, text: r.text }];
      })
    : [];
  return { drop, merge };
}

/* ------------------------------------------------------------- the timer */

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * THE WEEKLY TIMER.
 *
 * An hourly interval rather than a timeout aimed at Monday morning, for the
 * reason every other schedule on this box gives: this is a laptop, it sleeps,
 * and a pass due while the lid was shut should run when it wakes rather than
 * not at all. "Has one run this week" is asked of the table, so a restart —
 * and under `node --watch` there are dozens a day — does not forget.
 *
 * IT NEEDS A PROVIDER AND SAYS SO BY DOING NOTHING. `complete()` throws with no
 * provider configured; the pass records the error against the week and stops
 * trying until next week. That is the correct behaviour for a box whose owner
 * has not connected a model: silence, not an hourly exception in the log.
 */
export function startConsolidation() {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        const week = isoWeek();
        if (db.prepare("SELECT week FROM chief_memory_passes WHERE week = ?").get(week)) return;
        if (noteCount() < 3) return;
        const out = await consolidate({ week });
        if (out.ran)
          console.log(
            `[chief] memory consolidation ${week}: ${out.before} → ${out.after} notes` +
              (out.error ? ` (${out.error})` : ""),
          );
      } catch (err) {
        /* Must not throw: this runs on a timer with nobody to catch it. */
        console.error("[chief] memory consolidation failed", err);
      }
    })();
  }, 60 * 60_000);
  timer.unref?.();
}

/* --------------------------------------------------- what routes/chat.ts asks */

/**
 * THE MEMORY AS A SYSTEM TURN.
 *
 * NEWEST-CONFIRMED FIRST AND CAPPED, with the remainder COUNTED rather than
 * silently dropped: an agent told it has been shown thirty of forty notes knows
 * to read the rest through the `memory` skill when the answer is not in front
 * of it. An agent shown thirty of forty and told nothing assumes it has seen
 * the memory.
 *
 * EACH LINE CARRIES ITS PROVENANCE AND ITS AGE, in words. "You told me" and
 * "I noticed" are different claims and they should read differently; a belief
 * from four months ago quoted without its date is a belief presented as
 * current.
 *
 * VENTURE NOTES ONLY FOR THE VENTURE IN HAND. A conversation about one
 * venture gets the global notes and that venture's; it does not get eighteen
 * other businesses' beliefs, which would be most of the turn and none of the
 * answer.
 */
export function memoryLines(ventureId: string | null): string[] {
  const all = notes();
  const relevant = all.filter((n) => n.scope === "global" || (ventureId && n.ventureId === ventureId));
  if (!relevant.length) return [];
  const shown = relevant.slice(0, CONTEXT_NOTES);
  const rest = relevant.length - shown.length;

  const lines = [
    `WHAT YOU KNOW ABOUT THIS OWNER AND THESE BUSINESSES — durable notes, ` +
      `each one a dated belief rather than a measurement. Use them; say when ` +
      `one is old; correct one when the owner corrects you.`,
    ...shown.map((n) => `- ${saying(n)}${n.ventureName ? ` [${n.ventureName}]` : ""} (${age(n)})`),
  ];
  if (rest > 0)
    lines.push(
      `- … and ${rest} older note${rest === 1 ? "" : "s"} not shown. Read them with ` +
        `the \`memory\` skill rather than assuming this is all of it.`,
    );
  return lines;
}

function saying(n: MemoryNote): string {
  return n.source === "owner" ? `You told me: ${n.text}` : `I noticed: ${n.text}`;
}

function age(n: MemoryNote): string {
  const d = n.ageDays;
  if (d === 0) return "confirmed today";
  if (d === 1) return "confirmed yesterday";
  if (d < 60) return `confirmed ${d} days ago`;
  return `confirmed ${Math.round(d / 30)} months ago`;
}
