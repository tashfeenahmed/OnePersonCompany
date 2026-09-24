/**
 * DELIVERY — what happens to a finished asset the autopilot queued.
 *
 * THE GAP THIS CLOSES. The autopilot queues a video run and then forgets about
 * it: the run finishes half an hour later, the file lands on a run page, and
 * unless somebody goes looking, nothing tells them it exists. The system this
 * replaces sent every finished item to Telegram the moment it existed, and
 * that is the half that made an unattended loop worth running.
 *
 * A SWEEP RATHER THAN A HOOK IN THE EXECUTOR, and the reason is ownership. A
 * completion callback would be a line in `runs/executor.ts` — a file four other
 * areas are also editing — and it would fire exactly once, so a delivery that
 * failed because Telegram was not paired would never be retried and a run that
 * finished while the process was restarting would never be delivered at all.
 * A sweep over finished rows is idempotent by construction: it asks "which
 * finished runs have no delivery row", which is the same question after a
 * crash as before one.
 *
 * ONLY WHAT THE AUTOPILOT QUEUED. A video the owner started by hand is a video
 * the owner is already watching; pushing it to their phone would be a
 * notification about something they are looking at. The autopilot's own log is
 * the join — `kind = 'video'`, `action = 'queued'`, `ref` is the run id.
 *
 * TWO DELIVERIES, AND THE DRAFT IS THE IMPORTANT ONE. The message is a
 * courtesy; the draft in the publishing queue is what makes the asset usable.
 * Successful filing is recorded once. Filing failures remain eligible for a
 * later sweep; already filed clips are idempotent. Notification failures are
 * recorded after filing rather than repeatedly interrupting the owner.
 *
 * THE TELEGRAM IMPORT IS DYNAMIC AND GUARDED. `telegram/bridge.ts` reaches
 * `routes/chat.ts`, which reaches `routes/pluginConfig.ts`, which calls
 * `manifestCollectors()` at module scope — a static import from anything a
 * manifest touches is "Cannot access 'MANIFESTS' before initialization" and a
 * server that does not boot.
 */
import { configValue, db, now, ventureRowById } from "../../db.ts";
import { onAutopilotAsset } from "../publishing/autopilot-hook.ts";
import { SOCIALFEED_PLUGIN } from "./novelty.ts";

/**
 * WHERE A FINISHED ASSET IS ANNOUNCED, as a setting rather than as a fact.
 *
 * There is one channel on this box and this setting names it, so installing
 * the area cannot start pushing to somebody's phone unconditionally. `off` is
 * a real answer.
 *
 * `off` STILL FILES THE DRAFT. The two halves of a delivery are not the same
 * promise: the draft is the thing that makes an asset usable and is silent,
 * and the message is the interruption. Switching off the interruption must not
 * cost the queue entry.
 */
export const DEFAULT_CHANNEL = "telegram";

export function channel(): "telegram" | "off" {
  return (configValue(SOCIALFEED_PLUGIN, "deliverTo") ?? "").trim().toLowerCase() === "off"
    ? "off"
    : DEFAULT_CHANNEL;
}

export type DeliveryRow = {
  ref: string;
  kind: string;
  venture_id: string | null;
  at: string;
  channel: string | null;
  sent: number;
  reason: string | null;
  publish_item: string | null;
};

