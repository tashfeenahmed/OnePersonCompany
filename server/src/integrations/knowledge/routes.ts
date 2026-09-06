/**
 * `/api/knowledge` — the fact store, its evidence, and the four buttons the
 * owner needs over it.
 *
 * THE READS SAY WHAT THEY ARE NOT. A list of facts with no note about tiers is
 * a list of assertions; every document here carries the precedence rule and the
 * sentence about proposals, because the client, the skill and the agent all
 * render from this JSON and none of them should have to know the rules by
 * heart.
 *
 * REFRESH IS A ROUTE THAT AWAITS, and that is a decision rather than an
 * oversight. A repository read is four to twenty HTTP calls and one completion
 * — seconds, not minutes — so it is a request the page can wait on with a
 * spinner, unlike a research run. It is also the only route here that spends
 * anything, which is why it is a POST and why the skill marks it as an action.
 *
 * NOTHING HERE DELETES. `retire` sets a status; `correct` writes a new fact and
 * marks the old one. The table has no DELETE statement in it at all, and the
 * absence is the feature: a store of what a business knows that can forget on a
 * button press is a store nobody can rely on six months later.
 */
import { Hono } from "hono";
import { ventureRow } from "../../db.ts";
import { deriveVenture } from "./derive.ts";
import { refreshRepo, resolveRepo } from "./extract.ts";
import {
  CONFIDENCE,
  KINDS,
  MAX_STATEMENT,
  TIERS,
  TIER_SAYS,
  type FactKind,
  allFacts,
  confirm,
  contradictions,
  correct,
  coverage,
  factCount,
  facts,
  put,
  repoRow,
  retire,
  setRepo,
} from "./store.ts";

export const knowledgeRoutes = new Hono();

/** The sentence every read carries. Written once so the page, the CLI and the
 *  agent are told the same thing about what a tier is worth. */
const PRECEDENCE =
  "Four tiers. `owner` is what the owner stated; `repo` was read out of the " +
  "product's own source with a file and a line; `measured` was derived by code " +
  "from a connected account; `proposed` is an agent's suggestion that nobody " +
  "has confirmed and is NOT knowledge. For what the product IS, owner beats " +
  "repo beats measured. For a NUMBER, measured beats everything. Quote the " +
  "tier and the observation date with any fact you use.";

const isKind = (v: string): v is FactKind => (KINDS as readonly string[]).includes(v);

/** A venture key from the query or the body, resolved the same way everywhere:
 *  an id, a slug, a name or a host, which is what `ventureRow` accepts. */
function resolve(key: string | undefined) {
  const k = (key ?? "").trim();
  if (!k) return { error: "A venture is required — its slug or its id." } as const;
  const v = ventureRow(k);
  if (!v) return { error: `No venture called "${k}".` } as const;
  return { venture: v } as const;
}

/* -------------------------------------------------------------------- reads */

/**
 * The facts for one venture, or for the portfolio when none is named.
 *
 * MEASURED FACTS ARE DERIVED ON THE WAY IN when a venture is named. It is a
 * few indexed SELECTs and it means the page and the agent never read a figure
 * that a collector superseded twenty minutes ago — the alternative is a store
 * whose numbers are as old as the last timer, which is exactly the staleness
 * this feature is supposed to remove.
 */
knowledgeRoutes.get("/", (c) => {
  const key = c.req.query("venture");
  let ventureId: string | undefined;
  let repo: ReturnType<typeof repoRow> | undefined;
  let via: string | null = null;

  if (key) {
    const r = resolve(key);
    if ("error" in r) return c.json({ error: r.error }, 404);
    ventureId = r.venture.id;
    deriveVenture(ventureId);
    repo = repoRow(ventureId);
    via = resolveRepo(ventureId)?.via ?? null;
  }

  const kind = c.req.query("kind");
  if (kind && !isKind(kind))
    return c.json({ error: `Not a kind: ${kind}. The seven are ${KINDS.join(", ")}.` }, 400);
  const tier = c.req.query("tier");
  if (tier && !(TIERS as readonly string[]).includes(tier))
    return c.json({ error: `Not a tier: ${tier}. The four are ${TIERS.join(", ")}.` }, 400);

  const status = c.req.query("status");
  const limit = Number(c.req.query("limit") ?? 200);
  const list = facts({
    ventureId,
    kind,
    tier,
    status,
    limit: Number.isFinite(limit) ? limit : 200,
  });

  return c.json({
    venture: ventureId ? { id: ventureId, name: ventureRow(ventureId)!.name } : null,
    count: list.length,
    total: factCount(ventureId),
    facts: list,
    kinds: KINDS,
    tiers: TIERS,
    tierSays: TIER_SAYS,
    repo: repo
      ? {
          repo: repo.repo,
          kind: repo.kind,
          head: repo.head,
          extractedAt: repo.extracted_at,
          note: repo.note,
          error: repo.error,
          via,
        }
      : ventureId
        ? { repo: null, kind: null, head: null, extractedAt: null, note: null, error: null, via }
        : null,
    limits: { maxStatement: MAX_STATEMENT },
    note: PRECEDENCE,
  });
});

