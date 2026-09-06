/**
 * THE FIVE DECISIONS THIS AREA CANNOT MAKE FOR ANYBODY.
 *
 * Every one of them is a setting rather than a constant because the right
 * answer is different for every installation of this app, and none of them can
 * be measured:
 *
 *   publicBaseUrl   Instagram and TikTok do not take bytes. They take a URL
 *                   and fetch it themselves, minutes later, from their own
 *                   network. This server binds to loopback, so there is no way
 *                   for this code to DISCOVER a URL that reaches it — the
 *                   owner has to have arranged one (a tunnel, a reverse proxy)
 *                   and to say what it is. With it empty, those two
 *                   destinations report themselves as unable to publish and
 *                   say why; they never half-try.
 *   timezone        "Half past nine" is a local wall clock, and the calendar
 *                   is drawn in it. Defaults to this machine's own zone, which
 *                   is what a laptop's owner means until they say otherwise.
 *                   ONE ZONE FOR THE WHOLE BOX — see `ownerZone` below.
 *   maxAttempts     How many times a failed publish is retried before the item
 *                   is marked failed and left alone. Retrying forever against
 *                   a permission that will never be granted is a log nobody
 *                   reads.
 *   blackout        Windows in which nothing goes out. A due item inside one
 *                   stays due — it is not skipped and it is not lost — and
 *                   goes out on the first tick after the window closes.
 *   autoSchedule    What happens to an asset the Autopilot finished. Off by
 *                   default: a generator that also PUBLISHED on a schedule
 *                   without the owner having said so per venture is the one
 *                   failure this whole area is shaped to prevent.
 *
 * THE ZONE MATHS IS NOT HERE ANY MORE. `wall`, `validZone` and the machine-zone
 * fallback were written out three times in three areas — this one, the video
 * autopilot and the morning briefing — and they had already drifted. They live
 * in `shared/time.ts` now and this file re-exports them, so the two callers in
 * this area keep their one import and nothing outside has to learn a new path.
 */
import { configValue } from "../../db.ts";
import { resolveZone, systemZone, validZone, wall } from "../../shared/time.ts";

/* Re-exported rather than re-implemented. `manifest.ts` and `scheduler.ts`
   already import them from here. */
export { systemZone as localZone, validZone, wall };

export const PLUGIN = "publishing";

export const DEFAULT_MAX_ATTEMPTS = 3;

/** The scheduler's tick. A minute is the resolution the calendar promises;
 *  anything finer would be a timer that wakes sixty times for each thing it
 *  does. */
export const TICK_MS = 60_000;

/** How long an item may sit in `publishing` before the next start decides the
 *  process died mid-call and reclaims it. Generously longer than the longest
 *  publish path here (LinkedIn's upload plus a thirty-second poll). */
export const STUCK_MINUTES = 15;

/**
 * THE OWNER'S ZONE. ONE SETTING, FOR EVERYTHING THIS BOX DOES ON A CLOCK.
 *
 * There used to be three, one per area — the publishing calendar's, the video
 * autopilot's and the morning briefing's — and each of them fell back to the
 * machine zone when it was the one the owner had not filled in. Set once, the
 * result was a box that generated on the zone you typed, applied its blackout
 * window on UTC, and delivered a briefing an hour off a third answer. Nobody
 * ever intends to live in three time zones.
 *
 * `publishing.timezone` IS THE KEY THAT SURVIVED, because outbound timing is
 * the thing a zone is most expensive to be wrong about and this is where
 * outbound timing lives. The other two are read as FALLBACKS and nothing more:
 * an existing box where the owner only ever filled in the autopilot's field
 * keeps working and gets one consistent answer everywhere, and the settings
 * page writes the canonical key from now on. Once the last legacy row is gone
 * the two names below can go with it.
 */
export const ZONE_KEY = "timezone";
const LEGACY_ZONE_SOURCES: [plugin: string, key: string][] = [
  ["autopilot", "timezone"],
  ["briefing", "timezone"],
];

export function ownerZone(): string {
  const own = (configValue(PLUGIN, ZONE_KEY) ?? "").trim();
  if (validZone(own)) return own;
  for (const [plugin, key] of LEGACY_ZONE_SOURCES) {
    const legacy = (configValue(plugin, key) ?? "").trim();
    if (validZone(legacy)) return legacy;
  }
  return resolveZone(null);
}

/* --------------------------------------------------------------- blackout */

/**
 * One window in which nothing is published.
 *
 * `days` empty means every day. A window whose end is BEFORE its start wraps
 * over midnight — "22:00-07:00" is one window, not a mistake — and that is the
 * common case, which is why it is handled rather than refused.
 */
export type Blackout = { days: number[]; from: number; to: number; raw: string };

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

const MINUTES = (h: number, m: number) => h * 60 + m;

/**
 * `22:00-07:00`, `Sat,Sun 00:00-23:59`, `mon-fri 09:00-17:00` — one per line.
 *
 * PARSED LEFT TO RIGHT AND NEVER GUESSED. A line this cannot read is dropped
 * and reported by the settings check, because a blackout window that was
 * silently ignored is a post going out at four in the morning.
 */
