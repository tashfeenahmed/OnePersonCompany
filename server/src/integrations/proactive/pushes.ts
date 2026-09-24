/**
 * THE TWO PUSHES — an alert that trips, and a run that ends, told to the phone.
 *
 * Everything else in this area waits to be read: the Alerts page, `/alerts` in
 * the bot, the morning briefing. That is right for a figure that moved and
 * wrong for "the site stopped answering" at eleven in the morning, which the
 * briefing would mention the next day. These two sweeps close that gap, and
 * nothing else — what to wake somebody for is a decision, and these are the
 * two the owner asked for.
 *
 * SWEEPS RATHER THAN HOOKS, for socialfeed/deliver.ts's reason. A line in
 * engine.ts or runs/executor.ts would fire once: a push that failed because
 * Telegram was not paired would never be retried, and a run that finished
 * while the process restarted would never be told at all. A sweep asks "which
 * trips and which finished runs have no push row", which is the same question
 * after a crash as before one. Trips raised by the anomaly pass are caught by
 * the same question, which a hook in the engine would have missed.
 *
 * WHAT IS NOT PUSHED, and each is a decision:
 *
 *   UNREADABLE   A rule whose document could not be read is a plugin problem,
 *                not a business figure, and it happens a dozen times a week.
 *                It stays on the page, in `/alerts` and in the briefing.
 *   CANCELLED    Somebody stopped it; they know.
 *   AUTOPILOT VIDEO THAT FINISHED   socialfeed/deliver.ts already sends it,
 *                with the draft it filed. A FAILED one is not sent there, so
 *                it is sent here.
 *
 * THE RULES THE OTHER TWO QUEUES LEARNED, kept rather than re-argued:
 *
 *   1. OFF UNTIL SWITCHED ON, and switching on is not a backlog. Each push has
 *      a mark — the moment it was armed — and anything older is suppressed as
 *      "before pushing was switched on". While it is off, new rows are
 *      suppressed as "pushing is off" rather than left to pile up.
 *   2. THE ROW IS WRITTEN AFTER `notify()` ANSWERS, and a pass in flight is
 *      shared with a second caller rather than run beside it.
 *   3. MORE THAN A FEW AT ONCE IS ONE MESSAGE. The nightly pipeline starts ten
 *      runs in a minute; ten failures because the model box is off is one
 *      piece of news, not ten.
 *   4. QUIET HOURS ARE THE CUSTOMERS AREA'S, the one window the relay also
 *      honours. There is no severity on a rule (engine.ts says why), so
 *      nothing here pierces them; a message held is sent when they end.
 *   5. IT NEVER THROWS. It runs on a timer inside the process that serves the
 *      dashboard.
 *
 * PLAIN TEXT, NOT HTML, on proactive/telegram.ts's rule: a rule name, a run
 * title and an error string can each contain a `<`, and Telegram answers a
 * stray one in HTML mode with a 400 rather than a message.
 */
import { configValue, db, now, ventureRowById } from "../../db.ts";
import { EXTRA_BROWSER_ORIGINS } from "../../config.ts";
import { quietDeferral } from "../customers/events.ts";
import { settings as customerSettings } from "../customers/store.ts";
import { PLUGIN as BRIEFING } from "./briefing.ts";
import { clearWords, docAt, tripWords, type TripFacts } from "./alert-words.ts";
import { clip, duration, lanOnly, plainCause, plural, when } from "../../shared/phone.ts";

export const ALERTS_KEY = "alertsTelegram";
export const RUNS_KEY = "runsTelegram";

/** One trip or run sent at a time up to this; past it, one message for all. */
export const SINGLE_MAX = 3;
/** Lines one grouped message names before it says how many more. */
const GROUP_LINES = 12;
/** A push that Telegram refused this many times is left as failed. */
export const MAX_ATTEMPTS = 5;
/** Older than this when it would be sent, and it is no longer a message. */
export const MAX_AGE_HOURS = 24;

type Subject = "alert-trip" | "alert-clear" | "run";
type Send = (text: string) => Promise<{ sent: boolean; reason?: string }>;

const onOff = (v: string | null) => ["on", "yes", "true", "1"].includes((v ?? "").trim().toLowerCase());

