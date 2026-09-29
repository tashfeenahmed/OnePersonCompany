/**
 * WHAT THE DEVELOPMENT BOARD NEEDED THAT THE GITHUB COLLECTOR NEVER KEPT.
 *
 * The collector reads today's star count and a fortnight of traffic. That
 * answers "how many" and never "when" — a board with 29,751 stars on it could
 * not say whether a thousand of them arrived yesterday. Two reads fill that in:
 *
 *   STARS BY DAY, from the stargazers API's own timestamps
 *   (`application/vnd.github.star+json`). Walked from the LAST page backwards,
 *   because the newest stars are at the end, and stopped as soon as a page
 *   reaches a day already stored — so the first run backfills ninety days and
 *   every later run costs a page or two. Days are rewritten whole from the
 *   stop point forward, so a star that was later removed drops out.
 *
 *   RELEASE DOWNLOADS, from each release's asset `download_count` — the one
 *   GitHub figure that counts a person fetching a build (the desktop app's
 *   installers) rather than a page view. A per-day snapshot of each repo's
 *   running total turns it into downloads per day from here on.
 *
 * Runs on the traffic cadence (every six hours) and stops early when the
 * account's rate limit runs low: the traffic reads matter more.
 */
import { db } from "../db.ts";
import { tokenAccounts } from "./github.ts";

const API = "https://api.github.com";
const BACKFILL_DAYS = 90;
const MAX_PAGES = 200;
const MIN_STARS = 5;
const RESERVE = 600;

type Got<T> = { body: T; link: string | null; remaining: number | null };

async function get<T>(path: string, token: string, accept = "application/vnd.github+json"): Promise<Got<T>> {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: accept, Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "OnePersonCompany/0.1 (+insights)" },
    signal: AbortSignal.timeout(20_000),
  });
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return { body: (await res.json()) as T, link: res.headers.get("link"), remaining: remaining === null ? null : Number(remaining) };
}

const lastPage = (link: string | null): number => {
  const m = link ? /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link) : null;
  return m ? Number(m[1]) : 1;
};
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

let running = false;

