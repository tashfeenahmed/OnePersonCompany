/**
 * BUSINESS EVENTS — what Stripe said happened, and whether the owner was
 * actually told.
 *
 * THE SECOND HALF OF THAT SENTENCE IS THE POINT. This box already had two
 * ways of putting a figure on a phone: the alert engine, which watches a
 * document for a threshold, and the briefing, which arrives at seven. Neither
 * can say "a customer paid you at 14:06" — an aggregate cannot name a moment
 * — and neither has any record of a message that failed to send. So this
 * route publishes the delivery state beside the event, including the reasons
 * an event correctly produced no message, because "you were not told" is a
 * fact about the tool and there was previously nowhere to read it.
 *
 * `suppressed` IS NOT `failed`. Four things stop a message and they are not
 * interchangeable: the first collection's backlog, a collapse of repeated
 * failures for one customer, an aggregate alert that already covered the same
 * class in the same hour, and a type the owner muted. Each writes its own
 * sentence into `suppressedBy`. A delivery that was ATTEMPTED and refused is
 * a different row entirely — it has an `attempts` count and an error, and it
 * is in the undelivered view until it succeeds or runs out of attempts.
 */
import { Hono } from "hono";
import { ventureRows } from "../../db.ts";
import { WATCHED_EVENTS } from "../../providers/stripe.ts";
import { COLLAPSE_MINUTES, RECONCILE_MINUTES } from "./events.ts";
import { MAX_DELIVERY_ATTEMPTS } from "./collect.ts";
import {
  businessEvent,
  businessEvents,
  muteType,
  mutedTypes,
  requeue,
  settings,
  unmuteType,
  type BusinessEventRecord,
} from "./store.ts";

export const businessEventRoutes = new Hono();

function shape(e: BusinessEventRecord, names: Map<string, string>) {
  return {
    id: e.id,
    type: e.type,
    at: e.at,
    summary: e.summary,
    account: e.account_label,
    venture: e.venture_id,
    ventureName: e.venture_id ? (names.get(e.venture_id) ?? null) : null,
    /** What the event is ABOUT, as a reference rather than a copy. The object
     *  itself still lives at Stripe and a stored copy would be an ageing
     *  second version of it. */
    object: { id: e.object_id, type: e.object_type },
    customer: e.customer,
    amount: e.amount,
    currency: e.currency,
    delivery: {
      deliveredAt: e.delivered_at,
      /** Attempts made, whether or not any succeeded. Never reset by a
       *  resend: it is the history of what this event has cost. */
      attempts: e.attempts,
      error: e.delivery_error,
      /** True where the pass has stopped trying. The row stays visible. */
      exhausted: e.delivered_at === null && e.attempts >= MAX_DELIVERY_ATTEMPTS,
      muted: e.muted === 1,
      suppressedBy: e.suppressed_by,
      /** Quiet hours. The event is still going to be delivered; it is waiting
       *  for a civil hour in the owner's zone. */
      deferredUntil: e.deferred_until,
    },
    seenAt: e.seen_at,
  };
}

businessEventRoutes.get("/", (c) => {
  const s = settings();
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 7) || 7, 1), 90);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
  const type = (c.req.query("type") ?? "").trim() || undefined;
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));

  const rows = businessEvents({ days, limit, type });
  const window = businessEvents({ days, limit: 1000 });
  const muted = mutedTypes();

  return c.json({
    window: { days },
    settings: {
      /** Whether anything is pushed at all. Off until asked for. */
      telegram: s.telegram,
      quietHours: s.quiet ? `${s.quiet.from}-${s.quiet.to}` : null,
      timezone: s.timezone,
      timezoneFrom: s.timezoneFrom,
      mutedTypes: muted,
      collapseMinutes: COLLAPSE_MINUTES,
      reconcileMinutes: RECONCILE_MINUTES,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    },
    watched: [...WATCHED_EVENTS],
    counts: {
      inWindow: window.length,
      delivered: window.filter((e) => e.delivered_at).length,
      /** Waiting: neither delivered nor suppressed. Includes deferred rows. */
      pending: window.filter((e) => !e.delivered_at && e.muted === 0).length,
      suppressed: window.filter((e) => e.muted === 1).length,
      failed: window.filter((e) => !e.delivered_at && e.delivery_error).length,
      byType: Object.fromEntries(
        [...new Set(window.map((e) => e.type))].sort().map((t) => [
          t,
          window.filter((e) => e.type === t).length,
        ]),
      ),
    },
    items: rows.map((e) => shape(e, names)),
    note:
      "One row per Stripe event id — that is the whole dedupe, which is why the walk may " +
      "overlap its own window freely. A suppressed row is not a failure: read `suppressedBy`.",
    cannot: [
      "prove delivery to a human. `deliveredAt` means Telegram accepted the message, which is not the same as somebody reading it.",
      "reconstruct an event Stripe has aged out. Stripe keeps events for thirty days; anything older than the first collection was never seen and cannot be.",
      "tell you the money moved. An event is a notification, not settlement — the ledger is the only place money is measured.",
    ],
  });
});

businessEventRoutes.get("/undelivered", (c) => {
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const rows = businessEvents({ days: 30, limit: 500, undeliveredOnly: true });
  return c.json({
    items: rows.map((e) => shape(e, names)),
    counts: {
      total: rows.length,
      deferred: rows.filter((e) => e.deferred_until).length,
      failed: rows.filter((e) => e.delivery_error).length,
      exhausted: rows.filter((e) => e.attempts >= MAX_DELIVERY_ATTEMPTS).length,
    },
    note:
      "Not delivered and not suppressed, over thirty days. A deferred row is waiting for the " +
      `end of quiet hours; an exhausted one has been tried ${MAX_DELIVERY_ATTEMPTS} times and ` +
      "the pass has stopped, but it is still here rather than dropped.",
  });
});

/* ------------------------------------------------------------------ writes */

businessEventRoutes.post("/mute", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { type?: string } | null;
  const type = String(body?.type ?? "").trim();
  if (!type) return c.json({ error: "Name the event type to mute." }, 400);
  if (!(WATCHED_EVENTS as readonly string[]).includes(type))
    return c.json(
      {
        error: `“${type}” is not a type this area watches. The watched list is: ${WATCHED_EVENTS.join(", ")}.`,
      },
      400,
    );
  muteType(type);
  return c.json({
    muted: mutedTypes(),
    note:
      `${type} will not produce a message, and anything of that type still waiting has gone ` +
      "quiet too — a mute that only applied to future events would still deliver the backlog " +
      "that made you press the button. The events are still ingested and still readable.",
  });
});

businessEventRoutes.post("/unmute", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { type?: string } | null;
  const type = String(body?.type ?? "").trim();
  if (!type) return c.json({ error: "Name the event type to unmute." }, 400);
  const was = unmuteType(type);
  return c.json({
    muted: mutedTypes(),
    note: was
      ? `${type} will produce messages again. Events already suppressed stay suppressed — use resend on any you want now.`
      : `${type} was not muted; nothing changed.`,
  });
});

businessEventRoutes.post("/:id/resend", (c) => {
  const id = c.req.param("id");
  const row = businessEvent(id);
  if (!row) return c.json({ error: `There is no event ${id}.` }, 404);
  requeue(id);
  return c.json({
    item: shape(businessEvent(id)!, new Map(ventureRows().map((v) => [v.id, v.name]))),
    note:
      "Queued for the next delivery pass, which runs every ten minutes. The attempts count is " +
      "NOT reset — it is the history of what this event has cost. Quiet hours and the collapse " +
      "rule still apply, so a resend inside quiet hours will be deferred rather than sent now.",
  });
});
