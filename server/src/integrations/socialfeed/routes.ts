/**
 * THE SOCIAL FEED ROUTES.
 *
 * Three questions and four writes:
 *
 *   GET  /api/socialfeed/posts        what went out, and how it did
 *   GET  /api/socialfeed/sourcing     candidates, history and every verdict
 *   GET  /api/socialfeed/ugc          the UGC jobs and whether they can run
 *   POST /api/socialfeed/collect      read the timelines now
 *   POST /api/socialfeed/discover     find sources for one venture now
 *   POST /api/socialfeed/forget       drop one history entry, unblocking a topic
 *   POST /api/socialfeed/ugc/start    queue a UGC job — THIS ONE SPENDS MONEY
 *
 * THE MONEY DOOR IS NAMED AND THE OTHERS ARE NOT. `ugc/start` calls a paid
 * image model on every press and, when one is configured, a much more
 * expensive video model. The skill entry says so and the route says so in its
 * answer; nothing here is marked `destructive`, because none of it is
 * irreversible — a queued run can be cancelled and a draft can be deleted —
 * and marking a reversible action destructive would teach a client to ignore
 * the flag on the actions that really are.
 *
 * EVERY LIST IS BOUNDED AND EVERY WINDOW IS NAMED, the house rule. `null`
 * means not measured; nothing here turns a missing metric into a zero.
 */
import { Hono } from "hono";
import { db, ventureRow, ventureRowById, ventureRows } from "../../db.ts";
import { insertRun, mintRunId, queuedCount, runRow, shapeRun } from "../runs/store.ts";
import { assetRows } from "../publishing/assets.ts";
import { destinationRows, META_PLUGIN } from "../publishing/destinations.ts";
import { imageModel, imageReadiness } from "../ventures/studio.ts";
import { tokenAccounts } from "../../providers/replicate.ts";
import * as meta from "../../providers/meta.ts";
import { accountRows, lastRead, postRows, readPosts, shapePost } from "./posts.ts";
import { candidateRows, channelFor, discover, settings as sourcingSettings } from "./sourcing.ts";
import { checkRows, forget, historyRows, noveltyDays, restore } from "./novelty.ts";
import { channel, deliveryRows, sweep } from "./deliver.ts";
import { shapeUgc, ugcRows, ugcSeconds, videoModel } from "./ugc.ts";

export const socialfeedRoutes = new Hono();

const clamp = (raw: string | undefined, fallback: number, lo: number, hi: number) => {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

const ventureOf = (key: string | undefined) => (key ? (ventureRow(key) ?? null) : null);

/* ------------------------------------------------------------------ posts */

socialfeedRoutes.get("/posts", (c) => {
  const key = c.req.query("venture");
  const v = ventureOf(key);
  if (key && !v) return c.json({ error: `There is no venture “${key}”.` }, 404);
  const platform = (c.req.query("platform") ?? "").trim().toLowerCase() || null;
  if (platform && !["facebook", "instagram"].includes(platform))
    return c.json({ error: "`platform` is `facebook` or `instagram`." }, 400);

  const rows = postRows({ ventureId: v?.id ?? null, platform, limit: clamp(c.req.query("limit"), 60, 1, 300) });
  const mapped = destinationRows().filter((d) => d.plugin_id === META_PLUGIN && d.kind === "page");

  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    lastReadAt: lastRead(),
    posts: rows.map(shapePost),
    /* ONE ROW PER PLACE POSTS COME FROM, with its own freshness and its own
       error. A Page that is failing keeps the date it last worked. */
    accounts: accountRows().map((a) => ({
      platform: a.platform,
      pageId: a.page_id,
      pageName: a.page_name,
      account: a.account_label,
      ventureId: a.venture_id,
      ventureName: a.venture_id ? (ventureRowById(a.venture_id)?.name ?? null) : null,
      lastOkAt: a.last_ok_at,
      lastTriedAt: a.last_try_at,
      posts: a.posts,
      /* Meta's own sentence, whole. (#210) wants a Page token, (#100) means the
         metric no longer exists and (#190) means the wrong kind of token —
         three different fixes, so they are never folded into "unavailable". */
      error: a.error,
      insightsError: a.insights_error,
    })),
    metrics: {
      /* WHAT IS STILL A VALID METRIC NAME, measured on 2026-09-06 against
         v21.0 — see providers/meta.ts. */
      facebook: meta.POST_INSIGHT_METRICS,
      retired: meta.RETIRED_POST_METRICS,
      instagram: ["reach", "like_count", "comments_count"],
      note:
        "The keys under a post's `metrics` are Meta's OWN names. `post_media_view` counts RENDERS " +
        "and Instagram's `reach` counts unique accounts; they are different quantities and are never " +
        "added or compared. A metric that is not a key was not reported — it is not zero.",
    },
    coverage: {
      pagesMapped: mapped.length,
      /* NULL UNTIL SOMETHING HAS ACTUALLY BEEN READ, which is the difference
         between a measurement and an assumption. This counts Instagram
         accounts that were FOUND during a read; before the first read it is
         zero for the same reason an empty table is zero, and a page that said
         "no Instagram account is linked" on the strength of that would be
         making a claim about Meta out of a claim about this database. */
      instagramLinked: lastRead() === null ? null : accountRows().filter((a) => a.platform === "instagram").length,
      note:
        "Only Pages the owner has mapped to a venture under Publishing are read. A token can administer " +
        "Pages belonging to businesses this box has never heard of, and reading those would be collecting " +
        "somebody else's data.",
    },
    note:
      "This is the timeline read BACK from Meta, not what this box queued. A post with `fromDraft` came out " +
      "of a draft generated here; a post without one was made somewhere else, which is most of them.",
  });
});

