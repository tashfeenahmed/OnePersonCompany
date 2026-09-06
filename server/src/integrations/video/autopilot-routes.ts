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
      "there is no credential for any social or video platform in this vault and no route here that would upload one. " +
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