/** Every fact ever recorded for one venture, corrected and retired included —
 *  the history panel's read, and the input to the contradictions pass. */
knowledgeRoutes.get("/history", (c) => {
  const r = resolve(c.req.query("venture"));
  if ("error" in r) return c.json({ error: r.error }, 404);
  return c.json({
    venture: { id: r.venture.id, name: r.venture.name },
    facts: allFacts(r.venture.id),
    note:
      "Corrected and retired facts are kept on purpose: a sentence the owner " +
      "corrected, and the sentence that replaced it, are both part of what is " +
      "known. Nothing here is deleted.",
  });
});

knowledgeRoutes.get("/contradictions", (c) => {
  const key = c.req.query("venture");
  const r = resolve(key);
  if ("error" in r) return c.json({ error: r.error }, 404);
  const rows = contradictions(allFacts(r.venture.id));
  return c.json({
    venture: { id: r.venture.id, name: r.venture.name },
    count: rows.length,
    unresolved: rows.filter((x) => !x.resolved).length,
    contradictions: rows,
    note:
      "A row here is a POINTER at two facts that appear to disagree, never a " +
      "verdict about either. `resolved` means the owner already corrected one " +
      "of them. An unresolved row is two live sources carrying different " +
      "figures about the same subject; nothing on this box has picked a winner.",
  });
});

knowledgeRoutes.get("/coverage", (c) =>
  c.json({
    ventures: coverage(),
    kinds: KINDS,
    note:
      "`missing` is the kinds of fact a venture has NONE of. It is the point of " +
      "this document: an absence nobody can see is an absence nobody fills. " +
      "`stale` counts facts past their refresh date; `proposed` counts " +
      "suggestions waiting for the owner.",
  }),
);

/* ------------------------------------------------------------------- writes */

/** What the owner types. The highest tier there is, and the only one a person
 *  can write directly. */
knowledgeRoutes.post("/facts", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    venture?: unknown;
    kind?: unknown;
    statement?: unknown;
  };
  const r = resolve(typeof body.venture === "string" ? body.venture : undefined);
  if ("error" in r) return c.json({ error: r.error }, 404);
  const kind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
  if (!isKind(kind))
    return c.json({ error: `A kind is required, one of ${KINDS.join(", ")}.` }, 400);
  const statement = typeof body.statement === "string" ? body.statement.trim() : "";
  if (!statement) return c.json({ error: "A statement is required." }, 400);
  if (statement.length > MAX_STATEMENT)
    return c.json({ error: `A fact is at most ${MAX_STATEMENT} characters.` }, 400);

  const { id, outcome } = put({
    ventureId: r.venture.id,
    kind,
    statement,
    tier: "owner",
    sourceType: "owner",
    sourceRef: "the owner wrote it on the Knowledge tab",
    confidence: CONFIDENCE.owner,
    createdBy: "owner",
  });
  return c.json({ ok: true, id, outcome, facts: facts({ ventureId: r.venture.id }) });
});

/**
 * WHAT AN AGENT SUGGESTS.
 *
 * It lands in the `proposed` tier and nowhere else — there is no parameter on
 * this route that could put it anywhere else, which is the point. An agent that
 * has read a report and believes something about the product may say so here;
 * until the owner presses confirm it is a question, it never reaches
 * `factsForPrompt`, and every surface that draws it says UNCONFIRMED.
 *
 * `basis` is required and is not decoration: a proposal with no stated reason
 * is one the owner cannot judge, and the whole cost of this feature is the
 * owner's attention on the confirm button.
 */
