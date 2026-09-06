/**
 * THE BRIEFING ROUTES — the latest one, the history, and a button that builds
 * one now.
 *
 * EVERY BRIEFING ANSWERS WITH ITS FACTS AS WELL AS ITS PROSE, always, on every
 * route below. That is the contract this area is built around: the page draws
 * the write-up and, under it, the figures it was made from, so a reader can
 * check any sentence against something. A route that returned only the markdown
 * would make the facts an implementation detail of a table nobody reads, and
 * the checkability would quietly be gone within a release.
 *
 * `POST /now` REBUILDS TODAY RATHER THAN MAKING A SECOND BRIEFING, because the
 * day is the key. Pressing it twice before lunch gives you one row, rewritten,
 * and one more line in the briefing chat — the delivery is not deduplicated,
 * deliberately: an owner who pressed Build now is asking to be sent it.
 */
import { Hono } from "hono";
import {
  DEFAULT_HOUR,
  SESSION,
  build,
  deliveredMessages,
  settings,
  systemZone,
  zoned,
} from "./briefing.ts";
import { briefing, briefings, latestBriefing, type BriefingRow } from "./store.ts";

export const briefingRoutes = new Hono();

function shape(b: BriefingRow) {
  let facts: unknown = {};
  try {
    facts = JSON.parse(b.facts);
  } catch {
    facts = {};
  }
  return {
    day: b.day,
    builtAt: b.built_at,
    /* The zone the DAY was computed in, stored on the row — so a briefing does
       not change which day it belongs to when the setting changes. */
    timezone: b.timezone,
    markdown: b.markdown,
    /* What the prose was written from. Empty markdown with a note beside it is
       a briefing whose facts are real and whose write-up did not happen; the
       facts are the half that is always true. */
    facts,
    model: b.model,
    note: b.note,
    delivered: {
      chat: b.to_chat === 1,
      telegram: b.to_telegram === 1,
      note: b.delivery_note,
    },
  };
}

/**
 * The settings as they are actually being applied, beside the schedule they
 * produce. `nextAt` is not a stored timestamp: it is derived from the zone and
 * the hour every time it is asked, so it cannot describe a schedule that has
 * since been changed.
 */
briefingRoutes.get("/settings", (c) => {
  const s = settings();
  const { day, hour } = zoned(s.timezone);
  return c.json({
    hour: s.hour,
    defaultHour: DEFAULT_HOUR,
    timezone: s.timezone,
    systemTimezone: systemZone(),
    telegram: s.telegram,
    sections: s.sections,
    today: { day, hour, built: !!briefing(day) },
    /* The session a briefing is filed under, so a caller can read the
       transcript back with GET /api/chat/<id>/messages and see it landed. */
    session: SESSION,
  });
});

briefingRoutes.get("/latest", (c) => {
  const b = latestBriefing();
  if (!b)
    return c.json(
      {
        briefing: null,
        /* Null with a reason, not an empty object. "Nothing has been built
           yet" and "the build failed" are different mornings. */
        note: "No briefing has been built yet. It is built once a day at the configured hour, and POST /api/briefing/now builds one immediately.",
      },
      200,
    );
  return c.json({ briefing: shape(b) });
});

briefingRoutes.get("/", (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 14) || 14));
  const rows = briefings(days);
  return c.json({
    window: { days, returned: rows.length },
    briefings: rows.map(shape),
  });
});

briefingRoutes.get("/:day{[0-9]{4}-[0-9]{2}-[0-9]{2}}", (c) => {
  const b = briefing(c.req.param("day"));
  if (!b) return c.json({ error: "No briefing was built for that day." }, 404);
  return c.json({ briefing: shape(b) });
});

/**
 * Build now.
 *
 * IT CAN TAKE A WHILE — a snapshot pass over six documents and one model call
 * — and it is a POST that waits for the answer rather than a run. That is the
 * right shape for something measured in seconds rather than minutes; the runs
 * engine is for work measured in minutes.
 */
briefingRoutes.post("/now", async (c) => {
  const result = await build({ force: true, signal: c.req.raw.signal });
  return c.json({
    briefing: shape(result.row),
    delivery: result.delivery,
    /* What actually reached the transcript, so the caller can see the message
       exists rather than trusting a boolean. */
    messages: deliveredMessages(3).map((m) => ({
      id: m.id,
      ts: m.ts,
      channel: m.channel,
      chars: m.content.length,
    })),
  });
});
