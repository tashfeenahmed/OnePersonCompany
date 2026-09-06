import { appForKind, runPage } from "../../../../shared/runRoutes.ts";
/**
 * THE ROSTER, AND WHAT IT IS DERIVED FROM.
 *
 * There is one sub-agent per venture per role and there are exactly six roles,
 * so the roster is a cross product of a table this area does not own with a
 * constant this file does. `ensureTeam` is the whole of the provisioning: it
 * inserts what is missing and prunes what has been orphaned, it is called on
 * every read of the org and on every dispatch, and it is idempotent — which is
 * what lets there be no create route, no delete route, and no state in which a
 * venture has five workers because somebody added a role in a release nobody
 * ran a backfill for.
 *
 * WHAT IS STORED AND WHAT IS COMPUTED. Three columns are the owner's — the
 * name, the standing instructions, and whether it is switched on. Everything
 * else a caller sees about a worker is read out of `agent_runs` at request
 * time: what it is running now, what it has queued, what it last produced, how
 * many of its runs finished and how many broke. None of that is copied into
 * this table, because a count kept in two places is a count that will one day
 * disagree with itself, and the ledger is the one that would be right.
 *
 * A RUN IS A WORKER'S WORK BECAUSE OF ITS KIND AND ITS VENTURE, and not
 * because of a column. `agent_runs.subagent_id` exists and says something
 * narrower — that this run was DISPATCHED rather than started by hand — but
 * attribution never reads it: an SEO review of Acme is the Acme SEO
 * Analyst's work whether the owner started it from the app or asked the Chief
 * of Staff for it, and a roster that only counted the second would show six
 * idle workers beside a ledger full of their output.
 *
 * THE MAPPING IS `role -> kind` AND IT IS NOT AN IDENTITY. Five of the six
 * roles are named after their kind; `visibility` runs `geo` and `writer` runs
 * `papers`, because "geo" is what the measurement is called in the trade and
 * "Papers" is what the app is called, and neither is what a person would call
 * the worker. The third name — the APP SLUG a client builds a URL out of — is
 * a third column here rather than a client-side switch, for the reason every
 * path on this box is written down once: a page that guessed `/apps/geo/` from
 * the kind would 404 and nothing would tell it why.
 */
import { db, now, ventureRow, ventureRowById, type VentureRow } from "../../db.ts";
import { kindDef } from "../runs/kinds.ts";
import { runTallies, shapeRun, type RunKind, type RunRow, type RunTally } from "../runs/store.ts";
import { readBrand } from "../../ventures/enrich.ts";

/* -------------------------------------------------------------- the roles */

export type Role = "researcher" | "competitors" | "seo" | "demand" | "visibility" | "writer" | "producer" | "serp" | "aso" | "campaigns";

export type RoleDef = {
  role: Role;
  kind: RunKind;
  /** What the worker is, in the words a person would use on an org chart. */
  title: string;
  /** Appended to the venture's name to make the default name. */
  suffix: string;
};

export const ROLES: RoleDef[] = [
  { role: "researcher", kind: "research", title: "Researcher", suffix: "Researcher" },
  { role: "competitors", kind: "competitors", title: "Competitor analyst", suffix: "Competitor Analyst" },
  { role: "seo", kind: "seo", title: "SEO analyst", suffix: "SEO Analyst" },
  { role: "demand", kind: "demand", title: "Demand analyst", suffix: "Demand Analyst" },
  { role: "visibility", kind: "geo", title: "AI visibility analyst", suffix: "Visibility Analyst" },
  { role: "writer", kind: "papers", title: "Academic paper writer", suffix: "Paper Writer" },
  { role: "producer", kind: "video", title: "Video producer", suffix: "Video Producer" },
  { role: "serp", kind: "serp", title: "SERP analyst", suffix: "SERP Analyst" },
  { role: "aso", kind: "aso", title: "Store listing auditor", suffix: "ASO Auditor" },
  /* The campaign planner, owned by integrations/publishing/. A worker per
     venture, so switching one off is how the owner says "not this business". */
  { role: "campaigns", kind: "campaign", title: "Campaign planner", suffix: "Campaign Planner" },
];

