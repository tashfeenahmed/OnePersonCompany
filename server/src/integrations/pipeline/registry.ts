/**
 * THE STAGE REGISTRY — one place that knows everything this box does on its
 * own, and when.
 *
 * WHAT WAS WRONG. Fourteen `onStart` timers across nine areas, each with its
 * own hour, its own watermark, its own idea of what "today" means and its own
 * table to write to. Every one of them is correct on its own terms. Together
 * they are not a schedule: nothing anywhere lists them, nothing orders them,
 * nothing stops two of them spending the model provider's queue on the same
 * minute, and "what did the estate do last night" is a question that has to be
 * answered by opening nine pages. The owner cannot switch one off without
 * finding its settings, cannot see that the briefing runs before the rounds
 * have dispatched anything, and cannot put a dollar cap on the whole night.
 *
 * WHAT THIS IS. A registry of STAGES. A stage is one recurring piece of work
 * with a name, an area, its dependencies, whether it is on, how often it is
 * due, and a budget. Two kinds live in it and the difference is the single
 * most important thing on this page:
 *
 *   CALLED STAGES have a `run`. The nightly walk is their scheduler: it
 *   decides they are due, it starts them, it times them, it prices them and it
 *   records the outcome. Nothing else starts them.
 *
 *   SELF-SCHEDULED STAGES have no `run` and a `lastRun` instead. They keep
 *   their own timer, exactly as they always have, and appear here so the
 *   schedule is COMPLETE rather than only complete about the parts that were
 *   rewritten. Their row carries the last time they actually did something,
 *   read from their own table. The registry never calls them, so nothing they
 *   do can happen twice.
 *
 * THE REGISTRY DOES NOT DUPLICATE WORK, and that is the rule that decides
 * which kind a stage gets. A piece of work becomes a called stage only when
 * its own timer has been made to stand down — which today is true of exactly
 * two: the chief's rounds (whose timer defers when this pipeline owns the
 * stage; see chief/rounds.ts) and the synthesis pass, which never had a timer
 * of its own. Everything else is self-scheduled and honestly labelled as such.
 * A future area that wants the pipeline to be its scheduler calls
 * `registerStage` with a `run` from its own manifest and removes its timer;
 * nothing here has to change.
 *
 * EVERY DECISION IN A NIGHT IS A PURE FUNCTION IN THIS FILE. `orderStages`,
 * `parseBlackouts`, `blackoutFor`, `dueByCadence` and `spend` are exported
 * with no database and no clock of their own precisely so they can be tested
 * without one — a schedule whose ordering can only be observed by waiting
 * until two in the morning is a schedule nobody checks.
 */
import { configValue, db, now } from "../../db.ts";

/** The pseudo-plugin the night's settings hang off. `plugin_config` points at
 *  `plugins`, so a setting has to hang off a row and there is no credential
 *  here to connect — the same device `rounds`, `briefing` and `backups` use. */
export const PIPELINE_PLUGIN = "pipeline";

export const DEFAULT_HOUR = 2;
/** The whole night, in minutes, after which the walk stops starting stages.
 *  It is a PLANNING budget: a stage already running is never killed by it. */
export const DEFAULT_MAX_MINUTES = 120;

export type Cadence = "daily" | "weekly" | "monthly";
export const CADENCES: Cadence[] = ["daily", "weekly", "monthly"];

export type StageOutcome = "completed" | "skipped" | "failed" | "over-budget";

export type StageResult = {
  outcome: StageOutcome;
  /** Why it was skipped. Present only on `skipped`, and written for a person. */
  reason?: string | null;
  /** What went wrong. Present only on `failed`. */
  error?: string | null;
  /** One line for the overnight summary — what this stage actually did. */
  note?: string | null;
  /** Whatever the stage counted. Never summed across stages by anything here. */
  counts?: Record<string, number>;
};

export type StageContext = {
  /** The night's id, so a stage can file its own rows against it. */
  runId: string;
  stageId: string;
  /** A planned night: work out what you WOULD do, do none of it, and say so in
   *  `note`. Every called stage must honour this — a dry run that spends money
   *  is worse than no dry run, because the owner will use it to find out what
   *  tonight costs. */
  dry: boolean;
  /** Aborted when the night's clock runs out or the run is cancelled. */
  signal: AbortSignal;
  /** Epoch ms after which this stage is over its time budget. A stage that
   *  loops should check it; one that does not is cut off by `signal`. */
  deadline: number;
  budget: { maxUsd: number | null; maxMinutes: number | null };
};

