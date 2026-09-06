/**
 * THE FACT STORE — reading, writing and ordering evidence-backed product
 * knowledge.
 *
 * WHAT IS WRONG WITHOUT IT. Ask the chat agent "does Example Support support
 * webhooks" and it has three things to reason from: a one-sentence description
 * the owner typed at creation, a palette measured off the home page, and
 * whatever the model remembers about a word. None of those is the product. The
 * product is a repository, a Stripe catalogue and a set of things the owner
 * knows and has never written down — and until this table existed there was
 * nowhere on this box to put any of them with their evidence attached.
 *
 * A FACT IS NEVER A BARE SENTENCE HERE. It carries the tier it sits in, where
 * it was read, when, and how confident that makes it. Every render — the tab,
 * the skill, the system turn, the Studio brief — states the tier and the date,
 * because a capability quoted without them is a capability the reader will
 * assume is current and verified.
 *
 * THE PRECEDENCE, and it is two rules rather than one, because the two
 * questions have different best answers:
 *
 *   WHAT THE PRODUCT IS   — owner beats repo beats measured. The owner's
 *     sentence is the only one that is not a reading of something else; the
 *     repository is what the code does; a Stripe product is a configuration,
 *     and a configuration can describe a plan nobody ever shipped.
 *   WHAT A NUMBER IS      — measured beats everything, always. A price in a
 *     constants file is what a developer typed once; a live Stripe price is
 *     what customers are charged. An owner recalling an install count is a
 *     person recalling a number.
 *
 * NOTHING IS EVER DELETED AND NOTHING IS EVER REWRITTEN IN PLACE except a
 * measured figure, which is the one kind of fact whose identity survives its
 * value changing ("installs" is one fact; 4,100 and 4,180 are two readings of
 * it). A correction files a NEW owner fact and marks the old one `corrected`
 * with a pointer to its replacement, so the disagreement is still on the
 * record — this is the thing WorkDash's soul.js got right and the reason its
 * documents could be trusted: picking a winner silently is the failure.
 */
import { randomUUID } from "node:crypto";
import { db, now, ventureRowById, ventureRows } from "../../db.ts";

/* ------------------------------------------------------------------ shapes */

/**
 * SEVEN KINDS, AND THEY ARE A CLOSED SET ON PURPOSE. A free-text category is a
 * category nobody can filter on and a model will invent a synonym for on every
 * call. Each one names a different question a reader arrives with:
 *
 *   capability  — what it can do. "Sends webhooks on subscription events."
 *   pricing     — what it costs and how it is packaged.
 *   audience    — who it is for. The hardest to evidence and the easiest to
 *                 invent; see the prohibited inferences in extract.ts.
 *   integration — what it talks to: a provider, an API, a store.
 *   limitation  — what it cannot do, or does badly. The kind everything else
 *                 on this box is structurally bad at recording.
 *   metric      — a figure about the product itself (installs, live prices).
 *   claim       — what the product SAYS about itself: a README tagline, a
 *                 marketing line. Never evidence that the thing is true.
 */
export const KINDS = [
  "capability",
  "pricing",
  "audience",
  "integration",
  "limitation",
  "metric",
  "claim",
] as const;
export type FactKind = (typeof KINDS)[number];

export const TIERS = ["owner", "repo", "measured", "proposed"] as const;
export type FactTier = (typeof TIERS)[number];

