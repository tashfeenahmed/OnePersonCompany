/**
 * PyPI downloads, bucketed into weeks WHEN THEY ARE READ.
 *
 * `/api/npm`'s document, one registry across, and deliberately the same shape:
 * a person looking at both pages is comparing two registries, and two pages
 * that bucketed weeks differently would make that comparison quietly wrong.
 * The week rule is therefore identical — ISO, Monday to Sunday, partial weeks
 * marked and never drawn as complete ones — and it is restated here rather
 * than imported, because a shared helper across two areas is a dependency
 * neither area's brief allows.
 *
 * IT IS DOWNLOADS, NOT INSTALLS, AND THE WORD IS LOAD-BEARING. PyPI's counter
 * is CDN file requests. A CI job installing on every push, a Docker layer
 * rebuild and a person typing `pip install` are one download each and nothing
 * can tell them apart. Every field here is named `downloads`.
 *
 * MIRRORS ARE EXCLUDED. The collector always sends `?mirrors=false`, so these
 * figures are smaller than the ones pypistats shows by default and smaller
 * than PyPI's raw dataset. That is a decision — a mirror warming its cache is
 * not demand — and it is on the wire in `notes.mirrors` so a figure here can
 * be reconciled with one from anywhere else.
 *
 * pypistats' OWN `recent` WINDOWS ARE PUBLISHED BESIDE THE WEEKS AND NEVER
 * INSTEAD OF THEM. `last_week` there is a ROLLING seven days ending yesterday;
 * `lastCompleteWeek` here is Monday to Sunday. They disagree by design, both
 * are true, and each is labelled with what it is — the same care
 * `/api/npm` takes over npm's own `last-week`.
 *
 * A DAY pypistats HAS NO ROW FOR IS ABSENT, NOT ZERO. Its dataset is rebuilt
 * daily and the most recent day or two are often not there yet. An absent day
 * makes its week partial, which is exactly what it is.
 */
import { Hono } from "hono";
import { configValue } from "../../db.ts";
import { projectHost, parsePackages } from "./pypi.ts";
import { clockAt, pypiDaysSince, pypiPackages } from "./store.ts";

export const pypiRoutes = new Hono();

/** How much history the page reads. A quarter and a bit, which is what a
 *  weekly bar chart can show without the bars becoming hairlines. */
const DAYS = 120;