knowledgeRoutes.post("/proposals", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    venture?: unknown;
    kind?: unknown;
    statement?: unknown;
    basis?: unknown;
  };
  const r = resolve(typeof body.venture === "string" ? body.venture : undefined);
  if ("error" in r) return c.json({ error: r.error }, 404);
  const kind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
  if (!isKind(kind))
    return c.json({ error: `A kind is required, one of ${KINDS.join(", ")}.` }, 400);
  const statement = typeof body.statement === "string" ? body.statement.trim() : "";
  if (!statement) return c.json({ error: "A statement is required." }, 400);
  if (statement.length > MAX_STATEMENT)
    return c.json({ error: `A fact is at most ${MAX_STATEMENT} characters.` }, 400);
  const basis = typeof body.basis === "string" ? body.basis.trim() : "";
  if (!basis)
    return c.json(
      {
        error:
          "A basis is required: one sentence saying what you read that made you " +
          "propose this. A proposal the owner cannot judge is a proposal that will sit unconfirmed for ever.",
      },
      400,
    );

  const { id, outcome } = put({
    ventureId: r.venture.id,
    kind,
    statement,
    tier: "proposed",
    sourceType: "model",
    sourceRef: basis.slice(0, 300),
    confidence: CONFIDENCE.proposed,
    createdBy: "agent",
  });
  return c.json({
    ok: true,
    id,
    outcome,
    note:
      "Filed as PROPOSED. It is not knowledge until the owner confirms it, it " +
      "is not given to any other agent as context, and you must not state it as true.",
  });
});

knowledgeRoutes.post("/facts/:id/correct", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { statement?: unknown; kind?: unknown };
  const statement = typeof body.statement === "string" ? body.statement : "";
  const kind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
  const out = correct(
    c.req.param("id"),
    statement,
    kind && isKind(kind) ? kind : undefined,
  );
  if (!out.ok) return c.json({ error: out.error }, 400);
  return c.json({
    ok: true,
    corrected: out.corrected,
    replacement: out.replacement,
    note:
      "The old sentence is kept and marked corrected, pointing at its " +
      "replacement. Both are in the history; only the owner's is active.",
  });
});

knowledgeRoutes.post("/facts/:id/retire", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { why?: unknown };
  const out = retire(c.req.param("id"), typeof body.why === "string" ? body.why : null);
  if (!out.ok) return c.json({ error: out.error }, 404);
  return c.json({ ok: true });
});

knowledgeRoutes.post("/facts/:id/confirm", (c) => {
  const out = confirm(c.req.param("id"));
  if (!out.ok) return c.json({ error: out.error }, 400);
  return c.json({ ok: true, fact: out.fact });
});

/**
 * THE PER-VENTURE REPOSITORY SETTING.
 *
 * `owner/name` is read as GitHub; anything starting with a `/` is read as a
 * directory on this machine. There is no third form and no auto-detection
 * beyond those two, because a string that is ambiguous between them is a string
 * whose meaning the owner should state.
 */
knowledgeRoutes.put("/repo", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { venture?: unknown; repo?: unknown };
  const r = resolve(typeof body.venture === "string" ? body.venture : undefined);
  if ("error" in r) return c.json({ error: r.error }, 404);
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!repo)
    return c.json(
      { error: 'A repository is required: "owner/name" for GitHub, or an absolute path on this machine.' },
      400,
    );
  const kind: "github" | "local" = repo.startsWith("/") ? "local" : "github";
  if (kind === "github" && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo))
    return c.json(
      {
        error:
          `"${repo}" is neither "owner/name" nor an absolute path. A GitHub repository ` +
          `is two segments; a local checkout starts with a slash.`,
      },
      400,
    );
  return c.json({ ok: true, repo: setRepo(r.venture.id, repo, kind) });
});

/** Read the repository now. The only route here that spends anything. */
knowledgeRoutes.post("/refresh", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { venture?: unknown; force?: unknown };
  const r = resolve(typeof body.venture === "string" ? body.venture : undefined);
  if ("error" in r) return c.json({ error: r.error }, 404);
  const out = await refreshRepo(r.venture.id, { force: body.force === true });
  if (!out.ok && out.error) return c.json({ ...out, error: out.error }, 400);
  return c.json({
    ...out,
    facts: facts({ ventureId: r.venture.id, tier: "repo" }),
    note:
      "Every fact filed here cited a file and a line that was checked to exist " +
      "in what was actually fetched. Facts whose citation did not check out are " +
      "counted in `dropped` with the reason and were not stored.",
  });
});

/** Re-derive the measured tier for one venture, out of the live plugin
 *  tables. Cheap, deterministic and safe to call at any time. */
knowledgeRoutes.post("/derive", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { venture?: unknown };
  const r = resolve(typeof body.venture === "string" ? body.venture : undefined);
  if ("error" in r) return c.json({ error: r.error }, 404);
  return c.json({ ok: true, ...deriveVenture(r.venture.id) });
});