export const SOURCE_TYPES = ["repo", "url", "plugin", "owner", "model"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const STATUSES = ["active", "corrected", "retired"] as const;
export type FactStatus = (typeof STATUSES)[number];

/** A sentence, not a document. Past this it is a report and belongs in a run. */
export const MAX_STATEMENT = 500;
/** How many facts one venture may hold. Past this the oldest-observed
 *  `proposed` are dropped first, then the oldest `retired`. */
export const MAX_FACTS = 300;
/** How many facts reach the agent's system turn. See `knowledgeLines`. */
export const CONTEXT_FACTS = 18;

/**
 * CONFIDENCE IS DERIVED, NEVER SUPPLIED. A caller that could send its own
 * number would send 0.95 for a guess, because every caller believes itself.
 * These five are the only values this table ever holds, and each is a claim
 * about the GATE that was passed rather than about how sure anybody feels.
 */
export const CONFIDENCE = {
  /** The owner typed it. */
  owner: 1,
  /** Code read a file and produced this mechanically — a package name, a
   *  dependency list. No model was involved. */
  repoDirect: 0.95,
  /** Derived from a connected plugin's own tables by a deterministic deriver. */
  measured: 0.9,
  /** A model proposed it FROM repository material and the citation it gave was
   *  checked to exist in the material. */
  repoModel: 0.75,
  /** An agent suggested it from nothing that can be checked. Pending. */
  proposed: 0.35,
} as const;

/** How long a repo fact stands before it is re-read even if HEAD has not
 *  moved. A month: long enough not to spend completions on an idle repo, short
 *  enough that a fact nobody looked at for a quarter is not quoted as current. */
export const REPO_TTL_DAYS = 30;
/** A measured fact is a reading of a live table and is rewritten on every
 *  derive pass; this is only the sentence a reader is shown about its age. */
export const MEASURED_TTL_HOURS = 6;

export type FactRow = {
  id: string;
  venture_id: string;
  kind: string;
  statement: string;
  tier: string;
  source_type: string;
  source_ref: string;
  source_commit: string | null;
  observed_at: string;
  confidence: number;
  status: string;
  corrected_by: string | null;
  created_by: string;
  refresh_after: string | null;
  fingerprint: string;
  created_at: string;
};

export type Fact = {
  id: string;
  ventureId: string;
  ventureName: string | null;
  kind: FactKind;
  statement: string;
  tier: FactTier;
  source: { type: SourceType; ref: string; commit: string | null; url: string | null };
  observedAt: string;
  ageDays: number;
  confidence: number;
  status: FactStatus;
  correctedBy: string | null;
  createdBy: "agent" | "owner";
  refreshAfter: string | null;
  /** True when `refresh_after` is in the past. Published rather than left to
   *  each caller, so "stale" means one thing on the page, in the skill and in
   *  the prompt. */
  stale: boolean;
};

const isKind = (v: string): v is FactKind => (KINDS as readonly string[]).includes(v);
const isTier = (v: string): v is FactTier => (TIERS as readonly string[]).includes(v);

/* --------------------------------------------------------------- fingerprint */

/**
 * The IDENTITY of a fact, as opposed to its wording.
 *
 * Lower-cased, punctuation dropped, digits replaced by a marker and runs of
 * space collapsed. The digit rule is the interesting one: "Play listing has
 * 4,100 installs" and "Play listing has 4,180 installs" are ONE fact read
 * twice, and a fingerprint that kept the digits would file the second as a new
 * fact every morning and leave the store full of a hundred readings of the
 * same sentence.
 *
 * Measured facts do not use this at all — a deriver supplies its own stable
 * key, because two derivers may legitimately produce sentences that normalise
 * the same way and they are still two facts.
 */
export function fingerprint(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/\d[\d,._]*/g, "#")
    .replace(/[^a-z0-9#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/* -------------------------------------------------------------------- shape */

function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * A source that can be clicked, where one exists.
 *
 * A repo citation is stored as `<repo> <path>:<line>` — the repo is part of the
 * reference because a venture can be re-pointed at a different repository and a
 * bare path would then name a file in the wrong tree. `owner/name` becomes a
 * GitHub blob URL pinned to the COMMIT rather than to a branch, because a link
 * to `main` is a link to a file that will not say what the fact says. A local
 * path gets no URL: there is nothing to open over HTTP and inventing a
 * `file://` would be a link that works on one machine.
 */
export function sourceUrl(r: FactRow): string | null {
  if (r.source_type === "url") return /^https?:\/\//.test(r.source_ref) ? r.source_ref : null;
  if (r.source_type !== "repo") return null;
  const m = /^([^\s/]+\/[^\s/]+)\s+(.+?):(\d+)(?:-\d+)?$/.exec(r.source_ref);
  if (!m || !r.source_commit) return null;
  return `https://github.com/${m[1]}/blob/${r.source_commit}/${m[2]}#L${m[3]}`;
}

export function shape(r: FactRow): Fact {
  const v = ventureRowById(r.venture_id);
  return {
    id: r.id,
    ventureId: r.venture_id,
    /* Null when the venture has been deleted. The fact is kept — something was
       true of a business that no longer exists — and the caller draws it
       unfiled rather than inventing a name. */
    ventureName: v?.name ?? null,
    kind: isKind(r.kind) ? r.kind : "claim",
    statement: r.statement,
    tier: isTier(r.tier) ? r.tier : "proposed",
    source: {
      type: (SOURCE_TYPES as readonly string[]).includes(r.source_type)
        ? (r.source_type as SourceType)
        : "model",
      ref: r.source_ref,
      commit: r.source_commit,
      url: sourceUrl(r),
    },
    observedAt: r.observed_at,
    ageDays: daysSince(r.observed_at),
    confidence: r.confidence,
    status: (STATUSES as readonly string[]).includes(r.status)
      ? (r.status as FactStatus)
      : "active",
    correctedBy: r.corrected_by,
    createdBy: r.created_by === "owner" ? "owner" : "agent",
    refreshAfter: r.refresh_after,
    stale: r.refresh_after !== null && Date.parse(r.refresh_after) < Date.now(),
  };
}

/* --------------------------------------------------------------------- reads */

export function factRow(id: string): FactRow | undefined {
  return db.prepare("SELECT * FROM knowledge_facts WHERE id = ?").get(id) as
    | FactRow
    | undefined;
}

/**
 * TIER ORDER FOR "WHAT IS THIS PRODUCT", in SQL, so the page, the skill and the
 * prompt cannot each invent their own. Proposed is last everywhere and always:
 * a pending suggestion must never be the first line a reader sees.
 */
const TIER_RANK =
  "CASE tier WHEN 'owner' THEN 0 WHEN 'repo' THEN 1 WHEN 'measured' THEN 2 ELSE 3 END";

export type FactQuery = {
  ventureId?: string;
  kind?: string;
  tier?: string;
  status?: string;
  limit?: number;
};

export function facts(q: FactQuery = {}): Fact[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.ventureId) {
    where.push("venture_id = ?");
    args.push(q.ventureId);
  }
  if (q.kind) {
    where.push("kind = ?");
    args.push(q.kind);
  }
  if (q.tier) {
    where.push("tier = ?");
    args.push(q.tier);
  }
  /* No status filter means ACTIVE ONLY. A list that quietly included retired
     and corrected facts would be a list in which the corrected sentence and
     the correction both appear, which is worse than either alone. */
  where.push("status = ?");
  args.push(q.status && (STATUSES as readonly string[]).includes(q.status) ? q.status : "active");

  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 200), 1), 500);
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_facts
        WHERE ${where.join(" AND ")}
        ORDER BY ${TIER_RANK}, observed_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...args, limit) as unknown as FactRow[];
  return rows.map(shape);
}

