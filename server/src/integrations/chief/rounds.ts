import { dueDay } from "../../runtime/schedule.ts";
/**
 * ROUNDS — the scheduled walk over the estate.
 *
 * NINETEEN VENTURES, SIX WORKERS EACH, ONE RUN SLOT AND ONE OWNER WHO HAS TO
 * REMEMBER TO ASK. That is the problem this solves. The org area gave every
 * venture a team and the chat agent a way to send one off; what neither gave
 * anybody was a reason for work to happen on a Tuesday when nobody opened the
 * dashboard. A round is that reason: once a day, at an hour the owner sets,
 * walk the ventures and give the configured roles a job on the ones that are
 * due.
 *
 * IT DISPATCHES THROUGH THE ORG'S OWN DOOR AND STARTS NO ENGINE OF ITS OWN.
 * `dispatch()` in subagents/routes.ts is imported and called directly — not
 * over a loopback POST, which would work and would put an HTTP round trip
 * inside a timer, and not with an INSERT of its own, which would not: that
 * function is where a dispatch's rules live (a switched-off worker refuses, the
 * standing instructions go in front of the brief, the run is filed under a
 * session). A second author for those rules is a second set of them.
 *
 * THE THREE THINGS IT WILL NOT DO, each of which is a setting rather than a
 * constant because a different owner wants a different answer:
 *
 *   — It will not work a venture at a QUIET STAGE. An `idea`-stage venture with
 *     no site and no customers has nothing for an SEO analyst to read, and a
 *     round that dispatched one anyway would spend the slot to produce a report
 *     saying so.
 *   — It will not work the same venture twice inside its CADENCE. "Days between
 *     rounds per venture" is what stops nineteen businesses being reviewed
 *     every night for ever; the useful cadence for a business is weeks.
 *   — It will not exceed MAX RUNS PER ROUND. There is one slot. A round that
 *     queued a hundred and fourteen jobs would be a queue with a day of work in
 *     it and the owner's own dispatch behind all of it.
 *
 * AND THE ONE IT WILL NEVER DO, which is not a setting: it will not dispatch a
 * role that is already running or queued for that venture. A second copy of the
 * same job does not arrive sooner. It delays everything behind it and bills
 * twice for one report.
 *
 * THE LEDGER RECORDS DECISIONS AND NOT ONLY WORK. `agent_runs` has no row for a
 * venture that was skipped, so "why did nothing happen last night" is a
 * question it cannot answer. `chief_joblog` has a row for every job the round
 * considered, with the reason, including the ones that became nothing.
 */
import { appendChatMessage, configValue, db, now, upsertPlugin, ventureRows, type VentureRow } from "../../db.ts";
import { dispatch } from "../subagents/routes.ts";
import { ROLES, ensureTeam, roleDef, subagentId, subagentRow } from "../subagents/store.ts";

/** The pseudo-plugin the settings hang off, the way `workspace`, `chat` and
 *  `backups` do: plugin_config points at plugins, so a setting has to hang off
 *  something and there is no `rounds` integration to connect to. */
export const ROUNDS_PLUGIN = "rounds";

/** The chat session every round files its work under. A fixed id rather than
 *  one per round, so the rail carries ONE "Rounds" row with every night's work
 *  nested under it, instead of a new conversation every morning. */
export const ROUNDS_SESSION = "rounds";

export const DEFAULT_HOUR = 6;
export const DEFAULT_MAX = 3;
export const DEFAULT_DAYS = 7;
export const DEFAULT_ROLES = ["demand"];
export const DEFAULT_QUIET = ["idea"];

export type RoundSettings = {
  enabled: boolean;
  hour: number;
  /** An IANA zone name, or null for this machine's own. The hour the owner
   *  typed is an hour in a place; a laptop that travels would otherwise start
   *  rounds at six in whatever country it woke up in. */
  timezone: string | null;
  roles: string[];
  maxRuns: number;
  daysBetween: number;
  quietStages: string[];
};

function list(raw: string | null, fallback: string[]): string[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : fallback;
}

