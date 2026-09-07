/**
 * EVERY WAY A NUMBER OR A TIME GETS WRITTEN ON THIS CLIENT, IN ONE PLACE.
 *
 * WRITE A LOCAL FORMATTER AND IT WILL DISAGREE WITH THIS ONE, silently. Every
 * function below has a convention that a plausible second implementation gets
 * differently — whether `pct` takes a fraction or a scaled percent, whether a
 * duration is seconds or milliseconds, whether days start at 24 hours or 48,
 * whether a missing date is "never" or a dash, whether bytes are base 1024 or
 * base 1000. None of those is a type error. All of them are wrong answers on
 * the page, and each function's own note below says which way it went.
 *
 * NOTHING HERE INVENTS A VALUE. Every function takes null, undefined and NaN
 * and returns the em dash, because a missing figure means the server was asked
 * and could not tell — a bounce rate over no visits, a renewal with no price
 * because no registrar API publishes one, a load average from a box that did
 * not answer. Drawing one of those as "0" would put a measurement on the page
 * that nobody made, which is the single thing this codebase is arranged around
 * not doing.
 *
 * A caller whose missing value has a MEANING — a backup that has genuinely
 * never run, a run that has not finished — passes that word as `nullText`. It
 * is never a zero, and it is never guessed here.
 *
 * NO IMPORTS, EVER. A leaf with no dependencies cannot be in a module cycle,
 * and "importing it would have made a cycle" is the reason a formatter gets
 * copied somewhere else instead. Keep this file importing nothing.
 */

/** The one character a value nobody measured is drawn as. */
export const DASH = "—";

/** What every formatter here does with a value that is not a number.
 *  `nullText` is for a caller whose absence means something sayable. */
export type Absent = { nullText?: string };

type Maybe = number | null | undefined;

/** null, undefined, NaN and ±Infinity are all "the server could not tell". A
 *  NaN reaching a page as "NaN%" is the same failure as a null reaching it as
 *  "0%": a figure on the screen that no measurement stands behind. */
function absent(n: Maybe): n is null | undefined {
  return n === null || n === undefined || !Number.isFinite(n);
}

/* ------------------------------------------------------------- proportion */

/**
 * A proportion, AS A 0–1 FRACTION, ALWAYS.
 *
 * `pct(0.4)` is "40%". There is no second convention and there must never be
 * one: the three functions this replaces shared a signature `(number) =>
 * string` and disagreed about their input, so an editor's auto-import decided
 * which of two answers a page showed and nothing could catch it — on pages
 * whose whole premise is not misreporting figures.
 *
 * A caller holding a percent the server already scaled divides at the call
 * site: `pct(row.bounceRate / 100)`. That division is visible in review; an
 * import is not.
 *
 * One decimal, with a trailing ".0" dropped, because that is the precision
 * these documents actually carry — 3.14 → "3.1%", 40 → "40%".
 */