export function factCount(ventureId?: string): number {
  const row = ventureId
    ? db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_facts WHERE venture_id = ? AND status = 'active'")
        .get(ventureId)
    : db.prepare("SELECT COUNT(*) AS n FROM knowledge_facts WHERE status = 'active'").get();
  return Number((row as { n: number }).n);
}

/* -------------------------------------------------------------------- writes */

export type WriteFact = {
  ventureId: string;
  kind: FactKind;
  statement: string;
  tier: FactTier;
  sourceType: SourceType;
  sourceRef: string;
  sourceCommit?: string | null;
  confidence: number;
  createdBy: "agent" | "owner";
  /** Absent means "derive it from the tier" — see `expiryFor`. */
  refreshAfter?: string | null;
  /** A deriver's stable key. Absent means fingerprint the statement. */
  key?: string;
};

function expiryFor(tier: FactTier): string | null {
  const t = Date.now();
  if (tier === "repo") return new Date(t + REPO_TTL_DAYS * 86_400_000).toISOString();
  if (tier === "measured") return new Date(t + MEASURED_TTL_HOURS * 3_600_000).toISOString();
  /* An owner statement and a pending proposal both have no expiry, for
     opposite reasons: the owner does not go stale, and a proposal is not
     knowledge yet so there is nothing to refresh. */
  return null;
}

export const newId = () => `kf-${randomUUID().slice(0, 12)}`;

/**
 * One fact in, without ever filing the same thing twice.
 *
 * A fact whose (venture, tier, fingerprint) already exists and is ACTIVE is
 * REFRESHED: the statement, the source, the commit and the date are updated
 * and the id is kept. That is what makes a nightly re-read of a repository an
 * update rather than a hundred duplicates, and what lets a measured figure move
 * without becoming a second fact.
 *
 * It returns the id and which of the two happened, because the extraction
 * report says "4 added, 11 refreshed" and that sentence is the difference
 * between a repository that changed and one that did not.
 */
