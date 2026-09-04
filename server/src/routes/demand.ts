/**
 * Demand: one route for the three sources that measure what strangers said.
 *
 * ONE DOCUMENT RATHER THAN THREE, which is the opposite of the split the two
 * search engines take, and the difference is worth stating because it is the
 * same test both times: is there a figure that legitimately spans them?
 *
 * For Google and Bing there is not — they count different searches by
 * different people under different anonymisation rules, and a single
 * /api/search would be an invitation to add impressions that must never be
 * added. Here there is: a THREAD is a thread. "Somebody asked about this in
 * public" is one fact whether the somebody was on Reddit or on Hacker News,
 * and counting the two together is what makes "is anyone talking about this at
 * all" answerable. So the count of threads spans the sources, and it is the
 * only figure that does — UPVOTES ARE NEVER ADDED ACROSS THEM, because a
 * Reddit upvote and a Hacker News point are two crowds' currencies and their
 * exchange rate is not a thing anybody knows.
 *
 * SearXNG is in the same document rather than beside it because it is not a
 * fourth opinion: it is the tier that answers a Reddit query when the Atom
 * feed will not, so "which tier answered" and "is the node healthy" are one
 * question asked twice. A separate route would mean a card about Reddit's
 * fallback that could not see whether the fallback works.
 *
 * EVERY WINDOW IS COMPUTED HERE, ON THE READ, from each row's own date —
 * the rule the domains countdown and every cost total follow. A "signals this
 * month" written down at collection time is wrong the next morning and badly
 * wrong after a week of failed collections, which is the week somebody looks.
 *
 * AND A ROW THAT CANNOT BE DATED IS IN NO WINDOW AT ALL. The SearXNG tier
 * produces rows with no post date, because a web index does not know one.
 * Counting those inside "the last 30 days" would be asserting a date nobody
 * measured; dropping them silently would lose the evidence that the fallback
 * fired. They are counted apart, as `unaged`, on every object that has them.
 */
import { Hono } from "hono";
import {
  configValue,
  demandItems,
  demandQueries,
  getPlugin,
  searxngEngines,
  searxngStates,
  type DemandItemRow,
} from "../db.ts";
import * as accounts from "../accounts.ts";
import * as demand from "../providers/demand.ts";
import * as searxng from "../providers/searxng.ts";
import { DEMAND_EVERY_HOURS, watchTerms } from "../collector.ts";

export const demandRoutes = new Hono();

const days = (c: { req: { query: (k: string) => string | undefined } }) => {
  const n = Number(c.req.query("days") ?? 30);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 365) : 30;
};

/** How long since a thread was posted, or null where nothing dated it. */
function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return (Date.now() - at) / 86_400_000;
}

type Signal = {
  id: string;
  term: string;
  title: string;
  url: string;
  context: string | null;
  createdAt: string | null;
  ageDays: number | null;
  points: number | null;
  comments: number | null;
  tier: string;
  /** How this box first knew about it. Ours, not the source's — which is what
   *  makes it the one freshness figure the unaged tier can still contribute. */
  firstSeenAt: string;
};

const shapeSignal = (r: DemandItemRow): Signal => ({
  id: r.id,
  term: r.term,
  title: r.title,
  url: r.url,
  context: r.context,
  createdAt: r.created_at,
  ageDays: ageDays(r.created_at),
  points: r.points,
  comments: r.comments,
  tier: r.tier,
  firstSeenAt: r.first_seen_at,
});

/** The most recent moment a source was actually asked anything. Null means it
 *  never has been, which is not the same as answering nothing. */
function askedAt(source: string): string | null {
  const rows = demandQueries(source).map((q) => q.asked_at).sort();
  return rows.at(-1) ?? null;
}

/**
 * Per phrase: what happened, and when.
 *
 * The four statuses travel as they were stored. A card that folded `throttled`
 * and `ok · 0 items` together would be a card that cannot tell "nobody is
 * talking about this" from "nobody would let us look", which is the single
 * distinction this whole integration is built around.
 */
