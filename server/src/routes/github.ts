/**
 * The GitHub board, in one call.
 *
 * ONE ROUTE FOR THE WHOLE PAGE, for the reason /api/domains is one route: a
 * dozen cards ask the same question of the same repo list — the stars, the
 * traffic line, the referrers, the table — and a dozen requests for one answer
 * is a burst the box does not need to serve.
 *
 * THREE THINGS ARE COMPUTED HERE, EVERY TIME, RATHER THAN STORED:
 *
 *   1. Whether the rate-limit figure still means anything. "4,780 requests
 *      left" was true when it was written and becomes a lie the moment the
 *      hour rolls over and the budget refills. The database holds the number
 *      AND the reset time; this decides, against the clock, whether to quote
 *      it — the same rule the domains route follows for expiry countdowns.
 *
 *   2. The fourteen-day totals. GitHub's window slides daily, so a total
 *      written down last night is a total of a different fortnight by
 *      tomorrow.
 *
 *   3. How stale each half of the answer is. The repo facts and the traffic
 *      are collected on two different cadences on purpose, so the page is told
 *      both dates rather than one date that would be wrong for half of it.
 *
 * TWO KINDS OF NUMBER THAT LOOK ALIKE AND ARE NOT. Views add up: across days,
 * across repos, always. UNIQUES DO NOT. GitHub de-duplicates visitors within
 * each day for the series and across the whole fortnight for its header
 * figure, so fourteen daily uniques added together counts every returning
 * visitor again, and two repos' uniques added together counts anybody who
 * looked at both. Every unique figure this route emits therefore says which
 * kind it is, and the widgets repeat it — because "56,707 people" and "78,000
 * person-days" are different sentences and only one of them is true.
 */
import { Hono } from "hono";
import {
  allGithubRepos,
  configValue,
  githubPopular,
  githubStates,
  githubTrafficSince,
  githubWindows,
} from "../db.ts";
import * as accounts from "../accounts.ts";
import { MAX_REPOS, TRAFFIC_DAYS } from "../providers/github.ts";

export const githubRoutes = new Hono();

/** How much daily history the page draws. GitHub only ever serves fourteen
 *  days, but this database keeps every day it has ever been told about, so the
 *  line can be longer than the API's own window — which is the whole reason
 *  the days are stored rather than the totals. */
const CHART_DAYS = 90;

/**
 * How old a traffic reading can be before it stops counting as "the last
 * fourteen days".
 *
 * A repo drops out of the traffic selection when the ranking moves — a new
 * org, a repo that went quiet, a push that reshuffles the tail — and when it
 * does, its window FREEZES. Left in the totals, a fortnight measured three
 * weeks ago goes on being added to "views over the last fourteen days", which
 * is a figure about a window that has moved on without it.
 *
 * So a stale window is kept on its own repo's row, with its date and a flag,
 * and left out of every aggregate. Two days is comfortably more than the six
 * hours between refreshes and comfortably less than a week of silence.
 */
const STALE_HOURS = 48;

const today = () => new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** A calendar day moved by whole days, in UTC. Every date this route reasons
 *  about is a day rather than an instant, so the arithmetic stays in days. */
function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