export function put(f: WriteFact): { id: string; outcome: "added" | "refreshed" } {
  const statement = f.statement.trim().slice(0, MAX_STATEMENT);
  const fp = (f.key ?? fingerprint(statement)).slice(0, 200);
  const at = now();

  const existing = db
    .prepare(
      "SELECT * FROM knowledge_facts WHERE venture_id = ? AND tier = ? AND fingerprint = ? AND status = 'active'",
    )
    .get(f.ventureId, f.tier, fp) as FactRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE knowledge_facts
          SET kind = ?, statement = ?, source_type = ?, source_ref = ?, source_commit = ?,
              observed_at = ?, confidence = ?, created_by = ?, refresh_after = ?
        WHERE id = ?`,
    ).run(
      f.kind,
      statement,
      f.sourceType,
      f.sourceRef,
      f.sourceCommit ?? null,
      at,
      f.confidence,
      f.createdBy,
      f.refreshAfter === undefined ? expiryFor(f.tier) : f.refreshAfter,
      existing.id,
    );
    return { id: existing.id, outcome: "refreshed" };
  }

  const id = newId();
  db.prepare(
    `INSERT INTO knowledge_facts
       (id, venture_id, kind, statement, tier, source_type, source_ref, source_commit,
        observed_at, confidence, status, corrected_by, created_by, refresh_after,
        fingerprint, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'active',NULL,?,?,?,?)`,
  ).run(
    id,
    f.ventureId,
    f.kind,
    statement,
    f.tier,
    f.sourceType,
    f.sourceRef,
    f.sourceCommit ?? null,
    at,
    f.confidence,
    f.createdBy,
    f.refreshAfter === undefined ? expiryFor(f.tier) : f.refreshAfter,
    fp,
    at,
  );
  prune(f.ventureId);
  return { id, outcome: "added" };
}

/**
 * THE CAP, applied where it can be explained rather than by an insert that
 * silently drops the row somebody just typed.
 *
 * Proposals go first — they are the only tier that is not evidence — oldest
 * first, and only once a venture is over the cap. Nothing active and confirmed
 * is ever dropped by this: a venture with three hundred real facts keeps them
 * and the page says how many there are.
 */
function prune(ventureId: string): void {
  const n = factCount(ventureId);
  if (n <= MAX_FACTS) return;
  db.prepare(
    `UPDATE knowledge_facts SET status = 'retired'
      WHERE id IN (
        SELECT id FROM knowledge_facts
         WHERE venture_id = ? AND status = 'active' AND tier = 'proposed'
         ORDER BY observed_at ASC LIMIT ?
      )`,
  ).run(ventureId, n - MAX_FACTS);
}

/**
 * THE OWNER SAYS OTHERWISE.
 *
 * A correction is TWO writes and never one: a new owner-tier fact carrying the
 * corrected sentence, and the old row marked `corrected` with `corrected_by`
 * pointing at its replacement. The old sentence is not edited and not deleted,
 * because "the repository says the export is CSV and the owner says it is CSV
 * and JSON" is a disagreement worth being able to read later — and because a
 * correction that erased its target would make the extraction look like it had
 * been right all along the next time it ran.
 *
 * The replacement inherits the KIND of what it corrects unless the caller
 * names a different one: correcting a pricing fact almost always produces
 * another pricing fact, and making the owner restate the category to fix a
 * sentence is a form worth not having.
 */
export function correct(
  id: string,
  statement: string,
  kind?: FactKind,
): { ok: true; corrected: Fact; replacement: Fact; inPlace: boolean } | { ok: false; error: string } {
  const old = factRow(id);
  if (!old) return { ok: false, error: `No fact with id ${id}.` };
  if (old.status !== "active")
    return { ok: false, error: `That fact is already ${old.status}; there is nothing to correct.` };
  const text = statement.trim();
  if (!text) return { ok: false, error: "A correction needs a sentence." };
  if (text.length > MAX_STATEMENT)
    return { ok: false, error: `A fact is at most ${MAX_STATEMENT} characters.` };

  const { id: newid } = put({
    ventureId: old.venture_id,
    kind: kind ?? (isKind(old.kind) ? old.kind : "claim"),
    statement: text,
    tier: "owner",
    sourceType: "owner",
    sourceRef: `the owner corrected a ${old.tier} fact on the Knowledge tab`,
    confidence: CONFIDENCE.owner,
    createdBy: "owner",
  });

  /*
    THE ROW CORRECTED ITSELF, AND THIS IS THE ORDINARY CASE, NOT THE EDGE ONE.

    `put()` dedupes on (venture, tier, fingerprint), and `fingerprint()`
    replaces every digit run with a marker — so an owner editing his own
    sentence to change a NUMBER ("39 a month" to "49 a month") normalises to the
    same fingerprint at the same tier, and `put()` correctly REFRESHES the row
    in place and hands back the id it was given. Marking that row `corrected`
    with `corrected_by` pointing at ITSELF was a fact that vanished: it left
    `facts()`, `factsForPrompt`, `knowledgeLines` and the Studio brief, and
    `contradictions()` reported it disagreeing with itself. The store's single
    highest-tier statement disappeared on the most ordinary owner action there
    is.

    There is nothing to supersede when a sentence has replaced itself, so the
    supersession is skipped and the caller is told which of the two happened.
    The row's `observed_at` has already moved, which is the whole of what an
    in-place edit should do.
  */
  if (newid === id) {
    const fact = shape(factRow(id)!);
    return { ok: true, corrected: fact, replacement: fact, inPlace: true };
  }

  db.prepare("UPDATE knowledge_facts SET status = 'corrected', corrected_by = ? WHERE id = ?").run(
    newid,
    id,
  );
  return {
    ok: true,
    corrected: shape(factRow(id)!),
    replacement: shape(factRow(newid)!),
    inPlace: false,
  };
}

export function retire(id: string, why: string | null = null): { ok: boolean; error?: string } {
  const row = factRow(id);
  if (!row) return { ok: false, error: `No fact with id ${id}.` };
  if (row.status === "retired") return { ok: true };
  db.prepare("UPDATE knowledge_facts SET status = 'retired', source_ref = ? WHERE id = ?").run(
    why ? `${row.source_ref} — retired: ${why.slice(0, 120)}` : row.source_ref,
    id,
  );
  return { ok: true };
}

/**
 * A PROPOSAL BECOMES KNOWLEDGE ONLY HERE.
 *
 * Confirming moves it to the OWNER tier, which is the only route to that tier
 * other than the owner typing the sentence himself. Where the proposal came
 * from is kept in the reference rather than thrown away: the owner confirmed
 * the sentence, and that an agent proposed it is still part of what is known
 * about it.
 */
export function confirm(
  id: string,
): { ok: true; fact: Fact } | { ok: false; status: 400 | 404 | 409; error: string } {
  const row = factRow(id);
  if (!row) return { ok: false, status: 404, error: `No fact with id ${id}.` };
  if (row.tier !== "proposed")
    return { ok: false, status: 400, error: `Only a proposed fact needs confirming; that one is ${row.tier}.` };
  if (row.status !== "active")
    return { ok: false, status: 400, error: `That proposal is ${row.status}.` };

  /*
    THE OWNER MAY ALREADY HAVE SAID IT.

    Confirming promotes the row to the owner tier WITHOUT changing its
    fingerprint, and `knowledge_facts_identity` is unique on (venture, tier,
    fingerprint) for active rows — so a proposal that says what the owner has
    already written raised a raw SQLITE_CONSTRAINT_UNIQUE out of the Confirm
    button. Nothing dedupes a proposal against another tier at write time
    (`put()` keys per tier, deliberately: an agent proposing something the
    repository also says is a real and useful state), so the collision can only
    be resolved here.

    The proposal is RETIRED rather than promoted, because it is a duplicate of a
    higher-tier fact and there is nothing for the owner to decide, and the
    refusal names the sentence that already stands so the reader can see that
    nothing was lost.
  */
  const already = db
    .prepare(
      "SELECT * FROM knowledge_facts WHERE venture_id = ? AND tier = 'owner' AND fingerprint = ? AND status = 'active'",
    )
    .get(row.venture_id, row.fingerprint) as FactRow | undefined;
  if (already) {
    retire(id, "the owner already had this fact; confirming would have duplicated it");
    return {
      ok: false,
      status: 409,
      error:
        `You already have that fact: "${already.statement.slice(0, 160)}". The proposal ` +
        `has been retired as a duplicate rather than filed twice.`,
    };
  }

  db.prepare(
    `UPDATE knowledge_facts
        SET tier = 'owner', source_type = 'owner', source_ref = ?, confidence = ?,
            observed_at = ?, refresh_after = NULL
      WHERE id = ?`,
  ).run(
    `owner confirmed a proposal — ${row.source_ref}`.slice(0, 300),
    CONFIDENCE.owner,
    now(),
    id,
  );
  return { ok: true, fact: shape(factRow(id)!) };
}

/* ----------------------------------------------------------- contradictions */

export type Contradiction = {
  kind: FactKind;
  reason: string;
  resolved: boolean;
  a: Fact;
  b: Fact;
};

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "this", "that", "from", "into",
  "its", "it", "is", "are", "was", "were", "has", "have", "had", "on", "in", "to",
  "at", "by", "as", "but", "not", "per", "there", "their", "which", "product",
]);

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );

const numbers = (s: string) =>
  new Set((s.match(/\d[\d,._]*/g) ?? []).map((n) => n.replace(/[,_]/g, "").replace(/\.0+$/, "")));

const same = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * WHERE TWO TIERS DISAGREE.
 *
 * TWO KINDS OF DISAGREEMENT AND BOTH ARE REPORTED, because they mean different
 * things to a reader:
 *
 *   RESOLVED — the owner corrected something. The pair is on the record with
 *     `corrected_by` joining them, and it is worth showing: it says the
 *     repository or a plugin was wrong about this once, which is a reason to
 *     read the next fact from that source more carefully.
 *   UNRESOLVED — two ACTIVE facts of the same kind, from DIFFERENT tiers,
 *     about visibly the same subject, carrying different numbers. Nobody has
 *     picked a winner and this code does not pick one either: it names both and
 *     says which tier each came from, and the precedence rules say which the
 *     agent should quote.
 *
 * THE SUBJECT TEST IS DELIBERATELY CRUDE — three or more shared content words
 * of four letters or more. A semantic comparison would need a model, a model
 * would need a completion per pair, and the failure mode of a clever detector
 * is a contradiction nobody can see the reason for. This one over-reports
 * slightly and every row it produces can be read and dismissed in a second.
 * It is a POINTER at a pair of facts, never a verdict about either.
 */
export function contradictions(all: Fact[]): Contradiction[] {
  const out: Contradiction[] = [];
  const byId = new Map(all.map((f) => [f.id, f]));

  for (const f of all) {
    if (f.status !== "corrected" || !f.correctedBy) continue;
    const to = byId.get(f.correctedBy);
    if (!to) continue;
    out.push({
      kind: f.kind,
      resolved: true,
      reason: `The owner corrected a ${f.tier} fact. The owner's sentence stands.`,
      a: f,
      b: to,
    });
  }

  const active = all.filter((f) => f.status === "active" && f.tier !== "proposed");
  /* The token and digit sets are computed ONCE per fact rather than once per
     comparison. The pair walk is quadratic and the tab loads it on every
     render; recomputing `words(b.statement)` inside the inner loop made it
     quadratic in the STATEMENTS as well, which on four hundred facts is a
     hundred thousand string splits for a panel that is usually empty. */
  const tokens = new Map(active.map((f) => [f.id, words(f.statement)]));
  const digits = new Map(active.map((f) => [f.id, numbers(f.statement)]));
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.kind !== b.kind || a.tier === b.tier) continue;
      const wb = tokens.get(b.id)!;
      const shared = [...tokens.get(a.id)!].filter((w) => wb.has(w));
      if (shared.length < 3) continue;
      const na = digits.get(a.id)!;
      const nb = digits.get(b.id)!;
      if (!na.size || !nb.size || same(na, nb)) continue;
      out.push({
        kind: a.kind,
        resolved: false,
        reason:
          `Both are about ${shared.slice(0, 3).join(", ")} and they carry different figures ` +
          `(${[...na].join(", ")} against ${[...nb].join(", ")}). ` +
          (a.kind === "metric" || a.kind === "pricing"
            ? `For a figure the measured tier is the one to quote.`
            : `Nobody has settled this; quote both tiers or ask the owner.`),
        a,
        b,
      });
    }
  return out.slice(0, 40);
}