function queries(source: string, terms: string[]) {
  const held = new Map(demandQueries(source).map((q) => [q.term, q] as const));
  return terms.map((term) => {
    const row = held.get(term);
    return {
      term,
      /* A phrase in the list that has no row has never been asked — the state
         between typing it and the next collection, and it says so rather than
         borrowing "failed". */
      status: row?.status ?? "unasked",
      tier: row?.tier ?? null,
      tierLabel: row?.tier
        ? (demand.TIER_LABEL[row.tier as demand.Tier] ?? row.tier)
        : null,
      items: row?.items ?? null,
      error: row?.error ?? null,
      askedAt: row?.asked_at ?? null,
    };
  });
}

demandRoutes.get("/", (c) => {
  const windowDays = days(c);
  const terms = watchTerms();
  const since = Date.now() - windowDays * 86_400_000;
  const all = demandItems();

  const redditPlugin = getPlugin("reddit");
  const hnPlugin = getPlugin("hackernews");
  const searxPlugin = getPlugin("searxng");

  /* The feed token, as a FACT ABOUT THE ACCOUNTS rather than as a value: this
     route returns entry names and states, never a credential, exactly as
     /api/plugins does. */
  const redditAccounts = accounts.list("reddit").filter((a) => a.connected);

  const inWindow = (r: DemandItemRow) => {
    const at = r.created_at ? Date.parse(r.created_at) : NaN;
    return !Number.isNaN(at) && at >= since;
  };

  function section(source: "reddit" | "hn") {
    const mine = all.filter((r) => r.source === source);
    const dated = mine.filter(inWindow);
    const unaged = mine.filter((r) => !r.created_at);
    const signals = dated.map(shapeSignal);
    /* Distinct THREADS, because a thread found by two phrases is one thread
       and every count on a card is a count of things people wrote. */
    const distinct = new Set(dated.map((r) => r.id));
    const scored = dated.filter((r) => r.points !== null);
    return {
      signals,
      /** Threads in the window, de-duplicated across the phrases that found
       *  them. Never the row count, which is larger and means something else. */
      threads: distinct.size,
      /** Rows whose tier could not date them, so they are in NO window. */
      unaged: unaged.length,
      /** Rows nobody could score. On Hacker News that is every comment;
       *  through SearXNG it is everything. Not zeroes. */
      unscored: dated.length - scored.length,
      /** First seen by THIS box inside the window — the only freshness figure
       *  that works for an unaged row. Distinct THREADS, like everything else
       *  counted here: a thread two phrases both found is one new thing to
       *  read, not two. */
      newHere: new Set(
        mine.filter((r) => Date.parse(r.first_seen_at) >= since).map((r) => r.id),
      ).size,
      queries: queries(source, terms),
      seenAt: askedAt(source),
    };
  }

  const reddit = section("reddit");
  const hn = section("hn");

  /* Which tier answered, counted over the phrases whose answer stands. This is
     the sentence the Reddit card exists to carry: twelve threads from the Atom
     feed and twelve from a web index are not the same claim. */
  const tiers = new Map<string, number>();
  for (const q of demandQueries("reddit"))
    if (q.tier) tiers.set(q.tier, (tiers.get(q.tier) ?? 0) + 1);

  const searxStates = searxngStates();
  const searxEngines = searxngEngines();
  const newest = searxStates
    .slice()
    .sort((a, b) => a.seen_at.localeCompare(b.seen_at))
    .at(-1);

  return c.json({
    generatedAt: new Date().toISOString(),
    windowDays,
    everyHours: DEMAND_EVERY_HOURS,
    /** The watch list, in full. It is configuration rather than a credential,
     *  so it reads back — which is the whole reason it can be corrected. */
    terms,
    /*
      WHEN THIS BOX FIRST SAW ANYTHING, which is what makes `newHere` readable.
      Everything is new on the first morning — a thread posted in March and
      first seen today is genuinely new TO US and genuinely not news — so a
      card drawing that figure has to be able to say how long we have been
      looking. Null before the first collection.
    */
    collectingSince:
      all.map((r) => r.first_seen_at).sort()[0] ?? null,
    maxTerms: demand.MAX_TERMS,

    reddit: {
      connected: redditPlugin?.connected === 1,
      ...reddit,
      /* WHETHER THE THROTTLE IS LIFTED, and by which account. The difference
         is four phrases a collection against one, and it is the only thing
         the optional credential buys. */
      token: {
        held: redditAccounts.length > 0,
        accounts: redditAccounts.map((a) => ({
          id: a.id,
          label: a.label,
          lastOkAt: a.lastOkAt,
          lastError: a.lastError,
        })),
        note: redditAccounts.length
          ? `The account's own prefs/feeds token is in use, so Reddit serves ` +
            `about ${Math.round(demand.REDDIT_BUDGET_MS / demand.REDDIT_GAP_TOKEN_MS)} ` +
            `phrases a collection instead of one.`
          : `No feed token, so Reddit's anonymous limit of one query a minute ` +
            `applies and a collection asks ONE phrase. A token from ` +
            `reddit.com/prefs/feeds lifts it — no developer app, one settings page.`,
      },
      tiers: [...tiers.entries()].map(([tier, count]) => ({
        tier,
        label: demand.TIER_LABEL[tier as demand.Tier] ?? tier,
        queries: count,
      })),
      /* Where the threads came from. A count of THREADS per subreddit, not of
         rows: two phrases finding the same thread is one conversation. */
      subreddits: (() => {
        const byGroup = new Map<string, Set<string>>();
        for (const r of all)
          if (r.source === "reddit" && r.context && inWindow(r))
            (byGroup.get(r.context) ?? byGroup.set(r.context, new Set()).get(r.context)!).add(
              r.id,
            );
        return [...byGroup.entries()]
          .map(([name, ids]) => ({ name, threads: ids.size }))
          .sort((a, b) => b.threads - a.threads);
      })(),
    },

    hn: {
      connected: hnPlugin?.connected === 1,
      ...hn,
      /* Stories and comments counted apart, because only one of them has a
         score in Algolia's index and a mixed count would imply otherwise. */
      stories: all.filter((r) => r.source === "hn" && r.context === "story" && inWindow(r))
        .length,
      comments: all.filter(
        (r) => r.source === "hn" && r.context === "comment" && inWindow(r),
      ).length,
    },

    searxng: {
      connected: searxPlugin?.connected === 1,
      /** The endpoint actually in use — the setting, or the default it falls
       *  back to. On the wire because "which box is this searching" is a
       *  question a card should be able to answer. */
      url: searxng.endpoint(),
      configured: (configValue("searxng", "url") ?? "") !== "",
      seenAt: newest?.seen_at ?? null,
      /** The last probe. Null before the first one, which is not a failure. */
      probe: newest
        ? {
            ok: newest.ok === 1,
            query: newest.query,
            results: newest.results,
            /* OF THOSE RESULTS, HOW MANY CAME FROM THE SITE THE QUERY ASKED
               FOR. The probe is a site: search because that is what Reddit's
               fallback tier asks, and ten results with none of them on the
               site is a node that is answering the wrong question — which a
               results count alone reads as perfect health. */
            onSite: newest.on_site,
            site: searxng.PROBE_SITE,
            ms: newest.ms,
            enginesOk: newest.engines_ok,
            enginesRefused: newest.engines_bad,
            error: newest.error,
          }
        : null,
      /* Per engine, from that probe. THE MEASUREMENT THAT MATTERS: a node down
         to one working engine still answers ten links and still looks healthy,
         and `refused` carries the node's own words for why the others did not
         — "CAPTCHA" and "too many requests" being two different problems. */
      engines: searxEngines.map((e) => ({
        engine: e.engine,
        results: e.results,
        refused: e.refused,
      })),
      /** How often the safety net actually had to stand in for Reddit. */
      standIns: demandQueries("reddit").filter((q) => q.tier === "searxng").length,
      cannot: searxng.CANNOT,
    },

    /* The one figure that spans the sources, and the sentence saying which
       figures may not. */
    totals: {
      threads: new Set(all.filter(inWindow).map((r) => `${r.source}:${r.id}`)).size,
      newHere: reddit.newHere + hn.newHere,
      unaged: reddit.unaged + hn.unaged,
      note:
        "Threads add across the two sources — a thread is a thread. Upvotes do " +
        "not: a Reddit upvote and a Hacker News point are two crowds' " +
        "currencies and nothing here converts between them.",
    },

    cannot: demand.CANNOT,
  });
});