export type Stage = {
  /** Unique, kebab-case, stable — it is the key of the owner's overrides and
   *  of every result row, so renaming one orphans its history. */
  id: string;
  /** The integration area it belongs to, for grouping on the page. */
  area: string;
  title: string;
  /** Written for the owner: what this piece of work is and what it costs. */
  about: string;
  /** Stage ids that must have COMPLETED tonight before this may start. A
   *  dependency that was skipped or failed skips this one with that reason,
   *  which is the whole reason to declare one. */
  deps: string[];
  defaultEnabled: boolean;
  defaultCadence: Cadence;
  /** The part of the night this stage prefers, `HH:MM-HH:MM` in the pipeline's
   *  own zone, or null for anywhere inside the nightly window. It is a
   *  PREFERENCE expressed as a window because that is the same vocabulary as a
   *  blackout, and the two are read by the same function. */
  defaultWindow: string | null;
  budget: { maxUsd?: number; maxMinutes?: number };
  /** Present on a stage the registry SCHEDULES. Absent on one that keeps its
   *  own timer — see the file header. */
  run?: (ctx: StageContext) => Promise<StageResult>;
  /** Present on a SELF-SCHEDULED stage: the last time it actually did
   *  something, read from that area's own table. Must never throw — a table
   *  that does not exist yet answers null, which reads as "never". */
  lastRun?: () => string | null;
};

/* ------------------------------------------------------------- the registry */

const stages = new Map<string, Stage>();

/**
 * Add a stage. Idempotent by id, because `node --watch` re-imports modules on
 * every save and a registry that appended would grow a duplicate a minute.
 * The LAST registration wins, so a reload picks up the edited definition.
 */
export function registerStage(stage: Stage): void {
  stages.set(stage.id, stage);
}

export function allStages(): Stage[] {
  return [...stages.values()];
}

export function stage(id: string): Stage | null {
  return stages.get(id) ?? null;
}

/* ------------------------------------------------------------------ order */

/**
 * DEPENDENCY ORDER, and a deterministic one.
 *
 * Kahn's algorithm with the ready set kept in REGISTRATION order rather than
 * sorted: two stages that depend on nothing run in the order their areas were
 * registered, every night, which is what makes two nights comparable. A sort
 * by id would put `alerts` before `briefing` for a reason that is about the
 * alphabet and nothing else.
 *
 * A CYCLE DOES NOT THROW. It returns the cycle's members in `cycle` and leaves
 * them out of `order`; the walk records each of them as skipped naming the
 * others. A nightly that refused to run at all because two stages of fourteen
 * were mis-declared would be a worse night than one that runs twelve.
 *
 * A dependency on an id that is not registered is dropped and named in
 * `missing` — an area removed in a release must not take the stages that
 * mentioned it down with it.
 */
export function orderStages(input: Stage[]): {
  order: Stage[];
  cycle: string[];
  missing: { stage: string; dep: string }[];
} {
  const byId = new Map(input.map((s) => [s.id, s]));
  const missing: { stage: string; dep: string }[] = [];
  const deps = new Map<string, string[]>();
  for (const s of input) {
    const kept: string[] = [];
    for (const d of s.deps) {
      if (byId.has(d)) kept.push(d);
      else missing.push({ stage: s.id, dep: d });
    }
    deps.set(s.id, kept);
  }

  const order: Stage[] = [];
  const done = new Set<string>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const s of input) {
      if (done.has(s.id)) continue;
      if (!deps.get(s.id)!.every((d) => done.has(d))) continue;
      order.push(s);
      done.add(s.id);
      moved = true;
    }
  }
  const cycle = input.filter((s) => !done.has(s.id)).map((s) => s.id);
  return { order, cycle, missing };
}

/**
 * How deep to indent a stage on the page: the longest chain of dependencies
 * behind it. Computed here rather than on the client because the client would
 * have to re-implement the cycle guard to do it safely.
 */
export function depthOf(id: string, input: Stage[], seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const s = input.find((x) => x.id === id);
  if (!s || !s.deps.length) return 0;
  return 1 + Math.max(0, ...s.deps.map((d) => depthOf(d, input, new Set(seen))));
}

/* -------------------------------------------------------------- blackouts */