/* ---------------------------------------------------------------- coverage */

export type Coverage = {
  ventureId: string;
  slug: string;
  name: string;
  stage: string;
  total: number;
  byTier: Record<FactTier, number>;
  byKind: Record<FactKind, number>;
  /** The kinds with no active fact at all. This is the point of the document:
   *  an absence nobody can see is an absence nobody fills. */
  missing: FactKind[];
  repo: string | null;
  repoKind: "github" | "local" | null;
  repoHead: string | null;
  extractedAt: string | null;
  repoError: string | null;
  stale: number;
  proposed: number;
};

export function coverage(): Coverage[] {
  const rows = db
    .prepare(
      `SELECT venture_id, tier, kind, COUNT(*) AS n,
              SUM(CASE WHEN refresh_after IS NOT NULL AND refresh_after < ? THEN 1 ELSE 0 END) AS stale
         FROM knowledge_facts WHERE status = 'active'
        GROUP BY venture_id, tier, kind`,
    )
    .all(now()) as unknown as {
    venture_id: string;
    tier: string;
    kind: string;
    n: number;
    stale: number;
  }[];

  const repos = new Map(
    (
      db.prepare("SELECT * FROM knowledge_repos").all() as unknown as RepoRow[]
    ).map((r) => [r.venture_id, r]),
  );

  return ventureRows().map((v) => {
    const mine = rows.filter((r) => r.venture_id === v.id);
    const byTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<FactTier, number>;
    const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FactKind, number>;
    let stale = 0;
    for (const r of mine) {
      if (isTier(r.tier)) byTier[r.tier] += r.n;
      if (isKind(r.kind)) byKind[r.kind] += r.n;
      stale += Number(r.stale ?? 0);
    }
    const linked = repos.get(v.id) ?? null;
    return {
      ventureId: v.id,
      slug: v.slug,
      name: v.name,
      stage: v.stage,
      total: mine.reduce((n, r) => n + r.n, 0),
      byTier,
      byKind,
      missing: KINDS.filter((k) => byKind[k] === 0),
      repo: linked?.repo ?? null,
      repoKind: linked ? (linked.kind === "local" ? "local" : "github") : null,
      repoHead: linked?.head ?? null,
      extractedAt: linked?.extracted_at ?? null,
      repoError: linked?.error ?? null,
      stale,
      proposed: byTier.proposed,
    };
  });
}