githubRoutes.get("/", (c) => {
  const repoRows = allGithubRepos();
  const windowRows = githubWindows();
  const windows = new Map(windowRows.map((w) => [w.full_name, w]));
  const fresh = (seenAt: string) =>
    Date.now() - Date.parse(seenAt) < STALE_HOURS * 3_600_000;
  const states = githubStates();
  const accountRows = accounts.list("github");
  const labels = new Map(accountRows.map((a) => [a.id, a.label]));
  const now = Date.now();

  /*
    ONE ROW PER REPO, whichever accounts can see it. Two logins that both hold
    a repo — a personal account that is also in the org — would otherwise
    contribute its stars twice to every total on the page. The freshest row
    wins, and the account that read it is carried so "where do I go to change
    this" stays answerable.
  */
  const byName = new Map<string, (typeof repoRows)[number]>();
  for (const r of repoRows) {
    const held = byName.get(r.full_name);
    if (!held || held.seen_at < r.seen_at) byName.set(r.full_name, r);
  }
  const rows = [...byName.values()];

  const popular = new Map<string, { referrers: Popular[]; paths: Popular[] }>();
  for (const p of githubPopular()) {
    if (!byName.has(p.full_name)) continue; // a repo nobody holds any more
    const bucket = popular.get(p.full_name) ?? { referrers: [], paths: [] };
    popular.set(p.full_name, bucket);
    const entry = {
      name: p.name,
      title: p.title,
      count: p.count,
      uniques: p.uniques,
    };
    (p.kind === "path" ? bucket.paths : bucket.referrers).push(entry);
  }

  const repos = rows.map((r) => {
    const w = windows.get(r.full_name);
    const pop = popular.get(r.full_name);
    return {
      fullName: r.full_name,
      owner: r.owner,
      name: r.name,
      org: r.is_org === 1,
      private: r.private === 1,
      fork: r.fork === 1,
      archived: r.archived === 1,
      accountId: r.account_id,
      account: labels.get(r.account_id) ?? r.account_label,
      stars: r.stars ?? 0,
      forks: r.forks ?? 0,
      /** GitHub's open_issues_count: issues AND open pull requests. */
      openIssues: r.open_issues ?? 0,
      watchers: r.watchers ?? 0,
      language: r.language,
      homepage: r.homepage,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      /*
        Null means traffic was never obtained for this repo — it lost the
        ranking, or the token cannot push to it. It never means zero: a repo
        nobody visited and a repo we are not allowed to ask about are
        different findings, and only one of them is about the repo.
      */
      traffic: w
        ? {
            days: w.days,
            views: w.views,
            /** GitHub's own de-duplicated count for the window. Not the sum
             *  of the daily uniques, which is a different number. */
            uniques: w.uniques,
            clones: w.clones,
            cloneUniques: w.clone_uniques,
            note: w.note,
            seenAt: w.seen_at,
            /** True when this window was last read too long ago to still be
             *  "the last fourteen days" — see STALE_HOURS. Kept on the row
             *  and left out of every total. */
            stale: !fresh(w.seen_at),
          }
        : null,
      referrers: pop?.referrers.sort((a, b) => b.count - a.count) ?? [],
      paths: pop?.paths.sort((a, b) => b.count - a.count) ?? [],
    };
  });

  /* Every total and every line below is of the repos whose traffic is CURRENT.
     A frozen window still shows on its own row, with its date; adding it to
     "views over the last fourteen days" would be adding a different
     fortnight. */
  const withTraffic = repos.filter((r) => r.traffic && !r.traffic.stale);
  const staleTraffic = repos.filter((r) => r.traffic?.stale).length;

  /* ------------------------------------------------------------- series */

  const since = daysAgo(CHART_DAYS);
  const perDay = new Map<
    string,
    {
      views: number;
      uniques: number;
      clones: number;
      cloneUniques: number;
      /** How many repos are in this day's figure. See below. */
      repos: Set<string>;
    }
  >();
  /* The line is drawn over the same repos the totals are of. A repo whose
     window has frozen contributes to neither, or the chart and the figure
     above it would be about two different sets. */
  const current = new Set(
    withTraffic.map((r) => r.fullName),
  );
  for (const p of githubTrafficSince(CHART_DAYS)) {
    if (!current.has(p.fullName)) continue;
    const bucket = perDay.get(p.day) ?? {
      views: 0,
      uniques: 0,
      clones: 0,
      cloneUniques: 0,
      repos: new Set<string>(),
    };
    perDay.set(p.day, bucket);
    bucket.repos.add(p.fullName);
    if (p.metric === "views") bucket.views += p.value;
    else if (p.metric === "uniques") bucket.uniques += p.value;
    else if (p.metric === "clones") bucket.clones += p.value;
    else if (p.metric === "cloneUniques") bucket.cloneUniques += p.value;
  }
  /*
    THE DAY IN PROGRESS IS MARKED, AND FOR A SHARPER REASON THAN "IT IS NOT
    OVER YET". GitHub's traffic aggregation lags its own clock: at half past
    six in the evening UTC, today's bucket on a repo taking twelve thousand
    views a day still read zero. Drawn as a point on a line that is a cliff,
    and a cliff is the one shape a reader will always believe. It stays in the
    data — dropping a figure GitHub gave us would be its own kind of edit —
    and it carries the flag that keeps it off the line.
  */
  const currentDay = today();

  /*
    AND SO IS A DAY OUTSIDE THE WINDOW SOME REPO WAS MEASURED OVER. This is the
    subtler half of the same problem and the one that actually bit.

    Repos do not all report the same fourteen days. One quiet repo came back
    with days stretching a week further back than the busiest one's window;
    added up, that drew six days of "almost nothing" — one repo's traffic,
    summed as if it were thirty — and then a vertical jump to 6,784 on the day
    the big repo's window began. Nothing happened that day. The coverage
    changed, and a chart that draws a change in coverage as a change in traffic
    is lying about the one thing it exists to show.

    The comparable range is derived from the COLLECTIONS rather than from the
    rows, which is the only version of this that stays right as history builds
    up. Each traffic read covers the fourteen days ending on the day it ran, so
    every repo is measured over the same fourteen days by construction — a repo
    with no row inside that span genuinely had no views, because GitHub omits
    zero days. The earliest read therefore fixes the left edge; everything
    older than it is a stray extra day GitHub handed back for a sparse repo,
    which nothing else covers. The right edge is yesterday, because today is
    still running.

    Written this way, the drawn window GROWS: a month of collecting is a month
    of comparable days, even though GitHub itself will only ever show fourteen.
  */
  const reads = windowRows
    .filter((w) => byName.has(w.full_name) && fresh(w.seen_at))
    .map((w) => w.seen_at.slice(0, 10))
    .sort();
  const earliestRead = reads[0] ?? null;
  const comparable = earliestRead
    ? {
        from: shiftDay(earliestRead, -(TRAFFIC_DAYS - 1)),
        to: shiftDay(currentDay, -1),
      }
    : null;

  const daily = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({
      day,
      views: v.views,
      uniques: v.uniques,
      clones: v.clones,
      cloneUniques: v.cloneUniques,
      repos: v.repos.size,
      partial:
        day >= currentDay ||
        (comparable !== null && (day < comparable.from || day > comparable.to)),
    }));

  /* ------------------------------------------------------------ summary */

  const sum = (pick: (r: (typeof repos)[number]) => number | null | undefined) =>
    withTraffic.reduce((n, r) => n + (pick(r) ?? 0), 0);

  const byLanguage: Record<string, number> = {};
  for (const r of repos) if (r.language) byLanguage[r.language] = (byLanguage[r.language] ?? 0) + 1;

  /*
    THE PORTFOLIO'S REFERRERS, added across repos. This is the one aggregate
    that adds cleanly and is worth the arithmetic: github.com sending 25,207
    views to one repo and 400 to another is one fact about one channel. The
    uniques column beside it is summed per repo and says so.
  */
  const refs = new Map<string, { count: number; uniques: number }>();
  for (const r of withTraffic)
    for (const ref of r.referrers) {
      const held = refs.get(ref.name) ?? { count: 0, uniques: 0 };
      held.count += ref.count;
      held.uniques += ref.uniques;
      refs.set(ref.name, held);
    }
  const topReferrers = [...refs]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const topPaths = withTraffic
    .flatMap((r) =>
      r.paths.map((p) => ({
        repo: r.fullName,
        path: p.name,
        title: p.title,
        count: p.count,
        uniques: p.uniques,
      })),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  /*
    THE BUDGET, JUDGED AGAINST THE CLOCK RATHER THAN QUOTED. Past its reset the
    stored figure describes an hour that is over — the ceiling has refilled and
    the number understates what is available, which on a card reading "9 left"
    would be an alarm about nothing. `expired` says so and the widget stops
    quoting the number rather than quietly showing a wrong one.
  */
  const accountSummary = accountRows.map((a) => {
    const s = states.find((x) => x.account_id === a.id);
    const expired = s?.rate_reset_at ? Date.parse(s.rate_reset_at) < now : false;
    return {
      id: a.id,
      label: a.label,
      login: s?.login ?? null,
      name: s?.name ?? null,
      followers: s?.followers ?? null,
      publicRepos: s?.public_repos ?? null,
      connected: a.connected,
      lastError: a.lastError,
      lastOkAt: a.lastOkAt,
      rate: {
        remaining: s?.rate_remaining ?? null,
        limit: s?.rate_limit ?? null,
        resetAt: s?.rate_reset_at ?? null,
        /** True when the hour the figure describes has already ended. */
        expired,
        /** What the last run spent. */
        requests: s?.requests ?? null,
        checkedAt: s?.checked_at ?? null,
      },
      trafficAt: s?.traffic_at ?? null,
    };
  });

  // The tightest budget across the accounts that still have a live figure —
  // the one that will run out first is the one worth showing.
  const live = accountSummary.filter(
    (a) => a.rate.remaining !== null && !a.rate.expired,
  );
  const tightest =
    live.sort((a, b) => (a.rate.remaining ?? 0) - (b.rate.remaining ?? 0))[0] ?? null;

  const mostViewed = [...withTraffic].sort(
    (a, b) => (b.traffic!.views ?? 0) - (a.traffic!.views ?? 0),
  )[0];

  const trafficSeenAt = withTraffic
    .map((r) => r.traffic!.seenAt)
    .sort()
    .at(-1) ?? null;

  return c.json({
    repos,
    /** Daily, summed across every repo traffic was collected for. `views` and
     *  `clones` add up honestly; `uniques` is a sum of per-day, per-repo
     *  unique counts and is labelled as such wherever it is drawn. */
    daily,
    summary: {
      repos: repos.length,
      public: repos.filter((r) => !r.private).length,
      private: repos.filter((r) => r.private).length,
      forks: repos.filter((r) => r.fork).length,
      archived: repos.filter((r) => r.archived).length,
      stars: repos.reduce((n, r) => n + r.stars, 0),
      forkCount: repos.reduce((n, r) => n + r.forks, 0),
      /** GitHub's open_issues_count summed: issues AND open pull requests. */
      openIssues: repos.reduce((n, r) => n + r.openIssues, 0),
      byLanguage,
      /** How many repos have CURRENT traffic, and how many hold a window that
       *  has stopped being refreshed — a repo that dropped out of the
       *  selection. The cap is what decides which get asked. */
      trafficRepos: withTraffic.length,
      trafficStale: staleTraffic,
      trafficCap: MAX_REPOS,
      trafficDays: TRAFFIC_DAYS,
      views: sum((r) => r.traffic?.views),
      /** Per-repo unique visitors, ADDED. A person who looked at two repos is
       *  in here twice; GitHub offers no cross-repo de-duplication at all. */
      uniquesSummed: sum((r) => r.traffic?.uniques),
      clones: sum((r) => r.traffic?.clones),
      cloneUniquesSummed: sum((r) => r.traffic?.cloneUniques),
      topReferrers,
      topPaths,
      mostViewed: mostViewed
        ? { fullName: mostViewed.fullName, views: mostViewed.traffic!.views }
        : null,
      accounts: accountSummary,
      rate: tightest?.rate ?? accountSummary[0]?.rate ?? null,
      /** The orgs the owner asked for. Empty means none were walked, which is
       *  a setting rather than a silence. */
      orgs: (configValue("github", "orgs") ?? "")
        .split(/[\s,]+/)
        .map((o) => o.trim())
        .filter(Boolean),
      /** Two dates, because the repo facts and the traffic are collected on
       *  two cadences and one date would be wrong for half the page. */
      seenAt: rows.map((r) => r.seen_at).sort().at(-1) ?? null,
      trafficSeenAt,
      chartFrom: daily.length ? daily[0]!.day : since,
      chartTo: daily.length ? daily.at(-1)!.day : today(),
    },
  });
});

type Popular = { name: string; title: string | null; count: number; uniques: number };
