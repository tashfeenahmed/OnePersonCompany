import { appForKind, runPage, subagentPage } from "../../../../shared/runRoutes.ts";
/**
 * THE ROSTER, AND WHAT IT IS DERIVED FROM.
 *
 * There is one sub-agent per venture per role, so most of the roster is a cross
 * product of a table this area does not own with a constant this file does —
 * plus a short tail of workers that belong to no venture and exist once each.
 * `ensureTeam` is the whole of the provisioning: it
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
 * MOST WORKERS BELONG TO A VENTURE. ONE DOES NOT, and that is the seam this
 * file grew for. A People Analyst writes a dossier on a person of interest —
 * a founder, a customer, a correspondent — and that person is not filed under
 * one of the owner's own companies. Provisioning one per venture would have
 * put the same worker in eight places and made "which Acme wrote this dossier
 * on Jane Doe" a question with no answer. So there are two role tables:
 * `ROLES`, the venture roles, which every `ventures × ROLES` loop on this box
 * still walks unchanged, and `PORTFOLIO_ROLES`, provisioned ONCE. A portfolio
 * worker's row carries `venture_id = ''` — the sentinel, not NULL, because the
 * column is NOT NULL and UNIQUE(venture_id, role) already gives exactly the
 * one-row-per-role guarantee wanted — and its runs are the ones whose
 * `agent_runs.venture_id` IS NULL. Those two spellings of "no venture" meet in
 * exactly one place, `tallies`/`lastRuns`, where SQLite renders a NULL group
 * key as the empty string and the two agree by arithmetic rather than by
 * coincidence; the comment there says so.
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
import { kindDef, type InputSpec, type KindDef } from "../runs/kinds.ts";
import { runTallies, shapeRun, type RunKind, type RunRow, type RunTally } from "../runs/store.ts";
import { readBrand } from "../../ventures/enrich.ts";

/* -------------------------------------------------------------- the roles */

export type Role =
  | "researcher"
  | "competitors"
  | "seo"
  | "demand"
  | "visibility"
  | "writer"
  | "producer"
  | "serp"
  | "aso"
  | "campaigns"
  /* The first role with no venture behind it. See `PORTFOLIO_ROLES`. */
  | "people";

