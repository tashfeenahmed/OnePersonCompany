/**
 * THE ACTIVITY DOCUMENT.
 *
 * The feed itself, plus per-day counts by kind so a page can draw the shape of
 * a month without holding a month of rows.
 *
 * EVERY EVENT CARRIES `exact`, AND IT IS THE FIRST THING A READER SHOULD LOOK
 * AT. True means the source published the moment: a signup's own createdAt, a
 * run's finished_at, a card's done_at, GitHub's pushed_at. False means the
 * source publishes a DAY — Stripe's charge and ledger tables are one row per
 * UTC day per currency — so the timestamp is the start of that day and is a
 * bucket rather than an observation. `resolution: "day"` is on the detail of
 * every one of those, and a surface that prints "00:00" for one is printing a
 * moment nobody measured.
 *
 * THE DAY COUNTS ARE COUNTS OF EVENTS AND NEVER OF MONEY. Four refunds is four
 * rows on the chart whether they were four dollars or four thousand; the
 * amounts are on the events. A bar chart of "activity" that scaled with
 * currency would be a revenue chart with the currencies added together, which
 * is the one thing this codebase never does.
 *
 * `venture` FILTERS ON WHAT CAN BE ATTRIBUTED, AND SOME KINDS NEVER CAN.
 * Stripe's day tables are per account and per currency, not per product, so no
 * charge, refund or dispute has a venture and filtering by one excludes them
 * all. That is stated in the document rather than left as a surprising gap.
 */
import { Hono } from "hono";
import { ventureRow, ventureRows } from "../../db.ts";
import { db } from "../../db.ts";
import { WINDOW_DAYS, runFeedPass } from "./feed.ts";

export const activityRoutes = new Hono();

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value));
}

/** Which kinds structurally cannot carry a venture, so the document can say so
 *  rather than leave a filtered feed looking broken. */
const UNATTRIBUTABLE = ["charge", "refund", "dispute", "payment_failed"];

type Row = {
  key: string; ts: string; exact: number; kind: string; venture_id: string | null;
  product: string | null; title: string; detail: string; source: string; found_at: string;
};

activityRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? 14) || 14, 1, 400);
  const limit = clamp(Number(c.req.query("limit") ?? 200) || 200, 1, 1000);
  const ventureParam = (c.req.query("venture") ?? "").trim();
  const kindParam = (c.req.query("kind") ?? "").trim();

  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const fromIso = `${from}T00:00:00.000Z`;

  let venture: { id: string; slug: string; name: string } | null = null;
  if (ventureParam) {
    const row = ventureRow(ventureParam);
    if (!row)
      return c.json(
        {
          error: `There is no venture called “${ventureParam}”. The ones there are: ${ventureRows().map((v) => v.slug).join(", ")}.`,
        },
        404,
      );
    venture = { id: row.id, slug: row.slug, name: row.name };
  }

  const kinds = kindParam
    ? kindParam.split(",").map((k) => k.trim()).filter(Boolean)
    : [];

  const where: string[] = ["ts >= ?"];
  const args: (string | number)[] = [fromIso];
  if (venture) {
    where.push("venture_id = ?");
    args.push(venture.id);
  }
  if (kinds.length) {
    where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
    args.push(...kinds);
  }
  const clause = where.join(" AND ");

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM activity_events WHERE ${clause}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM activity_events WHERE ${clause} ORDER BY ts DESC, key DESC LIMIT ?`)
    .all(...args, limit) as unknown as Row[];

  /* The per-day counts are computed over the SAME filter as the feed, so the
     chart and the list can never disagree — and over every day in the window,
     including the empty ones, because a gap in a bar chart is information and a
     missing bar is a rendering accident. */
  const counted = db
    .prepare(
      `SELECT substr(ts, 1, 10) AS day, kind, COUNT(*) AS n
         FROM activity_events WHERE ${clause}
        GROUP BY day, kind ORDER BY day ASC`,
    )
    .all(...args) as unknown as { day: string; kind: string; n: number }[];

  const byDay = new Map<string, Record<string, number>>();
  for (let i = 0; i < days; i++)
    byDay.set(new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10), {});
  for (const r of counted) {
    const d = byDay.get(r.day);
    if (d) d[r.kind] = r.n;
  }

  const kindTotals = new Map<string, number>();
  for (const r of counted) kindTotals.set(r.kind, (kindTotals.get(r.kind) ?? 0) + r.n);

  const oldest = (db.prepare("SELECT MIN(ts) AS t FROM activity_events").get() as { t: string | null }).t;
  const lastPass = (db.prepare("SELECT MAX(found_at) AS t FROM activity_events").get() as { t: string | null }).t;

  return c.json({
    window: { days, from, of: "the events' own timestamps, not when this box noticed them" },
    filter: {
      venture,
      kinds: kinds.length ? kinds : null,
      note: venture
        ? `Stripe's day tables are per account and per currency, not per product, so ${UNATTRIBUTABLE.join(", ")} events carry no venture and are excluded by this filter.`
        : null,
    },
    events: rows.map((r) => ({
      key: r.key,
      ts: r.ts,
      /** TRUE: the source published this moment. FALSE: the source publishes a
       *  day, and this is the start of it — a bucket, not an observation. */
      exact: r.exact === 1,
      resolution: r.exact === 1 ? "moment" : "day",
      kind: r.kind,
      venture: r.venture_id,
      product: r.product,
      title: r.title,
      detail: ((): unknown => {
        try {
          return JSON.parse(r.detail);
        } catch {
          return {};
        }
      })(),
      source: r.source,
      firstSeenAt: r.found_at,
    })),
    counts: {
      returned: rows.length,
      matching: total,
      truncated: total > rows.length,
      byKind: [...kindTotals.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n })),
      /** Counts of EVENTS per day, never of money. See this file's header. */
      byDay: [...byDay.entries()].map(([day, kinds]) => ({
        day,
        kinds,
        n: Object.values(kinds).reduce((a, b) => a + b, 0),
      })),
    },
    coverage: {
      /** The oldest event in the table at all — not the oldest thing that ever
       *  happened. The pass only derives back this far on a first run. */
      oldest,
      derivesBackDays: WINDOW_DAYS,
      /** When the pass last wrote anything. Null on a box where it has never
       *  run, which is different from a feed that is genuinely empty. */
      lastPassAt: lastPass,
      exactKinds: ["signup", "run", "card", "push", "alert"],
      dayResolutionKinds: UNATTRIBUTABLE,
      note:
        "Half of these timestamps are the source's own and half are computed from daily rows. " +
        "`exact` says which on every event; a day-resolution event's time is the start of its " +
        "UTC day and nobody observed a 00:00.",
    },
  });
});

/**
 * Run the pass now.
 *
 * A POST because it writes, and it is on this router rather than in a skill's
 * actions because there is nothing an agent gains by forcing a refresh of a
 * derivation that runs on a timer — it is the page's Collect button, for a
 * feature whose collector is not a plugin.
 */
activityRoutes.post("/refresh", (c) => {
  const r = runFeedPass();
  return c.json({ ok: true, ...r });
});
