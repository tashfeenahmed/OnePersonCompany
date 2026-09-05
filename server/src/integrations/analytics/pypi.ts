/**
 * PyPI downloads — npm's shape, one registry across.
 *
 * NO CREDENTIAL, AND THEREFORE NO ACCOUNT. Both services this reads are public
 * and unauthenticated, so there is nothing to seal in the vault and nothing to
 * verify before storing. What it needs instead is a LIST: which packages are
 * mine. That is configuration rather than a secret — public by design, shown
 * in full, readable back so a typo can be corrected — and it lives in
 * `plugin_config`, which exists for exactly this. "Connected" therefore means
 * "there is a list to collect", the same reading providers/npm.ts documents.
 *
 * IT IS DOWNLOADS, NEVER INSTALLS, and here the word carries even more than it
 * does for npm. PyPI's own counter is derived from CDN logs in BigQuery, and
 * `pypistats.org` is a public mirror of that dataset. A CI job installing on
 * every push, a Docker layer rebuild and a person typing `pip install` are one
 * download each and nothing can tell them apart. Every field below is named
 * `downloads` and every document above it says the same word.
 *
 * MIRRORS ARE EXCLUDED, ALWAYS. `?mirrors=false` is sent on every overall
 * request, because a mirror warming its cache pulls every version of every
 * package and would put a step change in a chart on the day somebody in
 * another country stood one up. That is a decision, not a default, and it is
 * on the wire in the route's own note so a figure here can be reconciled with
 * one from anywhere else.
 *
 * TWO SERVICES, TWO FAILURE STATES, KEPT APART. pypistats answers the
 * downloads; pypi.org answers what the package IS. They are different hosts
 * with different outages, so each keeps its own error on the row — a package
 * whose metadata 404s can still have downloads, and a brand-new package
 * pypistats has never heard of can still have a version and a summary.
 *
 * WHAT IT READS, and nothing else:
 *   GET pypistats.org/api/packages/{name}/recent            last day/week/month
 *   GET pypistats.org/api/packages/{name}/overall?mirrors=false   the daily line
 *   GET pypi.org/pypi/{name}/json                           version, summary, urls
 */

const STATS = "https://pypistats.org/api";
const REGISTRY = "https://pypi.org";
const TIMEOUT_MS = 25_000;
/** A User-Agent with a way to reach the person running it — the courtesy both
 *  of these services ask for in their own documentation, and the difference
 *  between being rate-limited politely and being blocked. */
const USER_AGENT = "onepersoncompany-collector/1.0 (+https://github.com/onepersoncompany)";

/** How much daily history the overall endpoint is asked for. pypistats serves
 *  about 180 days and no more; asking for more would be asking for a silence
 *  that reads as a gap. */
export const DAYS_HISTORY = 180;

export type DayPoint = { day: string; downloads: number };

export type Recent = {
  lastDay: number | null;
  lastWeek: number | null;
  lastMonth: number | null;
};

export type Meta = {
  version: string | null;
  summary: string | null;
  homePage: string | null;
  projectUrls: Record<string, string> | null;
};

/* ------------------------------------------------------------------ names */

/**
 * PEP 503: a name is letters, digits, and runs of `-`, `_` or `.` between
 * them.
 *
 * `normalise` is what actually goes in a URL and in the database, because PEP
 * 503 says `Foo.Bar_baz` and `foo-bar-baz` are THE SAME PACKAGE — pypistats
 * routes only the normalised form, and storing both spellings would report one
 * package as two with half its downloads each.
 */
export function validName(name: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) && name.length <= 214;
}

export function normalise(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** The configured list, from one text field. Commas or newlines, because both
 *  are what a person pastes; a name that is not one is dropped here rather
 *  than becoming a 404 on every run. Normalised and de-duplicated, so
 *  `Flask` and `flask` on two lines are one package. */
export function parsePackages(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const name = part.trim();
    if (!name || !validName(name)) continue;
    const key = normalise(name);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/* ------------------------------------------------------------------- http */

async function get<T>(url: string, what: string): Promise<T> {
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
        ? `${what} did not answer within ${TIMEOUT_MS / 1000} seconds`
        : `could not reach ${what} (${name})`,
    );
  }
  if (res.status === 404) throw new Error(`${what} has never heard of that package`);
  if (res.status === 429)
    throw new Error(`${what} is rate-limiting this box — the list is too long, or too often`);
  if (!res.ok) throw new Error(`${what} answered HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} answered ${res.status} with something that is not JSON`);
  }
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/* ---------------------------------------------------------------- readers */