socialfeedRoutes.post("/collect", async (c) => {
  const result = await readPosts();
  return c.json({
    ...result,
    note:
      "One request per Page, with insights riding on the posts edge as a field expansion. Nothing is written " +
      "to any timeline: every call in this path is a GET.",
  });
});

/* --------------------------------------------------------------- sourcing */

socialfeedRoutes.get("/sourcing", (c) => {
  const key = c.req.query("venture");
  const v = ventureOf(key);
  if (key && !v) return c.json({ error: `There is no venture “${key}”.` }, 404);
  const limit = clamp(c.req.query("limit"), 60, 1, 300);
  const s = sourcingSettings();

  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    settings: {
      /* How far back the judge is shown. There is no threshold beside it any
         more: whether two topics are the same piece of work is a model's
         verdict, not a share of shared words. See novelty.ts. */
      noveltyDays: noveltyDays(),
      minMinutes: Math.round(s.minSeconds / 60),
      maxMinutes: Math.round(s.maxSeconds / 60),
      probeTop: s.probe,
      channels: Object.entries(s.channels).map(([venture, url]) => ({ venture, url })),
      /* Where a finished asset is announced. `off` still files the draft. */
      deliverTo: channel(),
    },
    ventures: ventureRows().map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      /* The venture's own channel, if a setting names one. Null means the
         search is one query rather than two. */
      channel: channelFor(row, s),
    })),
    candidates: candidateRows({ ventureId: v?.id ?? null, limit }).map((r) => ({
      id: r.id,
      ventureId: r.venture_id,
      query: r.query,
      url: r.url,
      sourceId: r.source_id,
      title: r.title,
      author: r.author,
      engine: r.engine,
      publishedAt: r.published_at,
      durationS: r.duration_s,
      /* `searxng` is the engine's own length string, which is sometimes wrong;
         `yt-dlp` is the file's real metadata. Null means neither said. */
      durationFrom: r.duration_from,
      score: r.score,
      rank: r.rank,
      verdict: r.verdict,
      reason: r.reason,
      ts: r.ts,
    })),
    history: historyRows({ ventureId: v?.id ?? null, limit }).map((r) => ({
      id: r.id,
      ventureId: r.venture_id,
      ventureName: ventureRowById(r.venture_id)?.name ?? null,
      format: r.format,
      topic: r.topic,
      /* The exact-match key, not a similarity fingerprint: two rows with the
         same one are the same topic typed twice. Whether two DIFFERENT topics
         are the same piece of work is in `verdicts`, where a model said so. */
      fingerprint: r.fingerprint,
      sourceUrl: r.source_url,
      sourceId: r.source_id,
      pageUrl: r.page_url,
      assetKind: r.asset_kind,
      assetRef: r.asset_ref,
      createdAt: r.created_at,
      /* Null is a live entry the gate counts. A date is one the owner set
         aside: the gate ignores it and the row is still here. */
      archivedAt: r.archived_at,
    })),
    verdicts: checkRows({ ventureId: v?.id ?? null, limit }).map((r) => ({
      id: r.id,
      ts: r.ts,
      ventureId: r.venture_id,
      format: r.format,
      kind: r.kind,
      value: r.value,
      verdict: r.verdict,
      reason: r.reason,
      matched: r.matched,
      matchedId: r.matched_id,
      score: r.score,
    })),
    deliveries: deliveryRows(40).map((d) => ({
      ref: d.ref,
      ventureId: d.venture_id,
      at: d.at,
      channel: d.channel,
      sent: d.sent === 1,
      reason: d.reason,
      publishItem: d.publish_item,
    })),
    note:
      "The gate runs BEFORE anything is generated. A refusal costs nothing and is the feature working; a " +
      "`failed` verdict does not exist here, because a gate cannot fail — it can only allow or refuse. " +
      "`candidates` is the LAST SEARCH for each venture and nothing older: a new search replaces that venture's " +
      "rows, so the reasons shown here are the reasons of the search whose `ts` they carry. `verdicts` and " +
      "`history` accumulate and are not replaced.",
  });
});

