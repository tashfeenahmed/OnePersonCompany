/**
 * The proactive area's own rows.
 *
 * WHY THESE ARE HERE AND NOT IN db.ts, for the reason signals/db.ts gives:
 * the shared file owns the tables every area reads, and a helper added to it
 * per integration is what the manifest seam exists to stop. The SQL is in
 * `migrations.ts` beside this file and the statements that touch it are here.
 *
 * THERE IS ONE RULE ABOUT THIS FILE WORTH STATING: nothing in it reads a
 * business figure. It reads and writes rules, events, observations, snapshots
 * and briefings — the machinery — and every actual number arrives from
 * `engine.ts`, which got it by making an HTTP request to a route that already
 * exists. That separation is what lets a rule be written against a plugin that
 * did not exist when this file was written.
 */
import { db, now } from "../../db.ts";

/* ------------------------------------------------------------------ rules */

/** The comparisons a rule may make. See `evaluate()` in engine.ts for what
 *  each one does with `threshold` and `windowMinutes`. */
export const OPERATORS = [
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "changed",
  "dropped_by_pct",
  "rose_by_pct",
] as const;
export type Operator = (typeof OPERATORS)[number];

/** The two that compare this reading with one from the past, and therefore
 *  need a window and a percentage rather than an absolute threshold. */
export const WINDOWED: Operator[] = ["dropped_by_pct", "rose_by_pct"];
/** The one that takes no threshold at all. */
export const THRESHOLDLESS: Operator[] = ["changed"];

export type RuleRow = {
  id: number;
  name: string;
  skill: string;
  view: string;
  params: string;
  path: string;
  op: Operator;
  threshold: number | null;
  window_minutes: number | null;
  venture_id: string | null;
  enabled: number;
  cooldown_minutes: number;
  seeded: number;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string | null;
  last_value: number | null;
  last_error: string | null;
};

export type RuleWrite = {
  name: string;
  skill: string;
  view: string;
  params: Record<string, string | number>;
  path: string;
  op: Operator;
  threshold: number | null;
  windowMinutes: number | null;
  ventureId: string | null;
  enabled: boolean;
  cooldownMinutes: number;
  seeded?: boolean;
};

export function rules(opts: { enabledOnly?: boolean } = {}): RuleRow[] {
  const sql = opts.enabledOnly
    ? "SELECT * FROM alert_rules WHERE enabled = 1 ORDER BY id ASC"
    : "SELECT * FROM alert_rules ORDER BY id ASC";
  return db.prepare(sql).all() as unknown as RuleRow[];
}

export function rule(id: number): RuleRow | undefined {
  return db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(id) as unknown as
    | RuleRow
    | undefined;
}

export function insertRule(w: RuleWrite): RuleRow {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO alert_rules
         (name, skill, view, params, path, op, threshold, window_minutes,
          venture_id, enabled, cooldown_minutes, seeded, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      w.name,
      w.skill,
      w.view,
      JSON.stringify(w.params ?? {}),
      w.path,
      w.op,
      w.threshold,
      w.windowMinutes,
      w.ventureId,
      w.enabled ? 1 : 0,
      w.cooldownMinutes,
      w.seeded ? 1 : 0,
      ts,
      ts,
    );
  return rule(Number(info.lastInsertRowid))!;
}

/**
 * A PARTIAL UPDATE, and the absent/null distinction is deliberate — the same
 * one routes/board.ts spends a paragraph on. A field left out of the patch is
 * untouched; a field sent as null is CLEARED. Without that, "this rule is no
 * longer about a venture" would have no expression.
 */