export function deliveryRows(limit = 40): DeliveryRow[] {
  return db
    .prepare("SELECT * FROM socialfeed_deliveries ORDER BY at DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as DeliveryRow[];
}

export type SweepResult = {
  looked: number;
  delivered: { ref: string; ventureName: string | null; sent: boolean; reason: string | null; publishItem: string | null }[];
};

/**
 * Deliver every finished autopilot video that has not been delivered.
 *
 * Returns what it did, including the failures, so the route and the page can
 * show them — a sweep that logged only successes would answer "why did I not
 * get a message" with silence.
 */
let sweeping = false;

export async function sweep(): Promise<SweepResult> {
  /*
    ONE SWEEP AT A TIME, the guard `posts.ts` keeps for the same reason. The
    delivery row is written only AFTER `notify()` resolves, so the five-minute
    timer firing while the agent's own `deliver` action is still in flight
    would find the same finished run undelivered and send the same message
    twice. `createItem` is idempotent, so it was only ever the message that
    doubled — which is the half a person notices.
  */
  if (sweeping) return { looked: 0, delivered: [] };
  sweeping = true;
  try {
    return await sweepOnce();
  } finally {
    sweeping = false;
  }
}

async function sweepOnce(): Promise<SweepResult> {
  /* Finished video runs the autopilot queued, newest first, that have no
     delivery row. Twenty at a time: a first run on a box with a long history
     should not send twenty messages in one second. */
  const rows = db
    .prepare(
      `SELECT l.ref AS ref, r.venture_id AS venture_id, r.title AS title
         FROM video_autopilot_log l
         JOIN agent_runs r ON r.id = l.ref
        WHERE l.kind = 'video' AND l.action = 'queued' AND l.ref IS NOT NULL
          AND r.status = 'done'
          AND l.ref NOT IN (SELECT ref FROM socialfeed_deliveries)
        ORDER BY r.finished_at DESC
        LIMIT 20`,
    )
    .all() as unknown as { ref: string; venture_id: string | null; title: string }[];

  const out: SweepResult = { looked: rows.length, delivered: [] };
  for (const row of rows) {
    const venture = row.venture_id ? ventureRowById(row.venture_id) : undefined;

    /* THE DRAFT FIRST. If the publishing queue refuses the item there is
       nothing worth telling somebody about, and the reason it refused is the
       thing to record. */
    const clips = db.prepare("SELECT idx FROM video_clips WHERE run_id = ? ORDER BY idx").all(row.ref) as { idx: number }[];
    const sources = clips.length
      ? clips.map(clip => ({ kind: "video_clip" as const, id: `${row.ref}:${clip.idx}` }))
      : [{ kind: "video_job" as const, id: row.ref }];
    const filed = venture ? sources.map(source => onAutopilotAsset({ ventureId: venture.id, ventureSlug: venture.slug, source })) : [];
    const publishItem = filed.find(item => item.itemId)?.itemId ?? null;
    const filingError = !venture ? "The video's venture no longer exists." : filed.filter(item => !item.itemId).map(item => item.note).join(" · ") || null;

    /* Worded for a phone: what it is and for whom, then where it went. The
       title is shown only when it says more than "Video — FreeLLMAPI". */
    const dash = /^(.+?) — (.+)$/.exec(row.title);
    const made = (dash?.[1] ?? "video").toLowerCase();
    const drafts = filed.filter(item => item.itemId).length;
    const text =
      `${made === "carousel" ? "🖼️" : "🎬"} New ${escapeHtml(made)} ready for <b>${escapeHtml(venture?.name ?? "a venture")}</b>\n` +
      (dash ? "" : `${escapeHtml(row.title.slice(0, 200))}\n`) +
      (publishItem
        ? `Saved as ${drafts === 1 ? "a draft" : `${drafts} drafts`} in Publishing. Nothing has been posted yet.${filingError ? `\nSome clips couldn't be saved: ${escapeHtml(filingError)}` : ""}`
        : `It couldn't be saved to Publishing: ${escapeHtml(filingError ?? "no draft was created.")}`);

    let sent = false;
    let reason: string | null = filingError;
    const to = channel();
    let where: string | null = to;
    if (to === "off") {
      /* Recorded as a delivery that happened, because it did: the draft was
         filed. Only the message was declined, and by the owner. */
      reason = [reason, "the delivery channel is switched off, so no message was sent"]
        .filter(Boolean)
        .join(" · ");
    } else if (!filingError) {
      try {
        const { notify } = await import("../../telegram/bridge.ts");
        const res = await notify(text, { html: true });
        sent = res.sent;
        where = res.sent ? `telegram:${res.accountId}` : "telegram";
        if (!res.sent) reason = [reason, res.reason].filter(Boolean).join(" · ") || null;
      } catch (err) {
        reason = [reason, err instanceof Error ? err.message : String(err)].filter(Boolean).join(" · ") || null;
      }
    }

    // A temporary filing failure must be retried by the next sweep. Successful
    // clips are idempotent, so a partial batch does not duplicate drafts.
    if (!filingError) db.prepare(
      "INSERT OR REPLACE INTO socialfeed_deliveries (ref, kind, venture_id, at, channel, sent, reason, publish_item) VALUES (?,?,?,?,?,?,?,?)",
    ).run(row.ref, "video", row.venture_id, now(), where, sent ? 1 : 0, reason, publishItem);

    out.delivered.push({ ref: row.ref, ventureName: venture?.name ?? null, sent, reason, publishItem });
  }
  return out;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The timer. Every five minutes, and it does nothing at all when there is
 * nothing finished and undelivered — which is almost always.
 */
export function startDelivery() {
  const tick = () => {
    try {
      void sweep().catch(() => {
        /* A sweep that throws has already written whatever it managed. */
      });
    } catch {
      /* onStart work must not throw. */
    }
  };
  /*
    A FIRST TICK AFTER THIRTY SECONDS, and the reason is `node --watch`.

    The server restarts on every save, so on a box somebody is working on a
    timer whose first fire is five minutes away may never fire at all — the
    sweep that exists to hand finished work over would simply never run. Thirty
    seconds is long enough that a burst of saves does not turn into a burst of
    sweeps, and the sweep itself is idempotent and finds nothing on a box with
    nothing waiting, so an extra one costs a single SELECT.
  */
  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, 300_000).unref?.();
}