export const pushSettings = () => ({
  alerts: onOff(configValue(BRIEFING, ALERTS_KEY)),
  runs: onOff(configValue(BRIEFING, RUNS_KEY)),
});

/* ------------------------------------------------------------------ ledger */

export function armedAt(subject: "alerts" | "runs"): string | null {
  const row = db.prepare("SELECT armed_at FROM telegram_push_marks WHERE subject = ?").get(subject) as
    | { armed_at: string }
    | undefined;
  return row?.armed_at ?? null;
}

/**
 * Set or clear the marks from the settings. Called by the settings write (the
 * briefing entry's `after`) so the mark is the moment the owner pressed save,
 * and again at the top of every pass so a value written any other way is
 * noticed within one tick. A mark that already exists is left alone: saving
 * the briefing hour must not re-arm, or it would swallow a trip that arrived
 * a minute earlier.
 */
export function armPushes(s = pushSettings(), at = now()) {
  for (const [subject, on] of [["alerts", s.alerts], ["runs", s.runs]] as const) {
    if (on) db.prepare("INSERT OR IGNORE INTO telegram_push_marks (subject, armed_at) VALUES (?, ?)").run(subject, at);
    else db.prepare("DELETE FROM telegram_push_marks WHERE subject = ?").run(subject);
  }
}

function record(subject: Subject, ref: string, state: "sent" | "suppressed" | "failed", note: string | null) {
  db.prepare(
    `INSERT INTO telegram_pushes (subject, ref, state, attempts, note, at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject, ref) DO UPDATE SET
       state = excluded.state, note = excluded.note, at = excluded.at,
       attempts = telegram_pushes.attempts + excluded.attempts`,
  ).run(subject, ref, state, state === "suppressed" ? 0 : 1, note, now());
}

/** Not yet told, or told and refused fewer than MAX_ATTEMPTS times. */
const UNTOLD = (subject: Subject, refExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM telegram_pushes p WHERE p.subject = '${subject}' AND p.ref = ${refExpr}
     AND (p.state <> 'failed' OR p.attempts >= ${MAX_ATTEMPTS}))`;

/* ------------------------------------------------------------------- words */

/*
  HOW THESE READ, and why. The owner reads them on a phone: what happened
  first, in plain words, with the thing's real name — "💾 Disk is 87% full on
  Demo box", "✅ Competitor research for Video To Reel is done: 5 new cards on
  the board (1 h 4 min)". No rule paths, run ids or UTC stamps: the Alerts page
  and the run's own page carry those. The words for an alert live in
  alert-words.ts, because `/alerts` in the bot says the same things.

  A time is given only when it helps: an event told more than half an hour
  after it happened, or a trip that has already recovered.
*/

const origin = () => [...EXTRA_BROWSER_ORIGINS][0] ?? "";
/** A link only helps if it opens on the phone; a LAN address does not, away
 *  from home. */
const phoneLink = (path: string) => (origin() && !lanOnly(origin()) ? `${origin()}${path}` : null);
const STALE_MINUTES = 30;
const late = (iso: string, now: Date) => now.getTime() - Date.parse(iso) > STALE_MINUTES * 60_000;
const zone = () => customerSettings().timezone;

/** Kept for callers that print a duration; "time not recorded" for none. */
export function took(ms: number | null): string {
  return duration(ms) ?? "time not recorded";
}

export type TripRow = {
  id: number;
  ts: string;
  message: string;
  narration: string | null;
  cleared_at: string | null;
  recovery_message: string | null;
  rule: string;
  venture_id: string | null;
  skill: string;
  path: string;
  op: string;
  threshold: number | null;
  window_minutes: number | null;
  observed: number | null;
  previous: number | null;
  context: string | null;
};

const ventureName = (id: string | null) => (id ? ventureRowById(id)?.name ?? null : null);

export const tripFacts = (t: TripRow): TripFacts => ({ ...t, venture: ventureName(t.venture_id) });

type Say = { zone?: string; now?: Date; doc?: unknown };

/** The model's narration is left on the Alerts page: it is three sentences,
 *  and on a phone the headline is the news. */
export function tripMessage(t: TripRow, o: Say = {}): string {
  const z = o.zone ?? zone();
  const now = o.now ?? new Date();
  const w = tripWords(tripFacts(t), o.doc !== undefined ? o.doc : docAt(t.skill, t.ts), z, now);
  return [
    `${w.emoji} ${w.head}`,
    ...w.lines,
    late(t.ts, now) ? `That was ${when(t.ts, z, now)}.` : null,
    t.cleared_at ? `✅ Already fine again ${when(t.cleared_at, z, now)}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function clearMessage(t: TripRow, o: Say = {}): string {
  const z = o.zone ?? zone();
  const w = clearWords(tripFacts(t), o.doc !== undefined ? o.doc : docAt(t.skill, t.cleared_at), z, o.now ?? new Date(), docAt(t.skill, t.ts));
  return [`${w.emoji} ${w.head}`, ...w.lines].join("\n");
}

