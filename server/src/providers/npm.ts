/**
 * npm downloads.
 *
 * NO CREDENTIAL, AND THEREFORE NO ACCOUNT. `api.npmjs.org/downloads` is public
 * and unauthenticated, so there is nothing to seal in the vault and nothing to
 * verify before storing. What npm needs instead is a LIST: which packages are
 * mine. That is configuration rather than a secret — public by design, shown
 * in full — and it lives in `plugin_config`, which exists for exactly this.
 *
 * IT IS "DOWNLOADS", NEVER "INSTALLS". npm's counter is HTTP tarball fetches:
 * a CI job that installs on every push, a Docker layer rebuild, a mirror
 * warming its cache and a person typing `npm i -g` are one download each and
 * npm cannot tell them apart. Calling that "installs" would put a number on
 * the top of a funnel that is wrong in an unknown direction, and every
 * conversion rate computed from it would inherit the error. So: downloads,
 * labelled downloads, everywhere — the word is load-bearing and this file's
 * callers keep it.
 *
 * The same honesty applies to SPIKES. A release week pulls mirrors and CI; the
 * week one package launched reads 1,738 against a floor nearer 45. This
 * reports weeks raw and editorialises none of them.
 *
 * WEEKS ARE ISO, MONDAY TO SUNDAY. npm's own `last-week` endpoint returns a
 * ROLLING window ending yesterday, which is why npmjs.com can show 188 for a
 * week this bucket calls 178 — same downloads, different seven days. The daily
 * series is fetched and re-bucketed here so that every weekly figure on the
 * dashboard means the same seven days as every other one.
 *
 * WHAT IT READS, and nothing else:
 *   GET /downloads/range/{start}:{end}/{package}   the daily series
 *   GET /downloads/range/last-month/{package}      the same, fixed 30 days
 *   GET registry.npmjs.org/-/v1/search             who publishes what, on demand
 */

const DOWNLOADS = "https://api.npmjs.org";
const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 20_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/** How far back a collection asks. npm serves the daily series for years, but
 *  the dashboard reads weeks and nine of them is a quarter — long enough for a
 *  launch spike to be visibly behind you rather than the whole chart. */
export const WEEKS = 9;

export type DayPoint = { day: string; downloads: number };

export type Series = {
  package: string;
  /** Which endpoint answered — the range, or the 30-day fallback. Published
   *  because five weeks of data and nine weeks of data are different answers
   *  and a chart that shortened overnight should be able to say why. */
  endpoint: "range" | "last-month";
  /** The range npm actually ANSWERED with, which is not always the one asked
   *  for: a package published three weeks ago is served a shorter one. Every
   *  "is this week complete" judgement is made against these, never against
   *  the request. */
  start: string;
  end: string;
  days: DayPoint[];
};

/* ------------------------------------------------------------------ dates */

export const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The Monday of a day's ISO week, in UTC. The one bucketing rule here. */
export function monday(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  // getUTCDay is 0 for Sunday, which is the END of an ISO week, not its start.
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return iso(d);
}

/**
 * The ISO-8601 week label of a day — "2026-W35".
 *
 * ISO's own rule, not `%Y-%W`: the week containing the year's first Thursday
 * is week one, so Monday 29 December 2025 is 2026-W01. A naive year-plus-week
 * would call it week 52 of 2025 and put it before the previous fifty-one on
 * any axis sorted by label.
 */
export function isoWeek(day: string): string {
  const d = new Date(`${monday(day)}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(`${monday(iso(jan4))}T00:00:00Z`);
  const week = Math.round((d.getTime() - firstMonday.getTime()) / 604_800_000) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The [start, end] a collection asks for: `weeks` ISO weeks ending with the
 *  one in progress. The end is TODAY, because npm has no figures for the
 *  future and an end date past today would make the current week look
 *  finished when it is not. */
export function window(weeks = WEEKS, today = new Date()): { start: string; end: string } {
  const end = iso(today);
  const first = new Date(`${monday(end)}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() - (weeks - 1) * 7);
  return { start: iso(first), end };
}

