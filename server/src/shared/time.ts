/**
 * THE LOCAL WALL CLOCK, AND THE DAILY SCHEDULE BUILT ON IT.
 *
 * Every area that runs something daily needs it, and each hand-rolled copy is
 * a fresh chance to disagree: the owner sets a timezone in three plugin
 * settings and the box still runs the autopilot on one zone, the blackout
 * window on another and the briefing an hour off a third.
 *
 * WHAT THIS MODULE SETTLED ON
 *
 *   1. ONE FORMATTER CALL PER READING. The day, the hour, the minute and the
 *      weekday all come out of a single `formatToParts`. Asking twice at
 *      23:59:59.9 can straddle midnight and hand back an hour from one day
 *      beside a date from the next — a bug that fires once in a few million
 *      ticks and is unreproducible when it does.
 *
 *   2. `% 24`, ALWAYS. "24" is what some ICU builds call midnight in an
 *      `hour12: false` format. Read literally it never equals a configured
 *      hour, so a schedule set to midnight silently never fires.
 *
 *   3. THE SCHEDULER WALKS, IT DOES NOT COMPUTE. "02:00 in Europe/Berlin" is
 *      not an arithmetic offset from now: the offset changes twice a year, and
 *      a day containing a DST transition is 23 or 25 hours long. So
 *      `nextRunAt` probes the formatter minute by minute for up to 48 hours and
 *      takes the first local hour and minute that match. This also handles
 *      half-hour and quarter-hour offsets, and it
 *      is correct on both transition days by construction rather than by
 *      argument. Forty-eight and not twenty-five, because a spring-forward day
 *      can skip the configured hour entirely and the next occurrence is then
 *      more than 24 hours out.
 *
 *   4. AN UNSET ZONE RESOLVES TO THE MACHINE'S OWN, AT READ TIME, AND THE
 *      RESOLVED NAME IS WHAT CALLERS SEE. Storing `null` and passing
 *      `undefined` to `Intl` (which quietly uses the machine zone) produces
 *      the SAME INSTANT and a DIFFERENT DOCUMENT — one page says
 *      "Europe/Berlin", another says nothing at all for the same schedule. A
 *      zone that is set but not a real IANA name resolves the same way rather
 *      than throwing: a typo in a settings field must not take the scheduler
 *      down. `dailySchedule` reports `zoneWasSet` so a page can still say
 *      "using this machine's zone" where that is worth saying.
 *
 *   5. A MISSED DAY CATCHES UP ONCE. `dueDay` coalesces any number of missed
 *      days into a single run — a box that was asleep for a week owes one
 *      briefing, not seven.
 */

import { configValue } from "../db.ts";
import { nextZonedTime } from "../../../shared/zonedTime.ts";

/* ------------------------------------------------------------------ zones */

/**
 * The machine's own zone. Node knows it; guessing "UTC" would build every
 * schedule at the wrong hour for everybody not in London in winter. "UTC" is
 * only the last resort for a box whose ICU cannot answer at all.
 */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Is this a zone name `Intl` will accept? The only way to ask is to try. */