export function roleDef(role: string): RoleDef | null {
  return ROLES.find((r) => r.role === role) ?? null;
}

/* `appForKind` is NOT declared here any more. It was a third table of
   kind -> page, and it disagreed with the other two: `shotsqa` has no role, so
   this answered "shotsqa" — a page that does not exist — where `runPage`
   answered "ops". It comes from `shared/runRoutes.ts` now, which is also what
   the client rail reads, so a kind cannot resolve to two places. */
export { appForKind };

/** The roles, each with the sentence the kind already publishes about itself.
 *  Quoted from `kinds.ts` rather than restated here: two descriptions of one
 *  job drift, and the run's own is the one the agent doing it will read. */
export function roleInfos() {
  return ROLES.map((r) => ({
    role: r.role,
    kind: r.kind,
    title: r.title,
    what: kindDef(r.kind)?.what ?? "",
    /* DERIVED, not stored on the role. The slug is a property of the KIND —
       two roles running one kind must land on one page — and keeping a column
       here was what let this roster drift from the router. */
    app: appForKind(r.kind),
  }));
}

/* ---------------------------------------------------------------- the rows */

export type SubagentRow = {
  id: string;
  venture_id: string;
  role: string;
  name: string;
  title: string;
  instructions: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export function subagentId(ventureId: string, role: string): string {
  return `sa-${ventureId}-${role}`;
}

export function subagentRow(id: string): SubagentRow | undefined {
  return db.prepare("SELECT * FROM subagents WHERE id = ?").get(id) as SubagentRow | undefined;
}

/**
 * PROVISION THE SIX, AND FORGET THE ORPHANS.
 *
 * Called on every read of the org and on every dispatch, so a venture created
 * in another tab has a team by the time anything asks about it and a venture
 * deleted in another tab has none. Both halves are cheap — six selects against
 * a unique index, and one delete that matches nothing on almost every call —
 * and doing them here rather than on a hook into the ventures area keeps this
 * feature out of a directory that another agent owns.
 *
 * `ventureId` NARROWS THE INSERT AND NOT THE PRUNE. Provisioning one venture's
 * team is what a dispatch needs; pruning is about rows whose venture is gone,
 * which by definition cannot be found by naming that venture. So the prune is
 * always the whole table, and it is the reason a stale worker cannot outlive
 * its business by more than one request.
 */
export function ensureTeam(ventureId?: string): void {
  const rows = ventureId ? [ventureRowById(ventureId)].filter((v): v is VentureRow => !!v) : ventureRowsAll();
  const ts = now();
  const insert = db.prepare(
    `INSERT INTO subagents (id, venture_id, role, name, title, instructions, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const v of rows)
    for (const r of ROLES)
      insert.run(subagentId(v.id, r.role), v.id, r.role, `${v.name} ${r.suffix}`, r.title, ts, ts);

  /* The orphans. No foreign key does this — see 080_subagents on why a table
     in another area's directory is not something to hang a constraint off —
     so it is done here, on every read, and the roster is right one request
     after a venture is deleted. */
  db.prepare("DELETE FROM subagents WHERE venture_id NOT IN (SELECT id FROM ventures)").run();
}

function ventureRowsAll(): VentureRow[] {
  return db.prepare("SELECT * FROM ventures ORDER BY position, id").all() as unknown as VentureRow[];
}

/* -------------------------------------------------------------- the ledger */

/** Every (venture, kind) pair's tallies. The fold itself is `runTallies` in
 *  runs/store.ts — this names the grouping, which is the only part that is
 *  the roster's own. The key order is the column order: `venture:kind`. */
function tallies(): Map<string, RunTally> {
  return runTallies({ groupBy: ["venture_id", "kind"] });
}

/** The newest run of each (kind, venture) pair, which is every worker's last
 *  run in one statement. Ordered by `queued_at` then `rowid`, the same total
 *  order the runs list uses, so "last" means the same thing in both places. */
function lastRuns(): Map<string, RunRow> {
  const rows = db
    .prepare(
      `SELECT a.* FROM agent_runs a
        WHERE a.venture_id IS NOT NULL
          AND a.rowid = (SELECT b.rowid FROM agent_runs b
                          WHERE b.kind = a.kind AND b.venture_id = a.venture_id
                          ORDER BY b.queued_at DESC, b.rowid DESC LIMIT 1)`,
    )
    .all() as unknown as RunRow[];
  return new Map(rows.map((r) => [`${r.venture_id}:${r.kind}`, r]));
}

/** One worker's runs, newest first — its whole history, which is every run of
 *  its kind for its venture however it was started. */
export function subagentRuns(ventureId: string, kind: string, limit = 50): RunRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_runs
        WHERE kind = ? AND venture_id = ?
        ORDER BY queued_at DESC, rowid DESC LIMIT ?`,
    )
    .all(kind, ventureId, Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as RunRow[];
}

/* --------------------------------------------------------------- the shape */

/** The venture as the org chart draws it: enough to paint a card, and not the
 *  whole record. The favicon is the measured one — a `data:` URL, so the chart
 *  needs no second request per venture — and null where the site has never
 *  been read, which is different from a site with no icon. */
export function shapeVentureCard(v: VentureRow) {
  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    color: v.color,
    stage: v.stage,
    favicon: readBrand(v.brand).favicon,
  };
}

export function shapeSubagent(row: SubagentRow, ctx?: { tallies: Map<string, RunTally>; last: Map<string, RunRow> }) {
  const def = roleDef(row.role);
  /* A row whose role is no longer one of the six can only come from a database
     edited by hand or from a role removed in a release. It is shaped rather
     than hidden — the owner's instructions are still in it — and its kind is
     the role's own name, which resolves to no runs and therefore to an empty
     history rather than to somebody else's. */
  const kind = def?.kind ?? row.role;
  const key = `${row.venture_id}:${kind}`;
  const t = (ctx?.tallies ?? tallies()).get(key) ?? { done: 0, failed: 0, running: 0, queued: 0 };
  const last = (ctx?.last ?? lastRuns()).get(key) ?? null;
  return {
    id: row.id,
    ventureId: row.venture_id,
    role: row.role,
    kind,
    name: row.name,
    title: row.title,
    instructions: row.instructions,
    enabled: row.enabled === 1,
    running: t.running > 0,
    queued: t.queued,
    /* The runs engine's own summary, not a second one. A page that already
       knows how to draw a run in a list draws this one the same way. */
    lastRun: last ? shapeRun(last) : null,
    counts: { done: t.done, failed: t.failed },
  };
}

/**
 * THE WHOLE ORG, top to bottom.
 *
 * Provisioning happens first, so this is also the call that makes a new
 * venture's team exist. The tallies and the last runs are read once and handed
 * to every worker, rather than each worker asking for its own.
 */
export function orgVentures() {
  ensureTeam();
  const ctx = { tallies: tallies(), last: lastRuns() };
  const rows = db
    .prepare("SELECT * FROM subagents ORDER BY venture_id, role")
    .all() as unknown as SubagentRow[];
  const byVenture = new Map<string, SubagentRow[]>();
  for (const r of rows) {
    const list = byVenture.get(r.venture_id);
    if (list) list.push(r);
    else byVenture.set(r.venture_id, [r]);
  }
  /* Ordered by the ROLE TABLE and not by the id, so every venture's card lists
     its six in the same order — an org chart whose rows shuffle between cards
     is one nobody can read across. */
  const order = new Map(ROLES.map((r, i) => [r.role as string, i]));
  return ventureRowsAll().map((v) => ({
    ...shapeVentureCard(v),
    subagents: (byVenture.get(v.id) ?? [])
      .sort((a, b) => (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99))
      .map((r) => shapeSubagent(r, ctx)),
  }));
}

/* --------------------------------------------------- what routes/chat.ts asks */

/**
 * THE VENTURE'S TEAM, AS ONE PARAGRAPH FOR A SYSTEM TURN.
 *
 * Exported for routes/chat.ts and written here rather than there, on the rule
 * `ventureContext` already keeps: the prose about a thing has one author, and
 * it is the file that owns the thing. Null when the id names nothing or the
 * venture has no team yet, because a turn that said "this venture's team is:"
 * and then listed nothing would be worse than not mentioning it.
 *
 * NAMES AND ROLES ONLY. Not the instructions — those are the owner's standing
 * orders to a worker and repeating them into a conversation would invite the
 * Chief of Staff to follow them itself — and not the run counts, which are a
 * question the `runs` skill answers properly and would be stale by the time
 * the turn was read.
 */
export function ventureTeamLines(ventureId: string): string[] | null {
  ensureTeam(ventureId);
  const rows = db
    .prepare("SELECT * FROM subagents WHERE venture_id = ?")
    .all(ventureId) as unknown as SubagentRow[];
  if (!rows.length) return null;
  const order = new Map(ROLES.map((r, i) => [r.role as string, i]));
  return rows
    .sort((a, b) => (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99))
    .map((r) => `- ${r.name} — ${r.title} (role \`${r.role}\`)${r.enabled === 1 ? "" : " — SWITCHED OFF by the owner"}`);
}

/**
 * THE RUNS FILED UNDER ONE CONVERSATION.
 *
 * Exported for `GET /api/chat/sessions`, which nests these under the session
 * that asked for them. Every session's children come back in ONE statement
 * rather than one per session, because the rail asks for the whole list on
 * every poll and a query per conversation would make that cost grow with the
 * transcript count.
 *
 * `to` IS ON THE WIRE RATHER THAN COMPOSED BY THE CLIENT, for the reason every
 * path on this box is written down once: a rail that guessed `/apps/<kind>`
 * would send `geo` runs to a page that does not exist.
 */
export type RunChild = {
  /* Prefixed, because a rail that keyed children and sessions in one map would
     otherwise be one collision away from opening a run as a chat. */
  id: string;
  runId: string;
  title: string;
  kind: string;
  app: string;
  status: string;
  to: string;
};

/** One run, in the shape both doors publish it. The polled list builds it from
 *  a row; the live SSE frame builds it from the run it has just filed. It used
 *  to be TWO shapes — the frame carried no `app` and no `to`, so a rail could
 *  not draw a link from it and threw the payload away to re-poll, which made a
 *  typed event into an expensive "something changed" ping. */
export function runChild(r: { id: string; kind: string; title: string; status: string }): RunChild {
  return {
    id: `run:${r.id}`,
    runId: r.id,
    title: r.title,
    kind: r.kind,
    app: appForKind(r.kind),
    status: r.status,
    to: runPage(r.kind, r.id),
  };
}

export function childrenBySession(): Map<string, RunChild[]> {
  const rows = db
    .prepare(
      `SELECT id, kind, title, status, parent_session_id FROM agent_runs
        WHERE parent_session_id IS NOT NULL
        ORDER BY queued_at DESC, rowid DESC`,
    )
    .all() as unknown as {
    id: string;
    kind: string;
    title: string;
    status: string;
    parent_session_id: string;
  }[];
  const out = new Map<string, RunChild[]>();
  for (const r of rows) {
    const child = runChild(r);
    const list = out.get(r.parent_session_id);
    if (list) list.push(child);
    else out.set(r.parent_session_id, [child]);
  }
  return out;
}

/** The venture a caller named by id or slug, or nothing. Re-exported through
 *  this file so the routes below have one import for everything about a
 *  worker and its business. */
export function venture(key: string): VentureRow | undefined {
  return ventureRow(key);
}