export function updateRule(
  id: number,
  patch: Partial<{
    name: string;
    skill: string;
    view: string;
    params: Record<string, string | number>;
    path: string;
    op: Operator;
    threshold: number | null;
    windowMinutes: number | null;
    ventureId: string | null;
    enabled: boolean;
    cooldownMinutes: number;
  }>,
): RuleRow | undefined {
  const held = rule(id);
  if (!held) return undefined;

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };

  if (patch.name !== undefined) set("name", patch.name);
  if (patch.skill !== undefined) set("skill", patch.skill);
  if (patch.view !== undefined) set("view", patch.view);
  if (patch.params !== undefined) set("params", JSON.stringify(patch.params));
  if (patch.path !== undefined) set("path", patch.path);
  if (patch.op !== undefined) set("op", patch.op);
  if (patch.threshold !== undefined) set("threshold", patch.threshold);
  if (patch.windowMinutes !== undefined) set("window_minutes", patch.windowMinutes);
  if (patch.ventureId !== undefined) set("venture_id", patch.ventureId);
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  if (patch.cooldownMinutes !== undefined) set("cooldown_minutes", patch.cooldownMinutes);

  if (!sets.length) return held;
  set("updated_at", now());
  args.push(id);
  db.prepare(`UPDATE alert_rules SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return rule(id);
}

export function deleteRule(id: number): boolean {
  /* The events, observations and the rule go together. A cascade is declared
     on the tables, but node:sqlite does not enable foreign keys by default in
     every build, so the deletes are explicit — an orphaned event pointing at a
     rule that no longer exists would render as an alert nobody can explain. */
  db.prepare("DELETE FROM alert_events WHERE rule_id = ?").run(id);
  db.prepare("DELETE FROM alert_observations WHERE rule_id = ?").run(id);
  return db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id).changes > 0;
}

/** After a read, whatever came of it. `value` null with an `error` is the
 *  unreadable case; the two are written together so they can never disagree. */
export function markRule(id: number, value: number | null, error: string | null) {
  db.prepare(
    "UPDATE alert_rules SET last_evaluated_at = ?, last_value = ?, last_error = ? WHERE id = ?",
  ).run(now(), value, error, id);
}

/* ----------------------------------------------------------- observations */

export function recordObservation(ruleId: number, value: number, ts = now()) {
  db.prepare(
    "INSERT OR REPLACE INTO alert_observations (rule_id, ts, value) VALUES (?, ?, ?)",
  ).run(ruleId, ts, value);
}

/**
 * The newest reading at or before `at`, for the two windowed operators.
 *
 * AT OR BEFORE, NOT NEAREST. A rule asking "versus a week ago" that was given
 * the reading from six days and twenty-three hours ago because it happened to
 * be closer would be comparing against a window it did not name. Older is the
 * honest side to err on, and null — no reading is that old yet — is an answer
 * the engine reports rather than working around.
 */
export function observationAtOrBefore(ruleId: number, at: string): { ts: string; value: number } | null {
  const row = db
    .prepare(
      `SELECT ts, value FROM alert_observations
        WHERE rule_id = ? AND ts <= ?
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(ruleId, at) as unknown as { ts: string; value: number } | undefined;
  return row ?? null;
}

export function observations(ruleId: number, limit = 60): { ts: string; value: number }[] {
  const rows = db
    .prepare("SELECT ts, value FROM alert_observations WHERE rule_id = ? ORDER BY ts DESC LIMIT ?")
    .all(ruleId, limit) as unknown as { ts: string; value: number }[];
  return rows.reverse();
}

export function pruneObservations(days: number): number {
  const cut = new Date(Date.now() - days * 86_400_000).toISOString();
  return Number(db.prepare("DELETE FROM alert_observations WHERE ts < ?").run(cut).changes);
}

/* ------------------------------------------------------------------ events */

export type EventRow = {
  id: number;
  rule_id: number;
  ts: string;
  kind: "trip" | "unreadable" | "test";
  observed: number | null;
  previous: number | null;
  message: string;
  narration: string | null;
  narration_note: string | null;
  acknowledged_at: string | null;
};

export function insertEvent(e: {
  ruleId: number;
  kind: EventRow["kind"];
  observed: number | null;
  previous: number | null;
  message: string;
}): EventRow {
  const info = db
    .prepare(
      `INSERT INTO alert_events (rule_id, ts, kind, observed, previous, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(e.ruleId, now(), e.kind, e.observed, e.previous, e.message);
  return event(Number(info.lastInsertRowid))!;
}

export function event(id: number): EventRow | undefined {
  return db.prepare("SELECT * FROM alert_events WHERE id = ?").get(id) as unknown as
    | EventRow
    | undefined;
}

export function setNarration(id: number, narration: string | null, note: string | null) {
  db.prepare("UPDATE alert_events SET narration = ?, narration_note = ? WHERE id = ?").run(
    narration,
    note,
    id,
  );
}

export function events(opts: {
  days?: number;
  limit?: number;
  ruleId?: number | null;
  openOnly?: boolean;
  kinds?: EventRow["kind"][];
} = {}): EventRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.days) {
    where.push("ts >= ?");
    args.push(new Date(Date.now() - opts.days * 86_400_000).toISOString());
  }
  if (opts.ruleId) {
    where.push("rule_id = ?");
    args.push(opts.ruleId);
  }
  if (opts.openOnly) where.push("acknowledged_at IS NULL");
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    args.push(...opts.kinds);
  }
  args.push(opts.limit ?? 100);
  return db
    .prepare(
      `SELECT * FROM alert_events
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...args) as unknown as EventRow[];
}