export function validZone(zone: string | null | undefined): boolean {
  const z = (zone ?? "").trim();
  if (!z) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/** Rule 4, as a function: what zone a stored setting actually means. */
export const resolveZone = (zone: string | null | undefined): string =>
  validZone(zone) ? (zone as string).trim() : systemZone();

/* ------------------------------------------------------------ the clock */

/** One reading of the wall clock somewhere. */
export type Wall = {
  /** `YYYY-MM-DD`, local to the zone. */
  day: string;
  /** 0–23. Midnight is 0, never 24 — see rule 2. */
  hour: number;
  /** 0–59. */
  minute: number;
  /** Minutes since local midnight, for window comparisons. */
  minutes: number;
  /** 0 = Sunday, matching `Date.prototype.getDay`. */
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The local wall clock in a zone. `Intl` is the only thing on this box that
 * knows about zones and daylight saving; deriving an offset by hand is wrong
 * twice a year.
 */
export function wall(zone: string | null | undefined, at: Date = new Date()): Wall {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveZone(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = WEEKDAYS.indexOf(get("weekday"));
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
    /* A locale that does not give a recognisable short weekday falls back to
       the UTC one rather than to -1, which would silently never match a
       configured weekday. */
    weekday: weekday < 0 ? at.getUTCDay() : weekday,
  };
}

/**
 * The day and the hour, which is all most callers ever wanted. A narrowing of
 * `wall`, not a second implementation — one formatter, one set of rules.
 */
export function zoned(
  zone: string | null | undefined,
  at: Date = new Date(),
): { day: string; hour: number } {
  const { day, hour } = wall(zone, at);
  return { day, hour };
}

/* --------------------------------------------------------- the schedule */

/** What a once-a-day schedule is, everywhere on this box. */
export type DailySchedule = {
  enabled: boolean;
  /** 0–23, local to `timezone`. */
  hour: number;
  /** Always a real zone name — see rule 4. */
  timezone: string;
  /** False when `timezone` came from the machine rather than from a setting. */
  zoneWasSet: boolean;
};

/** Where `dailySchedule` looks, for a plugin that names its keys differently. */
export type ScheduleKeys = {
  enabledKey?: string;
  hourKey?: string;
  zoneKey?: string;
  /** Used when the hour setting is empty or unusable. */
  defaultHour?: number;
  /** For a schedule with no on/off setting of its own. */
  defaultEnabled?: boolean;
};

/**
 * An hour setting, read.
 *
 * AN EMPTY SETTING IS NOT A ZERO, and this is the one place that mistake is
 * expensive: `Number("")` is 0, which is a legal hour, so an unset field would
 * silently schedule for midnight rather than for the default. The string is
 * checked before it is a number.
 *
 * An out-of-range hour falls back to the default rather than clamping. One of
 * the copies clamped, which turns a typed `25` into 23:00 — a time the owner
 * did not choose, presented as if they had. The default is at least a value
 * the page can name.
 */
export function readHour(raw: string | null | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 23) return fallback;
  return n;
}

/** A plugin's daily schedule, from its own settings rows. */
export function dailySchedule(pluginId: string, keys: ScheduleKeys = {}): DailySchedule {
  const {
    enabledKey = "enabled",
    hourKey = "hour",
    zoneKey = "timezone",
    defaultHour = 9,
    defaultEnabled = false,
  } = keys;
  const enabledRaw = (configValue(pluginId, enabledKey) ?? "").trim().toLowerCase();
  const zoneRaw = (configValue(pluginId, zoneKey) ?? "").trim();
  return {
    /* OFF UNTIL ASKED FOR, by default. Something that writes, sends or spends
       starting itself because a default said so is a surprise. A caller whose
       schedule has no switch passes `defaultEnabled: true`. */
    enabled: enabledRaw ? enabledRaw === "on" || enabledRaw === "yes" || enabledRaw === "true" || enabledRaw === "1" : defaultEnabled,
    hour: readHour(configValue(pluginId, hourKey), defaultHour),
    timezone: resolveZone(zoneRaw),
    zoneWasSet: validZone(zoneRaw),
  };
}

/**
 * The next moment this schedule is due, as an ISO instant on the hour, or
 * `null` when it is off.
 *
 * Walked, not computed — see rule 3. Match minute zero in the LOCAL zone,
 * not UTC; 06:00 in Kathmandu is 00:15 UTC. The instant is always future.
 */
export function nextRunAt(
  schedule: { enabled?: boolean; hour: number; timezone: string | null },
  at: Date = new Date(),
): string | null {
  if (schedule.enabled === false) return null;
  return nextZonedTime(resolveZone(schedule.timezone), schedule.hour, 0, at);
}

/**
 * Is a daily run owed, and for which local day?
 *
 * `null` means nothing is owed. Otherwise the answer is the DAY the run is
 * being made for, which the caller stores and passes back as `lastDueDay` next
 * tick — that is what makes this idempotent across restarts.
 *
 * Missed days coalesce into ONE catch-up: a box asleep for a week owes one
 * run, not seven. And a run missed yesterday can still be made this morning
 * before today's hour comes round, which is why the candidate day steps back a
 * day when the local hour has not reached the scheduled one yet.
 *
 * A schedule that has never run (`lastDueDay === null`) waits for its hour
 * rather than firing immediately on the first tick after it is switched on.
 */
export function dueDay(
  day: string,
  currentHour: number,
  scheduledHour: number,
  lastDueDay: string | null,
): string | null {
  if (!lastDueDay && currentHour < scheduledHour) return null;
  const candidate =
    currentHour >= scheduledHour
      ? day
      /* Midday UTC, so the subtraction cannot land on the wrong side of a
         date boundary for any zone offset. */
      : new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return lastDueDay && lastDueDay >= candidate ? null : candidate;
}