function whole(raw: string | null, fallback: number, min: number, max: number): number {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function settings(): RoundSettings {
  const zone = (configValue(ROUNDS_PLUGIN, "timezone") ?? "").trim();
  return {
    enabled: (configValue(ROUNDS_PLUGIN, "enabled") ?? "").trim().toLowerCase() === "on",
    hour: whole(configValue(ROUNDS_PLUGIN, "hour"), DEFAULT_HOUR, 0, 23),
    timezone: zone && zoneIsReal(zone) ? zone : null,
    /* Only roles this box actually has. A setting naming a role that was
       removed in a release would otherwise skip silently on every venture,
       every night, and the round would report itself as having considered
       work it never could have dispatched. */
    roles: list(configValue(ROUNDS_PLUGIN, "roles"), DEFAULT_ROLES).filter((r) => roleDef(r) !== null),
    maxRuns: whole(configValue(ROUNDS_PLUGIN, "max"), DEFAULT_MAX, 1, 20),
    daysBetween: whole(configValue(ROUNDS_PLUGIN, "days"), DEFAULT_DAYS, 0, 365),
    quietStages: list(configValue(ROUNDS_PLUGIN, "quiet"), DEFAULT_QUIET),
  };
}

export function zoneIsReal(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The hour, and the calendar day, where the owner says they are. Both come
 *  out of one formatter call because asking twice at 23:59:59.9 can straddle
 *  midnight and give an hour from one day and a date from the next. */
function localNow(s: RoundSettings, at = new Date()): { hour: number; day: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: s.timezone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    /* "24" is what some ICU builds call midnight in an hour-only, hour12:false
       format. Read as 24 it would never equal a configured hour and rounds at
       midnight would never fire. */
    hour: Number(parts.hour) % 24,
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The next moment a round is due, or null when the schedule is off. */
export function nextRunAt(s = settings(), at = new Date()): string | null {
  if (!s.enabled) return null;
  /* Walked forward hour by hour rather than computed, because "06:00 in
     Europe/Dublin" is not an arithmetic offset from now — the offset changes
     twice a year — and a day with a DST transition in it has a 23-hour or a
     25-hour length. Twenty-five probes of a formatter is microseconds. */
  for (let i = 1; i <= 48; i += 1) {
    const probe = new Date(at.getTime() + i * 3_600_000);
    if (localNow(s, probe).hour === s.hour)
      return new Date(Math.floor(probe.getTime() / 3_600_000) * 3_600_000).toISOString();
  }
  return null;
}

/* --------------------------------------------------------------- the rows */

export type RoundRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  ventures: number;
  dispatched: number;
  skipped: number;
  notes: string;
};

export type JobRow = {
  id: number;
  round_id: string | null;
  ts: string;
  venture_id: string;
  role: string;
  run_id: string | null;
  outcome: string;
  reason: string;
};

export function roundRows(limit = 20): RoundRow[] {
  return db
    .prepare("SELECT * FROM chief_rounds ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as RoundRow[];
}

export function jobRows(roundId: string | null, limit = 100): JobRow[] {
  return roundId
    ? (db
        .prepare("SELECT * FROM chief_joblog WHERE round_id = ? ORDER BY id DESC LIMIT ?")
        .all(roundId, Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as JobRow[])
    : (db
        .prepare("SELECT * FROM chief_joblog ORDER BY id DESC LIMIT ?")
        .all(Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as JobRow[]);
}

export function shapeRound(r: RoundRow) {
  let notes: RoundNote[] = [];
  try {
    const parsed: unknown = JSON.parse(r.notes);
    if (Array.isArray(parsed)) notes = parsed as RoundNote[];
  } catch {
    notes = [];
  }
  return {
    id: r.id,
    startedAt: r.started_at,
    /* Null while it is walking. A round takes seconds, so a row that stays
       open is a crash and reads as one rather than as work in progress. */
    finishedAt: r.finished_at,
    trigger: r.trigger,
    ventures: r.ventures,
    dispatched: r.dispatched,
    skipped: r.skipped,
    notes,
  };
}

export function shapeJob(j: JobRow) {
  return {
    id: j.id,
    roundId: j.round_id,
    ts: j.ts,
    ventureId: j.venture_id || null,
    role: j.role || null,
    runId: j.run_id,
    outcome: j.outcome,
    reason: j.reason,
  };
}

type RoundNote = {
  ventureId: string;
  venture: string;
  stage: string;
  outcome: string;
  reason: string;
  roles: string[];
};

/* -------------------------------------------------------------- the walk */

/** One round at a time, in this process. The database check below catches a
 *  crash; this catches a second press of the button while the first is still
 *  walking, which the database cannot see because the row is not finished. */
let walking = false;

export type RoundResult = {
  ran: boolean;
  /** Why it did not run, where it did not. */
  why: string | null;
  round: ReturnType<typeof shapeRound> | null;
  jobs: ReturnType<typeof shapeJob>[];
};

/** When each venture was last given work by a round. Read once per walk
 *  rather than per venture, and read from the JOB LOG rather than from
 *  `agent_runs`: a run the owner started by hand is not a round, and counting
 *  it would let a busy afternoon suppress the schedule for a week. */
function lastRoundByVenture(): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT venture_id, MAX(ts) AS ts FROM chief_joblog
        WHERE outcome = 'dispatched' GROUP BY venture_id`,
    )
    .all() as unknown as { venture_id: string; ts: string }[];
  return new Map(rows.map((r) => [r.venture_id, r.ts]));
}

/** Is this worker already busy? Asked of `agent_runs`, which is the only
 *  authority on it — the roster derives the same answer from the same rows. */
function alreadyWorking(ventureId: string, kind: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
        WHERE venture_id = ? AND kind = ? AND status IN ('queued','running')`,
    )
    .get(ventureId, kind) as { n: number };
  return Number(row.n) > 0;
}

function mintRoundId(): string {
  return `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function logJob(roundId: string, j: { ventureId: string; role: string; runId: string | null; outcome: string; reason: string }) {
  db.prepare(
    `INSERT INTO chief_joblog (round_id, ts, venture_id, role, run_id, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(roundId, now(), j.ventureId, j.role, j.runId, j.outcome, j.reason);
}

/**
 * THE BRIEF A SCHEDULED WORKER IS GIVEN.
 *
 * IT SAYS IT IS SCHEDULED, first line, because a worker that thinks it was
 * asked a question answers the question and a worker that knows it is on a
 * round looks for what has changed.
 *
 * IT DOES NOT REPEAT THE GOALS, and that is a correction rather than an
 * omission. `dispatch` prepends the venture's goals to EVERY brief it handles —
 * see subagents/routes.ts — so a copy here put the same paragraph in the same
 * field twice, which reads to a model as emphasis rather than as duplication.
 * One author for that line, and it is the one that serves every door.
 *
 * IT IS SHORT ON PURPOSE. The owner's standing instructions for that worker are
 * prepended by `dispatch` too, and the venture's whole record is in front of the
 * run already; a paragraph here would be a fourth voice in one field.
 */
function brief(v: VentureRow, role: string): string {
  return [
    `This is a scheduled round, not a question from the owner: nobody is ` +
      `waiting at a screen. Look at ${v.name} as it stands today and report ` +
      `what has changed and what is worth doing about it — if the honest answer ` +
      `is "nothing has moved", say that plainly rather than filling the page.`,
    `Stage: ${v.stage}, which is the owner's own declaration and is what to ` +
      `tailor the work to.`,
    `Round role: ${role}.`,
  ].join("\n\n");
}

/**
 * WALK THE ESTATE.
 *
 * Returns as soon as the work is QUEUED. A round does not wait for its runs —
 * they take minutes each, there is one slot, and a function that waited would
 * hold a timer open for an hour and a route open for longer. What it reports is
 * what it dispatched, which is the only thing it knows at that moment; what
 * came of it is `GET /api/runs` and the session in the rail.
 */
export async function runRound(trigger: "schedule" | "manual"): Promise<RoundResult> {
  if (walking)
    return { ran: false, why: "A round is already walking. There is one slot and one walker.", round: null, jobs: [] };
  const s = settings();
  if (!s.roles.length)
    return {
      ran: false,
      why:
        "No roles are configured for a round, so there is nothing to dispatch. " +
        `Set them on the rounds settings — the six are ${ROLES.map((r) => r.role).join(", ")}.`,
      round: null,
      jobs: [],
    };

  walking = true;
  const id = mintRoundId();
  const startedAt = now();
  db.prepare(
    "INSERT INTO chief_rounds (id, started_at, trigger, ventures, dispatched, skipped, notes) VALUES (?, ?, ?, 0, 0, 0, '[]')",
  ).run(id, startedAt, trigger);

  const notes: RoundNote[] = [];
  let dispatched = 0;
  let skipped = 0;

  try {
    const ventures = ventureRows();
    const last = lastRoundByVenture();
    const cutoff = Date.now() - s.daysBetween * 86_400_000;

    say(
      `**Round started** — ${trigger === "manual" ? "started by hand" : "on the schedule"}, ` +
        `${ventures.length} venture${ventures.length === 1 ? "" : "s"} to walk, ` +
        `role${s.roles.length === 1 ? "" : "s"} ${s.roles.join(", ")}, at most ${s.maxRuns} run${s.maxRuns === 1 ? "" : "s"}.`,
    );

    for (const v of ventures) {
      if (s.quietStages.includes(v.stage)) {
        skipped += 1;
        notes.push({ ventureId: v.id, venture: v.name, stage: v.stage, outcome: "skipped", reason: `stage "${v.stage}" is quiet`, roles: [] });
        logJob(id, { ventureId: v.id, role: "", runId: null, outcome: "skipped", reason: `stage "${v.stage}" is quiet` });
        continue;
      }
      const seen = last.get(v.id);
      if (seen && Date.parse(seen) > cutoff) {
        const days = Math.floor((Date.now() - Date.parse(seen)) / 86_400_000);
        skipped += 1;
        const reason = `worked ${days} day${days === 1 ? "" : "s"} ago; the cadence is ${s.daysBetween} days`;
        notes.push({ ventureId: v.id, venture: v.name, stage: v.stage, outcome: "skipped", reason, roles: [] });
        logJob(id, { ventureId: v.id, role: "", runId: null, outcome: "skipped", reason });
        continue;
      }
      if (dispatched >= s.maxRuns) {
        skipped += 1;
        const reason = `the round's cap of ${s.maxRuns} run${s.maxRuns === 1 ? "" : "s"} was already spent`;
        notes.push({ ventureId: v.id, venture: v.name, stage: v.stage, outcome: "skipped", reason, roles: [] });
        logJob(id, { ventureId: v.id, role: "", runId: null, outcome: "skipped", reason });
        continue;
      }

      ensureTeam(v.id);
      const done: string[] = [];
      for (const role of s.roles) {
        if (dispatched >= s.maxRuns) break;
        const def = roleDef(role);
        if (!def) continue;
        if (alreadyWorking(v.id, def.kind)) {
          logJob(id, { ventureId: v.id, role, runId: null, outcome: "skipped", reason: "that worker is already running or queued" });
          continue;
        }
        const row = subagentRow(subagentId(v.id, role));
        if (!row) {
          logJob(id, { ventureId: v.id, role, runId: null, outcome: "failed", reason: "no such worker on this venture" });
          continue;
        }
        const out = dispatch(row, { brief: brief(v, role), parentSessionId: ROUNDS_SESSION });
        if (out.status === 201) {
          const run = (out.json as { run: { id: string } }).run;
          dispatched += 1;
          done.push(role);
          logJob(id, { ventureId: v.id, role, runId: run.id, outcome: "dispatched", reason: "" });
        } else {
          /* A switched-off worker answers 409 and that is a DECISION rather
             than a fault — the owner turned it off. It is logged as `refused`
             and not as `failed`, because a round that reported the owner's own
             switch as an error would be a round nobody could read. */
          const why = (out.json as { error?: string }).error ?? `status ${out.status}`;
          logJob(id, {
            ventureId: v.id,
            role,
            runId: null,
            outcome: out.status === 409 ? "refused" : "failed",
            reason: why,
          });
        }
      }
      if (done.length) {
        notes.push({ ventureId: v.id, venture: v.name, stage: v.stage, outcome: "dispatched", reason: "", roles: done });
      } else {
        skipped += 1;
        notes.push({
          ventureId: v.id,
          venture: v.name,
          stage: v.stage,
          outcome: "skipped",
          reason: "every configured role was already working, switched off, or refused",
          roles: [],
        });
      }
    }

    db.prepare(
      "UPDATE chief_rounds SET finished_at = ?, ventures = ?, dispatched = ?, skipped = ?, notes = ? WHERE id = ?",
    ).run(now(), ventures.length, dispatched, skipped, JSON.stringify(notes), id);

    /* A SUMMARY, NOT THE REPORTS. Each run posts its own completion back into
       this session when it finishes; a round that pasted anything of its own
       about the work would be writing about work that has not happened yet. */
    const worked = notes.filter((n) => n.outcome === "dispatched");
    say(
      `**Round finished** — ${dispatched} run${dispatched === 1 ? "" : "s"} dispatched across ` +
        `${worked.length} venture${worked.length === 1 ? "" : "s"}, ${skipped} skipped.` +
        (worked.length
          ? `\n\n${worked.map((n) => `- ${n.venture} — ${n.roles.join(", ")}`).join("\n")}`
          : `\n\nNothing was dispatched. ${firstReason(notes)}`) +
        `\n\nThe runs are queued, not done: they appear under this conversation as they finish.`,
    );

    const row = db.prepare("SELECT * FROM chief_rounds WHERE id = ?").get(id) as RoundRow;
    return { ran: true, why: null, round: shapeRound(row), jobs: jobRows(id).map(shapeJob) };
  } finally {
    walking = false;
    /* A round that threw left its row open. Closing it here means the ledger
       never carries a round that started and, as far as anybody can tell, is
       still walking six weeks later. */
    db.prepare("UPDATE chief_rounds SET finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(now(), id);
  }
}

/** The commonest reason nothing happened, for the one-line summary. Not a
 *  tally of all of them: the session message is a sentence, and the whole
 *  breakdown is on /workflows and in the job log. */
function firstReason(notes: RoundNote[]): string {
  const counts = new Map<string, number>();
  for (const n of notes) if (n.reason) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `Most common reason: ${top[0]} (${top[1]}).` : "Nothing was due.";
}

/**
 * A LINE IN THE ROUNDS CONVERSATION.
 *
 * Written as an ASSISTANT turn into the ordinary `chat_messages` table, which
 * is what makes "Rounds" a row in the owner's rail with the night's runs nested
 * under it — `GET /api/chat/sessions` derives sessions from messages, and
 * `parent_session_id` on each run does the nesting. No new table, no new
 * surface, and the owner can reply in it like any other conversation.
 *
 * `channel` IS 'rounds' AND NOT 'web'. Nobody was at a screen. The column exists
 * so a transcript can say which door a turn came in by, and calling a timer a
 * browser would be the one lie available here.
 */
function say(text: string): void {
  try {
    appendChatMessage({ sessionId: ROUNDS_SESSION, role: "assistant", content: text, channel: "rounds" });
  } catch (err) {
    /* A round that failed because its diary was full would be the cure killing
       the patient. The work matters more than the note about it. */
    console.error("[chief] could not write to the rounds session", err);
  }
}

/* ------------------------------------------------------------- the timer */

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * THE DAILY TIMER.
 *
 * A ten-minute interval rather than a timeout aimed at the hour, for the reason
 * every schedule on this box gives: this is a laptop, it sleeps, and a round
 * due at six while the lid was shut should run at nine when it wakes rather
 * than not at all. "Has one run today" is asked of the TABLE and not of a
 * variable, so the dozens of restarts a day that `node --watch` produces cannot
 * make it run twice.
 *
 * TODAY IS THE OWNER'S TODAY. The watermark is a calendar day in the configured
 * zone, not a UTC one, because a round at 23:00 local and one at 01:00 local
 * are two different nights everywhere except Greenwich.
 */
export function startRounds() {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        const s = settings();
        if (!s.enabled) return;
        const { hour, day } = localNow(s);
        const saved = db.prepare("SELECT value FROM runtime_settings WHERE key='rounds-last-due'").get() as { value: string } | undefined;
        const previous = roundRows(20).find(r => r.trigger === "schedule");
        const last = saved?.value ?? (previous ? localNow(s, new Date(previous.started_at)).day : null);
        const due = dueDay(day, hour, s.hour, last);
        if (!due) return;
        const out = await runRound("schedule");
        if (out.ran) db.prepare("INSERT INTO runtime_settings (key,value) VALUES ('rounds-last-due',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(due);
        if (out.ran && out.round)
          console.log(
            `[chief] round ${out.round.id}: ${out.round.dispatched} dispatched, ${out.round.skipped} skipped`,
          );
      } catch (err) {
        /* Must not throw: this runs on a timer with nobody to catch it. */
        console.error("[chief] round failed", err);
      }
    })();
  }, 10 * 60_000);
  timer.unref?.();
}

/** Called from the config registry's `after`, so switching rounds on at nine
 *  takes effect tomorrow morning rather than after the next restart.
 *  `startRounds` is idempotent, so the two callers cannot make two timers. */
export function afterConfig() {
  /* The plugin row is what makes the settings visible under Integrations;
     there is no credential to connect, so "connected" means "switched on". */
  upsertPlugin(ROUNDS_PLUGIN, settings().enabled, null);
  startRounds();
}