export function groupedTrips(trips: TripRow[], o: Say = {}): string {
  const z = o.zone ?? zone();
  const now = o.now ?? new Date();
  const lines = [`⚠️ ${trips.length} alerts went off`];
  for (const t of trips.slice(0, GROUP_LINES)) {
    const w = tripWords(tripFacts(t), docAt(t.skill, t.ts), z, now);
    lines.push(`• ${w.emoji} ${clip(w.head, 160)}${t.cleared_at ? " (fine again now)" : ""}`);
  }
  if (trips.length > GROUP_LINES) lines.push(`…and ${trips.length - GROUP_LINES} more.`);
  lines.push("Send /alerts to see what's still open.");
  return lines.join("\n");
}

export function groupedClears(trips: TripRow[], o: Say = {}): string {
  const z = o.zone ?? zone();
  const now = o.now ?? new Date();
  const lines = [`✅ ${trips.length} alerts are back to normal`];
  for (const t of trips.slice(0, GROUP_LINES))
    lines.push(`• ${clip(clearWords(tripFacts(t), docAt(t.skill, t.cleared_at), z, now, docAt(t.skill, t.ts)).head, 160)}`);
  if (trips.length > GROUP_LINES) lines.push(`…and ${trips.length - GROUP_LINES} more.`);
  return lines.join("\n");
}

export type RunRowLite = {
  id: string;
  kind: string;
  venture_id: string | null;
  title: string;
  status: "done" | "failed";
  started_at?: string | null;
  finished_at: string;
  ms: number | null;
  error: string | null;
};

/** `link` is null where the dashboard is only reachable at home. */
export type RunFacts = { kindName: string; cards: number; link: string | null };

/** What the run was, as a noun a person uses: "Competitor research". */
const RUN_NOUNS: Record<string, string> = {
  research: "Research",
  competitors: "Competitor research",
  seo: "SEO review",
  demand: "Demand research",
  geo: "AI visibility check",
  papers: "Paper search",
  shotsqa: "Screenshot check",
  serp: "Search results teardown",
  aso: "Store listing audit",
};

const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

function runWhat(r: RunRowLite, f: RunFacts): { what: string; titleLine: string | null } {
  const venture = ventureName(r.venture_id);
  const dash = /^(.+?) — (.+)$/.exec(r.title);
  /* A video run's title says what it made ("Carousel — FreeLLMAPI"). */
  const noun = r.kind === "video" && dash ? dash[1]! : RUN_NOUNS[r.kind] ?? f.kindName;
  const what = `${noun}${venture ? ` for ${venture}` : ""}`;
  /* The title is worth a line only when it says more than kind and venture —
     "Competitors — VideoToReel" says nothing "Competitor research for Video
     To Reel" did not. */
  const generic = dash && (!venture || squash(dash[2]!) === squash(venture) || squash(dash[2]!).includes(squash(venture)) || squash(venture).includes(squash(dash[2]!)));
  return { what, titleLine: generic ? null : clip(r.title, 120) };
}

const runMs = (r: RunRowLite) =>
  r.ms ?? (r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null);

const cardWords = (n: number) => (n ? `${plural(n, "new card")} on the board` : "no new cards");