export type RoleDef = {
  role: Role;
  kind: RunKind;
  /** What the worker is, in the words a person would use on an org chart. */
  title: string;
  /** Appended to the venture's name to make the default name — for a
   *  PORTFOLIO role there is no venture name to append it to, and the title
   *  is the whole of the name. It is still declared so the two tables have one
   *  type and `roleDef` can answer for both. */
  suffix: string;
  /**
   * ONE CLAUSE saying what the worker does, for a system turn — and only the
   * portfolio roles carry it.
   *
   * A venture worker is introduced to the Chief of Staff beside its venture,
   * where the role's title is enough: "Acme SEO Analyst — SEO analyst" needs
   * no gloss. A portfolio worker arrives with no business attached, in a list
   * of one, and "People Analyst — People analyst" says nothing at all. The
   * kind's own `what` is the honest sentence but it is a paragraph, and a
   * paragraph per worker in every chat turn is a paragraph nobody reads.
   */
  does?: string;
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

/**
 * THE ROLES THAT BELONG TO NO VENTURE, provisioned ONCE for the whole box.
 *
 * Kept OUT of `ROLES` rather than flagged inside it, and that is the whole
 * design decision. Every `ventures × ROLES` loop on this box — the nightly
 * rounds, the org chart's provisioning, the rounds settings validator — is
 * correct as written only while `ROLES` means "the roles a venture has". A
 * boolean on the role would have made each of those loops responsible for
 * remembering to skip one, which is the kind of rule that is remembered in
 * four places and forgotten in the fifth.
 */
export const PORTFOLIO_ROLES: RoleDef[] = [
  {
    role: "people",
    kind: "dossier",
    title: "People analyst",
    suffix: "People Analyst",
    does: "writes a dossier on a named person of interest",
  },
];

/** The sentinel `venture_id` a portfolio worker's ROW carries. '' and not
 *  NULL: the column is NOT NULL, and UNIQUE(venture_id, role) already makes
 *  one row per portfolio role without any change to the schema. Its RUNS are
 *  a different story — `agent_runs.venture_id` is nullable and they carry
 *  NULL, because a run genuinely has no venture. */
export const PORTFOLIO_VENTURE = "";

export function isPortfolioRole(role: string): boolean {
  return PORTFOLIO_ROLES.some((r) => r.role === role);
}

/** Both tables, because a caller that has a role string does not know and
 *  should not have to know which of the two it came out of. The loops that DO
 *  care read `ROLES` or `PORTFOLIO_ROLES` by name. */
export function roleDef(role: string): RoleDef | null {
  return ROLES.find((r) => r.role === role) ?? PORTFOLIO_ROLES.find((r) => r.role === role) ?? null;
}

/* `appForKind` is NOT declared here any more. It was a third table of
   kind -> page, and it disagreed with the other two: `shotsqa` has no role, so
   this answered "shotsqa" — a page that does not exist — where `runPage`
   answered "ops". It comes from `shared/runRoutes.ts` now, which is also what
   the client rail reads, so a kind cannot resolve to two places. */
export { appForKind };

/**
 * WHICH FIELD A BRIEF GOES IN.
 *
 * A kind's inputs are not interchangeable. Four of them have exactly one
 * free-text field (`focus`) and it is handed straight to the model as the user
 * turn — that is a brief, and it is what this is for. The others are
 * different: `geo` has `questions`, asked of a model verbatim; `papers` has
 * `topic`, sent to OpenAlex and arXiv as a literature-search query; `serp` has
 * `queries`, searched for as typed; `aso` has `store`, one of two words.
 *
 * So the rule is: the first `textarea` input, falling back to the first input
 * of any kind. It lives here rather than in routes.ts because the ROSTER has to
 * publish it too — see `roleInfo`.
 */
export function briefField(def: KindDef): InputSpec | null {
  return def.inputs.find((i) => i.kind === "textarea") ?? def.inputs[0] ?? null;
}

/** The roles, each with the sentence the kind already publishes about itself.
 *  Quoted from `kinds.ts` rather than restated here: two descriptions of one
 *  job drift, and the run's own is the one the agent doing it will read. */
function roleInfo(r: RoleDef) {
  return {
    role: r.role,
    kind: r.kind,
    title: r.title,
    what: kindDef(r.kind)?.what ?? "",
    /* WHAT THIS ROLE'S BRIEF IS USED AS, in the kind's own words. A dispatcher
       that is a model writes every brief as an instruction — "Check the AI
       visibility of Acme: ask the provider what it knows…" — and the worker
       uses it literally: run r-4ddfp6 asked a model that sentence as its fourth
       question, and r-rl9k4h searched OpenAlex for a paragraph and found
       nothing. Publishing the field's label and hint beside the role is what
       lets the dispatcher write the right thing, or nothing. */
    brief: (() => {
      const def = kindDef(r.kind);
      const field = def ? briefField(def) : null;
      return field ? { field: field.key, label: field.label, hint: field.hint, required: field.required } : null;
    })(),
    /* DERIVED, not stored on the role. The slug is a property of the KIND —
       two roles running one kind must land on one page — and keeping a column
       here was what let this roster drift from the router. */
    app: appForKind(r.kind),
    /* WHICH TABLE IT CAME OUT OF, on the wire, because a caller offering the
       roles in a picker has to know that one of them takes no venture and the
       rest require one. Deriving it from `kind`'s `needsVenture` would be
       close but not the same question, and one day not the same answer. */
    portfolio: isPortfolioRole(r.role),
  };
}

/** EVERY role, venture and portfolio, which is what a client drawing the org
 *  or an agent choosing who to dispatch needs to see. */
export function roleInfos() {
  return [...ROLES, ...PORTFOLIO_ROLES].map(roleInfo);
}

/** The VENTURE roles alone. For the nightly rounds, which walk ventures and
 *  can therefore only ever dispatch one of these — offering the portfolio
 *  roles there would be offering a setting that silently skips every night. */
export function ventureRoleInfos() {
  return ROLES.map(roleInfo);
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

/** `sa-<venture id>-<role>`, and `sa-portfolio-<role>` for the worker that has
 *  no venture. Answered off EITHER fact — the role being a portfolio one, or
 *  the caller holding the '' sentinel — because both callers exist: the
 *  dispatch door knows only the role, and `ensureTeam` knows only the row. */
export function subagentId(ventureId: string, role: string): string {
  return isPortfolioRole(role) || ventureId === PORTFOLIO_VENTURE
    ? `sa-portfolio-${role}`
    : `sa-${ventureId}-${role}`;
}

export function subagentRow(id: string): SubagentRow | undefined {
  return db.prepare("SELECT * FROM subagents WHERE id = ?").get(id) as SubagentRow | undefined;
}

/**
 * PROVISION THE TEAM, AND FORGET THE ORPHANS.
 *
 * Called on every read of the org and on every dispatch, so a venture created
 * in another tab has a team by the time anything asks about it and a venture
 * deleted in another tab has none. Both halves are cheap — a handful of
 * conflicting inserts against a unique index, and one delete that matches
 * nothing on almost every call —
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

  /* THE PORTFOLIO WORKERS, PROVISIONED WHATEVER `ventureId` SAID.
     `ventureId` narrows the loop above to one business; it cannot narrow this
     one, because these workers belong to no business and the caller that
     passed an id was not saying "and not those". One row per portfolio role
     for the whole box, and its NAME is the suffix — which for a venture worker
     is the tail of "Acme SEO Analyst" and here is the whole of it. There is no
     venture name to put in front of it, and "People Analyst" is what somebody
     writes on an org chart where "People analyst" is what they write in the
     column next to it. The two really are different strings: the name is what
     the worker is CALLED and the owner may change it, the title is what the
     job IS. */
  for (const r of PORTFOLIO_ROLES)
    insert.run(subagentId(PORTFOLIO_VENTURE, r.role), PORTFOLIO_VENTURE, r.role, r.suffix, r.title, ts, ts);

  /* The orphans. No foreign key does this — see 080_subagents on why a table
     in another area's directory is not something to hang a constraint off —
     so it is done here, on every read, and the roster is right one request
     after a venture is deleted.

     THE SENTINEL IS EXEMPT, and it has to be spelled out rather than relied
     on: '' is not the id of any venture and never will be, so a prune written
     as "whose venture is not in the table" deletes the portfolio workers on
     the very next read — provisioned one line above, gone one line below,
     with the owner's standing instructions for them going too. */
  db.prepare("DELETE FROM subagents WHERE venture_id <> ? AND venture_id NOT IN (SELECT id FROM ventures)").run(
    PORTFOLIO_VENTURE,
  );
}

function ventureRowsAll(): VentureRow[] {
  return db.prepare("SELECT * FROM ventures ORDER BY position, id").all() as unknown as VentureRow[];
}

/* -------------------------------------------------------------- the ledger */

/** Every (venture, kind) pair's tallies. The fold itself is `runTallies` in
 *  runs/store.ts — this names the grouping, which is the only part that is
 *  the roster's own. The key order is the column order: `venture:kind`.
 *
 *  A NULL VENTURE GROUPS UNDER `:kind`, because the fold joins the group
 *  columns and a NULL renders as the empty string. That is the same key the
 *  portfolio rows produce from their '' sentinel, which is why the People
 *  Analyst's counts land on it without a special case — see the file header,
 *  and do not "fix" the sentinel to NULL without reading `lastRuns` first. */
function tallies(): Map<string, RunTally> {
  return runTallies({ groupBy: ["venture_id", "kind"] });
}

/**
 * The newest run of each (kind, venture) pair, which is every worker's last
 * run in one statement. Ordered by `queued_at` then `rowid`, the same total
 * order the runs list uses, so "last" means the same thing in both places.
 *
 * THE `venture_id IS NOT NULL` FILTER IS GONE, and its removal is the whole
 * reason the portfolio worker shows a last run at all. It was there because
 * every worker had a venture, so a portfolio-wide run could never be any of
 * their last runs; the People Analyst's runs are ALL portfolio-wide, and under
 * that filter its card said "never run" for ever while the ledger filled up.
 * The correlated subquery has to spell the NULL case out too — `b.venture_id =
 * a.venture_id` is NULL, not true, when both sides are NULL, so without the
 * second limb no NULL-venture row is ever its own newest.
 *
 * THE KEY MAPS NULL ONTO '' DELIBERATELY, so it agrees with `runTallies`,
 * which groups in SQL and gets the empty string for a NULL group key, and with
 * the roster rows, which carry the '' sentinel. Three spellings of "no
 * venture" meeting on one key is worth saying out loud once here rather than
 * being rediscovered at each of the three.
 */
function lastRuns(): Map<string, RunRow> {
  const rows = db
    .prepare(
      `SELECT a.* FROM agent_runs a
        WHERE a.rowid = (SELECT b.rowid FROM agent_runs b
                          WHERE b.kind = a.kind
                            AND (b.venture_id = a.venture_id
                                 OR (b.venture_id IS NULL AND a.venture_id IS NULL))
                          ORDER BY b.queued_at DESC, b.rowid DESC LIMIT 1)`,
    )
    .all() as unknown as RunRow[];
  return new Map(rows.map((r) => [`${r.venture_id ?? PORTFOLIO_VENTURE}:${r.kind}`, r]));
}

/**
 * One worker's runs, newest first — its whole history, which is every run of
 * its kind for its venture however it was started.
 *
 * FOR A PORTFOLIO WORKER "its venture" IS `NULL`, and that is a different
 * statement rather than a different parameter: `venture_id = ''` matches no
 * run on this box, because a run's missing venture is spelled NULL and SQL
 * equality against NULL is never true. Handing the sentinel to the venture
 * branch would have returned an empty history and looked like a worker that
 * had never done anything.
 */
export function subagentRuns(ventureId: string, kind: string, limit = 50): RunRow[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  if (ventureId === PORTFOLIO_VENTURE)
    return db
      .prepare(
        `SELECT * FROM agent_runs
          WHERE kind = ? AND venture_id IS NULL
          ORDER BY queued_at DESC, rowid DESC LIMIT ?`,
      )
      .all(kind, cap) as unknown as RunRow[];
  return db
    .prepare(
      `SELECT * FROM agent_runs
        WHERE kind = ? AND venture_id = ?
        ORDER BY queued_at DESC, rowid DESC LIMIT ?`,
    )
    .all(kind, ventureId, cap) as unknown as RunRow[];
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
  /* A row whose role is no longer one of the roster's can only come from a database
     edited by hand or from a role removed in a release. It is shaped rather
     than hidden — the owner's instructions are still in it — and its kind is
     the role's own name, which resolves to no runs and therefore to an empty
     history rather than to somebody else's. */
  const kind = def?.kind ?? row.role;
  const key = `${row.venture_id}:${kind}`;
  const t = (ctx?.tallies ?? tallies()).get(key) ?? { done: 0, failed: 0, running: 0, queued: 0 };
  const last = (ctx?.last ?? lastRuns()).get(key) ?? null;
  const portfolio = row.venture_id === PORTFOLIO_VENTURE;
  return {
    id: row.id,
    /* NULL ON THE WIRE FOR A PORTFOLIO WORKER, never the '' sentinel. The
       sentinel is a storage decision — see the file header — and a client that
       was handed it would have to know that, and would sooner or later render
       an empty venture name or ask `/api/ventures/` for it. Null is what "this
       worker has no venture" means everywhere else on this box. */
    ventureId: portfolio ? null : row.venture_id,
    /* SAID OUT LOUD rather than left to be inferred from a null venture. A
       venture worker whose business was deleted a second ago also has no
       venture for one request — see `ensureTeam` — and the two are not the
       same worker at all. */
    portfolio,
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

/** A paged tool roster. Icons, instructions and report bodies belong in the
 * detail view; including them here can hide later workers behind the tool budget. */
export function workerRoster(opts: { ventureId?: string; role?: string; limit: number; offset: number }) {
  ensureTeam(opts.ventureId);
  const predicates: string[] = [];
  const args: string[] = [];
  if (opts.ventureId !== undefined) { predicates.push("s.venture_id = ?"); args.push(opts.ventureId); }
  if (opts.role) { predicates.push("s.role = ?"); args.push(opts.role); }
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM subagents s${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT s.*, v.slug AS venture_slug, v.name AS venture_name
    FROM subagents s LEFT JOIN ventures v ON v.id = s.venture_id${where}
    ORDER BY s.venture_id, s.role, s.id LIMIT ? OFFSET ?`).all(...args, opts.limit, opts.offset) as unknown as
      (SubagentRow & { venture_slug: string | null; venture_name: string | null })[];
  const ctx = { tallies: tallies(), last: lastRuns() };
  return {
    total, limit: opts.limit, offset: opts.offset,
    nextOffset: opts.offset + rows.length < total ? opts.offset + rows.length : null,
    workers: rows.map(row => {
      const s = shapeSubagent(row, ctx);
      return {
        id: s.id, name: s.name, role: s.role, kind: s.kind,
        venture: s.portfolio ? null : { id: row.venture_id, slug: row.venture_slug, name: row.venture_name },
        portfolio: s.portfolio, enabled: s.enabled, running: s.running, queued: s.queued,
        lastRun: s.lastRun ? { id: s.lastRun.id, status: s.lastRun.status, url: runThreadPage({ id: s.lastRun.id, kind: s.kind, venture_id: s.ventureId, venture_slug: row.venture_slug }) } : null,
      };
    }),
    roles: roleInfos().filter(role => !opts.role || role.role === opts.role),
  };
}

/**
 * THE WHOLE ORG, top to bottom: every venture with its team, and beside them
 * the workers that belong to none.
 *
 * Provisioning happens first, so this is also the call that makes a new
 * venture's team exist. The tallies and the last runs are read once and handed
 * to every worker, rather than each worker asking for its own — which is why
 * the two halves come back from ONE function rather than from two exported
 * ones a route would call in turn: two calls would be two provisionings, two
 * folds of `agent_runs` and two chances for the ventures and the portfolio to
 * be counted against different states of the ledger.
 */
export function orgChart() {
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
     its workers in the same order — an org chart whose rows shuffle between
     cards is one nobody can read across. */
  const order = new Map(ROLES.map((r, i) => [r.role as string, i]));
  const portfolioOrder = new Map(PORTFOLIO_ROLES.map((r, i) => [r.role as string, i]));
  return {
    ventures: ventureRowsAll().map((v) => ({
      ...shapeVentureCard(v),
      subagents: (byVenture.get(v.id) ?? [])
        .sort((a, b) => (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99))
        .map((r) => shapeSubagent(r, ctx)),
    })),
    /* THE SAME SHAPE AS A VENTURE'S WORKERS and not a reduced one. A client
       that had to draw two kinds of card would draw them differently, and the
       difference between these workers is one boolean and a null venture —
       not a different sort of thing. */
    portfolio: (byVenture.get(PORTFOLIO_VENTURE) ?? [])
      .sort((a, b) => (portfolioOrder.get(a.role) ?? 99) - (portfolioOrder.get(b.role) ?? 99))
      .map((r) => shapeSubagent(r, ctx)),
  };
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
 * THE WORKERS THAT BELONG TO NO VENTURE, as lines for a system turn.
 *
 * SAID IN EVERY CONVERSATION, where `ventureTeamLines` is said only in one
 * about a venture — and that asymmetry is the point rather than an oversight.
 * A venture's team is only dispatchable once the owner is talking about that
 * venture; a portfolio worker is dispatchable from anywhere, including the
 * conversations where no venture has been chosen at all, which are most of
 * them. A Chief of Staff that only learned about the People Analyst inside an
 * Acme conversation would never be told about it in the conversation where the
 * owner actually says "who is this person emailing me".
 *
 * EACH LINE CARRIES THE `does` CLAUSE, because these arrive with no business
 * beside them to explain what they are for — see `RoleDef.does`.
 *
 * Null when there are none. A heading with nothing under it reads as a list
 * that was cut off.
 */
export function portfolioTeamLines(): string[] | null {
  ensureTeam();
  const rows = db
    .prepare("SELECT * FROM subagents WHERE venture_id = ?")
    .all(PORTFOLIO_VENTURE) as unknown as SubagentRow[];
  if (!rows.length) return null;
  const order = new Map(PORTFOLIO_ROLES.map((r, i) => [r.role as string, i]));
  return rows
    .sort((a, b) => (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99))
    .map((r) => {
      const does = roleDef(r.role)?.does;
      return (
        `- ${r.name} — ${r.title} (role \`${r.role}\`)` +
        `${does ? ` — ${does}` : ""}` +
        `${r.enabled === 1 ? "" : " — SWITCHED OFF by the owner"}`
      );
    });
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
type RunThreadTarget = {
  id: string;
  kind: string;
  venture_id?: string | null;
  venture_slug?: string | null;
};

/** Derive the worker from the existing role registry and run's venture. List
 * callers join the slug once; single-run callers may resolve it here. Runs
 * with no matching worker retain their original Outputs destination. */
export function runThreadPage(run: RunThreadTarget): string {
  const scope = run.venture_slug !== undefined && run.venture_id !== undefined ? run :
    db.prepare(`SELECT r.venture_id, v.slug AS venture_slug FROM agent_runs r
      LEFT JOIN ventures v ON v.id = r.venture_id WHERE r.id = ?`).get(run.id) as
      { venture_id: string | null; venture_slug: string | null } | undefined;
  if (!scope) return runPage(run.kind, run.id);
  const role = (scope.venture_id ? ROLES : PORTFOLIO_ROLES).find(role => role.kind === run.kind);
  if (!role || (scope.venture_id && !scope.venture_slug)) return runPage(run.kind, run.id);
  return subagentPage(role.role, scope.venture_slug ?? null, run.id);
}

export function runChild(r: RunThreadTarget & { title: string; status: string }): RunChild {
  return {
    id: `run:${r.id}`,
    runId: r.id,
    title: r.title,
    kind: r.kind,
    app: appForKind(r.kind),
    status: r.status,
    to: runThreadPage(r),
  };
}

/** Ground chat handoff claims in the same ledger the sidebar reads. */
export function sessionWorkLines(sessionId: string): string[] {
  const rows = db.prepare(`SELECT r.id, r.kind, r.title, r.status, r.venture_id, v.slug AS venture_slug
    FROM agent_runs r LEFT JOIN ventures v ON v.id = r.venture_id
    WHERE r.parent_session_id = ? ORDER BY r.queued_at DESC, r.rowid DESC LIMIT 6`)
    .all(sessionId) as unknown as (RunThreadTarget & { title: string; status: string })[];
  return [
    "Registered OPC runs in this conversation, from the live run ledger:",
    ...(rows.length ? rows.slice(0, 5).map(row => {
      const child = runChild(row);
      return `- ${row.id}: ${row.kind}, ${row.status}; report ${child.to}`;
    }) : ["None. Earlier assistant claims, native helper tasks and local files are not registered OPC dispatches."]),
    ...(rows.length > 5 ? ["Older runs omitted; read the runs history if needed."] : []),
    "Use this current state over earlier claims in the conversation. Never say a worker " +
      "is running from a previous assistant message alone; verify the roster and actual run id.",
  ];
}

export function childrenBySession(): Map<string, RunChild[]> {
  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.title, r.status, r.parent_session_id, r.venture_id, v.slug AS venture_slug
        FROM agent_runs r LEFT JOIN ventures v ON v.id = r.venture_id
        WHERE r.parent_session_id IS NOT NULL
        ORDER BY r.queued_at DESC, r.rowid DESC`,
    )
    .all() as unknown as {
    id: string;
    kind: string;
    title: string;
    status: string;
    parent_session_id: string;
    venture_id: string | null;
    venture_slug: string | null;
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