/**
 * WHAT AN OPEN ALERT IS — one definition, and this is it.
 *
 * There were THREE hand-written versions of this predicate: this one, a raw
 * SELECT in the action inbox and another in the nightly proposal's evidence,
 * and they already differed on kind filtering. Two of them said `kind <>
 * 'test'` and this one named the kinds; equal today, one new kind from
 * disagreeing, and the disagreement would show as three different counts on
 * three surfaces with nothing to say which was right.
 *
 * `unreadable` IS OPEN, and that is a decision rather than an oversight: a
 * rule that has not been able to read its document for three days is a thing
 * the owner needs to know about, and hiding it because it is not a trip would
 * make a broken watchdog look like a quiet business. `test` never counts — it
 * is a thing the owner did on purpose, two seconds ago — and naming the kinds
 * rather than excluding one is what makes a FOURTH kind a decision somebody
 * has to make here instead of a row that silently appears on one surface.
 */
export const OPEN_KINDS: EventRow["kind"][] = ["trip", "unreadable"];

/** The open events themselves, newest first. Every surface that draws "what
 *  needs attention" reads this rather than writing the predicate again. */
export const openEvents = (opts: { limit?: number; ruleId?: number | null } = {}): EventRow[] =>
  events({ ...opts, openOnly: true, kinds: OPEN_KINDS, limit: opts.limit ?? 500 });

/**
 * One venture's open alerts, with the rule that raised each.
 *
 * The join is here rather than in the two assemblers that need it — the
 * morning briefing and the nightly proposal's evidence packet — because they
 * were describing one venture's open alerts to a model on the same night out
 * of two independently written queries with two windows and two caps. Neither
 * was wrong; they were two accounts of one state, which is worse than one
 * account that is merely incomplete, because the disagreement is what a reader
 * has to resolve.
 */
export function openEventsForVenture(
  ventureId: string,
  opts: { days?: number; limit?: number } = {},
): { ts: string; rule: string; skill: string; message: string; narration: string | null }[] {
  const args: (string | number)[] = [ventureId, ...OPEN_KINDS];
  const since = opts.days
    ? new Date(Date.now() - opts.days * 86_400_000).toISOString()
    : null;
  if (since) args.push(since);
  args.push(opts.limit ?? 20);
  return db
    .prepare(
      `SELECT e.ts AS ts, r.name AS rule, r.skill AS skill, e.message AS message,
              e.narration AS narration
         FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
        WHERE r.venture_id = ? AND e.acknowledged_at IS NULL
          AND e.kind IN (${OPEN_KINDS.map(() => "?").join(", ")})
          ${since ? "AND e.ts >= ?" : ""}
        ORDER BY e.ts DESC LIMIT ?`,
    )
    .all(...args) as unknown as ReturnType<typeof openEventsForVenture>;
}

/** Whether any rule on this box names a venture at all. "No rule watches this"
 *  and "nothing has tripped" are different findings and only one of them is
 *  about the business. */
export const ruleCountForVenture = (ventureId: string): number =>
  Number(
    (db.prepare("SELECT COUNT(*) AS n FROM alert_rules WHERE venture_id = ?").get(ventureId) as {
      n: number;
    }).n,
  );