export function runMessage(r: RunRowLite, f: RunFacts, o: Say = {}): string {
  const now = o.now ?? new Date();
  const { what, titleLine } = runWhat(r, f);
  const lines: (string | null)[] = [];
  if (r.status === "done") {
    const d = duration(runMs(r));
    lines.push(`✅ ${what} is done: ${cardWords(f.cards)}${d ? ` (${d})` : ""}`, titleLine);
  } else {
    const cause = plainCause(r.error);
    lines.push(`⚠️ ${what} failed${cause.known ? `: ${cause.text}` : ""}`, titleLine, cause.known ? null : `Reason: ${cause.text}`);
  }
  if (late(r.finished_at, now)) lines.push(`That was ${when(r.finished_at, o.zone ?? zone(), now)}.`);
  lines.push(f.link);
  return lines.filter(Boolean).join("\n");
}

export function groupedRuns(rows: { r: RunRowLite; f: RunFacts }[]): string {
  const failed = rows.filter((x) => x.r.status === "failed");
  const done = rows.length - failed.length;
  const head = !failed.length
    ? `✅ ${plural(rows.length, "agent run")} finished`
    : !done
      ? `⚠️ ${plural(rows.length, "agent run")} failed`
      : `⚠️ ${rows.length} agent runs finished: ${done} done, ${failed.length} failed`;
  /* Ten failures from one cause — the Dell switched off overnight — are one
     sentence, not ten repetitions of it. */
  const causes = failed.map((x) => plainCause(x.r.error));
  const shared = causes.length > 1 && causes.every((c) => c.known && c.text === causes[0]!.text) ? causes[0]!.text : null;
  const lines = [head];
  if (shared) lines.push(`${failed.length === rows.length ? "They all" : `All ${failed.length} failures`} had the same cause: ${shared}.`);
  for (const { r, f } of rows.slice(0, GROUP_LINES)) {
    const { what } = runWhat(r, f);
    if (r.status === "done") {
      const d = duration(runMs(r));
      lines.push(`• ✅ ${what}: ${cardWords(f.cards)}${d ? ` (${d})` : ""}`);
    } else lines.push(`• ❌ ${what}${shared ? "" : `: ${clip(plainCause(r.error).text, 100)}`}`);
  }
  if (rows.length > GROUP_LINES) lines.push(`…and ${rows.length - GROUP_LINES} more.`);
  return lines.join("\n");
}

/* -------------------------------------------------------------- the sends */

/** The guarded dynamic import every pusher on this box uses — see
 *  customers/collect.ts `push()` for the boot cycle a static one causes. */
const notifySend: Send = async (text) => {
  const { notify } = await import("../../telegram/bridge.ts");
  return notify(text, { html: false });
};