export function parseBlackout(text: string | null | undefined): {
  windows: Blackout[];
  bad: string[];
} {
  const windows: Blackout[] = [];
  const bad: string[] = [];
  for (const raw of (text ?? "").split(/[\n;]/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:([a-z,\- ]+?)\s+)?(\d{1,2}):(\d{2})\s*(?:-|to|–)\s*(\d{1,2}):(\d{2})$/i.exec(line);
    if (!m) {
      bad.push(line);
      continue;
    }
    const days: number[] = [];
    if (m[1]) {
      let ok = true;
      for (const part of m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        const range = /^([a-z]+)\s*-\s*([a-z]+)$/.exec(part);
        if (range) {
          const a = DAY_NAMES[range[1]!];
          const b = DAY_NAMES[range[2]!];
          if (a === undefined || b === undefined) { ok = false; break; }
          for (let d = a; ; d = (d + 1) % 7) {
            days.push(d);
            if (d === b) break;
          }
        } else {
          const d = DAY_NAMES[part];
          if (d === undefined) { ok = false; break; }
          days.push(d);
        }
      }
      if (!ok) {
        bad.push(line);
        continue;
      }
    }
    const from = MINUTES(Number(m[2]), Number(m[3]));
    const to = MINUTES(Number(m[4]), Number(m[5]));
    if (from > 23 * 60 + 59 || to > 23 * 60 + 59) {
      bad.push(line);
      continue;
    }
    windows.push({ days: [...new Set(days)], from, to, raw: line });
  }
  return { windows, bad };
}

/** Is this wall-clock moment inside any of them? Pure, so the test can walk a
 *  day of minutes across a window that wraps midnight. */
export function inBlackout(
  windows: Blackout[],
  at: { weekday: number; minutes: number },
): Blackout | null {
  for (const w of windows) {
    /* A window that wraps midnight belongs to the day it STARTED on, so
       "Fri 22:00-02:00" covers Friday night and the small hours of Saturday.
       The second half is checked against the previous day's membership. */
    const wraps = w.to < w.from;
    const dayMatches = (d: number) => !w.days.length || w.days.includes(d);
    /* INCLUSIVE OF THE CLOSING MINUTE. The documented example is
       `Sat,Sun 00:00-23:59`, which anybody typing it means as "all of Saturday
       and Sunday"; an exclusive end left 23:59 open, and a post going out in
       the one minute a blackout was meant to cover is exactly the failure the
       setting exists to prevent. A window is therefore [from, to]. The cost is
       that two adjacent windows overlap on one minute, which changes nothing:
       being inside either is being inside a blackout. */
    if (!wraps) {
      if (dayMatches(at.weekday) && at.minutes >= w.from && at.minutes <= w.to) return w;
    } else {
      if (dayMatches(at.weekday) && at.minutes >= w.from) return w;
      if (dayMatches((at.weekday + 6) % 7) && at.minutes <= w.to) return w;
    }
  }
  return null;
}

/* ---------------------------------------------------------- auto-schedule */

/**
 * `slug = HH:MM` per line, `*` for every venture.
 *
 * THE ONLY THING THAT PUTS AN AUTOPILOT ASSET ON THE CALENDAR. With no line
 * for a venture, a finished Autopilot post becomes a DRAFT here and stops —
 * the owner approves it or does not. With a line, it becomes a scheduled item
 * at the next occurrence of that local time, still requiring an approval
 * before the scheduler will send it. There is no setting anywhere in this area
 * that publishes without an approval; this one only chooses a date.
 */
export type AutoSlot = { slug: string; hour: number; minute: number };

export function parseAutoSchedule(text: string | null | undefined): {
  slots: AutoSlot[];
  bad: string[];
} {
  const slots: AutoSlot[] = [];
  const bad: string[] = [];
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9*_-]+)\s*=\s*(\d{1,2}):(\d{2})$/.exec(line);
    if (!m) {
      bad.push(line);
      continue;
    }
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 23 || minute > 59) {
      bad.push(line);
      continue;
    }
    slots.push({ slug: m[1]!.toLowerCase(), hour, minute });
  }
  return { slots, bad };
}

/* ---------------------------------------------------------------- reading */

export type PublishSettings = {
  publicBaseUrl: string | null;
  timezone: string;
  maxAttempts: number;
  blackout: Blackout[];
  blackoutRaw: string;
  autoSchedule: AutoSlot[];
};

export function settings(): PublishSettings {
  const attemptsRaw = (configValue(PLUGIN, "maxAttempts") ?? "").trim();
  const attempts = Number(attemptsRaw);
  const blackoutRaw = configValue(PLUGIN, "blackout") ?? "";
  return {
    publicBaseUrl: normaliseBase(configValue(PLUGIN, "publicBaseUrl")),
    timezone: ownerZone(),
    maxAttempts:
      Number.isInteger(attempts) && attempts >= 1 && attempts <= 20
        ? attempts
        : DEFAULT_MAX_ATTEMPTS,
    blackout: parseBlackout(blackoutRaw).windows,
    blackoutRaw,
    autoSchedule: parseAutoSchedule(configValue(PLUGIN, "autoSchedule")).slots,
  };
}

/** Trailing slashes off, and nothing but an http(s) origin accepted. A base
 *  URL with a path is allowed — a reverse proxy may mount this API under one —
 *  but a bare hostname is not, because the scheme decides whether Instagram
 *  will fetch it at all. */
export function normaliseBase(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(v)) return null;
  return v;
}
