/**
 * THE AUTOPILOT ROUTES — what is scheduled, when it next fires, and what it
 * has done.
 *
 * TWO ROUTES AND ONE OF THEM WRITES. `GET /api/autopilot` is the whole state:
 * the settings as they resolve (not as they are stored — a blank setting is a
 * default and the page should show the default), the next instant it would
 * wake, this week's tally per venture against the cadence, and the log.
 * `POST /api/autopilot/now` runs a pass immediately.
 *
 * `now` IS NOT DESTRUCTIVE AND IS ALSO NOT FREE, and the skill entry says both.
 * It queues work that costs Replicate credit and Pexels quota, and it is
 * bounded by exactly the same three brakes the clock is: the cadence, the day
 * cap and the run queue. That is the point of the manual door — it is the
 * scheduled pass, run now, rather than a way round the limits. A pass that
 * finds every cadence met queues nothing and says so, which is the correct
 * answer and is not a failure.
 *
 * THE TALLY IS COMPUTED PER READ AND IS NOT STORED. It is a count of log rows
 * in the last seven days, which is the same count the pass itself makes when
 * it decides; a cached copy would be a second answer to a question with one
 * source.
 */
import { Hono } from "hono";
import { db, ventureRows, ventureRowById } from "../../db.ts";
import { activeProvider } from "../../models/provider.ts";
import { queuedCount, runningRow } from "../runs/store.ts";
import { logRows, nextRunAt, runPass, schedule, wall } from "./autopilot.ts";
/* THE GATE'S OWN STATE, added 2026-09-06. It is on THIS document rather than
   behind a second request because "why was nothing queued" is the question
   this page exists to answer, and since the gate landed the answer is often
   "because it was a repeat" — which lives in another area's tables. */
import { checkRows, historyRows, noveltyDays, repeatLimit } from "../socialfeed/novelty.ts";
import { candidateRows, settings as sourcingSettings, channelFor } from "../socialfeed/sourcing.ts";

export const autopilotRoutes = new Hono();

/** How many of one kind were queued for one venture in the last seven days.
 *  The same rolling window the pass uses — see autopilot.ts. */
function weekly(): Map<string, { post: number; video: number }> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = db
    .prepare(
      "SELECT venture_id, kind, COUNT(*) AS n FROM video_autopilot_log WHERE action = 'queued' AND ts >= ? AND venture_id IS NOT NULL GROUP BY venture_id, kind",
    )
    .all(since) as unknown as { venture_id: string; kind: string; n: number }[];
  const out = new Map<string, { post: number; video: number }>();
  for (const r of rows) {
    const b = out.get(r.venture_id) ?? { post: 0, video: 0 };
    if (r.kind === "post") b.post += r.n;
    if (r.kind === "video") b.video += r.n;
    out.set(r.venture_id, b);
  }
  return out;
}

