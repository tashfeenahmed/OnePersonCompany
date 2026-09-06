/**
 * THE RESULT CURSOR — new native job results, once, to the owner's phone.
 *
 * The runtime ran the job and knows what it produced. What it does NOT have is
 * this box's Telegram pairing: the bot token lives in this app's vault, and it
 * is not going into an agent's home directory, because an agent that executes
 * model-written code with a bot token beside it is a bot anyone who can talk
 * to the agent can speak as. WorkDash's hermescron.js inverted delivery for
 * exactly that reason and this keeps the rule: the runtime writes results
 * where it writes them, and THIS side, which already holds the token, reads
 * them and pushes.
 *
 * WHAT WAS REUSED FROM THE CUSTOMERS AREA RATHER THAN REBUILT, because a
 * second delivery queue with its own opinions is a second place for a phone to
 * buzz at three in the morning:
 *
 *   QUIET HOURS   `customers/events.ts`'s `quietDeferral`, with the window and
 *                 the timezone from `customers/store.ts`'s `settings()`. The
 *                 owner types "22-8" in ONE field, on the Customers plugin
 *                 page, and both relays honour it. Two places to type a quiet
 *                 window is two places for it to be wrong.
 *   RETRIES       the same five-attempt ceiling and the same shape of state —
 *                 `attempts`, `delivery_error`, `deferred_until` — so
 *                 "you were not told, and here is why" reads the same on both
 *                 queues. The constant is restated in store.ts beside the
 *                 column rather than imported, because importing
 *                 `customers/collect.ts` would pull a Stripe collector into
 *                 this timer's module graph for one integer.
 *   THE PUSH      `telegram/bridge.ts`'s `notify()`, through a GUARDED dynamic
 *                 import — the same one `customers/collect.ts` uses and for
 *                 the same reason: bridge.ts reaches `routes/chat.ts`, which
 *                 reaches `routes/pluginConfig.ts`, which calls
 *                 `manifestCollectors()` at module scope. A static import here
 *                 stops the server booting.
 *
 * SIX RULES, AND THEY ARE WORKDASH'S, because they were learned there first
 * and a relay that forgets them gets muted just as fast:
 *
 *   1. THE FIRST PASS SENDS NOTHING. A box that has been ticking for a week
 *      has a backlog on disk; on the first pass for a runtime every result is
 *      recorded as seen and suppressed as "first pass".
 *   2. DEDUP IS BY IDENTITY — the run's own ref in the runtime's own store,
 *      not by time. A re-read of the directory cannot re-send and neither can
 *      a clock skew.
 *   3. THERE IS A CEILING PER PASS. Past it, one line says how many were held
 *      back and where to read them; silent truncation is worse than either
 *      extreme.
 *   4. SILENCE IS A CONTRACT, NOT A BUG. A watchdog with nothing to report
 *      writes a file whose status says silent, and this says nothing.
 *   5. IT NEVER THROWS. It runs on a timer inside the process that serves the
 *      dashboard: a missing directory, a half-written file or an unreachable
 *      Telegram is recorded and stepped over.
 *   6. A FAILED RUN IS FORWARDED, ONCE. A reminder that quietly died is the
 *      worst outcome available — worse than no reminder, because the owner
 *      believes they are covered.
 */
import { now } from "../../db.ts";
import { quietDeferral } from "../customers/events.ts";
import { settings as customerSettings } from "../customers/store.ts";
import { readings, resultsFor, type NativeResult } from "./jobs.ts";
import {
  alreadySeen,
  cursor,
  defer,
  markDelivered,
  markDeliveryFailed,
  pendingResults,
  recordResult,
  setCursor,
  settings,
} from "./store.ts";

/** How much of one result goes in a message is a setting; this is only the
 *  sentence that says it was shortened. The full text stays in the row and in
 *  the runtime's own store. */