export type Blackout = {
  from: string;
  to: string;
  /** Stage ids, or `["*"]` for everything. */
  stages: string[];
  /** Days of the week, 0 = Sunday, or null for every day. */
  days: number[] | null;
  raw: string;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * PARSE THE OWNER'S BLACKOUT WINDOWS.
 *
 * One window per line or per `;`, in a shape that can be typed into a settings
 * box without a form:
 *
 *     22:00-23:30
 *     09:00-17:00 stages=synthesis days=1,2,3,4,5
 *
 * A WINDOW MAY WRAP PAST MIDNIGHT and that is deliberate, unlike the nightly
 * start hour. A blackout settles no watermark — it only ever answers "is now
 * inside" — and 23:00–01:00 is exactly the window somebody wants when the
 * thing they are protecting is their own evening.
 *
 * BAD LINES ARE RETURNED, NOT THROWN AND NOT SILENTLY DROPPED. `errors` is
 * what the settings check publishes back to the owner; a typo that quietly
 * removed a blackout would be a night that ran through a window he thought he
 * had closed.
 */
export function parseBlackouts(raw: string | null): { blackouts: Blackout[]; errors: string[] } {
  const blackouts: Blackout[] = [];
  const errors: string[] = [];
  const lines = (raw ?? "")
    .split(/[\n;]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split(/\s+/);
    const span = parts[0] ?? "";
    const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(span);
    if (!m || !HHMM.test(m[1]!) || !HHMM.test(m[2]!)) {
      errors.push(`"${line}" — a window starts with HH:MM-HH:MM, for example 22:00-23:30.`);
      continue;
    }
    if (m[1] === m[2]) {
      errors.push(`"${line}" — from and to are the same minute, which is not a window.`);
      continue;
    }
    let stageIds = ["*"];
    let days: number[] | null = null;
    let bad = false;
    for (const opt of parts.slice(1)) {
      const kv = /^(stages|days)=(.+)$/.exec(opt);
      if (!kv) {
        errors.push(`"${line}" — "${opt}" is not stages=… or days=….`);
        bad = true;
        break;
      }
      const values = kv[2]!.split(",").map((v) => v.trim()).filter(Boolean);
      if (kv[1] === "stages") {
        stageIds = values.includes("*") ? ["*"] : [...new Set(values)];
      } else {
        const nums = values.map(Number);
        if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
          errors.push(`"${line}" — days are 0 (Sunday) to 6, comma separated.`);
          bad = true;
          break;
        }
        days = [...new Set(nums)].sort();
      }
    }
    if (bad) continue;
    blackouts.push({ from: m[1]!, to: m[2]!, stages: stageIds, days, raw: line });
  }
  return { blackouts, errors };
}

const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Is this stage blacked out at this local minute? Returns the window that
 * caught it so the skip reason can quote it back.
 *
 * `minute` and `weekday` are passed in rather than read from a clock, because
 * the caller has already resolved them in the owner's zone and a second
 * resolution here could straddle midnight and disagree with the first.
 */
export function blackoutFor(
  blackouts: Blackout[],
  stageId: string,
  minute: number,
  weekday: number,
): Blackout | null {
  for (const b of blackouts) {
    if (!b.stages.includes("*") && !b.stages.includes(stageId)) continue;
    if (b.days && !b.days.includes(weekday)) continue;
    const from = minuteOf(b.from);
    const to = minuteOf(b.to);
    const inside = from < to ? minute >= from && minute < to : minute >= from || minute < to;
    if (inside) return b;
  }
  return null;
}

/* ----------------------------------------------------------- due, by cadence */

/**
 * Is a stage due today?
 *
 * `lastAt` is the last time this stage COMPLETED in a real (non-dry) night;
 * `today` is a calendar day in the owner's own zone. Daily means "not already
 * today", weekly means seven clear days, monthly twenty-eight — real day
 * arithmetic rather than calendar-month arithmetic, because "monthly" here
 * means a cadence and not the first of the month, and a stage due on the 31st
 * would run seven times a year.
 *
 * A stage that has NEVER completed is always due. That is what makes a newly
 * registered stage run on its first night rather than on its second.
 */