/**
 * pypistats' own rolling windows.
 *
 * THEY END YESTERDAY, NOT ON A CALENDAR BOUNDARY, and they are stored as
 * answered rather than recomputed from the daily line — which is the whole
 * reason they are worth storing at all. `last_week` here and "this week" on
 * the route are different seven days, and the route says so beside them
 * instead of quietly presenting one as the other.
 */
export async function recent(pkg: string): Promise<Recent> {
  const doc = await get<{ data?: Record<string, unknown> }>(
    `${STATS}/packages/${encodeURIComponent(normalise(pkg))}/recent`,
    "pypistats",
  );
  return {
    lastDay: num(doc.data?.last_day),
    lastWeek: num(doc.data?.last_week),
    lastMonth: num(doc.data?.last_month),
  };
}

/**
 * The daily line, mirrors excluded.
 *
 * The endpoint returns one row per (category, date) and with `mirrors=false`
 * the only category is `without_mirrors` — but the rows are summed per day
 * rather than filtered, so a future category cannot silently vanish from the
 * total. A day pypistats has no row for is ABSENT rather than zero: there is a
 * difference between "nobody downloaded it" and "the dataset has not been
 * built for that day yet", and only the first is a fact about the package.
 */
export async function overall(pkg: string): Promise<DayPoint[]> {
  const doc = await get<{
    data?: { category?: string; date?: string; downloads?: number }[];
  }>(
    `${STATS}/packages/${encodeURIComponent(normalise(pkg))}/overall?mirrors=false`,
    "pypistats",
  );
  const perDay = new Map<string, number>();
  for (const row of doc.data ?? []) {
    if (typeof row.date !== "string") continue;
    const n = num(row.downloads);
    if (n === null) continue;
    perDay.set(row.date, (perDay.get(row.date) ?? 0) + n);
  }
  return [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-DAYS_HISTORY)
    .map(([day, downloads]) => ({ day, downloads }));
}

/**
 * What the package IS, from PyPI's own JSON.
 *
 * `home_page` is a field PyPI deprecated in favour of `project_urls`, and both
 * are read: a package published five years ago has the first and a package
 * published this year has the second. The route derives a HOST from whichever
 * is there, so a venture with that host can be linked to the package — see
 * the entities route.
 */
export async function meta(pkg: string): Promise<Meta> {
  const doc = await get<{
    info?: {
      version?: string;
      summary?: string;
      home_page?: string;
      project_urls?: Record<string, string>;
    };
  }>(`${REGISTRY}/pypi/${encodeURIComponent(normalise(pkg))}/json`, "pypi.org");
  const info = doc.info ?? {};
  return {
    version: info.version ?? null,
    summary: info.summary ?? null,
    homePage: info.home_page?.trim() || null,
    projectUrls:
      info.project_urls && typeof info.project_urls === "object"
        ? info.project_urls
        : null,
  };
}

/**
 * The hostname this package is obviously about, or null.
 *
 * `home_page` first, then the project_urls entries in the order a human would
 * read them — Homepage, then Documentation, then anything else — and a code
 * FORGE IS SKIPPED. github.com is where a hundred packages live and is about
 * none of them, so linking a package to a venture because both mention GitHub
 * would fill the ventures map with edges that mean nothing.
 */
const FORGES = new Set([
  "github.com", "www.github.com", "gitlab.com", "www.gitlab.com",
  "bitbucket.org", "codeberg.org", "sourceforge.net",
  "pypi.org", "readthedocs.io", "readthedocs.org",
]);

export function hostOf(m: { homePage: string | null; projectUrls: Record<string, string> | null }): string | null {
  const candidates: string[] = [];
  if (m.homePage) candidates.push(m.homePage);
  const urls = m.projectUrls ?? {};
  for (const key of ["Homepage", "Home", "homepage", "Website", "Documentation"])
    if (urls[key]) candidates.push(urls[key]!);
  for (const value of Object.values(urls)) candidates.push(value);

  for (const raw of candidates) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || FORGES.has(host) || host.endsWith(".readthedocs.io")) continue;
    return host;
  }
  return null;
}