/* ------------------------------------------------------------- the repo row */

export type RepoRow = {
  venture_id: string;
  repo: string;
  kind: string;
  head: string | null;
  extracted_at: string | null;
  note: string | null;
  error: string | null;
  /** 'owner' when somebody typed it, 'link' when it came from `venture_links`
   *  the first time the repository was read. See migration 232. */
  source: string;
  updated_at: string;
};

export function repoRow(ventureId: string): RepoRow | undefined {
  return db.prepare("SELECT * FROM knowledge_repos WHERE venture_id = ?").get(ventureId) as
    | RepoRow
    | undefined;
}

export function setRepo(
  ventureId: string,
  repo: string,
  kind: "github" | "local",
  source: "owner" | "link" = "owner",
): RepoRow {
  const at = now();
  db.prepare(
    `INSERT INTO knowledge_repos (venture_id, repo, kind, head, extracted_at, note, error, source, updated_at)
     VALUES (?,?,?,NULL,NULL,NULL,NULL,?,?)
     ON CONFLICT(venture_id) DO UPDATE SET
       repo = excluded.repo, kind = excluded.kind, updated_at = excluded.updated_at,
       source = excluded.source,
       /* Pointing a venture at a DIFFERENT repository throws the stored HEAD
          away, because "we already read this commit" is a statement about the
          old tree and would skip the first read of the new one. */
       head = CASE WHEN knowledge_repos.repo = excluded.repo THEN knowledge_repos.head ELSE NULL END,
       error = NULL`,
  ).run(ventureId, repo, kind, source, at);
  return repoRow(ventureId)!;
}