export function dueByCadence(cadence: Cadence, lastAt: string | null, today: string): boolean {
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  if (!Number.isFinite(last)) return true;
  const days = { daily: 1, weekly: 7, monthly: 28 }[cadence];
  const lastDay = new Date(last).toISOString().slice(0, 10);
  if (cadence === "daily") return lastDay !== today;
  const elapsed = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${lastDay}T12:00:00Z`)) / 86_400_000;
  return elapsed >= days;
}

/* -------------------------------------------------------------- the budget */

export type Spend = {
  /** Dollars spent so far tonight, or null when nothing is priced. */
  usd: number | null;
  /** Minutes elapsed since the night started. */
  minutes: number;
};

/**
 * MAY THIS STAGE START?
 *
 * Three separate refusals and each names its own number, because "over budget"
 * with no figure is a sentence the owner cannot act on.
 *
 * THE DOLLAR CAP IS CHECKED BEFORE THE STAGE, NOT DURING IT. A stage that has
 * begun is not stopped by a budget — `runtime/budgets.ts` already refuses the
 * individual model call that would exceed the owner's per-run and per-day
 * limits, and a second killer inside the stage would leave half-written work
 * with no owner. This gate decides what to START; that one decides what to
 * SEND. They are different jobs and having both is the point.
 *
 * A NULL SPEND NEVER BLOCKS. When no price per million tokens is configured
 * this box cannot count dollars, and refusing to run the night because it
 * cannot measure the money would be the measurement deciding the policy.
 */
export function spend(
  used: Spend,
  night: { maxUsd: number | null; maxMinutes: number | null },
  stageBudget: { maxUsd: number | null; maxMinutes: number | null },
): { ok: true } | { ok: false; reason: string } {
  if (night.maxMinutes !== null && used.minutes >= night.maxMinutes)
    return {
      ok: false,
      reason:
        `the night's budget of ${night.maxMinutes} minute${night.maxMinutes === 1 ? "" : "s"} ` +
        `was already spent (${Math.round(used.minutes)} elapsed)`,
    };
  if (night.maxUsd !== null && used.usd !== null && used.usd >= night.maxUsd)
    return {
      ok: false,
      reason: `the night's budget of $${night.maxUsd.toFixed(2)} was already spent ($${used.usd.toFixed(2)})`,
    };
  if (
    stageBudget.maxMinutes !== null &&
    night.maxMinutes !== null &&
    used.minutes + stageBudget.maxMinutes > night.maxMinutes
  )
    return {
      ok: false,
      reason:
        `this stage is allowed ${stageBudget.maxMinutes} minutes and only ` +
        `${Math.max(0, Math.round(night.maxMinutes - used.minutes))} of the night's ` +
        `${night.maxMinutes} are left`,
    };
  return { ok: true };
}

/* --------------------------------------------------------------- settings */

export type PipelineSettings = {
  enabled: boolean;
  hour: number;
  timezone: string | null;
  resolvedTimezone: string;
  blackouts: Blackout[];
  blackoutErrors: string[];
  maxUsd: number | null;
  maxMinutes: number | null;
};