export function openEventCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM alert_events
        WHERE acknowledged_at IS NULL AND kind IN (${OPEN_KINDS.map(() => "?").join(", ")})`,
    )
    .get(...OPEN_KINDS) as unknown as { n: number };
  return row.n;
}

export function ackEvent(id: number): EventRow | undefined {
  db.prepare("UPDATE alert_events SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL")
    .run(now(), id);
  return event(id);
}

/** The last event of a kind for a rule — the cooldown's only input. */
export function lastEventAt(ruleId: number, kind: EventRow["kind"]): string | null {
  const row = db
    .prepare("SELECT ts FROM alert_events WHERE rule_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1")
    .get(ruleId, kind) as unknown as { ts: string } | undefined;
  return row?.ts ?? null;
}

/* --------------------------------------------------------------- snapshots */

export function writeSnapshot(skill: string, doc: unknown, ts: string) {
  db.prepare("INSERT OR REPLACE INTO alert_snapshots (skill, ts, doc) VALUES (?, ?, ?)").run(
    skill,
    ts,
    JSON.stringify(doc),
  );
}

/** The `n` newest snapshots of one skill, newest first. Two is what the
 *  narrator asks for: this cycle and the one before it. */
export function snapshots(skill: string, n = 2): { ts: string; doc: unknown }[] {
  const rows = db
    .prepare("SELECT ts, doc FROM alert_snapshots WHERE skill = ? ORDER BY ts DESC LIMIT ?")
    .all(skill, n) as unknown as { ts: string; doc: string }[];
  return rows.map((r) => {
    let doc: unknown = null;
    try {
      doc = JSON.parse(r.doc);
    } catch {
      doc = null;
    }
    return { ts: r.ts, doc };
  });
}

/**
 * The newest snapshot of one skill taken at or before `at`.
 *
 * AT OR BEFORE, for the reason the observations use it: a briefing that says
 * "against yesterday morning" must compare against a reading taken no later
 * than yesterday morning. Null — nothing is that old yet — is an answer the
 * briefing reports rather than works around.
 */
export function snapshotAtOrBefore(skill: string, at: string): { ts: string; doc: unknown } | null {
  const row = db
    .prepare("SELECT ts, doc FROM alert_snapshots WHERE skill = ? AND ts <= ? ORDER BY ts DESC LIMIT 1")
    .get(skill, at) as unknown as { ts: string; doc: string } | undefined;
  if (!row) return null;
  try {
    return { ts: row.ts, doc: JSON.parse(row.doc) };
  } catch {
    return null;
  }
}

export function pruneSnapshots(days: number): number {
  const cut = new Date(Date.now() - days * 86_400_000).toISOString();
  return Number(db.prepare("DELETE FROM alert_snapshots WHERE ts < ?").run(cut).changes);
}

/* ------------------------------------------------------------------- seeds */

export function seeded(plugin: string): boolean {
  return !!db.prepare("SELECT 1 FROM alert_seeds WHERE plugin = ?").get(plugin);
}

export function markSeeded(plugin: string, count: number) {
  db.prepare("INSERT OR REPLACE INTO alert_seeds (plugin, seeded_at, rules) VALUES (?, ?, ?)").run(
    plugin,
    now(),
    count,
  );
}

/* -------------------------------------------------------------- briefings */

export type BriefingRow = {
  day: string;
  built_at: string;
  timezone: string;
  markdown: string;
  facts: string;
  model: string | null;
  note: string | null;
  to_chat: number;
  to_telegram: number;
  delivery_note: string | null;
};

export function briefing(day: string): BriefingRow | undefined {
  return db.prepare("SELECT * FROM briefings WHERE day = ?").get(day) as unknown as
    | BriefingRow
    | undefined;
}

export function latestBriefing(): BriefingRow | undefined {
  return db.prepare("SELECT * FROM briefings ORDER BY day DESC LIMIT 1").get() as unknown as
    | BriefingRow
    | undefined;
}

export function briefings(days: number): BriefingRow[] {
  return db
    .prepare("SELECT * FROM briefings ORDER BY day DESC LIMIT ?")
    .all(days) as unknown as BriefingRow[];
}

/** Written whole, replacing the day's own row. A rebuild of today is a
 *  rebuild, not a second briefing: the day is the key. */
export function writeBriefing(b: {
  day: string;
  timezone: string;
  markdown: string;
  facts: unknown;
  model: string | null;
  note: string | null;
}): BriefingRow {
  db.prepare(
    `INSERT INTO briefings (day, built_at, timezone, markdown, facts, model, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       built_at = excluded.built_at, timezone = excluded.timezone,
       markdown = excluded.markdown, facts = excluded.facts,
       model = excluded.model, note = excluded.note`,
  ).run(b.day, now(), b.timezone, b.markdown, JSON.stringify(b.facts ?? {}), b.model, b.note);
  return briefing(b.day)!;
}

export function markDelivered(
  day: string,
  d: { chat?: boolean; telegram?: boolean; note?: string | null },
) {
  const held = briefing(day);
  if (!held) return;
  db.prepare("UPDATE briefings SET to_chat = ?, to_telegram = ?, delivery_note = ? WHERE day = ?").run(
    d.chat === undefined ? held.to_chat : d.chat ? 1 : 0,
    d.telegram === undefined ? held.to_telegram : d.telegram ? 1 : 0,
    d.note === undefined ? held.delivery_note : d.note,
    day,
  );
}