export function pct(fraction: Maybe, opts: Absent & { digits?: number } = {}): string {
  if (absent(fraction)) return opts.nullText ?? DASH;
  const digits = opts.digits ?? 1;
  return `${(fraction * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

/* --------------------------------------------------------------- duration */

/**
 * HOW LONG SOMETHING TOOK, FROM MILLISECONDS, in the largest unit still honest.
 *
 * Milliseconds because that is what the runs table stores. The seconds one is
 * `durationS`, NAMED APART rather than overloaded — two exports called
 * `duration` a factor of 1000 apart is a wrong import the compiler has nothing
 * to say about, and a four-second run drawn as "1h 6m".
 *
 * A run that has not finished HAS NO DURATION, and the callers that draw one
 * pass `{ nullText: "still going" }` rather than letting this file invent a
 * "0.0s" beside a report that is still being written.
 */
export function duration(ms: Maybe, opts: Absent = {}): string {
  if (absent(ms) || ms < 0) return opts.nullText ?? DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return m < 60 ? `${m}m ${rest}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * A SPAN, FROM SECONDS, at the coarseness a span is read at.
 *
 * Deliberately not `duration(seconds * 1000)`. These are average visit lengths
 * and box uptimes, where a tenth of a second is noise and "36h" is the answer
 * somebody wants — not "36h 0m". Days start at 48h here, and only here,
 * because two days of uptime is still read in hours by the person deciding
 * whether a box was rebooted.
 */
export function durationS(seconds: Maybe, opts: Absent = {}): string {
  if (absent(seconds) || seconds < 0) return opts.nullText ?? DASH;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/* ------------------------------------------------------------------ times */

/** Milliseconds since the epoch out of whatever a caller is holding, or null.
 *  Both forms are in use: routes answer with ISO strings, the mail tables
 *  carry epoch milliseconds. */
function at(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A TIMESTAMP AS AN AGE: "4m ago", "6h ago", "3d ago".
 *
 * A collected-at stamp is only useful as an age — nobody reads a panel to find
 * out that Hetzner was polled at 14:02.
 *
 * DAYS START AT 24 HOURS, not 48 — the switch that makes one reading say
 * "36h ago" on the deployment panel and "2d ago" on the integrations panel.
 * 24 is the one that agrees with what "yesterday" means.
 *
 * A missing stamp is "never" rather than a dash: unlike a measurement, a
 * timestamp's absence has a plain meaning — this has not happened. A caller
 * where absence means "not recorded" instead passes `{ nullText: "—" }`.
 * A stamp that will not parse is the dash, because a string that is not a date
 * has no age and "never" would be a claim about it.
 */
export function ago(
  value: string | number | Date | null | undefined,
  opts: Absent = {},
): string {
  const ms = at(value);
  if (ms === null) return value === null || value === undefined || value === "" ? (opts.nullText ?? "never") : DASH;
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * A TIMESTAMP AS A DATE: "12 Sep, 14:02".
 *
 * MISSING IS THE DASH, not "never". The dash is the one that cannot be false:
 * a null `publishedAt` on a draft does not mean the draft will never be
 * published. A surface where absence really does mean never-happened — a
 * backup, a scan, a deploy — passes `{ nullText: "never" }` and says so on
 * purpose.
 *
 * A string that will not parse is ECHOED rather than drawn as "Invalid Date".
 * Showing the raw value is what lets somebody see WHICH field is malformed.
 */
export function when(
  value: string | number | Date | null | undefined,
  opts: Absent & { year?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return opts.nullText ?? DASH;
  const ms = at(value);
  if (ms === null) return String(value);
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(opts.year ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A CLOCK WITH NO DATE ON IT: "14:02".
 *
 * The other half of `when`, for a row that sits under a heading which already
 * says the day — the sub-agent rail groups runs by date, and "5 Sep, 14:02" on
 * every row under "5 Sep" is the date three times a screen. Missing is the
 * dash, for `when`'s reason; a string that will not parse is echoed.
 */
export function clock(
  value: string | number | Date | null | undefined,
  opts: Absent = {},
): string {
  if (value === null || value === undefined || value === "") return opts.nullText ?? DASH;
  const ms = at(value);
  if (ms === null) return String(value);
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * A DATE WITH NO CLOCK ON IT: "5 Sep".
 *
 * `when` always appends a time, which is right for a stamp and wrong for the
 * eleven surfaces that carry a DAY — a card's due date, a deadline, a signup
 * date, a mail list column. All eleven had written their own
 * `toLocaleDateString` rather than print "5 Sep, 00:00" beside a date nobody
 * recorded an hour for, and they had drifted into four different shapes.
 *
 * A BARE `YYYY-MM-DD` IS READ IN UTC, and that is the bug this closes rather
 * than a preference. `Date.parse("2026-09-05")` is midnight UTC, so anywhere
 * west of Greenwich the reader's own zone drew the day before — a card due on
 * the 5th listed as due on the 4th. A caller holding an INSTANT that is
 * nonetheless a UTC day — a deadline the server counted days against — asks
 * for the same treatment with `{ utc: true }`, so the page and the server
 * agree about which day it is.
 *
 * `long` is the section-heading shape, "Friday, 5 September": a date drawn as
 * a separator between groups is read at a glance and wants the weekday.
 */
export function day(
  value: string | number | Date | null | undefined,
  opts: Absent & { year?: boolean | "2-digit"; long?: boolean; utc?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return opts.nullText ?? DASH;
  const dayKey = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = at(dayKey ? `${value}T00:00:00Z` : value);
  if (ms === null) return String(value);
  return new Date(ms).toLocaleDateString(undefined, {
    ...(opts.long ? { weekday: "long" as const } : {}),
    day: "numeric",
    month: opts.long ? ("long" as const) : ("short" as const),
    ...(opts.year ? { year: opts.year === "2-digit" ? ("2-digit" as const) : ("numeric" as const) } : {}),
    ...(dayKey || opts.utc ? { timeZone: "UTC" } : {}),
  });
}

/**
 * A DISTANCE IN DAYS: "today", "in 41d", "in 8mo", "12d ago".
 *
 * A renewal date's whole value is the distance to it. Past dates say "ago" in
 * words rather than carrying a minus sign that is easy to skim over, and long
 * distances round up to months and years because "in 412d" is a number nobody
 * converts.
 */
export function inDays(days: Maybe, opts: Absent = {}): string {
  if (absent(days)) return opts.nullText ?? DASH;
  const n = Math.round(days);
  if (n === 0) return "today";
  if (n < 0) return `${Math.abs(n)}d ago`;
  if (n < 45) return `in ${n}d`;
  if (n < 400) return `in ${Math.round(n / 30.44)}mo`;
  return `in ${(n / 365.25).toFixed(1)}y`;
}

/* ------------------------------------------------------------------ money */

/**
 * AN AMOUNT IN THE CURRENCY IT WAS ACTUALLY EARNED OR SPENT IN.
 *
 * Never converted, and never given a symbol chosen by the reader's locale:
 * A$11.58 and $11.58 are different amounts of money, and this box holds both.
 * The en-GB default is deliberate for exactly that reason — it renders US
 * dollars as "US$" rather than a bare "$" that also reads as Canadian and
 * Australian dollars on the same page.
 *
 * TWO DECIMAL PLACES BY DEFAULT, INCLUDING ABOVE A THOUSAND. Dropping the
 * cents at ≥1000 is the easy variation, and it makes one Stripe payout read
 * "€1,240" on one screen and "€1,240.37" on the next. An invoice has cents; a
 * headline tile that genuinely wants them gone passes `{ digits: 0 }` and owns
 * the rounding.
 *
 * THE try/catch IS LOAD-BEARING. `Intl` throws a RangeError on a currency code
 * that is not three letters, and a code it simply does not recognise is still a
 * real currency somebody was really paid in. Better the code beside the number
 * than nothing, or a symbol invented for it.
 */
export function money(
  n: Maybe,
  currency: string,
  opts: Absent & { digits?: number; locale?: string } = {},
): string {
  if (absent(n)) return opts.nullText ?? DASH;
  const digits = opts.digits ?? 2;
  const locale = opts.locale ?? "en-GB";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `${n.toLocaleString(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} ${currency.toUpperCase()}`;
  }
}

/* ------------------------------------------------------------------ sizes */

/**
 * BYTES AS THE UNIT A PERSON WOULD SAY.
 *
 * POWERS OF 1024 BY DEFAULT, because every source of these figures on this box
 * — free(1), df(1), the hypervisor, the backup tool — counts that way, and a
 * page that divides by 1000 reports a disk 7% emptier than the tool the owner
 * would run to check it. One 5,368,709,120-byte disk is "5.0 GB" or "5.4 GB"
 * depending purely on that choice, with nothing on the page to say which.
 *
 * THE CASING IS THE CLUE, and it is kept on purpose: base 1024 writes "KB",
 * base 1000 writes "kB". A caller reporting a figure a vendor states in base
 * 1000 — an object-store bill, a CDN's egress — passes `{ base: 1000 }` and is
 * legible as having done so.
 */
export function bytes(
  n: Maybe,
  opts: Absent & { base?: 1000 | 1024 } = {},
): string {
  if (absent(n)) return opts.nullText ?? DASH;
  const base = opts.base ?? 1024;
  const units = base === 1024 ? ["B", "KB", "MB", "GB", "TB", "PB"] : ["B", "kB", "MB", "GB", "TB", "PB"];
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i += 1;
  }
  const rounded = v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${sign}${rounded} ${units[i]}`;
}

/* ----------------------------------------------------------------- counts */

/**
 * A WHOLE NUMBER WITH SEPARATORS. 9479 is a number; 9,479 is a figure.
 *
 * NO DECIMALS, EVER. These are counts — views, posts, followers, rows — and
 * half a view is not a thing; printing "155,722.0" would suggest it might be.
 */
export function count(n: Maybe, opts: Absent = {}): string {
  if (absent(n)) return opts.nullText ?? DASH;
  return new Intl.NumberFormat("en-GB").format(Math.round(n));
}

/**
 * A COUNT SHORTENED FOR A TILE: "1.5M", "820k", "2.1B".
 *
 * Token counts and impression counts run to nine digits and mean nothing at
 * that length. One casing — capital M and B, lower-case k — because 1,500,000
 * was rendering as "1.5M" in one widget, "1.5m" in another and "1,500,000" in
 * a third, and a reader comparing two tiles should not have to work out
 * whether they are the same magnitude.
 *
 * Nothing is shortened below ten thousand: "9.5k" hides a difference that
 * "9,512" shows, and at that width there is room for it.
 */
export function compact(n: Maybe, opts: Absent = {}): string {
  if (absent(n)) return opts.nullText ?? DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const trim = (s: string) => s.replace(/\.0$/, "");
  if (abs >= 1e9) return `${sign}${trim((abs / 1e9).toFixed(1))}B`;
  if (abs >= 1e6) return `${sign}${trim((abs / 1e6).toFixed(1))}M`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  return count(n);
}
