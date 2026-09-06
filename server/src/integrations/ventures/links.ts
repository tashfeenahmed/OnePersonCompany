/**
 * THE CONNECTION MAP — which of the things this box measures belong to which
 * business.
 *
 * Twenty-seven integrations, several ventures, and until now no statement
 * anywhere that `sc-domain:acme.example`, the Cloudflare zone `acme.example`
 * and the Resend sending domain `acme.example` are three views of ONE thing
 * the owner runs. Every page on this dashboard could show a figure; none of
 * them could put a business's name on it.
 *
 * WHY THE LINK IS STORED AND THE SUGGESTION IS NOT. A hostname match is
 * evidence, not a decision — `acme.ie` and `acme.so` can be two businesses,
 * and a box that filed one under the other automatically would be wrong in a
 * way nobody notices until a revenue figure is captioned with the wrong name.
 * So suggestions are computed on every read, out of live tables, and carry the
 * sentence that produced them; a LINK is a row, written by the owner pressing
 * something. `accept-all` is that press, once, for the whole list.
 *
 * THE SUGGESTIONS ARE RECOMPUTED PER REQUEST AND THAT IS DELIBERATE. A cached
 * suggestion is a suggestion about a zone that may have been deleted this
 * morning; the whole point of the list is that it reflects what the collectors
 * currently hold. It costs a dozen indexed SELECTs and up to eight loopback
 * fetches with a three-second ceiling, which is the same order as any other
 * document on this server.
 *
 * THIS ROUTER IS MOUNTED AT `/api/venture-links` AND NOT INSIDE
 * `/api/ventures`, which is somebody else's file. The two are separate
 * concerns anyway: that route owns what the owner TYPED about a business, and
 * this one owns what the box has FOUND that might belong to it.
 */
import { Hono } from "hono";
import { allPlugins, db, now, ventureRow, ventureRows } from "../../db.ts";
import {
  allEntities,
  suggestFor,
  type Entity,
  type SourceNote,
  type Suggestion,
} from "./entities.ts";

export const ventureLinkRoutes = new Hono();

export type LinkRow = {
  venture_id: string;
  plugin: string;
  entity: string;
  label: string | null;
  source: "owner" | "auto";
  created_at: string;
};

/* ------------------------------------------------------------------ reads */

export function linksOf(ventureId: string): LinkRow[] {
  return db
    .prepare(
      "SELECT * FROM venture_links WHERE venture_id = ? ORDER BY plugin, entity",
    )
    .all(ventureId) as unknown as LinkRow[];
}

/**
 * The entities of one plugin this venture is linked to.
 *
 * Exported because the SEO audit asks it — "which Search Console property is
 * this venture's" is a question only this table can answer, and the audit
 * joining on a hostname of its own would be a second, quietly different rule
 * for the same decision.
 */
export function linkedEntities(ventureId: string, plugin: string): string[] {
  return (
    db
      .prepare(
        "SELECT entity FROM venture_links WHERE venture_id = ? AND plugin = ? ORDER BY entity",
      )
      .all(ventureId, plugin) as unknown as { entity: string }[]
  ).map((r) => r.entity);
}

/* ---------------------------------------------------- the entity resolvers */

/**
 * THE ONE SPELLING AN ENTITY IS COMPARED UNDER.
 *
 * A product linked as "Widget Pro" and a subscription carrying "widget pro"
 * are the same product. Matching them exactly — which two of the four readers
 * of this table did — meant a venture showed churn cases in the customers area
 * and zero revenue in the P&L for the same product, because one side
 * lowercased and the other did not. Case is not evidence of a different
 * business.
 */
export const normaliseEntity = (entity: string | null | undefined): string =>
  String(entity ?? "").trim().toLowerCase();

/**
 * Every entity of one plugin, keyed under `normaliseEntity`, to the ventures
 * that own it.
 *
 * A LIST rather than one id, because nothing stops two ventures being linked
 * to one entity and a reader that assumed otherwise would silently drop one.
 * `ORDER BY venture_id` so the first element is the same venture
 * `ventureOfEntity` below returns — four readers of one table giving two
 * answers is the bug this pair exists to close.
 */
export function linkIndex(plugin: string): Map<string, string[]> {
  const rows = db
    .prepare("SELECT venture_id, entity FROM venture_links WHERE plugin = ? ORDER BY venture_id")
    .all(plugin) as { venture_id: string; entity: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const key = normaliseEntity(r.entity);
    if (key) out.set(key, [...(out.get(key) ?? []), r.venture_id]);
  }
  return out;
}

