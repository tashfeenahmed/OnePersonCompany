/**
 * ONE ROUTER FOR THE GROWTH AREA, mounted at /api/growth.
 *
 * SIX DOCUMENTS UNDER ONE PREFIX, and they are one router rather than six
 * because they are one question asked six ways — "is anybody finding this, and
 * do they do anything when they arrive" — and because a reader of the code
 * should be able to see the whole surface of the area on one screen.
 *
 * FOUR OF THE SIX ARE COMPUTED ON EVERY READ and store nothing: authority, the
 * CRO funnel reading, the indexing document and ads health are all pure
 * functions of rows other collectors already own. What IS stored is what could
 * not be recomputed — a teardown's page structures as they were on the day, a
 * store listing as it was read, which experiments the owner started, and every
 * submission that was made.
 *
 * ERRORS ARE A SENTENCE AND A REAL STATUS. A venture that does not exist is a
 * 404 naming what was asked for; a submission for a host whose key file is
 * missing is a 200 with `outcome: "dry-run"` and the instruction, because the
 * request was understood and answered — it is the SITE that is not ready, and a
 * 4xx there would read as a bug in the caller.
 */
import { Hono } from "hono";
import { ventureRow } from "../../db.ts";
import { authorityAll, authorityFor } from "./authority.ts";
import { croFor, finishExperiment, startExperiment } from "./cro.ts";
import { adsHealthAll, adsHealthFor } from "./ads.ts";
import { auditDelta, indexingFor, sitemapUrls, sitemapsFor, submit } from "./indexing.ts";
import { rowsForRun, rowsForVenture } from "./serp.ts";
import { asoForRun, asoForVenture, ASO_RUBRIC } from "./aso.ts";

export const growthRoutes = new Hono();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* -------------------------------------------------------------- authority */

growthRoutes.get("/authority", (c) => c.json(authorityAll()));

growthRoutes.get("/authority/:host", (c) => c.json(authorityFor(c.req.param("host"))));

/* -------------------------------------------------------------------- cro */

growthRoutes.get("/cro/:ventureId", (c) => {
  const v = ventureRow(c.req.param("ventureId"));
  if (!v) return c.json({ error: `No venture called “${c.req.param("ventureId")}”.` }, 404);
  return c.json(croFor(v, c.req.query("stage") ?? null));
});

growthRoutes.post("/cro/:ventureId/start", async (c) => {
  const v = ventureRow(c.req.param("ventureId"));
  if (!v) return c.json({ error: `No venture called “${c.req.param("ventureId")}”.` }, 404);
  const body = (await c.req.json().catch(() => null)) as { experiment?: string; stage?: string } | null;
  const id = (body?.experiment ?? "").trim();
  if (!id) return c.json({ error: "Which experiment? Send `experiment` with an id from the library." }, 400);
  const got = startExperiment(v.id, id, (body?.stage ?? "").trim() || null);
  return got.ok ? c.json({ ok: true, experiment: got.row }, 201) : c.json({ error: got.error }, 400);
});

growthRoutes.post("/cro/:ventureId/finish", async (c) => {
  const v = ventureRow(c.req.param("ventureId"));
  if (!v) return c.json({ error: `No venture called “${c.req.param("ventureId")}”.` }, 404);
  const body = (await c.req.json().catch(() => null)) as
    | { experiment?: string; outcome?: string; result?: string; outcomeLink?: string }
    | null;
  const id = (body?.experiment ?? "").trim();
  if (!id) return c.json({ error: "Which experiment? Send `experiment` with an id from the library." }, 400);
  const got = finishExperiment(
    v.id,
    id,
    (body?.outcome ?? "done").trim(),
    (body?.result ?? "").trim() || null,
    (body?.outcomeLink ?? "").trim() || null,
  );
  return got.ok ? c.json({ ok: true, experiment: got.row }) : c.json({ error: got.error }, 400);
});

/* --------------------------------------------------------------- indexing */