export function zoneIsReal(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function whole(raw: string | null, fallback: number, min: number, max: number): number {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** A dollar setting. 0 and empty both mean NO CAP, which is a real answer and
 *  not a missing one — the alternative would be a box you cannot empty. */
function money(raw: string | null): number | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function settings(): PipelineSettings {
  const zone = (configValue(PIPELINE_PLUGIN, "timezone") ?? "").trim();
  const { blackouts, errors } = parseBlackouts(configValue(PIPELINE_PLUGIN, "blackouts"));
  const minutes = whole(configValue(PIPELINE_PLUGIN, "max-minutes"), DEFAULT_MAX_MINUTES, 0, 1440);
  return {
    enabled: (configValue(PIPELINE_PLUGIN, "enabled") ?? "").trim().toLowerCase() === "on",
    hour: whole(configValue(PIPELINE_PLUGIN, "hour"), DEFAULT_HOUR, 0, 23),
    timezone: zone && zoneIsReal(zone) ? zone : null,
    resolvedTimezone: zone && zoneIsReal(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    blackouts,
    blackoutErrors: errors,
    maxUsd: money(configValue(PIPELINE_PLUGIN, "max-usd")),
    /* Zero means no clock cap, matching the dollar setting rather than meaning
       "a night of zero minutes", which nobody has ever wanted to type. */
    maxMinutes: minutes > 0 ? minutes : null,
  };
}

/** The hour, the calendar day, the minute of the day and the weekday, where
 *  the owner says they are — all from ONE formatter call, because asking twice
 *  at 23:59:59.9 can straddle midnight and give an hour from one day beside a
 *  date from the next. */
export function zoned(
  s: Pick<PipelineSettings, "timezone">,
  at = new Date(),
): { day: string; hour: number; minute: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: s.timezone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  /* "24" is what some ICU builds call midnight in an hour12:false format. Read
     as 24 it would never equal a configured hour and a night set to midnight
     would never start. */
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: hour * 60 + minute,
    weekday: weekday < 0 ? new Date(at).getUTCDay() : weekday,
  };
}

/** The next moment a night is due, or null when the schedule is off. Walked
 *  hour by hour rather than computed: "02:00 in Europe/Dublin" is not an
 *  arithmetic offset from now, and a day with a DST transition in it is 23 or
 *  25 hours long. Fifty probes of a formatter is microseconds. */
export function nextRunAt(s = settings(), at = new Date()): string | null {
  if (!s.enabled) return null;
  for (let i = 1; i <= 48; i += 1) {
    const probe = new Date(at.getTime() + i * 3_600_000);
    if (zoned(s, probe).hour === s.hour)
      return new Date(Math.floor(probe.getTime() / 3_600_000) * 3_600_000).toISOString();
  }
  return null;
}

/* -------------------------------------------------------- per-stage overrides */

export type StagePref = {
  stage_id: string;
  enabled: number | null;
  cadence: string | null;
  max_usd: number | null;
  max_minutes: number | null;
  updated_at: string;
};

export function prefs(): Map<string, StagePref> {
  const rows = db.prepare("SELECT * FROM pipeline_stage_prefs").all() as unknown as StagePref[];
  return new Map(rows.map((r) => [r.stage_id, r]));
}

export function setPref(
  stageId: string,
  patch: { enabled?: boolean | null; cadence?: Cadence | null; maxUsd?: number | null; maxMinutes?: number | null },
): void {
  const held = prefs().get(stageId);
  const value = {
    enabled: patch.enabled === undefined ? (held?.enabled ?? null) : patch.enabled === null ? null : Number(patch.enabled),
    cadence: patch.cadence === undefined ? (held?.cadence ?? null) : patch.cadence,
    max_usd: patch.maxUsd === undefined ? (held?.max_usd ?? null) : patch.maxUsd,
    max_minutes: patch.maxMinutes === undefined ? (held?.max_minutes ?? null) : patch.maxMinutes,
  };
  db.prepare(
    `INSERT INTO pipeline_stage_prefs (stage_id, enabled, cadence, max_usd, max_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(stage_id) DO UPDATE SET
       enabled = excluded.enabled, cadence = excluded.cadence,
       max_usd = excluded.max_usd, max_minutes = excluded.max_minutes,
       updated_at = excluded.updated_at`,
  ).run(stageId, value.enabled, value.cadence, value.max_usd, value.max_minutes, now());
}

/** The settled definition of one stage: its own defaults with the owner's
 *  overrides on top. One author for that merge, because the page, the walk and
 *  the skill all need the same answer. */
export function settled(s: Stage, pref: StagePref | undefined) {
  const cadence = (pref?.cadence && CADENCES.includes(pref.cadence as Cadence)
    ? (pref.cadence as Cadence)
    : s.defaultCadence);
  return {
    id: s.id,
    area: s.area,
    title: s.title,
    about: s.about,
    deps: s.deps,
    scheduledBy: s.run ? ("pipeline" as const) : ("self" as const),
    enabled: pref?.enabled === null || pref?.enabled === undefined ? s.defaultEnabled : pref.enabled === 1,
    cadence,
    window: s.defaultWindow,
    maxUsd: pref?.max_usd ?? s.budget.maxUsd ?? null,
    maxMinutes: pref?.max_minutes ?? s.budget.maxMinutes ?? null,
    overridden: !!pref,
  };
}

export type SettledStage = ReturnType<typeof settled>;

/* ------------------------------------------------------------- "not tonight" */

export function skipDay(): { day: string; setAt: string; reason: string | null } | null {
  const row = db.prepare("SELECT * FROM pipeline_skips WHERE id = 1").get() as
    | { day: string; set_at: string; reason: string | null }
    | undefined;
  return row ? { day: row.day, setAt: row.set_at, reason: row.reason } : null;
}

export function setSkipDay(day: string | null, reason: string | null): void {
  if (day === null) {
    db.prepare("DELETE FROM pipeline_skips WHERE id = 1").run();
    return;
  }
  db.prepare(
    `INSERT INTO pipeline_skips (id, day, set_at, reason) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET day = excluded.day, set_at = excluded.set_at, reason = excluded.reason`,
  ).run(day, now(), reason);
}