function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, max).trimEnd()}…`, cut: true };
}

/**
 * One result on a phone.
 *
 * PLAIN TEXT, NOT HTML, on proactive/telegram.ts's rule: a cron job's output
 * can contain any character at all, and a stray `<` in HTML mode is a 400 from
 * Telegram rather than a message.
 *
 * The job name leads, because a reminder arriving with no sender is a reminder
 * the owner has to go and identify. The mark is the one this bot already uses
 * for "something went wrong" — a second vocabulary for the same idea is how a
 * glyph stops meaning anything.
 */
export function message(r: NativeResult, bodyChars: number): string {
  const mark = r.failed ? "⚠" : "⏰";
  const when = r.at ? `${r.at.slice(0, 16).replace("T", " ")} UTC` : "time not recorded";
  const { text, cut } = clip((r.body ?? "").trim(), bodyChars);
  return [
    `${mark} ${r.jobName ?? r.jobId}${r.failed ? " — FAILED" : ""}`,
    ``,
    text,
    cut ? `\n… shortened. The whole result is in ${r.runtime}'s own store.` : "",
    ``,
    `${when} · ${r.runtime} · scheduled by ${r.runtime}, not by this dashboard`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* --------------------------------------------------------------- the ingest */

/**
 * Read both runtimes and record anything new.
 *
 * Returns what it found rather than what it sent — sending is the pass below,
 * and keeping them apart is what lets the results panel show a backlog that
 * quiet hours is holding rather than a queue that looks empty.
 */
export function ingest(): { found: number; firstPass: string[] } {
  const s = settings();
  const firstPass: string[] = [];
  let found = 0;

  for (const reading of readings()) {
    if (!reading.readable) continue;
    const key = `seen:${reading.runtime}`;
    const primed = cursor(key) !== null;
    let results: NativeResult[] = [];
    try {
      results = resultsFor(reading.runtime, 200, alreadySeen);
    } catch {
      /* Rule 5. A store that could not be walked this minute is walked again
         next minute; a timer that throws takes the whole pass with it. */
      continue;
    }

    for (const r of results) {
      /*
        WHY A SILENT RESULT STILL GETS A ROW. Recording it is what stops it
        being re-read as new on every pass for as long as the file exists, and
        the row is the honest record of a watchdog that ran and found nothing.
        It is suppressed rather than delivered.
      */
      const suppressedBy = !primed
        ? "first pass"
        : r.silent || r.body === null
          ? "silent"
          : !s.relay
            ? "relay off"
            : null;
      const isNew = recordResult({
        id: `${r.runtime}:${r.jobId}/${r.ref}`,
        runtime: r.runtime,
        jobId: r.jobId,
        jobName: r.jobName,
        ref: r.ref,
        at: r.at,
        status: r.status,
        body: r.body,
        suppressedBy,
      });
      if (isNew && suppressedBy === null) found += 1;
    }

    if (!primed) {
      setCursor(key, now());
      firstPass.push(reading.runtime);
    }
  }

  return { found, firstPass };
}

/* -------------------------------------------------------------- the delivery */

/**
 * THE OUTBOUND CALL, AND WHY IT IS AN `await import`. See the file header —
 * `telegram/bridge.ts`'s import graph reaches `routes/pluginConfig.ts`, which
 * calls `manifestCollectors()` at module scope, and a manifest that pulls that
 * in at load time fails with "Cannot access 'MANIFESTS' before
 * initialization". Deferring costs one resolved module on a path that already
 * awaits a network call, and it keeps the push going through the one function
 * on this box that cannot send to the wrong chat.
 */
async function push(text: string): Promise<{ sent: boolean; reason?: string }> {
  const { notify } = await import("../../telegram/bridge.ts");
  return notify(text, { html: false });
}

export type DeliverResult = { delivered: number; deferred: number; held: number; failed: number };