growthRoutes.post("/indexing/submit", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { host?: string; urls?: string[]; sitemap?: boolean; audit?: boolean; dryRun?: boolean }
    | null;
  const host = (body?.host ?? "").trim();
  if (!host) return c.json({ error: "Which host? Send `host`, and either `urls`, or `audit: true`, or `sitemap: true`." }, 400);

  let urls = Array.isArray(body?.urls) ? body!.urls.filter((u) => typeof u === "string") : [];
  let reason = "owner";

  if (!urls.length && body?.audit) {
    const delta = auditDelta(host.replace(/^https?:\/\//, "").replace(/^www\./, ""));
    urls = [...delta.newUrls, ...delta.changedUrls];
    reason = delta.newUrls.length ? "audit-new" : "audit-changed";
    if (!urls.length) return c.json({ error: `Nothing to submit from the audit: ${delta.why}` }, 400);
  }

  if (!urls.length && body?.sitemap) {
    const maps = sitemapsFor(host.replace(/^https?:\/\//, "").replace(/^www\./, ""));
    const errors: string[] = [];
    for (const m of maps) {
      const got = await sitemapUrls(m.url);
      if ("urls" in got) urls.push(...got.urls);
      else errors.push(got.error);
    }
    reason = "sitemap";
    if (!urls.length)
      return c.json(
        {
          error: `No URL could be read from ${maps.map((m) => m.url).join(", ")}${errors.length ? ` — ${errors.join("; ")}` : ""}.`,
        },
        400,
      );
  }

  if (!urls.length) return c.json({ error: "There are no URLs to submit. Send `urls`, or ask for `audit: true` or `sitemap: true`." }, 400);

  const got = await submit({ host, urls, reason, dryRun: body?.dryRun === true });
  return "error" in got ? c.json({ error: got.error }, 400) : c.json(got);
});

growthRoutes.get("/indexing/:host", async (c) =>
  c.json(await indexingFor(c.req.param("host"), { check: c.req.query("check") === "1" })),
);

/* ------------------------------------------------------------------- ads */

growthRoutes.get("/ads", (c) => c.json(adsHealthAll()));

growthRoutes.get("/ads/:accountId", (c) => {
  const doc = adsHealthFor(c.req.param("accountId"));
  return doc
    ? c.json(doc)
    : c.json(
        {
          error: `No Meta ad account “${c.req.param("accountId")}” has been collected. GET /api/growth/ads lists the ones that have.`,
        },
        404,
      );
});

/* ------------------------------------------------------------------ serp */

growthRoutes.get("/serp", (c) => {
  const key = (c.req.query("venture") ?? "").trim();
  const limit = clamp(Number(c.req.query("limit") ?? 20) || 20, 1, 200);
  if (!key) return c.json({ error: "Which venture? GET /api/growth/serp?venture=<slug or id>." }, 400);
  const v = ventureRow(key);
  if (!v) return c.json({ error: `No venture called “${key}”.` }, 404);
  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name, host: v.host },
    rows: rowsForVenture(v.id, limit),
    means:
      "`ourRank` is where this host came in the SearXNG result list on ONE request from whichever engines answered; `gscPosition` is Google's own average over Search Console's window. They are different measurements and are never merged. `degraded: true` means the search answered a different question and no gap list was drawn.",
  });
});

growthRoutes.get("/serp/:runId", (c) => {
  const rows = rowsForRun(c.req.param("runId"));
  return c.json({ runId: c.req.param("runId"), rows, count: rows.length });
});

/* ------------------------------------------------------------------- aso */

growthRoutes.get("/aso", (c) => {
  const key = (c.req.query("venture") ?? "").trim();
  const limit = clamp(Number(c.req.query("limit") ?? 20) || 20, 1, 200);
  if (!key) return c.json({ error: "Which venture? GET /api/growth/aso?venture=<slug or id>." }, 400);
  const v = ventureRow(key);
  if (!v) return c.json({ error: `No venture called “${key}”.` }, 404);
  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name, host: v.host },
    rubric: ASO_RUBRIC,
    rows: asoForVenture(v.id, limit),
    means:
      "The score is this app's own rubric over the listing as a shopper reads it. A check that could not be answered is out of the denominator; a listing with fewer than three scorable dimensions is refused rather than graded.",
  });
});

growthRoutes.get("/aso/:runId", (c) => {
  const rows = asoForRun(c.req.param("runId"));
  return c.json({ runId: c.req.param("runId"), rows, count: rows.length, rubric: ASO_RUBRIC });
});
