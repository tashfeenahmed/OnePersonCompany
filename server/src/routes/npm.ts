/**
 * npm downloads, bucketed into weeks WHEN THEY ARE READ.
 *
 * The database holds one row per package per day, and nothing else — no
 * weekly totals, no "last week" figure, no percentage. Every one of those is
 * computed here against today's calendar, for the reason the domains route
 * computes its countdowns on every read: a week that was in progress when it
 * was written is a finished week the following Monday, and a stored
 * "downloads this week" would go on describing a Tuesday afternoon that ended
 * days ago.
 *
 * IT IS DOWNLOADS, NOT INSTALLS, AND THE WORD IS LOAD-BEARING. npm counts
 * HTTP tarball fetches. A CI job installing on every push, a Docker layer
 * rebuild, a mirror warming its cache and a person typing `npm i -g` are one
 * download each, and npm cannot tell them apart. Every field here is named
 * `downloads`, and the widgets that draw them say the same word, because
 * calling this "installs" would put a number on the top of a funnel that is
 * wrong in an unknown direction and quietly poison every rate computed below
 * it.
 *
 * WEEKS ARE ISO, MONDAY TO SUNDAY. npm's own `last-week` endpoint answers with
 * a ROLLING seven days ending yesterday, which is why npmjs.com can show 188
 * for a week this route calls 178 — the same downloads over a different seven
 * days. One definition, used by every weekly figure on the page.
 *
 * A PARTIAL WEEK IS MARKED AND NEVER DRAWN AS A COMPLETE ONE. The week in
 * progress always is; so is the oldest week if the history starts mid-week,
 * and so is any week with a day missing. Three days of a week rendered beside
 * seven-day weeks is a cliff that reads as a collapse in demand and is nothing
 * of the kind.
 */
import { Hono } from "hono";
import { configValue, npmDownloadsSince, npmPackages } from "../db.ts";
import { isoWeek, monday, parsePackages, publishedBy } from "../providers/npm.ts";

export const npmRoutes = new Hono();

/** How much history the page reads. npm serves years and this database keeps
 *  four hundred days; a quarter is what a weekly bar chart can show without
 *  the bars becoming hairlines. */
const DAYS = 120;

export type Week = {
  week: string;
  start: string;
  downloads: number;
  /** True when the seven days are not all in hand — the week in progress, a
   *  history that starts mid-week, or a day npm did not answer for. */
  partial: boolean;
};

/**
 * Days → ISO weeks, oldest first.
 *
 * `partial` is derived from the days actually HELD, not from the range that
 * was requested: a package published three weeks ago is served a shorter range
 * than asked for, and its first week is genuinely partial rather than quiet.
 */
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
      const end = sunday.toISOString().slice(0, 10);
      // Complete needs all three: the week begins inside what we hold, ends
      // inside it, and all seven days came back. npm omits no days in
      // practice, but a gap would otherwise read as a quiet week.
      const full = start >= from && end <= to && v.seen === 7;
      return { week: isoWeek(start), start, downloads: v.downloads, partial: !full };
    });
}

npmRoutes.get("/", (c) => {
  const configured = parsePackages(configValue("npm", "packages"));
  const state = npmPackages();
  const rows = npmDownloadsSince(DAYS);

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
    return {
      package: name,
      /** Which endpoint answered last: the requested range, or npm's fixed
       *  30-day window when the range was refused. Five weeks of history and
       *  nine are different answers and a chart that shortened can say why. */
      endpoint: s?.endpoint ?? null,
      rangeStart: s?.range_start ?? null,
      rangeEnd: s?.range_end ?? null,
      lastError: s?.last_error ?? null,
      lastOkAt: s?.last_ok_at ?? null,
      weeks,
      days,
      /**
       * The pair a card shows: the last FINISHED week, and the one in
       * progress. Deliberately not npm's own "last week", which is a rolling
       * window and would disagree with every other weekly figure here.
       */
      lastCompleteWeek: complete.at(-1) ?? null,
      currentWeek: weeks.at(-1)?.partial ? weeks.at(-1)! : null,
      total: days.reduce((n, d) => n + d.downloads, 0),
    };
  });

  /* The portfolio's own line: every configured package, added by day. These
     add up honestly — a download is a download, whichever package it was. */
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

  const last30 = days.slice(-30).reduce((n, d) => n + d.downloads, 0);

  return c.json({
    packages,
    weeks,
    days,
    summary: {
      /** How many names are configured, and how many of them npm answered
       *  for. One package 404ing must be visible as that rather than as a
       *  quieter week. */
      configured: configured.length,
      answering: packages.filter((p) => p.days.length && !p.lastError).length,
      failing: packages.filter((p) => p.lastError).length,
      lastCompleteWeek: complete.at(-1) ?? null,
      currentWeek: weeks.at(-1)?.partial ? weeks.at(-1)! : null,
      /** A rolling thirty days from the days held — not a calendar month, and
       *  not npm's `last-month`, which is its own rolling window. */
      last30,
      total: days.reduce((n, d) => n + d.downloads, 0),
      byPackage: Object.fromEntries(
        packages.map((p) => [p.package, p.lastCompleteWeek?.downloads ?? 0]),
      ),
      /** The one sentence every downloads figure on this page needs. */
      counts: "HTTP tarball fetches — CI, mirrors and people are one each",
      from: days[0]?.day ?? null,
      to: days.at(-1)?.day ?? null,
      seenAt: state.map((s) => s.seen_at).sort().at(-1) ?? null,
    },
  });
});

/**
 * What npm says a maintainer publishes.
 *
 * A DISCOVERY HELPER, deliberately separate from the collection. It exists so
 * the package list can be filled from the registry rather than from memory —
 * this account's four published packages were found this way — but nothing
 * calls it on a timer. A list that grows itself is a chart whose baseline
 * moves without anybody deciding it should, and a package that merely shares a
 * maintainer would arrive as a jump in "my downloads".
 */
npmRoutes.get("/published", async (c) => {
  const maintainer = (c.req.query("maintainer") ?? "").trim();
  if (!/^[a-z0-9][\w.-]{0,63}$/i.test(maintainer))
    return c.json({ error: "Pass ?maintainer=<npm username>." }, 400);
  try {
    const found = await publishedBy(maintainer);
    return c.json({
      maintainer,
      packages: found,
      /** Which of them are already in the list, so the answer is "here is
       *  what is missing" rather than a list to diff by eye. */
      configured: parsePackages(configValue("npm", "packages")),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "npm did not answer." },
      502,
    );
  }
});