/**
 * ONE PASS AT A TIME, AND THE SECOND CALLER WAITS FOR THE FIRST.
 *
 * `pendingResults` selects rows that are not yet delivered, and a row stops
 * being selected only when `markDelivered` runs AFTER Telegram has answered.
 * Between those two points there is a window as long as an HTTP round trip,
 * and two things can be inside it: the two-minute timer, which fires
 * regardless of what is in flight, and the Refresh button, which an owner can
 * press twice. Both would read the same rows and send the same message twice —
 * which is the first of the three failure modes the table's own migration says
 * it exists to prevent.
 *
 * A PROMISE RATHER THAN A BOOLEAN, so the second caller gets the FIRST pass's
 * result instead of a silent `{0,0,0,0}` that would make the Refresh button
 * report "nothing found" about a pass that was at that moment sending. A
 * failed pass clears the latch in `finally`; a pass that throws is the
 * caller's to report, and both callers see the same error.
 */
let inFlight: Promise<DeliverResult> | null = null;

export function deliverPending(at = new Date()): Promise<DeliverResult> {
  if (inFlight) return inFlight;
  inFlight = deliverOnce(at).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function deliverOnce(at: Date): Promise<DeliverResult> {
  const s = settings();
  const out: DeliverResult = { delivered: 0, deferred: 0, held: 0, failed: 0 };
  if (!s.relay) return out;

  /* One more than the ceiling, so "there are more" is a fact this pass read
     rather than a guess it made. */
  const queue = pendingResults(s.jobsPerPass + 1, at);
  if (!queue.length) return out;

  const cs = customerSettings();
  const batch = queue.slice(0, s.jobsPerPass);
  out.held = queue.length - batch.length;

  for (const row of batch) {
    /* QUIET HOURS FIRST, and it is the customers area's function rather than a
       second implementation. A result deferred keeps its row and its place in
       the queue; nothing is dropped for arriving at the wrong hour. */
    const until = quietDeferral(at, cs.timezone, cs.quiet);
    if (until) {
      defer(row.id, until);
      out.deferred += 1;
      continue;
    }

    const result = await push(
      message(
        {
          runtime: row.runtime as NativeResult["runtime"],
          jobId: row.job_id,
          jobName: row.job_name,
          ref: row.ref,
          at: row.at,
          status: row.status,
          failed: row.status === "failed" || row.status === "error" || row.status === "interrupted",
          body: row.body,
          silent: false,
        },
        s.jobsBodyChars,
      ),
    );
    if (result.sent) {
      markDelivered(row.id);
      out.delivered += 1;
    } else {
      markDeliveryFailed(row.id, result.reason ?? "Telegram did not accept the message.");
      out.failed += 1;
    }
  }

  /* RULE 3. One line for the remainder, and only when something was actually
     sent — a pass that delivered nothing has no message to append this to and
     would be announcing a backlog nobody asked about. */
  if (out.held > 0 && out.delivered > 0)
    await push(
      `…and ${out.held} more scheduled result${out.held === 1 ? "" : "s"} waiting. ` +
        `They are on the Scheduled jobs panel on your agent's page under Integrations, and ` +
        `the next pass will send them.`,
    ).catch(() => ({ sent: false }));

  return out;
}

/* ------------------------------------------------------------------- timer */

/**
 * Every two minutes, and it must never throw.
 *
 * TWO MINUTES BECAUSE A REMINDER IS NOT A DIGEST. The half-hour collector
 * schedule is the right cadence for a figure and the wrong one for "the thing
 * you asked to be reminded about at nine". It is a directory listing and a
 * SELECT, so the cost of the pass when nothing has happened is nil.
 *
 * The ingest runs whether or not pushing is on: the results panel and the
 * `jobs` skill read the same rows, and a box with the relay switched off
 * should still be able to answer "what has Hermes been doing".
 */
export const PASS_MINUTES = 2;

let timer: ReturnType<typeof setInterval> | null = null;

export function startRelayTimer() {
  if (timer) return;
  const pass = () => {
    try {
      ingest();
    } catch (err) {
      console.error(`[runtime] job ingest failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    void deliverPending().catch((err) => {
      console.error(`[runtime] job relay failed — ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  /* A first pass shortly after boot rather than immediately: the gateway is
     still starting and its store may be mid-write, and a restart storm should
     not thrash a directory walk. */
  const first = setTimeout(pass, 25_000);
  first.unref?.();
  timer = setInterval(pass, PASS_MINUTES * 60_000);
  timer.unref?.();
}