/**
 * Find sources for one venture, now.
 *
 * NOT FREE AND NOT A WRITE TO ANYTHING BUT THIS BOX'S OWN TABLE. It costs one
 * or two searches on the owner's own SearXNG node and up to a handful of
 * yt-dlp metadata reads — no downloads, no model calls, no money.
 */
socialfeedRoutes.post("/discover", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { venture?: unknown; topic?: unknown };
  const key = typeof body.venture === "string" ? body.venture : c.req.query("venture");
  const v = ventureOf(key ?? undefined);
  if (!v) return c.json({ error: "A venture is needed: source discovery is about one business's audience." }, 400);
  const topic = (typeof body.topic === "string" ? body.topic : "").trim();
  if (!topic)
    return c.json(
      { error: "A topic is needed. Discovery searches for footage ABOUT a subject; without one there is nothing to search for." },
      400,
    );

  const d = await discover(v, topic);
  return c.json({
    ...d,
    candidates: d.candidates.map((x, i) => ({ ...x, rank: i + 1 })),
    note:
      "Candidates come from the SearXNG node's video category. Duration is the engine's own string unless " +
      "`durationFrom` says `yt-dlp`, which is the file's real metadata and is only read for the top few. " +
      "Nothing was downloaded.",
  });
});

socialfeedRoutes.post("/forget", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "`id` is a content history row id." }, 400);
  const res = forget(id);
  if (!res.ok) return c.json({ error: res.error }, 404);
  return c.json({
    ok: true,
    id,
    already: res.already === true,
    note:
      "That entry is ARCHIVED, not deleted. The gate stops counting it, so the topic it blocked is allowed the " +
      "next time it comes up; the row itself is still in the history, flagged, and `restore` puts it back. " +
      "The record of what was made is not destroyed by overruling the gate.",
  });
});

socialfeedRoutes.post("/restore", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "`id` is a content history row id." }, 400);
  const res = restore(id);
  if (!res.ok) return c.json({ error: res.error }, 404);
  return c.json({ ok: true, id, note: "That entry counts again, so its topic will be refused as a repeat inside the window." });
});

socialfeedRoutes.post("/deliver", async (c) => {
  const res = await sweep();
  return c.json({
    ...res,
    channel: channel(),
    note:
      "Delivers finished videos the AUTOPILOT queued and nothing else — a video started by hand is one somebody " +
      "is already watching. Each is filed as a DRAFT in the publishing queue, and announced on the paired Telegram " +
      `chat unless the delivery setting is off (it is “${channel()}”). Nothing is published anywhere.`,
  });
});

/* -------------------------------------------------------------------- ugc */

socialfeedRoutes.get("/ugc", (c) => {
  const key = c.req.query("venture");
  const v = ventureOf(key);
  if (key && !v) return c.json({ error: `There is no venture “${key}”.` }, 404);
  const replicate = tokenAccounts("socialfeed_ugc_readiness");
  const model = videoModel();
  const image = imageReadiness();

  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    ready: {
      replicate: replicate.length > 0,
      image: image.ready,
      imageProvider: image.provider,
      imageModel: imageModel(),
      /* NULL IS THE DEFAULT AND IT IS NOT A FAULT. With no model named the
         animation step is skipped, the job produces a still, and nothing is
         spent. */
      videoModel: model,
      seconds: ugcSeconds(),
      note: !image.ready
        ? image.note
        : model && !replicate.length
          ? "The still image is ready to generate. Connect Replicate to animate it."
        : model
          ? `The animation step will call ${model}, which costs real money per clip.`
          : "No image-to-video model is named, so a UGC job will produce a still image and skip the animation step. Nothing is spent on video.",
    },
    /* Pictures are optional when the owner describes the scene. */
    ventures: ventureRows().map((row) => {
      const assets = assetRows(row.id).length;
      return { id: row.id, slug: row.slug, name: row.name, assets, canRun: image.ready };
    }),
    jobs: ugcRows(v?.id ?? null, clamp(c.req.query("limit"), 40, 1, 200)).map(shapeUgc),
    note:
      "A UGC job is a `video` run with `format: ugc`. It produces a DRAFT in the publishing queue and never " +
      "posts anything. `skipped` on a job names the step that did not run and why — the ordinary value is the " +
      "animation step with no model configured, and that is not a failure.",
  });
});