export async function collectInsights(): Promise<{ stars: number; releases: number; note: string }> {
  if (running) return { stars: 0, releases: 0, note: "already running" };
  running = true;
  try {
    const pair = tokenAccounts("collect_github")[0];
    if (!pair) return { stars: 0, releases: 0, note: "no GitHub account" };
    const token = pair.token;
    let remaining = Infinity;
    const spend = (r: number | null) => { if (r !== null) remaining = r; };
    const repos = db
      .prepare("SELECT full_name, stars FROM github_repos WHERE fork = 0 AND archived = 0 ORDER BY stars DESC")
      .all() as { full_name: string; stars: number }[];

    /* ---- stars by day */
    let starRepos = 0;
    const newest = db.prepare("SELECT MAX(day) d FROM github_star_days WHERE full_name = ?");
    const clear = db.prepare("DELETE FROM github_star_days WHERE full_name = ? AND day >= ?");
    const put = db.prepare("INSERT INTO github_star_days (full_name, day, n) VALUES (?,?,?)");
    const mark = db.prepare(
      `INSERT INTO github_star_state (full_name, covered_from, synced_at) VALUES (?,?,?)
       ON CONFLICT (full_name) DO UPDATE SET covered_from = MIN(covered_from, excluded.covered_from), synced_at = excluded.synced_at`,
    );
    for (const r of repos.filter((x) => x.stars >= MIN_STARS)) {
      if (remaining < RESERVE) break;
      const have = (newest.get(r.full_name) as { d: string | null }).d;
      /* Re-read from the day before the newest stored one, so a day that was
         still filling at the last run is completed. */
      const from = have ? new Date(Date.parse(`${have}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : daysAgo(BACKFILL_DAYS);
      try {
        const first = await get<{ starred_at: string }[]>(`/repos/${r.full_name}/stargazers?per_page=100&page=1`, token, "application/vnd.github.star+json");
        spend(first.remaining);
        const last = lastPage(first.link);
        const counts = new Map<string, number>();
        let reached = false;
        let lowest = last + 1;
        for (let page = last, n = 0; page >= 1 && n < MAX_PAGES && remaining >= RESERVE; page--, n++) {
          lowest = page;
          const got = page === 1 ? first : await get<{ starred_at: string }[]>(`/repos/${r.full_name}/stargazers?per_page=100&page=${page}`, token, "application/vnd.github.star+json");
          spend(got.remaining);
          for (const s of got.body) {
            const day = s.starred_at?.slice(0, 10);
            if (!day) continue;
            if (day < from) { reached = true; continue; }
            counts.set(day, (counts.get(day) ?? 0) + 1);
          }
          if (reached) break;
        }
        /* Only a walk that reached `from` (or the first page) covers every
           day since; anything short is left for the next run to finish. */
        if (!reached && lowest !== 1) continue;
        db.exec("BEGIN");
        try {
          clear.run(r.full_name, from);
          for (const [day, n] of counts) put.run(r.full_name, day, n);
          mark.run(r.full_name, from, new Date().toISOString());
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        starRepos++;
      } catch {
        /* one repo refusing (a private repo the token cannot list) is its own */
      }
    }

    /* ---- release downloads */
    let releaseRepos = 0;
    const delRel = db.prepare("DELETE FROM github_releases WHERE full_name = ?");
    const putRel = db.prepare(
      "INSERT INTO github_releases (full_name, tag, name, published_at, asset, downloads, seen_at) VALUES (?,?,?,?,?,?,?)",
    );
    const putDay = db.prepare(
      `INSERT INTO github_release_days (full_name, day, downloads) VALUES (?,?,?)
       ON CONFLICT (full_name, day) DO UPDATE SET downloads = excluded.downloads`,
    );
    for (const r of repos) {
      if (remaining < RESERVE) break;
      try {
        const got = await get<{ tag_name: string; name: string | null; published_at: string | null; draft: boolean; assets: { name: string; download_count: number }[] }[]>(
          `/repos/${r.full_name}/releases?per_page=100`,
          token,
        );
        spend(got.remaining);
        const releases = got.body.filter((x) => !x.draft);
        if (!releases.length) continue;
        const seen = new Date().toISOString();
        let total = 0;
        db.exec("BEGIN");
        try {
          delRel.run(r.full_name);
          for (const rel of releases) {
            if (!rel.assets.length) putRel.run(r.full_name, rel.tag_name, rel.name, rel.published_at, "", 0, seen);
            for (const a of rel.assets) {
              putRel.run(r.full_name, rel.tag_name, rel.name, rel.published_at, a.name, a.download_count, seen);
              total += a.download_count;
            }
          }
          putDay.run(r.full_name, today(), total);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        releaseRepos++;
      } catch {
        /* a repo with releases disabled answers 404; nothing to keep */
      }
    }
    return { stars: starRepos, releases: releaseRepos, note: `stars for ${starRepos} repos, releases for ${releaseRepos}` };
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------ read */

/** A release asset's platform, from its file name. */
function platformOf(asset: string): string {
  const a = asset.toLowerCase();
  if (/\.(dmg|pkg)$|mac|darwin|osx/.test(a)) return "macOS";
  if (/\.(exe|msi)$|win/.test(a)) return "Windows";
  if (/\.(appimage|deb|rpm|snap)$|linux/.test(a)) return "Linux";
  if (/\.(apk|aab)$|android/.test(a)) return "Android";
  if (/\.(yml|yaml|blockmap|sig|sha256|txt|json)$/.test(a)) return "Update metadata";
  return "Other";
}

export function insightsDoc(days: number) {
  const from = daysAgo(days);
  const starDays = db
    .prepare("SELECT full_name repo, day, n FROM github_star_days WHERE day >= ? ORDER BY day")
    .all(from) as { repo: string; day: string; n: number }[];
  const starCoverage = db.prepare("SELECT full_name repo, covered_from, synced_at FROM github_star_state").all() as {
    repo: string; covered_from: string; synced_at: string;
  }[];
  const rows = db
    .prepare("SELECT full_name repo, tag, name, published_at, asset, downloads FROM github_releases ORDER BY published_at DESC")
    .all() as { repo: string; tag: string; name: string | null; published_at: string | null; asset: string; downloads: number }[];
  const releases = new Map<string, { repo: string; tag: string; name: string | null; publishedAt: string | null; downloads: number; assets: { name: string; downloads: number; platform: string }[] }>();
  for (const r of rows) {
    const k = `${r.repo}@${r.tag}`;
    const rel = releases.get(k) ?? { repo: r.repo, tag: r.tag, name: r.name, publishedAt: r.published_at, downloads: 0, assets: [] };
    if (r.asset) {
      rel.assets.push({ name: r.asset, downloads: r.downloads, platform: platformOf(r.asset) });
      rel.downloads += r.downloads;
    }
    releases.set(k, rel);
  }
  const releaseDays = db
    .prepare("SELECT full_name repo, day, downloads FROM github_release_days WHERE day >= ? ORDER BY day")
    .all(daysAgo(days + 1)) as { repo: string; day: string; downloads: number }[];
  const repoTraffic = db
    .prepare(
      `SELECT full_name repo, day,
              SUM(CASE WHEN metric = 'views' THEN value ELSE 0 END) views,
              SUM(CASE WHEN metric = 'uniques' THEN value ELSE 0 END) uniques,
              SUM(CASE WHEN metric = 'clones' THEN value ELSE 0 END) clones
         FROM github_traffic WHERE day >= ? GROUP BY full_name, day ORDER BY day`,
    )
    .all(from) as { repo: string; day: string; views: number; uniques: number; clones: number }[];
  return {
    window: { days, from, to: today() },
    generatedAt: new Date().toISOString(),
    starDays,
    starCoverage,
    releases: [...releases.values()],
    releaseDays,
    repoTraffic,
  };
}