/**
 * Which venture, if any, is linked to this entity at this plugin.
 *
 * NULL IS THE ORDINARY ANSWER and it means unlinked — shared, unattributed,
 * nobody's yet — never "the first venture". For the callers that ask this of
 * many rows at once, `linkIndex` is the same question asked in one query.
 */
export function ventureOfEntity(plugin: string, entity: string | null | undefined): string | null {
  const key = normaliseEntity(entity);
  if (!key) return null;
  const row = db
    .prepare(
      `SELECT venture_id FROM venture_links
       WHERE plugin = ? AND LOWER(TRIM(entity)) = ?
       ORDER BY venture_id LIMIT 1`,
    )
    .get(plugin, key) as { venture_id: string } | undefined;
  return row?.venture_id ?? null;
}

const shape = (r: LinkRow) => ({
  plugin: r.plugin,
  entity: r.entity,
  label: r.label,
  source: r.source,
  createdAt: r.created_at,
});

/* -------------------------------------------------------------------- map */

/**
 * The whole graph, in one document: the businesses, the integrations, the
 * things, and the edges between them.
 *
 * REGISTERED BEFORE `/:ventureKey`, because Hono matches in declaration order
 * and `map` is a perfectly good slug.
 *
 * `entities` IS EVERY ENTITY AND NOT ONLY THE LINKED ONES. A map that drew
 * only what is connected could not show what is NOT — and "eleven Resend
 * domains, four of them belonging to no venture" is the most useful sentence
 * this document can produce.
 */
ventureLinkRoutes.get("/map", async (c) => {
  const { entities, sources } = await allEntities();
  const edges = db
    .prepare("SELECT * FROM venture_links ORDER BY venture_id, plugin, entity")
    .all() as unknown as LinkRow[];

  const connected = new Map(allPlugins().map((p) => [p.id, p.connected === 1]));
  const pluginIds = [...new Set([...entities.map((e) => e.plugin), ...edges.map((e) => e.plugin)])].sort();

  /* An edge whose entity no longer exists is kept and FLAGGED rather than
     dropped: a zone that was deleted at Cloudflare this morning is exactly the
     thing the owner needs to see, and a map that silently hid it would report
     a healthy business with a missing DNS. */
  const known = new Set(entities.map((e) => `${e.plugin} ${e.entity}`));

  return c.json({
    ventures: ventureRows().map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      color: v.color,
      stage: v.stage,
      host: v.host,
    })),
    plugins: pluginIds.map((id) => ({
      id,
      connected: connected.get(id) ?? false,
      entities: entities.filter((e) => e.plugin === id).length,
    })),
    entities,
    edges: edges.map((e) => ({
      venture: e.venture_id,
      plugin: e.plugin,
      entity: e.entity,
      label: e.label,
      source: e.source,
      /* False means the link points at something no collector currently
         reports. Not an error: a paused integration and a deleted zone look
         the same from here, and only the owner knows which it was. */
      present: known.has(`${e.plugin} ${e.entity}`),
    })),
    unlinked: entities
      .filter((e) => !edges.some((x) => x.plugin === e.plugin && x.entity === e.entity))
      .map((e) => ({ plugin: e.plugin, entity: e.entity, label: e.label })),
    sources,
    note:
      "Edges are the owner's own statement about what belongs to what. `source: " +
      "\"auto\"` was proposed from a hostname or a name and accepted in bulk; " +
      "`\"owner\"` was linked one at a time. Nothing here is inferred at read time.",
  });
});

/* ------------------------------------------------------------ one venture */

function readVenture(key: string) {
  return ventureRow(key);
}

ventureLinkRoutes.get("/:ventureKey", async (c) => {
  const v = readVenture(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const links = linksOf(v.id);
  const { entities, sources } = await allEntities();
  const linked = new Set(links.map((l) => `${l.plugin} ${l.entity}`));
  const suggestions = suggestFor(v, entities, linked);

  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name, host: v.host, website: v.website },
    links: links.map(shape),
    suggestions,
    sources,
    note: v.host
      ? `Suggestions are matched against ${v.host} and against the name “${v.name}”. ` +
        "A hostname match is strong; a name match is a guess, and each one says which it is."
      : `${v.name} has no website, so nothing can be matched by hostname — only by name. ` +
        "Add a website to the venture, or link what belongs to it by hand.",
  });
});

