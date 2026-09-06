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
import { RUNTIME_KEYS, readSetting, writeSetting } from "../../runtime/settings.ts";
import { dailySchedule, dueDay, zoned } from "../../shared/time.ts";
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
  /** ALWAYS A REAL IANA ZONE NAME — this machine's own where the owner never
   *  typed one, with `zoneWasSet` carrying that fact separately. The hour the
   *  owner typed is an hour in a PLACE; a laptop that travels would otherwise
   *  start rounds at six in whatever country it woke up in. */
  timezone: string;
  zoneWasSet: boolean;
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
  /* The switch, the hour and the zone come from `shared/time.ts` — one reader
     for every daily schedule on this box. It is also where the rule that an
     out-of-range hour falls back rather than CLAMPS is written down: this file
     used to clamp, turning a typed 25 into 23:00, an hour the owner never
     chose presented as one they did. */
  const daily = dailySchedule(ROUNDS_PLUGIN, { defaultHour: DEFAULT_HOUR });
  return {
    enabled: daily.enabled,
    hour: daily.hour,
    timezone: daily.timezone,
    zoneWasSet: daily.zoneWasSet,
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

/**
 * ONE DECISION THE WALK MADE, and the ONLY thing it writes them into.
 *
 * A round used to record every decision TWICE — a `chief_joblog` row and a
 * line in `chief_rounds.notes` — from two separate call sites at each of six
 * places. They then counted differently: the header's `skipped` was per
 * VENTURE and the drill-down's was per ROLE, so any round where some workers
 * were busy made the two disagree with nothing saying which was right.
 *
 * Now the walk appends one of these per decision and both ledgers are DERIVED
 * from the array: the joblog row is written as it happens (so a round the
 * process dies inside still leaves its evidence), and the per-venture notes
 * and the three counters are folded out of the same items at the end. Two
 * views of one list cannot disagree.
 */
type WalkItem = {
  ventureId: string;
  venture: string;
  stage: string;
  /** Empty where the decision was about the whole venture rather than a role. */
  role: string;
  runId: string | null;
  /** `dispatched` | `skipped` | `refused` | `failed`. */
  outcome: string;
  reason: string;
};

/** One venture's line in the round's own document — what the page draws. */
type RoundNote = {
  ventureId: string;
  venture: string;
  stage: string;
  outcome: string;
  reason: string;
  roles: string[];
};

/**
 * THE PER-VENTURE VIEW, folded out of the items.
 *
 * A venture that got any work is `dispatched` and lists the roles; one that
 * got none is `skipped` and carries the first reason recorded against it,
 * which is the reason the walk actually stopped on.
 */
function notesFrom(items: WalkItem[]): RoundNote[] {
  const byVenture = new Map<string, RoundNote>();
  for (const i of items) {
    const note =
      byVenture.get(i.ventureId) ??
      { ventureId: i.ventureId, venture: i.venture, stage: i.stage, outcome: "skipped", reason: "", roles: [] };
    if (i.outcome === "dispatched") {
      note.outcome = "dispatched";
      note.roles.push(i.role);
      /* A venture that got work carries no reason: the reason is the work. */
      note.reason = "";
    } else if (note.outcome !== "dispatched" && !note.reason) note.reason = i.reason;
    byVenture.set(i.ventureId, note);
  }
  return [...byVenture.values()];
}

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

/**
 * RECORD ONE DECISION — the single writer, for both ledgers.
 *
 * The joblog row goes in AS IT HAPPENS rather than in a batch at the end,
 * because a round the process dies inside should still leave the evidence of
 * what it managed to do. The item is kept for the fold that writes the notes
 * and the counters when the walk is over.
 */
function record(roundId: string, items: WalkItem[], item: WalkItem): void {
  items.push(item);
  db.prepare(
    `INSERT INTO chief_joblog (round_id, ts, venture_id, role, run_id, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(roundId, now(), item.ventureId, item.role, item.runId, item.outcome, item.reason);
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

  /* ONE LIST, TWO VIEWS. See `WalkItem`: the notes and the counters are folded
     out of this at the end rather than kept in step by hand. */
  const items: WalkItem[] = [];
  const mark = (v: VentureRow, item: Omit<WalkItem, "ventureId" | "venture" | "stage">) =>
    record(id, items, { ventureId: v.id, venture: v.name, stage: v.stage, ...item });
  const dispatchedSoFar = () => items.filter((i) => i.outcome === "dispatched").length;

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
      /* THE VENTURE-LEVEL GATES. Each records one item with no role, which is
         what "the whole venture was passed over" looks like in the log. */
      if (s.quietStages.includes(v.stage)) {
        mark(v, { role: "", runId: null, outcome: "skipped", reason: `stage "${v.stage}" is quiet` });
        continue;
      }
      const seen = last.get(v.id);
      if (seen && Date.parse(seen) > cutoff) {
        const days = Math.floor((Date.now() - Date.parse(seen)) / 86_400_000);
        mark(v, {
          role: "",
          runId: null,
          outcome: "skipped",
          reason: `worked ${days} day${days === 1 ? "" : "s"} ago; the cadence is ${s.daysBetween} days`,
        });
        continue;
      }
      if (dispatchedSoFar() >= s.maxRuns) {
        mark(v, {
          role: "",
          runId: null,
          outcome: "skipped",
          reason: `the round's cap of ${s.maxRuns} run${s.maxRuns === 1 ? "" : "s"} was already spent`,
        });
        continue;
      }

      ensureTeam(v.id);
      const before = dispatchedSoFar();
      for (const role of s.roles) {
        if (dispatchedSoFar() >= s.maxRuns) break;
        const def = roleDef(role);
        if (!def) continue;
        if (alreadyWorking(v.id, def.kind)) {
          mark(v, { role, runId: null, outcome: "skipped", reason: "that worker is already running or queued" });
          continue;
        }
        const row = subagentRow(subagentId(v.id, role));
        if (!row) {
          mark(v, { role, runId: null, outcome: "failed", reason: "no such worker on this venture" });
          continue;
        }
        const out = dispatch(row, { brief: brief(v, role), parentSessionId: ROUNDS_SESSION });
        if (out.status === 201) {
          const run = (out.json as { run: { id: string } }).run;
          mark(v, { role, runId: run.id, outcome: "dispatched", reason: "" });
        } else {
          /* A switched-off worker answers 409 and that is a DECISION rather
             than a fault — the owner turned it off. It is logged as `refused`
             and not as `failed`, because a round that reported the owner's own
             switch as an error would be a round nobody could read. */
          const why = (out.json as { error?: string }).error ?? `status ${out.status}`;
          mark(v, { role, runId: null, outcome: out.status === 409 ? "refused" : "failed", reason: why });
        }
      }
      /* A venture every role declined gets ONE line saying so, because the
         per-role reasons are already in the log and the document is a summary.
         Recorded as a venture-level item so the fold sees it. */
      if (dispatchedSoFar() === before)
        mark(v, {
          role: "",
          runId: null,
          outcome: "skipped",
          reason: "every configured role was already working, switched off, or refused",
        });
    }

    /*
      THE HEADER'S THREE NUMBERS, DERIVED rather than kept in step by hand.
      `skipped` COUNTS VENTURES, which is what sits beside `ventures` in the
      same sentence; the per-role refusals are every non-dispatched row in the
      job log, one drill-down away. Counting one thing in the header and a
      different thing in the drill-down is what made them disagree, and both
      now come out of the one array.
    */
    const notes = notesFrom(items);
    const dispatched = items.filter((i) => i.outcome === "dispatched").length;
    const skipped = notes.filter((n) => n.outcome !== "dispatched").length;
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
        /* THE PIPELINE MAY BE DRIVING TONIGHT.
           `integrations/pipeline` registers the round as a STAGE of one visible
           nightly schedule, and a stage it starts is work this timer must not
           also start — two dispatches of the same job do not arrive sooner, they
           queue behind each other and bill twice. The predicate lives in the
           pipeline (one author for the rule; both sides read it) and answers
           false unless the pipeline is switched on AND its rounds stage is
           enabled, so a box without that area behaves exactly as before.
           Imported lazily: this file is imported by the chief manifest, which
           the skill registry pulls in, and a static import of a manifest's
           module from here would be a cycle. */
        const { pipelineOwnsRounds } = await import("../pipeline/stages-called.ts");
        if (pipelineOwnsRounds()) return;
        const { hour, day } = zoned(s.timezone);
        const saved = readSetting(RUNTIME_KEYS.roundsLastDue);
        const previous = roundRows(20).find((r) => r.trigger === "schedule");
        const last = saved ?? (previous ? zoned(s.timezone, new Date(previous.started_at)).day : null);
        const due = dueDay(day, hour, s.hour, last);
        if (!due) return;
        const out = await runRound("schedule");
        if (out.ran) writeSetting(RUNTIME_KEYS.roundsLastDue, due);
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