export type Week = {
  week: string;
  start: string;
  downloads: number;
  /** True when the seven days are not all in hand — the week in progress, a
   *  history that starts mid-week, or a day pypistats has not published. */
  partial: boolean;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The Monday of a day's ISO week, in UTC. */
function monday(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return iso(d);
}

/** ISO-8601's own week label — "2026-W35". The week containing the year's
 *  first Thursday is week one, so Monday 29 December 2025 is 2026-W01 and
 *  sorts after the fifty-one before it rather than before them. */
function isoWeek(day: string): string {
  const d = new Date(`${monday(day)}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(`${monday(iso(jan4))}T00:00:00Z`);
  const week = Math.round((d.getTime() - firstMonday.getTime()) / 604_800_000) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Days → ISO weeks, oldest first. `partial` is derived from the days
 *  actually HELD, not from the range that was asked for. */
export function weeksOf(days: { day: string; downloads: number }[]): Week[] {
  if (!days.length) return [];
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const from = sorted[0]!.day;
  const to = sorted.at(-1)!.day;

  const totals = new Map<string, { downloads: number; seen: number }>();
  for (const d of sorted) {
    const start = monday(d.day);
    const bucket = totals.get(start) ?? { downloads: 0, seen: 0 };
    bucket.downloads += d.downloads;
    bucket.seen += 1;
    totals.set(start, bucket);
  }

  return [...totals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, v]) => {
      const sunday = new Date(`${start}T00:00:00Z`);
      sunday.setUTCDate(sunday.getUTCDate() + 6);
      const end = iso(sunday);
      const full = start >= from && end <= to && v.seen === 7;
      return { week: isoWeek(start), start, downloads: v.downloads, partial: !full };
    });
}

pypiRoutes.get("/", (c) => {
  const configured = parsePackages(configValue("pypi", "packages"));
  const state = pypiPackages();
  const rows = pypiDaysSince(DAYS);

  const byPackage = new Map<string, { day: string; downloads: number }[]>();
  for (const r of rows) {
    const held = byPackage.get(r.package) ?? [];
    held.push({ day: r.day, downloads: r.downloads });
    byPackage.set(r.package, held);
  }

  const packages = configured.map((name) => {
    const days = byPackage.get(name) ?? [];
    const weeks = weeksOf(days);
    const complete = weeks.filter((w) => !w.partial);
    const s = state.find((x) => x.package === name);
    let projectUrls: Record<string, string> | null = null;
    try {
      projectUrls = s?.project_urls ? (JSON.parse(s.project_urls) as Record<string, string>) : null;
    } catch {
      projectUrls = null;
    }
    return {
      package: name,
      /** The stable key `venture_links` points at. See `/entities`. */
      entity: name,
      version: s?.version ?? null,
      summary: s?.summary ?? null,
      homePage: s?.home_page ?? null,
      projectUrls,
      host: projectHost({ homePage: s?.home_page ?? null, projectUrls }),
      lastError: s?.last_error ?? null,
      lastOkAt: s?.last_ok_at ?? null,
      historyReadAt: clockAt("pypi", name),
      /** pypistats' OWN rolling windows, ending yesterday. Never a calendar
       *  week and never compared with `lastCompleteWeek` below. */
      recent: {
        lastDay: s?.last_day ?? null,
        lastWeek: s?.last_week ?? null,
        lastMonth: s?.last_month ?? null,
        at: s?.recent_at ?? null,
        basis: "pypistats' own rolling windows, ending yesterday — not calendar weeks",
      },
      weeks,
      days,
      lastCompleteWeek: complete.at(-1) ?? null,
      currentWeek: weeks.at(-1)?.partial ? weeks.at(-1)! : null,
      last30: days.slice(-30).reduce((n, d) => n + d.downloads, 0),
      total: days.reduce((n, d) => n + d.downloads, 0),
      from: days[0]?.day ?? null,
      to: days.at(-1)?.day ?? null,
    };
  });

  /* The portfolio's own line: every configured package, added by day. These
     add honestly — a download is a download, whichever package it was. */
  const perDay = new Map<string, number>();
  for (const r of rows) {
    if (!configured.includes(r.package)) continue;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.downloads);
  }
  const days = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, downloads]) => ({ day, downloads }));
  const weeks = weeksOf(days);
  const complete = weeks.filter((w) => !w.partial);

  return c.json({
    packages,
    weeks,
    days,
    summary: {
      configured: configured.length,
      answering: packages.filter((p) => p.days.length && !p.lastError).length,
      failing: packages.filter((p) => p.lastError).length,
      lastCompleteWeek: complete.at(-1) ?? null,
      currentWeek: weeks.at(-1)?.partial ? weeks.at(-1)! : null,
      /** A rolling thirty days from the days HELD — not a calendar month, and
       *  not pypistats' `last_month`, which is its own rolling window. */
      last30: days.slice(-30).reduce((n, d) => n + d.downloads, 0),
      total: days.reduce((n, d) => n + d.downloads, 0),
      byPackage: Object.fromEntries(
        packages.map((p) => [p.package, p.lastCompleteWeek?.downloads ?? 0]),
      ),
      from: days[0]?.day ?? null,
      to: days.at(-1)?.day ?? null,
      seenAt: state.map((s) => s.seen_at ?? "").sort().at(-1) || null,
    },
    notes: {
      counts: "CDN file requests — CI, containers and people are one each. Downloads, never installs.",
      mirrors:
        "Mirrors are EXCLUDED (`?mirrors=false` on every request), so these " +
        "figures are smaller than pypistats' own default view. A mirror warming " +
        "its cache is not demand.",
      weeks:
        "Weeks are ISO, Monday to Sunday, bucketed at read time from the daily " +
        "rows. A week with a day missing is marked partial and must not be " +
        "compared with a complete one.",
      recent:
        "`recent` is pypistats' own rolling last day/week/month ending " +
        "yesterday. It will not equal `lastCompleteWeek`, which is a calendar " +
        "week, and neither is wrong.",
      lag: "pypistats rebuilds its dataset daily; the last day or two are often absent rather than zero.",
    },
  });
});

/**
 * The entities a venture can be linked to: one per package.
 *
 * `host` comes from the package's own home page or project URLs, with code
 * forges skipped — github.com is where a hundred packages live and is about
 * none of them, so linking a package to a venture because both mention GitHub
 * would fill the map with edges that mean nothing.
 */
pypiRoutes.get("/entities", (c) => {
  const state = pypiPackages();
  return c.json({
    entities: parsePackages(configValue("pypi", "packages")).map((name) => {
      const s = state.find((x) => x.package === name);
      let projectUrls: Record<string, string> | null = null;
      try {
        projectUrls = s?.project_urls ? (JSON.parse(s.project_urls) as Record<string, string>) : null;
      } catch {
        projectUrls = null;
      }
      return {
        plugin: "pypi",
        entity: name,
        label: s?.summary ? `${name} — ${s.summary}` : name,
        host: projectHost({ homePage: s?.home_page ?? null, projectUrls }),
      };
    }),
  });
});
