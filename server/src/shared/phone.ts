/**
 * HOW THINGS READ ON A PHONE — the small words every Telegram push shares.
 *
 * The owner reads these on a lock screen, so each helper answers one question
 * a person would ask rather than printing what the machine stored: "$19/yr"
 * and not "USD 19.00", "at 10:32pm" and not "2026-09-24 21:32 UTC", "couldn't
 * reach Dell 5820, it may be switched off" and not a URL and an exception class.
 *
 * NOTHING HERE READS THE DATABASE. The zone is the caller's (every pusher
 * already holds the customers area's `settings().timezone`), so each helper is
 * pure and the wording is what the tests pin.
 */
import { wall } from "./time.ts";

/* ------------------------------------------------------------------ money */

const SYMBOLS: Record<string, string> = { usd: "$", eur: "€", gbp: "£", jpy: "¥", inr: "₹", aud: "A$", cad: "C$" };
const PER: Record<string, string> = { day: "day", week: "wk", month: "mo", year: "yr" };

/** "$19", "€49.50", "CHF 12". Whole amounts lose their ".00". */
export function cash(amount: number, currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toLowerCase();
  const dp = Math.round(Math.abs(amount) * 100) % 100 === 0 ? 0 : 2;
  const n = Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sign = amount < 0 ? "-" : "";
  const sym = SYMBOLS[code];
  if (sym) return `${sign}${sym}${n}`;
  return code ? `${sign}${code.toUpperCase()} ${n}` : `${sign}${n}`;
}

/** "$19/yr", "€49/mo", "$57 every 3 months", or plain "$19" with no interval. */
export function price(
  amount: number,
  currency: string | null | undefined,
  interval?: string | null,
  count?: number | null,
): string {
  const base = cash(amount, currency);
  const unit = interval ? PER[interval] : undefined;
  if (!unit) return base;
  if (count && count > 1) return `${base} every ${count} ${interval}s`;
  return `${base}/${unit}`;
}

/** 17517 → "17,517"; 0.5 → "0.5"; 86.63 → "86.6". */
export function num(n: number, dp = 1): string {
  const r = Number(n.toFixed(dp));
  return r.toLocaleString("en-US", { maximumFractionDigits: dp });
}

/* ------------------------------------------------------------------- time */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "10:32pm" in the zone. */
export function clock(iso: string | Date, zone: string): string {
  const w = wall(zone, typeof iso === "string" ? new Date(iso) : iso);
  const h = w.hour % 12 || 12;
  return `${h}:${String(w.minute).padStart(2, "0")}${w.hour < 12 ? "am" : "pm"}`;
}

/** "Thu 24 Sep", or "Thu 24 Sep 2027" when it is not this year. */
export function dayName(day: string, now: Date = new Date(), zone = "UTC"): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const thisYear = Number(wall(zone, now).day.slice(0, 4));
  return `${weekday} ${d} ${MONTHS[m - 1]}${y === thisYear ? "" : ` ${y}`}`;
}

/** Days between two local `YYYY-MM-DD` dates. */
const dayGap = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** "today", "yesterday", "tomorrow" or "on Thu 24 Sep" for a local day. */
export function relativeDay(day: string, now: Date = new Date(), zone = "UTC"): string {
  const gap = dayGap(wall(zone, now).day, day);
  if (gap === 0) return "today";
  if (gap === -1) return "yesterday";
  if (gap === 1) return "tomorrow";
  return `on ${dayName(day, now, zone)}`;
}

/** "at 10:32pm", "yesterday at 10:32pm", "on Mon 21 Sep at 9:05am". */
export function when(iso: string, zone: string, now: Date = new Date()): string {
  const day = wall(zone, new Date(iso)).day;
  const rel = relativeDay(day, now, zone);
  return `${rel === "today" ? "" : `${rel} `}at ${clock(iso, zone)}`;
}

/** A local date for a deadline: "Sat 4 Oct". */
export const dateOf = (iso: string, zone: string, now: Date = new Date()) =>
  dayName(wall(zone, new Date(iso)).day, now, zone);

/** "40 s", "12 min", "1 h 4 min". Null when there is nothing to measure. */
export function duration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
}

/* ------------------------------------------------------------------ lists */

/** "a.com, b.com, +22 more". */
export function someOf(names: string[], show = 3): string {
  if (names.length <= show + 1) return names.join(", ");
  return `${names.slice(0, show).join(", ")}, +${names.length - show} more`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`);

/* ----------------------------------------------------------------- errors */

/**
 * A failure's cause in the owner's words, where the cause is one this box
 * knows. `known: false` means the text is the raw reason, shortened, and the
 * caller should put it on its own last line rather than in the headline.
 *
 * ORDER MATTERS: the unreachable-machine line is checked before the generic
 * "connection" one, because "Hermes stopped mid-answer — Local · Dell 5820
 * could not be reached" is both, and the useful answer is which machine.
 */
export function plainCause(raw: string | null | undefined): { text: string; known: boolean } {
  const s = (raw ?? "").trim();
  if (!s) return { text: "it stopped without saying why", known: true };
  const machine = /Could not reach (?:Local · )?([^(]+?) \(/i.exec(s)?.[1] ?? /(?:Local · )?([\w .-]+?) could not be reached/i.exec(s)?.[1];
  if (machine) {
    const name = machine.replace(/^Local · /, "").trim();
    return { text: `couldn't reach ${name}, it may be switched off`, known: true };
  }
  if (/interrupted by a restart/i.test(s)) return { text: "it was cut off when OPC restarted", known: true };
  const limit = /runtime limit|(\d[\d,]*)-second/i.test(s) && /ran out of time/i.test(s)
    ? /(\d[\d,]*)-second/.exec(s)?.[1]
    : null;
  if (limit) {
    const secs = Number(limit.replace(/,/g, ""));
    return { text: `it hit its ${duration(secs * 1000)} time limit (what it wrote so far is kept)`, known: true };
  }
  if (/still writing after (\d+) minutes/i.test(s))
    return { text: `the model was still writing after ${/after (\d+) minutes/i.exec(s)![1]} minutes, so it was stopped`, known: true };
  if (/stopped sending anything for (\d+) seconds/i.test(s)) return { text: "the model went silent mid-answer", known: true };
  if (/Connection error|ECONNRESET|socket hang up/i.test(s)) return { text: "the connection to the model dropped mid-answer", known: true };
  if (/stream was cancelled/i.test(s)) return { text: "it was cancelled part-way", known: true };
  const slow = /^(.+?) did not answer within (\d+) seconds/i.exec(s);
  if (slow) return { text: `${slow[1]} didn't answer within ${duration(Number(slow[2]) * 1000)}`, known: true };
  return { text: clip(s.replace(/\s+/g, " "), 160), known: false };
}

/* ------------------------------------------------------------------ links */

/** True for a link that only works at home: a LAN address or localhost. */
export function lanOnly(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|[\w-]+\.local$)/.test(host) || !host.includes(".");
  } catch {
    return true;
  }
}