/* ------------------------------------------------------------------- http */

async function get<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new Error(
      name === "TimeoutError"
        ? "npm did not answer within 20 seconds"
        : `could not reach npm (${name})`,
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

type RawRange = {
  start?: string;
  end?: string;
  package?: string;
  downloads?: { day?: string; downloads?: number }[];
};

function shape(pkg: string, raw: RawRange, endpoint: Series["endpoint"]): Series {
  const days: DayPoint[] = [];
  for (const row of raw.downloads ?? []) {
    if (typeof row.day !== "string") continue;
    const n = Number(row.downloads ?? 0);
    days.push({ day: row.day, downloads: Number.isFinite(n) ? n : 0 });
  }
  days.sort((a, b) => a.day.localeCompare(b.day));
  return {
    package: pkg,
    endpoint,
    start: raw.start ?? days[0]?.day ?? "",
    end: raw.end ?? days[days.length - 1]?.day ?? "",
    days,
  };
}

/**
 * A package name npm will actually route to.
 *
 * A SCOPED NAME KEEPS ITS SLASH. npm's router matches
 * `/downloads/range/{range}/{scope}/{name}` and a percent-encoded slash 404s,
 * so the range is encoded and the package deliberately is not — which is only
 * safe because the name is checked against npm's own grammar first. Anything
 * that is not a package name never reaches a URL.
 */
export function validName(name: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) && name.length <= 214;
}

/** The configured list, from one text field. Commas or newlines, because both
 *  are what a person pastes, and a name that is not one is dropped here rather
 *  than becoming a 404 on every run. */
export function parsePackages(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const name = part.trim();
    if (name && validName(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * One package's daily series.
 *
 * The 30-day fallback is npm's own fixed window and is what npmjs.com uses. It
 * fills five weeks rather than nine, so the older weeks keep whatever the
 * previous runs already wrote — which is the whole reason the daily figures
 * are stored per day rather than as a computed weekly total.
 */
export async function daily(
  pkg: string,
  start: string,
  end: string,
): Promise<Series> {
  if (!validName(pkg)) throw new Error(`"${pkg}" is not an npm package name`);
  const range = encodeURIComponent(`${start}:${end}`);
  try {
    return shape(pkg, await get<RawRange>(`${DOWNLOADS}/downloads/range/${range}/${pkg}`), "range");
  } catch (err) {
    // Not swallowed: if the fallback fails too, its error is what the caller
    // sees, because that is the one that means npm is actually unreachable.
    try {
      return shape(
        pkg,
        await get<RawRange>(`${DOWNLOADS}/downloads/range/last-month/${pkg}`),
        "last-month",
      );
    } catch {
      throw err;
    }
  }
}

/**
 * What npm says this maintainer publishes.
 *
 * A DISCOVERY HELPER, NOT A SOURCE OF TRUTH. It exists so the owner can fill
 * the package list without typing names from memory, and the collector never
 * calls it: a list that grows itself is a chart whose baseline moves without
 * anybody deciding it should, and an unrelated package that happens to share a
 * maintainer would arrive as a jump in "my downloads". The owner accepts the
 * names; this only offers them.
 */
export async function publishedBy(
  maintainer: string,
): Promise<{ name: string; version: string | null; updatedAt: string | null }[]> {
  const q = encodeURIComponent(`maintainer:${maintainer}`);
  const doc = await get<{
    objects?: { package?: { name?: string; version?: string; date?: string } }[];
  }>(`${REGISTRY}/-/v1/search?text=${q}&size=100`);
  const out: { name: string; version: string | null; updatedAt: string | null }[] = [];
  for (const o of doc.objects ?? []) {
    const name = o.package?.name;
    if (!name) continue;
    out.push({
      name,
      version: o.package?.version ?? null,
      updatedAt: o.package?.date ?? null,
    });
  }
  return out;
}