async function safeSend(send: Send, text: string): Promise<{ sent: boolean; reason: string | null }> {
  try {
    const r = await send(text);
    return { sent: r.sent, reason: r.sent ? null : r.reason ?? "Telegram did not accept the message." };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Anything the quiet window is holding right now, as the instant it ends. */
function quietUntil(at: Date): string | null {
  const cs = customerSettings();
  return quietDeferral(at, cs.timezone, cs.quiet);
}

const tooOld = (iso: string, at: Date) => at.getTime() - Date.parse(iso) > MAX_AGE_HOURS * 3_600_000;

export type PushResult = { sent: number; suppressed: number; failed: number; held: number };
const empty = (): PushResult => ({ sent: 0, suppressed: 0, failed: 0, held: 0 });

/* ------------------------------------------------------------------ alerts */

const TRIP_SELECT = `SELECT e.id, e.ts, e.message, e.narration, e.cleared_at, e.recovery_message,
                            e.observed, e.previous, e.context,
                            r.name AS rule, r.venture_id, r.skill, r.path, r.op, r.threshold, r.window_minutes
                       FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id`;

export async function pushAlerts(opts: { send?: Send; at?: Date; on?: boolean } = {}): Promise<PushResult> {
  const out = empty();
  const at = opts.at ?? new Date();
  const on = opts.on ?? pushSettings().alerts;
  const mark = armedAt("alerts");

  const trips = db
    .prepare(`${TRIP_SELECT} WHERE e.kind = 'trip' AND ${UNTOLD("alert-trip", "CAST(e.id AS TEXT)")} ORDER BY e.id LIMIT 200`)
    .all() as unknown as TripRow[];

  const due: TripRow[] = [];
  for (const t of trips) {
    const why = !on || !mark
      ? "pushing alerts to Telegram is off"
      : t.ts < mark
        ? "before pushing was switched on"
        : tooOld(t.ts, at)
          ? `older than ${MAX_AGE_HOURS}h when it could have been sent`
          : null;
    if (why) {
      record("alert-trip", String(t.id), "suppressed", why);
      out.suppressed += 1;
    } else due.push(t);
  }

  /* Recoveries of trips that WERE told. One whose trip was never sent has
     nothing to take back, and is not news. */
  const clears = on
    ? (db
        .prepare(
          `${TRIP_SELECT}
            WHERE e.kind = 'trip' AND e.cleared_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM telegram_pushes p WHERE p.subject = 'alert-trip'
                            AND p.ref = CAST(e.id AS TEXT) AND p.state = 'sent')
              AND ${UNTOLD("alert-clear", "CAST(e.id AS TEXT)")}
            ORDER BY e.id LIMIT 200`,
        )
        .all() as unknown as TripRow[])
    : [];
  const clearsDue: TripRow[] = [];
  for (const t of clears) {
    if (tooOld(t.cleared_at!, at)) {
      record("alert-clear", String(t.id), "suppressed", `older than ${MAX_AGE_HOURS}h when it could have been sent`);
      out.suppressed += 1;
    } else clearsDue.push(t);
  }

  if (!due.length && !clearsDue.length) return out;
  if (quietUntil(at)) {
    out.held = due.length + clearsDue.length;
    return out;
  }
  const send = opts.send ?? notifySend;

  /* A trip that has already recovered by the time it is sent says so in its
     own message, and its recovery is recorded as told with it. */
  const sendTrips = async (group: TripRow[], text: string) => {
    const r = await safeSend(send, text);
    for (const t of group) {
      record("alert-trip", String(t.id), r.sent ? "sent" : "failed", r.reason);
      if (r.sent && t.cleared_at) record("alert-clear", String(t.id), "sent", "told with the trip");
    }
    if (r.sent) out.sent += group.length;
    else out.failed += group.length;
  };
  if (due.length > SINGLE_MAX) await sendTrips(due, groupedTrips(due));
  else for (const t of due) await sendTrips([t], tripMessage(t));

  const told = new Set(due.map((t) => t.id));
  const pending = clearsDue.filter((t) => !told.has(t.id));
  const sendClears = async (group: TripRow[], text: string) => {
    const r = await safeSend(send, text);
    for (const t of group) record("alert-clear", String(t.id), r.sent ? "sent" : "failed", r.reason);
    if (r.sent) out.sent += group.length;
    else out.failed += group.length;
  };
  if (pending.length > SINGLE_MAX) await sendClears(pending, groupedClears(pending));
  else for (const t of pending) await sendClears([t], clearMessage(t));

  return out;
}

/* -------------------------------------------------------------------- runs */

export type RunDeps = {
  send?: Send;
  at?: Date;
  on?: boolean;
  /** Is the executor still settling this run (filing its cards)? */
  isRunning?: (id: string) => boolean;
  facts?: (r: RunRowLite) => RunFacts | Promise<RunFacts>;
};

/**
 * The run area's own helpers, loaded when first needed rather than at import:
 * `runs/cards.ts` reaches `routes/board.ts` and `runs/executor.ts` reaches
 * most of the server, and this file is imported by a manifest.
 */
async function runDeps(): Promise<{ isRunning: (id: string) => boolean; facts: (r: RunRowLite) => RunFacts }> {
  const [{ isRunning }, { runCardsFiled }, { kindDef }, { runThreadPage }] = await Promise.all([
    import("../runs/executor.ts"),
    import("../runs/cards.ts"),
    import("../runs/kinds.ts"),
    import("../subagents/store.ts"),
  ]);
  return {
    isRunning,
    facts: (r) => ({
      kindName: kindDef(r.kind)?.name ?? r.kind,
      cards: r.status === "done" ? runCardsFiled(r.id) : 0,
      link: phoneLink(runThreadPage({ id: r.id, kind: r.kind })),
    }),
  };
}

export async function pushRuns(opts: RunDeps = {}): Promise<PushResult> {
  const out = empty();
  const at = opts.at ?? new Date();
  const on = opts.on ?? pushSettings().runs;
  const mark = armedAt("runs");

  /* Done and failed only (see the header). An autopilot video that finished
     is socialfeed/deliver.ts's to announce. */
  const rows = db
    .prepare(
      `SELECT id, kind, venture_id, title, status, started_at, finished_at, ms, error
         FROM agent_runs r
        WHERE status IN ('done', 'failed') AND finished_at IS NOT NULL
          AND ${UNTOLD("run", "r.id")}
          AND NOT (r.kind = 'video' AND r.status = 'done' AND EXISTS (
                SELECT 1 FROM video_autopilot_log l
                 WHERE l.kind = 'video' AND l.action = 'queued' AND l.ref = r.id))
        ORDER BY finished_at LIMIT 200`,
    )
    .all() as unknown as RunRowLite[];
  if (!rows.length) return out;

  const due: RunRowLite[] = [];
  for (const r of rows) {
    const why = !on || !mark
      ? "pushing runs to Telegram is off"
      : r.finished_at < mark
        ? "before pushing was switched on"
        : tooOld(r.finished_at, at)
          ? `older than ${MAX_AGE_HOURS}h when it could have been sent`
          : null;
    if (why) {
      record("run", r.id, "suppressed", why);
      out.suppressed += 1;
    } else due.push(r);
  }
  if (!due.length) return out;
  if (quietUntil(at)) {
    out.held = due.length;
    return out;
  }

  const loaded = opts.isRunning && opts.facts ? null : await runDeps();
  const isRunning = opts.isRunning ?? loaded!.isRunning;
  const facts = opts.facts ?? loaded!.facts;

  /* A run still in the executor's slot is filing its cards; the count is not
     known until it leaves, which is the next pass. */
  const ready: { r: RunRowLite; f: RunFacts }[] = [];
  for (const r of due) {
    if (isRunning(r.id)) {
      out.held += 1;
      continue;
    }
    ready.push({ r, f: await facts(r) });
  }
  if (!ready.length) return out;

  const send = opts.send ?? notifySend;
  const tell = async (group: typeof ready, text: string) => {
    const res = await safeSend(send, text);
    for (const { r } of group) record("run", r.id, res.sent ? "sent" : "failed", res.reason);
    if (res.sent) out.sent += group.length;
    else out.failed += group.length;
  };
  if (ready.length > SINGLE_MAX) await tell(ready, groupedRuns(ready));
  else for (const x of ready) await tell([x], runMessage(x.r, x.f));
  return out;
}

/* ------------------------------------------------------------------- timer */

let inFlight: Promise<{ alerts: PushResult; runs: PushResult }> | null = null;

/** Both sweeps, one at a time, and a second caller shares the first's pass —
 *  runtime/relay.ts spends a paragraph on why a boolean is not enough. */
export function pushPass(): Promise<{ alerts: PushResult; runs: PushResult }> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    armPushes();
    const alerts = await pushAlerts().catch((err) => {
      console.error(`[pushes] alert push failed — ${err instanceof Error ? err.message : String(err)}`);
      return empty();
    });
    const runs = await pushRuns().catch((err) => {
      console.error(`[pushes] run push failed — ${err instanceof Error ? err.message : String(err)}`);
      return empty();
    });
    for (const [name, r] of [["alert", alerts], ["run", runs]] as const)
      if (r.sent || r.failed)
        console.log(`[pushes] ${name}: ${r.sent} sent, ${r.failed} failed, ${r.held} held, ${r.suppressed} suppressed`);
    return { alerts, runs };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Every two minutes, the relay's cadence: a trip is not a digest. The first
 *  pass waits for boot to settle, as the relay's does. */
export const PASS_MINUTES = 2;

export function startPushes() {
  const tick = () => {
    try {
      void pushPass().catch(() => {});
    } catch {
      /* onStart work must not throw. */
    }
  };
  setTimeout(tick, 45_000).unref?.();
  setInterval(tick, PASS_MINUTES * 60_000).unref?.();
}