autopilotRoutes.get("/", (c) => {
  const s = schedule();
  const tally = weekly();
  const provider = activeProvider();

  return c.json({
    schedule: {
      enabled: s.enabled,
      /* Per venture per WEEK, and the week is the last seven days rather than
         a calendar one. Stated on the wire because a client that assumed
         Monday-to-Sunday would draw the wrong bar. */
      postsPerVenturePerWeek: s.posts,
      videosPerVenturePerWeek: s.videos,
      hour: s.hour,
      timezone: s.timezone,
      quietStages: s.quiet,
      formats: s.formats,
      dailyCap: s.cap,
    },
    now: { local: wall(s.timezone), queued: queuedCount(), running: runningRow()?.title ?? null },
    /* Null when it is switched off — not a date in the past, and not the date
       it WOULD have been. Off means there is no next run. */
    nextRunAt: nextRunAt(s),
    ready: {
      model: provider?.id ?? null,
      note: provider
        ? `Topics are derived by ${provider.label}. Nothing is queued without one.`
        : "No model provider is live, so no topic can be derived and a pass will queue nothing. Choose one under Integrations → Models.",
    },
    ventures: ventureRows().map((v) => {
      const t = tally.get(v.id) ?? { post: 0, video: 0 };
      const quiet = s.quiet.includes(v.stage.toLowerCase());
      return {
        id: v.id,
        slug: v.slug,
        name: v.name,
        stage: v.stage,
        /* Why this venture will or will not get anything, in one sentence, so
           the page does not have to derive it from four numbers. */
        quiet,
        posts: { made: t.post, cadence: s.posts, due: !quiet && s.posts > t.post },
        videos: { made: t.video, cadence: s.videos, due: !quiet && s.videos > t.video },
      };
    }),
    /* ------------------------------------------------- the novelty gate */
    novelty: {
      windowDays: noveltyDays(),
      /* The share of a new topic's distinctive words that must already have
         been used for it to count as the same work. Asymmetric — see
         integrations/socialfeed/novelty.ts. */
      repeatLimit: repeatLimit(),
      note:
        "The gate runs BEFORE anything is generated, so a refusal costs nothing and is the feature working. " +
        "A topic is compared over the window; a source video is compared forever, because a second short out " +
        "of the same footage is the same footage.",
      verdicts: checkRows({ limit: 40 }).map((r) => ({
        id: r.id,
        ts: r.ts,
        ventureId: r.venture_id,
        ventureName: r.venture_id ? (ventureRowById(r.venture_id)?.name ?? null) : null,
        format: r.format,
        kind: r.kind,
        value: r.value,
        verdict: r.verdict,
        reason: r.reason,
        matched: r.matched,
        score: r.score,
      })),
      history: historyRows({ limit: 40 }).map((r) => ({
        id: r.id,
        ventureId: r.venture_id,
        ventureName: ventureRowById(r.venture_id)?.name ?? null,
        format: r.format,
        topic: r.topic,
        sourceUrl: r.source_url,
        assetKind: r.asset_kind,
        assetRef: r.asset_ref,
        createdAt: r.created_at,
      })),
    },
    /* ----------------------------------------------- the source search */
    sources: {
      settings: (() => {
        const so = sourcingSettings();
        return {
          minMinutes: Math.round(so.minSeconds / 60),
          maxMinutes: Math.round(so.maxSeconds / 60),
          probeTop: so.probe,
          channels: ventureRows()
            .map((row) => ({ venture: row.slug, url: channelFor(row, so) }))
            .filter((x) => x.url !== null),
        };
      })(),
      candidates: candidateRows({ limit: 60 }).map((r) => ({
        id: r.id,
        ventureId: r.venture_id,
        ventureName: ventureRowById(r.venture_id)?.name ?? null,
        query: r.query,
        url: r.url,
        title: r.title,
        author: r.author,
        engine: r.engine,
        durationS: r.duration_s,
        /* `yt-dlp` is the file's real metadata; `searxng` is the engine's own
           string and is sometimes wrong. Null means neither said. */
        durationFrom: r.duration_from,
        publishedAt: r.published_at,
        score: r.score,
        rank: r.rank,
        verdict: r.verdict,
        reason: r.reason,
        ts: r.ts,
      })),
      note:
        "Candidates are found on the owner's own SearXNG node in its video category and ranked by duration " +
        "fit, recency where a date exists, and how many engines carried the link. No model chose any of them.",
    },
    log: logRows(80).map((r) => ({
      id: r.id,
      ts: r.ts,
      passId: r.pass_id,
      ventureId: r.venture_id,
      ventureName: r.venture_id ? (ventureRowById(r.venture_id)?.name ?? null) : null,
      kind: r.kind,
      /* `queued` is work that now exists, `skipped` is a rule being obeyed,
         `failed` is something breaking. Three words, never folded. */
      action: r.action,
      /* A studio post id for a post, a run id for a video, null for a skip.
         Not a foreign key — see the migration. */
      ref: r.ref,
      note: r.note,
    })),
    note:
      "The autopilot QUEUES work and never publishes any of it. A post lands in the Studio gallery and a video lands on its run page; " +
      "Finished assets are filed in Publishing as drafts for review. " +
      "`made` is what the autopilot itself queued in the last seven days — a post the owner made by hand is not counted and does not use up the cadence.",
  });
});

autopilotRoutes.post("/now", async (c) => {
  const result = await runPass("manual");
  return c.json({
    ...result,
    note:
      "A manual pass obeys exactly the same brakes as the scheduled one — the per-venture cadence, the day's cap and the run queue. " +
      "Queueing nothing because every cadence is met is the right answer, not a failure.",
  });
});