export function markRepo(
  ventureId: string,
  patch: { head?: string | null; note?: string | null; error?: string | null; extractedAt?: string },
): void {
  const r = repoRow(ventureId);
  if (!r) return;
  db.prepare(
    "UPDATE knowledge_repos SET head = ?, note = ?, error = ?, extracted_at = ?, updated_at = ? WHERE venture_id = ?",
  ).run(
    patch.head === undefined ? r.head : patch.head,
    patch.note === undefined ? r.note : patch.note,
    patch.error === undefined ? r.error : patch.error,
    patch.extractedAt ?? r.extracted_at,
    now(),
    ventureId,
  );
}

/* -------------------------------------------------------- the prompt export */

/** How a tier reads in a sentence, so every surface says the same thing about
 *  what a line is worth. */
export const TIER_SAYS: Record<FactTier, string> = {
  owner: "the owner said so",
  repo: "read out of the source",
  measured: "measured from a connected account",
  proposed: "PROPOSED, not confirmed",
};

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toISOString().slice(0, 10)
    : "date unknown";
};

/**
 * ONE LINE PER FACT, in the form every reader of this store gets.
 *
 * The tier and the date are IN the line and not in a header, because a block
 * of facts under one caption gets quoted line by line, and a line quoted
 * without its tier is a capability asserted.
 */
export function factLine(f: Fact): string {
  return `- [${f.tier} · ${shortDate(f.observedAt)}] ${f.kind}: ${f.statement}${
    f.tier === "proposed" ? " (UNCONFIRMED — do not state this as true)" : ""
  }`;
}

/**
 * THE EXPORT EVERY OTHER AREA CALLS — Studio, the research brief, synthesis.
 *
 * ONE FUNCTION RATHER THAN EACH CALLER QUERYING THE TABLE, for the reason the
 * skill registry exists at all: the precedence between tiers and the exclusion
 * of proposals are RULES, and a caller that wrote its own SELECT would get the
 * facts without them. A Studio caption written from an unconfirmed proposal is
 * a marketing claim invented by a model two steps upstream.
 *
 * PROPOSALS ARE NEVER EXPORTED. Not filtered out by the caller, not included
 * with a warning: absent. A block of context handed to a model comes back as
 * assertion, and there is no wording that survives that trip.
 *
 * CAPPED BY CHARACTERS AND NOT BY ROWS because the caller's budget is context,
 * and it never cuts mid-line — a truncated fact is a different fact. What did
 * not fit is COUNTED in the last line rather than hidden, so a model that has
 * been shown eight of twenty knows to ask for the rest.
 */