/* ----------------------------------------------------------------- writes */

/**
 * Link one thing to a venture, by hand.
 *
 * THE ENTITY IS NOT VALIDATED AGAINST THE ENTITY LIST, and that is a
 * deliberate looseness. A collector that has not run yet, an integration that
 * is between credentials, a zone that is being moved: all of them mean the
 * thing is real and temporarily unlisted, and refusing the link would make the
 * owner wait for a collection to record a fact they already know. The map
 * flags an edge whose entity is currently absent, which is the honest place
 * for that to show up.
 */
ventureLinkRoutes.post("/:ventureKey", async (c) => {
  const v = readVenture(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    plugin?: unknown;
    entity?: unknown;
    label?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const plugin = typeof body.plugin === "string" ? body.plugin.trim() : "";
  const entity = typeof body.entity === "string" ? body.entity.trim() : "";
  if (!plugin || !entity)
    return c.json(
      {
        error:
          "Expected { plugin, entity, label? } — the integration's id and its own " +
          "identifier for the thing (a Cloudflare zone id, a Search Console property, " +
          "an npm package name). GET this path for the suggestions, which carry both.",
      },
      400,
    );

  const label =
    typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;

  db.prepare(
    `INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?)
     ON CONFLICT(venture_id, plugin, entity) DO UPDATE SET
       label = COALESCE(excluded.label, venture_links.label),
       /* An auto link the owner has now made deliberately is promoted, never
          demoted: a link made by hand is a stronger statement than one
          accepted in bulk, and re-linking it is how that is said. */
       source = 'owner'`,
  ).run(v.id, plugin, entity, label, now());

  return c.json({ ok: true, links: linksOf(v.id).map(shape) }, 201);
});

/**
 * Accept every current suggestion, as `auto`.
 *
 * The source is `auto` even though the owner pressed the button, because what
 * they approved was A LIST rather than each row: the distinction that matters
 * later is "somebody looked at this one thing and said yes", and that is what
 * `owner` means. Re-linking one by hand promotes it.
 */
ventureLinkRoutes.post("/:ventureKey/accept-all", async (c) => {
  const v = readVenture(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const links = linksOf(v.id);
  const { entities } = await allEntities();
  const linked = new Set(links.map((l) => `${l.plugin} ${l.entity}`));
  const suggestions = suggestFor(v, entities, linked);

  const ts = now();
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      `INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at)
       VALUES (?, ?, ?, ?, 'auto', ?)
       ON CONFLICT(venture_id, plugin, entity) DO NOTHING`,
    );
    for (const s of suggestions) stmt.run(v.id, s.plugin, s.entity, s.label, ts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return c.json({
    accepted: suggestions.length,
    links: linksOf(v.id).map(shape),
    /* What was accepted, with the sentence that justified each — so a bulk
       press leaves a record of what it was told, not just of what it did. */
    because: suggestions.map((s: Suggestion) => ({
      plugin: s.plugin,
      entity: s.entity,
      why: s.why,
    })),
  });
});

/**
 * Unlink.
 *
 * The entity is the last segment and it is matched greedily — `{.+}` — because
 * a Bing site is `https://acme.example/` and a path parameter that stopped at
 * the first slash could never name one. An encoded entity works too; Hono
 * decodes either.
 */
ventureLinkRoutes.delete("/:ventureKey/:plugin/:entity{.+}", (c) => {
  const v = readVenture(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const plugin = c.req.param("plugin");
  const entity = c.req.param("entity");
  const res = db
    .prepare("DELETE FROM venture_links WHERE venture_id = ? AND plugin = ? AND entity = ?")
    .run(v.id, plugin, entity);

  if (!res.changes)
    return c.json(
      { error: `${v.name} is not linked to ${plugin} ${entity}.`, links: linksOf(v.id).map(shape) },
      404,
    );
  return c.json({ ok: true, links: linksOf(v.id).map(shape) });
});

/* --------------------------------------------------------------- for others */

/** Everything, for a caller that wants the graph without an HTTP round trip.
 *  Used by nothing yet; exported beside `linkedEntities` because the audit's
 *  join taught the lesson that a second copy of a rule is a second rule. */
export type { Entity, SourceNote, Suggestion };