/**
 * Queue one UGC job.
 *
 * IT SPENDS MONEY ON EVERY PRESS: one image-model prediction always, and one
 * image-to-video prediction when a model is configured. The answer says which
 * of those will happen, before anybody has to look at a bill.
 */
socialfeedRoutes.post("/ugc/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    venture?: unknown;
    brief?: unknown;
    assets?: unknown;
    aspect?: unknown;
  };
  const v = ventureOf(typeof body.venture === "string" ? body.venture : undefined);
  if (!v) return c.json({ error: "Choose a venture for this UGC shot." }, 400);

  const library = assetRows(v.id);
  const brief = (typeof body.brief === "string" ? body.brief : "").trim().slice(0, 2000);
  if (!library.length && !brief)
    return c.json({ error: "Describe the opening shot, or add a reference picture." }, 400);

  const image = imageReadiness();
  if (!image.ready) return c.json({ error: image.note }, 400);
  if (videoModel() && !tokenAccounts("socialfeed_ugc_start").length)
    return c.json({ error: "Connect Replicate to use the configured animation model." }, 400);

  const assets = Array.isArray(body.assets)
    ? body.assets.filter((x): x is string => typeof x === "string")
    : typeof body.assets === "string"
      ? body.assets.split(/[,\s]+/).filter(Boolean)
      : [];
  const unknown = assets.filter((id) => !library.some((a) => a.id === id));
  if (unknown.length) return c.json({ error: `Not assets of ${v.name}: ${unknown.join(", ")}.` }, 400);

  const aspect = typeof body.aspect === "string" && ["9:16", "1:1", "16:9"].includes(body.aspect.trim()) ? body.aspect.trim() : "9:16";

  const id = mintRunId();
  insertRun({
    id,
    kind: "video",
    ventureId: v.id,
    title: brief || `A UGC shot for ${v.name}`,
    input: { format: "ugc", brief, assets: assets.join(","), aspect, fit: "cover" },
  });

  const model = videoModel();
  return c.json(
    {
      run: shapeRun(runRow(id)!),
      queued: queuedCount(),
      spend: {
        /* Named before it happens, in the answer, rather than discovered on a
           bill. */
        image: `one prediction on ${imageModel()}, always`,
        video: model ? `one prediction on ${model}, which is the expensive one` : "none — no image-to-video model is configured, so that step is skipped",
      },
      note:
        "Queued as a video run. There is ONE run slot on this box, shared with everything else. The finished " +
        "asset becomes a DRAFT in the publishing queue; nothing is posted anywhere.",
    },
    201,
  );
});

/* A venture's assets, so the Studio page can decide whether to offer the
   button without importing the publishing area's own routes. */
socialfeedRoutes.get("/ugc/assets/:venture", (c) => {
  const v = ventureOf(c.req.param("venture"));
  if (!v) return c.json({ error: "No such venture." }, 404);
  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name },
    assets: assetRows(v.id).map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      url: `/api/publishing/assets/${a.id}/file`,
      width: a.width,
      height: a.height,
    })),
  });
});

/* One statement rather than a select per row: the Posts page asks how many
   posts each venture has and a portfolio of nineteen should not be nineteen
   queries. Kept here rather than in posts.ts because it is a shape for a
   page rather than a fact about a post. */
socialfeedRoutes.get("/posts/counts", (c) =>
  c.json({
    counts: db
      .prepare("SELECT venture_id, platform, COUNT(*) AS n FROM social_posts GROUP BY venture_id, platform")
      .all() as unknown as { venture_id: string | null; platform: string; n: number }[],
  }),
);