export function factsForPrompt(
  ventureId: string,
  kinds: FactKind[] | null = null,
  maxChars = 1200,
): string | null {
  const all = facts({ ventureId, limit: 200 }).filter(
    (f) => f.tier !== "proposed" && (!kinds || kinds.includes(f.kind)),
  );
  if (!all.length) return null;

  /* For a FIGURE the measured tier wins, so metrics and pricing are ordered
     measured-first inside the general owner/repo/measured order. This is the
     one place the two precedence rules meet and it is written out rather than
     left to the SQL, which cannot know the question being asked. */
  const rank = (f: Fact) =>
    f.kind === "metric" || f.kind === "pricing"
      ? { measured: 0, owner: 1, repo: 2, proposed: 3 }[f.tier]
      : { owner: 0, repo: 1, measured: 2, proposed: 3 }[f.tier];
  all.sort((a, b) => rank(a) - rank(b) || Date.parse(b.observedAt) - Date.parse(a.observedAt));

  const head =
    `WHAT IS KNOWN ABOUT THIS PRODUCT, WITH THE EVIDENCE. Each line carries the ` +
    `tier it came from and the date it was observed. \`owner\` is what the owner ` +
    `stated; \`repo\` was read out of the product's own source; \`measured\` came ` +
    `from a connected account. For what the product IS, owner beats repo beats ` +
    `measured; for a NUMBER, measured beats everything. Quote the tier and the ` +
    `date. Nothing here is a guess, and unconfirmed proposals are deliberately ` +
    `not included.`;

  const lines: string[] = [head];
  let used = head.length;
  let shown = 0;
  for (const f of all) {
    const line = factLine(f);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (!shown) return null;
  if (shown < all.length)
    lines.push(
      `- … and ${all.length - shown} more fact${all.length - shown === 1 ? "" : "s"} not shown here. ` +
        `Read them with the \`knowledge\` skill rather than assuming this is all of it.`,
    );
  return lines.join("\n");
}

/**
 * THE STANDING CONTEXT THE CHAT AGENT ALWAYS HAS — at most 25 lines.
 *
 * VENTURE FACTS ONLY FOR THE VENTURE IN HAND, on `memoryLines`'s rule: a
 * conversation about Example App 1 gets Example App 1's product knowledge, not
 * nineteen businesses' worth, which would be most of the turn and none of the
 * answer. An unscoped conversation gets NOTHING here rather than a portfolio
 * summary — the venture roster is already in the turn above, and a list of
 * every product's capabilities would be four thousand characters of context
 * for a question that has not been asked yet.
 *
 * IT IS SILENT WHEN EMPTY. A fresh install has no facts, and a turn saying
 * "nothing is known about this product" is an instruction to go and invent
 * some.
 */
export function knowledgeLines(ventureId: string | null): string[] {
  if (!ventureId) return [];
  const block = factsForPrompt(ventureId, null, 2600);
  if (!block) return [];
  /* The character budget above is generous; this is the hard cap the brief
     asks for, applied last so the counted-remainder line is never the thing
     that is cut. */
  const lines = block.split("\n");
  if (lines.length <= 25) return lines;
  const kept = lines.slice(0, 24);
  kept.push(
    `- … and more. The whole set is \`opc knowledge facts --venture <slug>\` or ` +
      `GET /api/skills/knowledge?view=facts&venture=<slug>.`,
  );
  return kept;
}

/**
 * Every fact ever recorded for one venture, active or not.
 *
 * Separate from `facts()` because the tab's history panel and the
 * contradictions pass both need the corrected and retired rows, and making
 * that the default of the ordinary read would put a superseded sentence beside
 * the sentence that superseded it in every list on this box.
 */
export function allFacts(ventureId: string, limit = 400): Fact[] {
  return (
    db
      .prepare(
        `SELECT * FROM knowledge_facts WHERE venture_id = ?
          ORDER BY ${TIER_RANK}, observed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(ventureId, Math.min(Math.max(limit, 1), 800)) as unknown as FactRow[]
  ).map(shape);
}

/**
 * THE BLOCK A RUN IS HANDED — the same shape `runs/context.ts` builds for the
 * audit, the competitors and the backlinks, so `blocksFor` can drop it into a
 * brief with one line and no adapter.
 *
 * IT ALWAYS ANSWERS. A venture with nothing on file gets the sentence saying
 * so, on `competitorBlock`'s rule: a research brief that silently omitted a
 * section would leave the model to assume the section was empty because the
 * product is simple, rather than because nobody has read its repository yet.
 */
export function knowledgeBlock(venture: { id: string; name: string }): {
  source: string;
  text: string;
} {
  const block = factsForPrompt(venture.id, null, 2200);
  return {
    source: "What is known about the product, with the evidence",
    text:
      block ??
      `Nothing has been recorded about ${venture.name}'s product yet. That is an ` +
        `absence of evidence, not evidence that the product is simple — do not ` +
        `describe what it does without saying where you got it.`,
  };
}
