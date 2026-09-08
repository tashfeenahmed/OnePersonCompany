/**
 * Running a provider and writing down what it said.
 *
 * Every attempt opens a row in `runs` BEFORE the network call and closes it
 * after, successful or not — so "when did this last work" is answerable even
 * when the answer is "it has not, since Tuesday". A collector that only records
 * its successes cannot tell you that.
 *
 * Current state and history are kept apart on purpose. `hetzner_servers` is
 * replaced each run, so a decommissioned box leaves the table and stops costing
 * money the moment it leaves the account. `readings` is append-only, so the
 * chart of what it used to cost survives the box being deleted.
 */
import {
  db,
  finishRun,
  now,
  record,
  startRun,
  syncPlugin,
  replaceDomains,
  recordQuota,
  writeLoad,
  type LoadPoint,
} from "./db.ts";
import * as accounts from "./accounts.ts";
import * as hetzner from "./providers/hetzner.ts";
import * as dynadot from "./providers/dynadot.ts";
import * as spaceship from "./providers/spaceship.ts";
import { daysUntil, type DomainRow } from "./providers/domains.ts";
import * as github from "./providers/github.ts";
import * as npm from "./providers/npm.ts";
import {
  configValue,
  forgetNpmPackages,
  githubStates,
  githubWindows,
  replaceGithubPopular,
  replaceGithubRepos,
  upsertPlugin,
  writeGithubState,
  writeGithubTraffic,
  writeGithubWindow,
  writeNpmDownloads,
  writeNpmPackage,
  type TrafficPoint,
} from "./db.ts";
import * as openai from "./providers/openai.ts";
import * as openrouter from "./providers/openrouter.ts";
import * as replicate from "./providers/replicate.ts";
import * as stock from "./providers/stock.ts";
/* The two search engines. Two providers and two collectors rather than one of
   each, because they measure different networks under different anonymisation
   rules and there is no figure below that spans them. */
import * as gsc from "./providers/gsc.ts";
import * as bing from "./providers/bing.ts";
import {
  bingKeywordStates,
  forgetBingKeywords,
  forgetBingSites,
  forgetGscProperties,
  replaceGscRanked,
  writeBingCrawlDays,
  writeBingKeyword,
  writeBingQueries,
  writeBingSite,
  writeBingTrafficDays,
  writeGscDays,
  writeGscSite,
} from "./db.ts";
import * as appstore from "./providers/appstore.ts";
import * as play from "./providers/play.ts";
import {
  appStoreAnswered,
  appStoreSales,
  playFiles,
  playStats,
  replaceAppStoreApps,
  writeAppStoreDay,
  writeAppStorePayouts,
  writeAppStoreReport,
  writeAppStoreState,
  writePlayEarnings,
  writePlayFile,
  writePlaySales,
  writePlayState,
  writePlayStats,
} from "./db.ts";
import * as stripe from "./providers/stripe.ts";
import * as adsense from "./providers/adsense.ts";
import * as cloudflare from "./providers/cloudflare.ts";
import {
  replaceCloudflareRegistrar,
  replaceCloudflareZones,
  writeCloudflareState,
  writeCloudflareTraffic,
} from "./db.ts";
/* Meta — the Pages and the ad account. One provider rather than two, because
   one token reaches both and the previous system's two collectors read the same file:
   splitting them here would be two credentials' worth of machinery for one
   credential. Instagram is not a provider at all and has no collector — it is
   a FIELD on a Page, and on this account that field is empty on every one. */
import * as meta from "./providers/meta.ts";
/* Mail: what arrives and what leaves. TWO providers and two collectors rather
   than one of each, because they are two credentials, two failure states and
   two clocks — a Google grant expiring has nothing to do with a Resend key
   being revoked. They meet one level up, in /api/mail, the way the two app
   stores meet in /api/mobile. */
import * as gmail from "./providers/gmail.ts";
import * as resend from "./providers/resend.ts";
import {
  gmailKnownDays,
  mailSalt,
  replaceGmailMailbox,
  replaceResendDomains,
  writeGmailCorrespondents,
  writeGmailDays,
  writeResendEmails,
  writeResendState,
} from "./db.ts";
/* The three demand sources. Reddit and Hacker News share one provider the way
   Pexels and Pixabay do — they answer the same question in two vocabularies —
   and SearXNG is its own, because it is a credentialed node with a state of
   its own that also happens to be the last tier of Reddit's fallback. */
import * as demand from "./providers/demand.ts";
import * as searxng from "./providers/searxng.ts";
import {
  demandOrderedTerms,
  demandQueries,
  forgetDemandTerms,
  replaceSearxngEngines,
  searxngStates,
  writeDemandItems,
  writeDemandQuery,
  writeSearxngState,
} from "./db.ts";
import {
  replaceMetaAdAccounts,
  replaceMetaCampaigns,
  replaceMetaPages,
  writeMetaAdDays,
  writeMetaState,
} from "./db.ts";
import {
  stripeBalances,
  stripeLedgerDays,
  stripePaidCents,
  stripeState,
  stripeSubscriptions,
  writeAdSenseDays,
  writeAdSenseMonths,
  pruneStripeCharges,
  writeStripeBalance,
  writeStripeChargeDays,
  writeStripeCharges,
  writeStripeLedgerDays,
  writeStripePayouts,
  writeStripeState,
  writeStripeSubscriptions,
} from "./db.ts";
import {
  newestReplicatePrediction,
  replaceOpenRouterKeys,
  replicatePredictions,
  writeOpenAiCosts,
  writeOpenRouterActivity,
  writeOpenRouterCredits,
  writeReplicatePredictions,
} from "./db.ts";

export type CollectSummary = {
  ok: boolean;
  runId: number;
  servers: number;
  volumes: number;
  monthlyEur: number;
  /** Per-server samples written this run. Mostly rewrites of the window the
   *  last run already saw, which is the point — see writeLoad. */
  loadPoints: number;
  /** One line per account, so "it worked" and "it worked for two of three"
   *  are different answers on the wire and not just in a warning string. */
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

export async function collectHetzner(): Promise<CollectSummary> {
  const runId = startRun("hetzner");

  try {
    const result = await hetzner.collect();

    if (result.accountsTried === 0) {
      const error = "No account is connected.";
      finishRun(runId, false, undefined, error);
      return { ...EMPTY, runId, error };
    }

    /*
      Each account is told what happened to IT before anything is written.
      One dead token becomes one red line on one account rather than a warning
      buried in a run note, and the accounts that answered keep their own
      "last worked" date instead of inheriting the failure of a neighbour.
    */
    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const monthly = hetzner.monthlyTotal(result);
    const seen = now();

    // One transaction: a half-written fleet is worse than an old one.
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM hetzner_servers").run();
      const insS = db.prepare(
        `INSERT INTO hetzner_servers
           (id, token_label, name, ipv4, status, plan, specs, location, cores,
            memory_gb, disk_gb, architecture, monthly_eur, ipv4_monthly_eur,
            created_at, seen_at, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const s of result.servers) {
        insS.run(
          s.id, s.accountLabel, s.name, s.ipv4, s.status, s.plan, s.specs, s.location,
          s.cores, s.memoryGb, s.diskGb, s.architecture, s.monthlyEur,
          s.ipv4MonthlyEur, s.createdAt, seen, s.accountId,
        );
      }

      db.prepare("DELETE FROM hetzner_volumes").run();
      const insV = db.prepare(
        `INSERT INTO hetzner_volumes
           (id, token_label, name, size_gb, location, server_id, monthly_eur,
            seen_at, account_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const v of result.volumes) {
        insV.run(
          v.id, v.accountLabel, v.name, v.sizeGb, v.location, v.serverId,
          v.monthlyEur, seen, v.accountId,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    /*
      The load samples, written outside the fleet transaction on purpose. The
      fleet is a replacement — all of it or none of it, or the page shows half
      a fleet. The samples are an accumulation keyed by their own timestamps,
      so a failure part-way through leaves fewer points rather than a wrong
      picture, and the next run fills them in.
    */
    const rows: LoadPoint[] = [];
    for (const m of result.metrics)
      for (const [metric, points] of Object.entries(m.series))
        for (const p of points ?? [])
          rows.push({ serverId: m.serverId, metric, ts: p.ts, value: p.value });
    const loadPoints = writeLoad(rows);

    // The series the dashboard draws.
    record("hetzner.spend", monthly, { currency: "eur", net: true });
    record("hetzner.servers", result.servers.length, {
      running: result.servers.filter((s) => s.status === "running").length,
    });

    /*
      A partial answer is still a working integration; warnings are attached to
      the run rather than promoted to a failure. The note names the accounts
      when there is more than one, because "€63.47/mo" across two projects and
      "€63.47/mo" across one are different facts and the run log is where the
      difference is checkable later.
    */
    const failed = result.accounts.filter((a) => !a.ok);
    const note =
      `${result.servers.length} servers, ${result.volumes.length} volumes, ` +
      `€${monthly}/mo, ${result.metrics.length} boxes sampled` +
      (result.accounts.length > 1
        ? ` · ${result.accounts.length - failed.length}/${result.accounts.length} accounts`
        : "") +
      (result.warnings.length ? ` · ${result.warnings.length} warning(s)` : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("hetzner", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      servers: result.servers.length,
      volumes: result.volumes.length,
      monthlyEur: monthly,
      loadPoints,
      accounts: result.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        ok: a.ok,
        error: a.error,
      })),
      warnings: result.warnings,
    };
  } catch (err) {
    // Record WHY it failed without claiming anything about whether the plugin
    // is connected — a provider having a bad minute is not a disconnection,
    // and a missing token is not a connection.
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("hetzner", error);
    return { ...EMPTY, runId, error };
  }
}

/** What a failed run reports: nothing measured, and no claim that it was. */
const EMPTY = {
  ok: false as const,
  runId: 0,
  servers: 0,
  volumes: 0,
  monthlyEur: 0,
  loadPoints: 0,
  accounts: [] as { id: number; label: string; ok: boolean; error?: string }[],
  warnings: [] as string[],
};


/* ------------------------------------------------------------- domains */

export type DomainSummary = {
  ok: boolean;
  runId: number;
  domains: number;
  /** Inside thirty days and not yet past — the window the dashboard calls
   *  "soon". A name whose date has gone is counted by `lapsed`, never here. */
  expiringSoon: number;
  lapsed: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

/**
 * One registrar, collected — once per account it holds.
 *
 * Both registrars answer the same question in two vocabularies, so both run
 * through this: the provider hands back rows already folded onto one shape, and
 * everything below — the replacement, the readings, the run note — is identical
 * for either. Adding a third registrar is a provider file and a line in
 * COLLECTORS, not another copy of this function.
 *
 * ONE ACCOUNT'S FAILURE IS ONE ACCOUNT'S FAILURE. Each account replaces only
 * its own rows, so a login that answers 401 leaves the other login's names
 * exactly where they were rather than emptying the portfolio; and it is the
 * ACCOUNT that goes red, not the plugin. The run only fails when every account
 * failed, because "Dynadot is broken" is a different sentence from "one of two
 * Dynadot logins is broken" and the second one must not be told as the first.
 *
 * THE READINGS ARE COUNTS, NOT COUNTDOWNS. "How many domains did this account
 * hold on the 4th" is a fact that stays true; "how many expire within 30 days"
 * measured on the 4th is a claim about the 4th that a chart would redraw as
 * history. The countdown is computed from the stored dates every time it is
 * read.
 *
 * The reading is the registrar's TOTAL across its accounts, which is the
 * series the dashboard has always drawn. Per-account series were considered
 * and left out: they would double the metric names for a question ("how many
 * domains do I own") that nobody asks per login.
 */
async function collectRegistrar(
  id: string,
  label: string,
  fetch: (creds: { key: string; secret: string }) => Promise<DomainRow[]>,
): Promise<DomainSummary> {
  const runId = startRun(id);
  const reader = `collect_${id}`;
  const empty = {
    ok: false as const,
    runId,
    domains: 0,
    expiringSoon: 0,
    lapsed: 0,
    accounts: [],
    warnings: [],
  };

  const { ready, broken } = accounts.credentialed(id, ["key", "secret"], reader);

  if (!ready.length && !broken.length) {
    const error = "No account is connected.";
    finishRun(runId, false, undefined, error);
    return { ...empty, error };
  }

  const outcomes: DomainSummary["accounts"] = [];
  const warnings: string[] = [];
  const all: DomainRow[] = [];

  /*
    An account whose vault entries are incomplete never reaches the provider.
    Sending a key with no secret earns a 401 that reads as "the registrar
    refused your key", which sends the owner to the registrar to fix something
    that is wrong here.
  */
  for (const { account, missing } of broken) {
    const error = `Missing ${missing.join(" and ")} in the vault.`;
    accounts.markFailed(account.id, error);
    outcomes.push({ id: account.id, label: account.label, ok: false, error });
    warnings.push(`${account.label}: ${error}`);
  }

  for (const { account, values } of ready) {
    try {
      const rows = await fetch({ key: values.key!, secret: values.secret! });
      replaceDomains(id, account.id, account.label, rows);
      all.push(...rows);
      accounts.markOk(account.id);
      outcomes.push({ id: account.id, label: account.label, ok: true });
    } catch (err) {
      // The rows this account wrote last time stay put: a failure to read is
      // not news that the names are gone.
      const error = err instanceof Error ? err.message : String(err);
      accounts.markFailed(account.id, error);
      outcomes.push({ id: account.id, label: account.label, ok: false, error });
      warnings.push(`${account.label}: ${error}`);
      console.error(`[collect] ${label} · ${account.label} failed — ${error}`);
    }
  }

  const okCount = outcomes.filter((o) => o.ok).length;

  if (!okCount) {
    const error = warnings.join("; ");
    finishRun(runId, false, undefined, error);
    syncPlugin(id, error);
    return { ...empty, accounts: outcomes, warnings, error };
  }

  /*
    "Renewing soon" and "already gone" are counted apart, and the same way
    the /domains route counts them — two places computing "soon" differently
    is how a run note ends up saying "1 renewing within 30 days" about a name
    that lapsed on Tuesday. A lapse is not a deadline; it is a thing that has
    already happened.
  */
  const days = all.map((d) => daysUntil(d.expiresAt));
  const soon = days.filter((n) => n !== null && n >= 0 && n <= 30).length;
  const lapsed = days.filter((n) => n !== null && n < 0).length;

  record(`${id}.domains`, all.length, {
    /* What could not be answered, so a run that returns fewer facts than
       last week is visible as that rather than as a change in the account. */
    withExpiry: all.filter((d) => d.expiresAt).length,
    autoRenewOff: all.filter((d) => d.autoRenew === false).length,
    /* How many logins this figure is the sum of. A total that quietly became
       the sum of two accounts is a total that changed meaning. */
    accounts: okCount,
  });

  // An account that holds nothing is a real answer, not a failure: a
  // registrar can be connected and empty.
  const note =
    `${all.length} domain${all.length === 1 ? "" : "s"}` +
    (outcomes.length > 1 ? ` across ${okCount}/${outcomes.length} accounts` : "") +
    (soon ? `, ${soon} renewing within 30 days` : "") +
    (lapsed ? `, ${lapsed} past its date` : "");

  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin(id, warnings.join("; ") || null);

  return {
    ok: true,
    runId,
    domains: all.length,
    expiringSoon: soon,
    lapsed,
    accounts: outcomes,
    warnings,
  };
}

export const collectDynadot = () =>
  collectRegistrar("dynadot", "Dynadot", dynadot.domainsFor);

export const collectSpaceship = () =>
  collectRegistrar("spaceship", "Spaceship", spaceship.domainsFor);

/* -------------------------------------------------------------- github */

export type GithubSummary = {
  ok: boolean;
  runId: number;
  /** Repos seen across every account, counted once each. */
  repos: number;
  stars: number;
  /** How many repos had their traffic refreshed THIS run — which is zero on
   *  most runs, by design. See TRAFFIC_EVERY_HOURS. */
  traffic: number;
  /** What the run spent, in API requests. */
  requests: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

/**
 * HOW OFTEN TRAFFIC IS WORTH ASKING FOR.
 *
 * The repo listing is one to three requests and is refreshed every run: stars
 * and open issues move by the minute, and reading them costs nothing worth
 * counting.
 *
 * Traffic is four requests PER REPO, and GitHub's series is day-grained.
 * Asking every half hour would spend 5,760 requests a day to redraw the same
 * fourteen daily buckets — a fifth of the authenticated budget, burned to
 * learn nothing, and the first symptom of running out is a dashboard that
 * stops updating for reasons nobody can see. Six hours is four refreshes a day
 * of a figure that changes once a day, which is enough margin for GitHub's own
 * lag without being a subscription to the same answer.
 *
 * A newly connected account has no clock yet, so it collects traffic
 * immediately: the point of connecting something is to see it.
 */
export const TRAFFIC_EVERY_HOURS = 6;

/** The organisations to walk, as the owner typed them. Empty is a decision
 *  (walk none) and the run note says so — see providers/github.ts on why the
 *  list is explicit rather than "every org I belong to". */
function orgList(): string[] {
  return (configValue("github", "orgs") ?? "")
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * GitHub, collected — once per account it holds.
 *
 * THE TWO WRITES ARE DELIBERATELY DIFFERENT SHAPES. The repo rows are a
 * REPLACEMENT scoped to one account: a repo that has been deleted or
 * transferred leaves the table on the next run, and an account that failed
 * keeps the rows it wrote last time rather than being emptied by a bad minute.
 * The traffic points are an ACCUMULATION keyed by their own day, so a run that
 * dies half way through leaves fewer days rather than a wrong picture — and so
 * that this database quietly ends up holding more history than GitHub itself
 * will show you, since its window only ever looks back a fortnight.
 */
export async function collectGithub(): Promise<GithubSummary> {
  const runId = startRun("github");
  const empty = {
    ok: false as const,
    runId,
    repos: 0,
    stars: 0,
    traffic: 0,
    requests: 0,
    accounts: [] as GithubSummary["accounts"],
    warnings: [] as string[],
  };

  try {
    const states = new Map(githubStates().map((s) => [s.account_id, s]));
    const trafficDue = (accountId: number) => {
      const at = states.get(accountId)?.traffic_at;
      if (!at) return true;
      return Date.now() - Date.parse(at) >= TRAFFIC_EVERY_HOURS * 3_600_000;
    };

    /* A repo nothing has ever been asked about is asked about now, whatever
       the clock says — otherwise adding an organisation at nine o'clock puts
       two repos on the page that will show no traffic until three. */
    const known = new Set(githubWindows().map((w) => w.full_name));
    const orgs = orgList();
    const result = await github.collect({
      orgs,
      wantTraffic: trafficDue,
      trafficMissing: (fullName) => !known.has(fullName),
    });

    if (result.accountsTried === 0) {
      const error = "No account is connected.";
      finishRun(runId, false, undefined, error);
      return { ...empty, error };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const collectedAt = now();
    for (const a of result.accounts) {
      // An account that could not list its repos keeps the ones it listed
      // last time: a failure to read is not news that the repos are gone.
      if (a.ok)
        replaceGithubRepos(
          a.id,
          a.label,
          result.repos.filter((r) => r.accountId === a.id),
        );
      /*
        The state row is written either way, because the RATE LIMIT is the
        most useful thing a failing account can still tell you — "403, and by
        the way there are nine requests left this hour" is the whole diagnosis.
      */
      writeGithubState(a.id, {
        login: a.login,
        name: a.identity?.name ?? null,
        followers: a.identity?.followers ?? null,
        publicRepos: a.identity?.publicRepos ?? null,
        rateRemaining: a.rate.remaining,
        rateLimit: a.rate.limit,
        rateResetAt: a.rate.resetAt,
        requests: a.requests,
        trafficAt: a.traffic ? collectedAt : null,
      });
    }

    const points: TrafficPoint[] = [];
    for (const [fullName, t] of result.traffic) {
      const series: [string, github.DayPoint[]][] = [
        ["views", t.views],
        ["uniques", t.uniques],
        ["clones", t.clones],
        ["cloneUniques", t.cloneUniques],
      ];
      for (const [metric, days] of series)
        for (const p of days) points.push({ fullName, metric, day: p.day, value: p.value });

      writeGithubWindow(fullName, {
        days: github.TRAFFIC_DAYS,
        views: t.totals.views,
        uniques: t.totals.uniques,
        clones: t.totals.clones,
        cloneUniques: t.totals.cloneUniques,
        note: t.note,
      });
      replaceGithubPopular(fullName, [
        ...t.referrers.map((r) => ({ ...r, kind: "referrer" })),
        ...t.paths.map((p) => ({ ...p, kind: "path" })),
      ]);
    }
    writeGithubTraffic(points);

    /*
      THE READINGS ARE THE FIGURES WITH NO OTHER HISTORY. Traffic and downloads
      keep their own day-grained tables, so writing them here as well would be
      storing the same measurement twice in two shapes that could disagree.
      Stars and followers have no such series anywhere — GitHub reports today's
      number and nothing else — so this is the only place a chart of them can
      come from.
    */
    const stars = result.repos.reduce((n, r) => n + r.stars, 0);
    const publicRepos = result.repos.filter((r) => !r.private).length;
    const okAccounts = result.accounts.filter((a) => a.ok);
    record("github.stars", stars, {
      repos: result.repos.length,
      public: publicRepos,
      private: result.repos.length - publicRepos,
      accounts: okAccounts.length,
    });
    const followers = okAccounts.reduce(
      (n, a) => n + (a.identity?.followers ?? 0),
      0,
    );
    if (okAccounts.some((a) => a.identity?.followers !== null))
      record("github.followers", followers, { accounts: okAccounts.length });

    const requests = result.accounts.reduce((n, a) => n + a.requests, 0);
    const failed = result.accounts.filter((a) => !a.ok);

    if (failed.length === result.accounts.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("github", error);
      return {
        ...empty,
        accounts: result.accounts.map((a) => ({
          id: a.id, label: a.label, ok: a.ok, error: a.error,
        })),
        warnings: result.warnings,
        error,
      };
    }

    /*
      The note says what the run DID, including the thing it chose not to do.
      "Traffic not due" is the difference between a quiet run and a broken one,
      and without it a reader watching the log would see the request count drop
      by two orders of magnitude and reasonably assume something had failed.
    */
    const note =
      `${result.repos.length} repos, ${stars} stars` +
      (result.accounts.length > 1
        ? ` · ${okAccounts.length}/${result.accounts.length} accounts`
        : "") +
      (result.traffic.size
        ? `, traffic on ${result.traffic.size}`
        : ", traffic not due") +
      (result.dormant ? `, ${result.dormant} dormant` : "") +
      (result.truncated ? `, ${result.truncated} past the cap` : "") +
      ` · ${requests} requests`;

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("github", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      repos: result.repos.length,
      stars,
      traffic: result.traffic.size,
      requests,
      accounts: result.accounts.map((a) => ({
        id: a.id, label: a.label, ok: a.ok, error: a.error,
      })),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("github", error);
    return { ...empty, error };
  }
}

/* ----------------------------------------------------------------- npm */

export type NpmSummary = {
  ok: boolean;
  runId: number;
  packages: number;
  /** Daily figures written this run, most of them rewrites of days already
   *  held — which is the point, see writeNpmDownloads. */
  days: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

/**
 * npm, collected — once per configured package.
 *
 * THERE ARE NO ACCOUNTS HERE, and that is not an omission. npm's downloads API
 * is public: there is no credential to hold, so there is nothing for an
 * account row to own, and inventing one would put "Account 1 · connected" on a
 * page describing a credential that does not exist. What npm has instead is a
 * LIST, and "connected" for this plugin means exactly "there is a list to
 * collect" — which is why this writes the plugin's flag directly rather than
 * through syncPlugin, whose rule (any account connected) would read false
 * forever.
 *
 * PER PACKAGE, NEVER PER RUN. One name that 404s — unpublished, renamed,
 * mistyped — must not cost the others their figures, so each failure is that
 * package's own error and the run succeeds if any package answered.
 *
 * NO READING IS RECORDED. The daily table IS the history, kept for four
 * hundred days, and every weekly figure the dashboard shows is bucketed from
 * it when it is read. A "downloads this week" written into `readings` every
 * half hour would be a derived number that decays — the exact thing the
 * domains table refuses to store — and it would disagree with the table beside
 * it the moment npm revised a day.
 */
export async function collectNpm(): Promise<NpmSummary> {
  const runId = startRun("npm");
  const packages = npm.parsePackages(configValue("npm", "packages"));

  if (!packages.length) {
    const error =
      "No packages configured. npm needs no key, but it does need to know " +
      "which packages are yours — set them on the plugin page.";
    finishRun(runId, false, undefined, error);
    upsertPlugin("npm", false, error);
    return { ok: false, runId, packages: 0, days: 0, accounts: [], warnings: [], error };
  }

  // A name taken off the list takes its downloads with it, or it would go on
  // counting inside every total while appearing nowhere on the page.
  forgetNpmPackages(packages);

  const { start, end } = npm.window();
  const warnings: string[] = [];
  let written = 0;
  let ok = 0;

  for (const pkg of packages) {
    try {
      const series = await npm.daily(pkg, start, end);
      written += writeNpmDownloads(pkg, series.days);
      writeNpmPackage(pkg, {
        endpoint: series.endpoint,
        rangeStart: series.start,
        rangeEnd: series.end,
        error: null,
      });
      ok += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // The days already written stay: a refused read is not news that the
      // downloads did not happen.
      writeNpmPackage(pkg, {
        endpoint: null,
        rangeStart: null,
        rangeEnd: null,
        error,
      });
      warnings.push(`${pkg}: ${error}`);
    }
  }

  if (!ok) {
    const error = warnings.join("; ");
    finishRun(runId, false, undefined, error);
    upsertPlugin("npm", true, error);
    return {
      ok: false, runId, packages: packages.length, days: 0,
      accounts: [], warnings, error,
    };
  }

  const note =
    `${ok}/${packages.length} package${packages.length === 1 ? "" : "s"}, ` +
    `${written} daily figures over ${start} → ${end}`;
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  upsertPlugin("npm", true, warnings.join("; ") || null);

  return {
    ok: true,
    runId,
    packages: ok,
    days: written,
    accounts: [],
    warnings,
  };
}

/** Which plugins can actually be collected today. The catalog is larger; this
 *  is the honest subset, and the API says so rather than implying the rest. */
export const COLLECTORS: Record<
  string,
  () => Promise<
    | CollectSummary
    | DomainSummary
    | GithubSummary
    | NpmSummary
    | CostSummary
    | StockSummary
    | StripeSummary
    | AdSenseSummary
    | MobileSummary
    | CloudflareSummary
    | SearchSummary
    | SocialSummary
    | DemandSummary
    | SearxngSummary
    | MailSummary
  >
> = {
  hetzner: collectHetzner,
  dynadot: collectDynadot,
  spaceship: collectSpaceship,
  github: collectGithub,
  npm: collectNpm,
  openai: collectOpenAI,
  openrouter: collectOpenRouter,
  replicate: collectReplicate,
  pexels: () => collectStock("pexels"),
  pixabay: () => collectStock("pixabay"),
  /* The two revenue providers. They are collected apart and totalled nowhere:
     one reports settled card money, the other an ad network's own estimate. */
  stripe: collectStripe,
  adsense: collectAdSense,
  /* The two app stores. Both on their own six-hour clock — see
     MOBILE_EVERY_HOURS — because both publish a day at a time at best. */
  appstore: collectAppStore,
  playstore: collectPlay,
  /* The zones, their records and their daily traffic rollups. On its own
     six-hour clock — see CLOUDFLARE_EVERY_HOURS — because the rollup it reads
     is a day at a time and the records only move when a human edits one. */
  cloudflare: collectCloudflare,
  /* The two search engines. Collected apart and joined nowhere: Google's
     impressions and Bing's count different searches on different networks, and
     one of the two can also answer a question Google structurally cannot —
     demand for a phrase nothing of ours ranks for. Both on the six-hour clock,
     see SEARCH_EVERY_HOURS. */
  gsc: collectGsc,
  "bing-webmaster": collectBing,
  /* Meta: the three Pages and the one ad account, on the six-hour clock — see
     SOCIAL_EVERY_HOURS. There is deliberately no `instagram` collector beside
     it: Instagram is reached as a field on a Page rather than as an API of its
     own, so a second entry here would be a second run row and a second failure
     state for a question the first one already asked. */
  meta: collectMeta,
  /* THE THREE DEMAND SOURCES, and the only three collectors here that measure
     something nobody on this account wrote. Reddit and Hacker News share one
     watch list and one document; SearXNG is beside them rather than under
     them because it is a credentialed node in its own right — and because it
     is what answers a Reddit query the day the Atom feed stops. All three on
     the six-hour clock, see DEMAND_EVERY_HOURS. */
  reddit: collectReddit,
  hackernews: collectHackerNews,
  searxng: collectSearxng,
  /* MAIL, AS TWO COLLECTORS. Gmail is what arrives and Resend is what leaves,
     and they are two entries here rather than one for the reason the app
     stores are two: two credentials, two failure states, and a run that goes
     red for one of them must not take the other's rows off the page. They meet
     one level up, in /api/mail. Both on the two-hour clock — see
     MAIL_EVERY_HOURS — which is the shortest slow clock on this box, because
     an inbox is the one thing here that moves while you are looking at it. */
  gmail: collectGmail,
  resend: collectResend,
};

/* ------------------------------------------------------------------- costs */

/**
 * The three cost providers, collected.
 *
 * WHAT THEY SHARE IS THE SHAPE OF THE ANSWER, NOT THE ANSWER. Each writes its
 * measurements at the grain the provider reports them, marks each account with
 * what happened to IT, and fails the run only when every account failed. What
 * they do not share is a unit: OpenAI and OpenRouter report US dollars,
 * Replicate reports predictions and seconds and no money at all. So there is no
 * shared "spend" summary type here that would need Replicate to answer with a
 * zero, and `usd: null` is the honest answer where a provider has none.
 */
export type CostSummary = {
  ok: boolean;
  runId: number;
  /** Rows written this run — the measurement, not a total of anything. */
  rows: number;
  /** What the window cost, in USD, or null where the provider does not say. */
  usd: number | null;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const NO_ACCOUNT = "No account is connected.";

/**
 * OpenAI's organization costs.
 *
 * The reading recorded is the WINDOW's total as it stands right now — a
 * trailing-thirty-day figure, sampled every collection, which is a real series
 * about a real thing. The per-day and per-project breakdowns are not recorded
 * as readings at all: they live in `openai_costs` at full grain, and every
 * total the route hands out is a sum over those rows computed on the read. A
 * "spend this month" written into readings would be a number that decays.
 */
export async function collectOpenAI(): Promise<CostSummary> {
  const runId = startRun("openai");
  try {
    const result = await openai.collect();
    if (result.accountsTried === 0) {
      finishRun(runId, false, undefined, NO_ACCOUNT);
      return { ...EMPTY_COST, runId, error: NO_ACCOUNT };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const okCount = result.accounts.filter((a) => a.ok).length;
    if (!okCount) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("openai", error);
      return {
        ...EMPTY_COST,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    writeOpenAiCosts(result.rows);

    const usd = Number(result.rows.reduce((n, r) => n + r.usd, 0).toFixed(6));
    const days = new Set(result.rows.map((r) => r.day)).size;
    const projects = new Set(result.rows.map((r) => r.projectId)).size;
    record("openai.spend", usd, {
      currency: "usd",
      windowDays: openai.WINDOW_DAYS,
      /* How many organizations this figure is the sum of. A total that quietly
         became a sum across two orgs is a total that changed meaning. */
      accounts: okCount,
      /* The buckets lag, so the newest day in this figure is partial. Said in
         the meta rather than assumed by whatever draws it. */
      lastDay: [...new Set(result.rows.map((r) => r.day))].sort().at(-1) ?? null,
    });

    const note =
      `$${usd.toFixed(2)} over ${days} day${days === 1 ? "" : "s"}, ` +
      `${projects} project${projects === 1 ? "" : "s"}` +
      (result.accounts.length > 1
        ? ` · ${okCount}/${result.accounts.length} accounts`
        : "");
    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("openai", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      rows: result.rows.length,
      usd,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("openai", error);
    return { ...EMPTY_COST, runId, error };
  }
}

/**
 * OpenRouter: the ledger, the activity cut and the key cut.
 *
 * THE KEYS ARE REPLACED ONLY FOR THE ACCOUNTS THAT ANSWERED. A key listing
 * that 403s hands back no keys, which is indistinguishable from an account
 * holding none — and replacing on that basis would delete nine keys' worth of
 * lifetime spend because a request timed out. `keysRead` is the provider
 * saying which listings actually happened.
 *
 * TWO READINGS, MEASURING TWO THINGS. `openrouter.spend` is the activity
 * window; `openrouter.balance` is what is left of what was bought. They are
 * not two views of one number and the cards that draw them say so.
 */
export async function collectOpenRouter(): Promise<CostSummary> {
  const runId = startRun("openrouter");
  try {
    const result = await openrouter.collect();
    if (result.accountsTried === 0) {
      finishRun(runId, false, undefined, NO_ACCOUNT);
      return { ...EMPTY_COST, runId, error: NO_ACCOUNT };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const okCount = result.accounts.filter((a) => a.ok).length;
    if (!okCount) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("openrouter", error);
      return {
        ...EMPTY_COST,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    writeOpenRouterActivity(result.activity);
    for (const id of result.keysRead) {
      const label =
        result.accounts.find((a) => a.id === id)?.label ?? String(id);
      replaceOpenRouterKeys(
        id,
        label,
        result.keys.filter((k) => k.accountId === id),
      );
    }
    for (const c of result.credits)
      writeOpenRouterCredits(c.accountId, c.accountLabel, c.purchased, c.spent);

    const usd = Number(result.activity.reduce((n, r) => n + r.usd, 0).toFixed(6));
    const days = new Set(result.activity.map((r) => r.day)).size;
    record("openrouter.spend", usd, {
      currency: "usd",
      /* The activity endpoint's own window — about a month, and OpenRouter's
         choice rather than ours, so it is written down as measured. */
      days,
      models: new Set(result.activity.map((r) => r.model)).size,
      accounts: okCount,
    });
    if (result.credits.length) {
      const purchased = result.credits.reduce((n, c) => n + c.purchased, 0);
      const spent = result.credits.reduce((n, c) => n + c.spent, 0);
      record("openrouter.balance", Number((purchased - spent).toFixed(6)), {
        currency: "usd",
        purchased: Number(purchased.toFixed(6)),
        /* LIFETIME spend, every key that ever existed — not the activity
           window above it and not the sum of the keys that still exist. */
        spentLifetime: Number(spent.toFixed(6)),
        accounts: result.credits.length,
      });
    }

    const note =
      `$${usd.toFixed(2)} over ${days} day${days === 1 ? "" : "s"} of activity, ` +
      `${result.keys.length} key${result.keys.length === 1 ? "" : "s"}` +
      (result.accounts.length > 1
        ? ` · ${okCount}/${result.accounts.length} accounts`
        : "");
    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("openrouter", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      rows: result.activity.length + result.keys.length,
      usd,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("openrouter", error);
    return { ...EMPTY_COST, runId, error };
  }
}

/**
 * Replicate: a prediction history, and no money anywhere in it.
 *
 * `usd` is null on the way out and stays null — not zero. Replicate's API
 * publishes no billing endpoint, a prediction carries no hardware SKU or
 * price, and half of what this account runs is billed per output rather than
 * per second, so there is nothing here to add up. What is recorded instead is
 * what Replicate does measure: how many predictions ran in the window and how
 * many seconds of compute they took.
 *
 * THE READINGS ARE COMPUTED FROM THE TABLE, NOT FROM THE ROWS JUST FETCHED.
 * The fetch is incremental — a run that finds four new predictions has fetched
 * four rows and the window still holds six hundred — so recording the fetch
 * would draw a chart of how busy the collector was rather than of how busy the
 * account was.
 */
export async function collectReplicate(): Promise<CostSummary> {
  const runId = startRun("replicate");
  try {
    const result = await replicate.collect(newestReplicatePrediction());
    if (result.accountsTried === 0) {
      finishRun(runId, false, undefined, NO_ACCOUNT);
      return { ...EMPTY_COST, runId, error: NO_ACCOUNT };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const okCount = result.accounts.filter((a) => a.ok).length;
    if (!okCount) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("replicate", error);
      return {
        ...EMPTY_COST,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    writeReplicatePredictions(result.rows);

    const since = new Date(
      Date.now() - replicate.WINDOW_DAYS * 86_400_000,
    ).toISOString();
    const window = replicatePredictions(since);
    const seconds = window.reduce((n, p) => n + (p.predict_seconds ?? 0), 0);
    record("replicate.predictions", window.length, {
      windowDays: replicate.WINDOW_DAYS,
      failed: window.filter((p) => p.status === "failed").length,
      accounts: okCount,
      /* No currency key, because there is no currency. See the provider. */
      cost: null,
    });
    record("replicate.compute", Number(seconds.toFixed(3)), {
      unit: "seconds",
      windowDays: replicate.WINDOW_DAYS,
      /* Predictions that reported no predict_time at all — still running, or
         never ran. Counted so the total is readable as "of how many". */
      unreported: window.filter((p) => p.predict_seconds === null).length,
      accounts: okCount,
    });

    const note =
      `${result.rows.length} new, ${window.length} in ${replicate.WINDOW_DAYS}d, ` +
      `${Math.round(seconds)}s of compute · no cost: Replicate publishes none` +
      (result.accounts.length > 1
        ? ` · ${okCount}/${result.accounts.length} accounts`
        : "");
    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("replicate", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      rows: result.rows.length,
      // Not zero. Nothing in this API can be converted into money.
      usd: null,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("replicate", error);
    return { ...EMPTY_COST, runId, error };
  }
}

/** What a failed cost run reports: nothing measured, and no claim that it
 *  was. `usd: null` rather than 0 for the same reason it is null on Replicate
 *  — a run that did not read a bill has not read a bill of nothing. */
const EMPTY_COST = {
  ok: false as const,
  rows: 0,
  usd: null,
  accounts: [] as CostSummary["accounts"],
  warnings: [] as string[],
};

/** The provider's per-account outcomes, trimmed to what the wire carries. */
function outcomeLines(
  outcomes: { id: number; label: string; ok: boolean; error?: string }[],
): CostSummary["accounts"] {
  return outcomes.map((a) => ({
    id: a.id,
    label: a.label,
    ok: a.ok,
    error: a.error,
  }));
}

/* ------------------------------------------------------------------ stock */

/**
 * How often the stock libraries are asked how much allowance is left.
 *
 * SIX HOURS, NOT THIRTY MINUTES, AND THE REASON IS THE MEASUREMENT ITSELF.
 * Neither service publishes a "check my quota" endpoint, so the only way to
 * read the counter is to spend one from it. At the ordinary cadence that is
 * ~1,440 requests a month against Pexels' 25,000 — nearly six percent of the
 * allowance burned watching the allowance, which is a preposterous trade for a
 * number that moves slowly. On this clock it is ~120 a month, under half a
 * percent, and a quota being burned fast is still caught the same day.
 *
 * The same reasoning puts GitHub's traffic read on a slow clock. See
 * TRAFFIC_EVERY_HOURS.
 */
export const STOCK_EVERY_HOURS = 6;

export type StockSummary = {
  ok: boolean;
  runId: number;
  /** Accounts whose quota was read this run. Zero on a skipped run. */
  read: number;
  skipped: boolean;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

/** "4h ago", for a run note explaining why nothing was read. */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The newest reading for a library, whatever account it came from — the
 *  question the clock asks is "when did we last spend a request here". */
function lastQuotaAt(library: string): string | null {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM stock_quota WHERE library = ?")
    .get(library) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

export async function collectStock(library: stock.Library): Promise<StockSummary> {
  const runId = startRun(library);
  const name = stock.DISPLAY[library];
  const empty = { ok: false as const, runId, read: 0, skipped: false, accounts: [], warnings: [] };

  try {
    const at = lastQuotaAt(library);
    if (at && Date.now() - Date.parse(at) < STOCK_EVERY_HOURS * 3_600_000) {
      // Not an error and not a failure — a deliberate no-op that says so, so a
      // run log full of these reads as restraint rather than as a broken timer.
      const note = `quota not due — read ${ago(at)}`;
      finishRun(runId, true, note);
      return { ...empty, ok: true, skipped: true };
    }

    const result = await stock.collect(library);
    if (result.accountsTried === 0) {
      const error = "No account is connected.";
      finishRun(runId, false, undefined, error);
      return { ...empty, error };
    }

    for (const a of result.accounts) {
      if (a.ok) {
        accounts.markOk(a.id);
        if (a.quota) recordQuota(library, a.id, a.quota);
      } else {
        accounts.markFailed(a.id, a.error ?? "The account did not answer.");
      }
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin(library, error);
      return { ...empty, accounts: result.accounts, warnings: result.warnings, error };
    }

    /*
      The note names the allowance rather than the request count, because the
      request count is one per account and says nothing. A library that reports
      no headers says THAT rather than a number — "quota not reported" is the
      honest run note for a service that answered without telling us anything.
    */
    const parts = ok.map((a) => {
      const q = a.quota;
      if (!q || q.remaining === null || q.limit === null)
        return `${a.label}: quota not reported`;
      return `${a.label}: ${q.remaining.toLocaleString("en-GB")} of ${q.limit.toLocaleString("en-GB")} left`;
    });
    const note = `${name} — ${parts.join(" · ")}`;

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin(library, result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      read: ok.length,
      skipped: false,
      accounts: result.accounts,
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin(library, error);
    return { ...empty, error };
  }
}

/* ----------------------------------------------------------------- revenue */

/**
 * The two revenue providers, and the reason they are collected separately.
 *
 * Stripe measures SETTLED money — a card was charged, a fee was taken, a
 * payout left for a bank — and AdSense measures ESTIMATED earnings that Google
 * revises for days afterwards. Neither summary type below carries a field the
 * other could fill, and nothing anywhere adds them: a "revenue" total spanning
 * a bank settlement and an ad-network estimate is a number no statement of
 * either kind would agree with.
 */
export type StripeSummary = {
  ok: boolean;
  runId: number;
  /** Rows written this run — the measurement, never a total of anything. */
  rows: number;
  /** Per currency, because they are never added. Null when nothing could be
   *  read at all, which is not the same as an account with no subscribers. */
  mrr: { currency: string; amount: number }[] | null;
  subscriptions: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_STRIPE = {
  ok: false as const,
  rows: 0,
  mrr: null,
  subscriptions: 0,
  accounts: [] as StripeSummary["accounts"],
  warnings: [] as string[],
};

/**
 * Stripe: the book, the ledger and the balance.
 *
 * WHAT IS RECORDED AS A READING AND WHAT IS NOT. `stripe.mrr`, `stripe.subs`,
 * `stripe.net30` and `stripe.balance` are sampled every collection, because
 * each is a single figure about the account AS IT STANDS and the series is the
 * only way to see it move. Churn is deliberately NOT recorded: it is a rate
 * over a window with a reconstructed denominator, and the route computes it
 * from the subscription rows when somebody asks. Writing it down would be
 * storing a second implementation of the same arithmetic, ready to disagree
 * with the first.
 *
 * A FIGURE THAT WOULD SPAN TWO CURRENCIES IS NOT RECORDED AT ALL. `record`
 * takes one number; a single-currency account gets a real series, and an
 * account that starts billing in euro as well gets a warning and a gap rather
 * than a total in no currency. This account is USD throughout today.
 */
export async function collectStripe(): Promise<StripeSummary> {
  const runId = startRun("stripe");
  try {
    const result = await stripe.collect(stripeState(), stripePaidCents());
    if (result.accountsTried === 0) {
      finishRun(runId, false, undefined, NO_ACCOUNT);
      return { ...EMPTY_STRIPE, runId, error: NO_ACCOUNT };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const okCount = result.accounts.filter((a) => a.ok).length;
    if (!okCount) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("stripe", error);
      return {
        ...EMPTY_STRIPE,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    writeStripeChargeDays(result.chargeDays);
    /*
      THE CHARGE LIST IS WRITTEN AND THEN CUT TO THE WALK'S OWN EDGE. A row
      older than the rolling window will never be reread, so a refund against
      it would never reach this table; pruning to the same ninety days the
      walk covers is what keeps every row here one the next run can correct.
    */
    writeStripeCharges(result.charges);
    pruneStripeCharges(new Date(Date.now() - stripe.WALK_DAYS * 86_400_000).toISOString());
    writeStripeLedgerDays(result.ledgerDays);
    writeStripeSubscriptions(result.subscriptions);
    writeStripeBalance(result.balances);
    writeStripePayouts(result.payouts);
    /*
      The history bookmark is written only for accounts that ANSWERED. An
      account whose key was refused this run must not have its window marked
      as walked — the next run would carry on from a chunk nobody read and
      leave a hole in the ledger that nothing would ever go back for.
    */
    for (const a of result.accounts)
      if (a.ok && a.state) writeStripeState(a.id, a.state);

    // Every figure below is computed from the rows in the DATABASE rather than
    // from the ones just fetched: the walk is incremental, so what came back
    // this run is a slice and the book is the whole table.
    const subs = stripeSubscriptions();
    const billing = subs.filter((s) => stripe.isBilling(s.status));
    const mrr = [...new Set(billing.map((s) => s.currency))].sort().map((currency) => ({
      currency,
      amount: Number(
        billing
          .filter((s) => s.currency === currency)
          .reduce((n, s) => n + s.monthly_usd, 0)
          .toFixed(2),
      ),
    }));

    if (mrr.length === 1) {
      record("stripe.mrr", mrr[0]!.amount, {
        currency: mrr[0]!.currency,
        subscriptions: billing.length,
        /* THE NORMALISATION, ON EVERY SAMPLE. An annual plan is counted as a
           twelfth of its price per month; that is a convention applied to the
           customer's cash flow rather than something Stripe reported, and a
           reading that did not say so would be a figure whose definition lives
           only in a comment. */
        basis: "active subscriptions, normalised to a month, net of recurring coupons",
        accounts: okCount,
      });
    } else if (mrr.length > 1) {
      result.warnings.push(
        `MRR spans ${mrr.length} currencies (${mrr.map((m) => m.currency).join(", ")}) — no single figure was recorded, because adding them would need a dated rate this box does not fetch`,
      );
    }

    record("stripe.subs", billing.length, {
      /* Three counts that are NOT the headline and must not be folded into it:
         a trial has never billed, a past-due subscription is billing and
         failing, and a pending cancellation is still billing today. */
      trialing: subs.filter((s) => s.status === "trialing").length,
      pastDue: subs.filter((s) => s.status === "past_due").length,
      pendingCancellation: billing.filter((s) => s.cancel_at_period_end === 1).length,
      accounts: okCount,
    });

    /* Net revenue over thirty days, off the balance ledger and nothing else —
       gross minus refunds, disputes and everything Stripe held back. The
       charge walk's gross is a different measurement and is never used here. */
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const ledger = stripeLedgerDays(from);
    const netCurrencies = [...new Set(ledger.map((r) => r.currency))];
    if (netCurrencies.length === 1) {
      const net = ledger.reduce((n, r) => n + r.net, 0);
      record("stripe.net30", Number(net.toFixed(2)), {
        currency: netCurrencies[0],
        days: 30,
        fees: Number(ledger.reduce((n, r) => n + r.fees, 0).toFixed(2)),
        /* A pass-through, not a cost, and on its own line for that reason. */
        taxWithheld: Number(ledger.reduce((n, r) => n + r.tax_withheld, 0).toFixed(2)),
        accounts: okCount,
      });
    }

    const balances = stripeBalances();
    const balCurrencies = [...new Set(balances.map((b) => b.currency))];
    if (balCurrencies.length === 1) {
      record(
        "stripe.balance",
        Number(balances.reduce((n, b) => n + b.available, 0).toFixed(2)),
        {
          currency: balCurrencies[0],
          /* Pending is money Stripe has and will not release yet. It is beside
             the available figure and never inside it: they answer "what could
             be paid out today" and "what is on its way". */
          pending: Number(balances.reduce((n, b) => n + b.pending, 0).toFixed(2)),
          accounts: okCount,
        },
      );
    }

    const rows =
      result.chargeDays.length + result.ledgerDays.length + result.subscriptions.length;
    const historyFrom = result.accounts
      .map((a) => a.state?.historyFrom)
      .filter((d): d is string => Boolean(d))
      .sort()[0];
    const note =
      `${billing.length} billing subs, ` +
      (mrr.length
        ? mrr.map((m) => `${m.amount.toFixed(2)} ${m.currency.toUpperCase()}/mo`).join(" + ")
        : "no MRR") +
      ` · ${result.chargeDays.length} charge days, ${result.ledgerDays.length} ledger days` +
      (result.unresolved
        ? ` · ${result.unresolved} cancellation(s) still to check for a payment`
        : "") +
      /* How far back the day tables now reach. On the wire it qualifies every
         windowed figure; in the run note it is the one line that says whether
         a short chart is a quiet month or a young ledger. */
      (historyFrom ? ` · history from ${historyFrom}` : "") +
      (result.accounts.length > 1 ? ` · ${okCount}/${result.accounts.length} accounts` : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("stripe", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      rows,
      mrr,
      subscriptions: billing.length,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("stripe", error);
    return { ...EMPTY_STRIPE, runId, error };
  }
}

export type AdSenseSummary = {
  ok: boolean;
  runId: number;
  rows: number;
  /** Whether Google would talk to us. FALSE is the ordinary state of this
   *  integration until somebody grants consent in a browser, and it is not a
   *  failure — see the run handling below. */
  authorised: boolean;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_ADSENSE = {
  ok: false as const,
  rows: 0,
  authorised: false,
  accounts: [] as AdSenseSummary["accounts"],
  warnings: [] as string[],
};

/**
 * AdSense — and the one collector here that does not treat "no account" as a
 * failed run.
 *
 * Every other collector in this file answers `accountsTried === 0` with
 * `finishRun(false, "No account is connected.")`, which is right for them: a
 * Hetzner token is pasted in ten seconds and a plugin with none is
 * misconfigured. AdSense is not like that. Connecting it needs a human to
 * approve a Google consent screen in a browser, as the AdSense account owner,
 * and until that happens there IS no credential to have. The collector this
 * replaces writes `{"error": "not-authorised", "hint": …}` and exits ZERO for exactly
 * this reason — a daily timer must never go red for a consent nobody has
 * given — and the same instinct applies here: the run finishes green with a
 * note saying what is missing and how to supply it.
 *
 * The same is true one layer in. A refresh token Google refuses is recorded
 * against ITS account with Google's own sentence, and the run still finishes:
 * the thing to do about `invalid_grant` is to mint a token in a browser, not
 * to look at a red line in a log. Only a transport failure fails the run,
 * because only a transport failure is fixed by trying again.
 */
export async function collectAdSense(): Promise<AdSenseSummary> {
  const runId = startRun("adsense");
  try {
    const result = await adsense.collect();

    if (result.accountsTried === 0) {
      const note =
        "not authorised — no OAuth grant is stored. AdSense needs a refresh token " +
        "minted in a browser by the account owner; the plugin page says how.";
      finishRun(runId, true, note);
      return { ...EMPTY_ADSENSE, ok: true, runId };
    }

    /*
      A REFUSAL IS RECORDED AS THE ACCOUNT'S OWN STATE, with Google's words and
      the console link where there is one. `SERVICE_DISABLED` in particular is
      a fix rather than a fault: the token is fine and the API simply has not
      been switched on for the Cloud project, and the account's error carries
      the link that switches it on.
    */
    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else if (a.refusal)
        accounts.markFailed(
          a.id,
          `${a.refusal.hint} ${a.refusal.enableUrl ? `(${a.refusal.enableUrl}) ` : ""}— ${a.refusal.detail}`,
        );
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const ok = result.accounts.filter((a) => a.ok);
    const transportFailures = result.accounts.filter((a) => !a.ok && !a.refusal);

    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every grant was refused.";
      syncPlugin("adsense", error);
      // Refusals finish the run GREEN with the reason in the note; a network
      // failure is the one thing here worth a red line and a retry.
      if (transportFailures.length) {
        finishRun(runId, false, undefined, error);
        return {
          ...EMPTY_ADSENSE,
          runId,
          authorised: true,
          accounts: outcomeLines(result.accounts),
          warnings: result.warnings,
          error,
        };
      }
      finishRun(runId, true, `not authorised — ${error}`);
      return {
        ...EMPTY_ADSENSE,
        ok: true,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
      };
    }

    writeAdSenseDays(result.days);
    writeAdSenseMonths(result.months);

    /*
      ONE READING, AND ONLY WHEN THE ACCOUNT REPORTS ONE CURRENCY. AdSense pays
      in the publisher's own currency; the field is called `usd` because that
      is what a revenue contract calls a per-month figure and this owner's
      account would report USD, but a EUR publisher would make the LABEL wrong
      and the number right. Two currencies would make the sum wrong, so it is
      not taken.
    */
    const currencies = [...new Set(result.days.map((d) => d.currency))];
    if (currencies.length === 1) {
      const total = result.days.reduce((n, d) => n + d.usd, 0);
      record("adsense.earnings", Number(total.toFixed(2)), {
        currency: currencies[0],
        windowDays: adsense.WINDOW_DAYS,
        sites: new Set(result.days.map((d) => d.site)).size,
        estimated: true,
        accounts: ok.length,
      });
    }

    const note =
      `${result.days.length} day rows, ${result.months.length} month rows, ` +
      `${new Set(result.days.map((d) => d.site)).size} site(s)` +
      (result.accounts.length > 1 ? ` · ${ok.length}/${result.accounts.length} accounts` : "");
    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("adsense", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      rows: result.days.length + result.months.length,
      authorised: true,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("adsense", error);
    return { ...EMPTY_ADSENSE, runId, error };
  }
}

/* ----------------------------------------------------------------- mobile */

/**
 * The two app stores, collected — and both on a slow clock.
 *
 * SIX HOURS, NOT THIRTY MINUTES, AND THE REASON IS WHAT IS ON THE OTHER END.
 * Apple generates one sales report per day and settles a payout once a month;
 * Google rewrites a day's install CSV once a day and writes the earnings ZIP
 * for a month only after that month has closed. Asking either of them every
 * half hour is forty-eight requests a day spent redrawing a figure that moved
 * once — the same trade STOCK_EVERY_HOURS refuses, and the same one
 * TRAFFIC_EVERY_HOURS refuses for GitHub.
 *
 * The skip is not a failure and says so. A run log full of "reports not due"
 * reads as restraint rather than as a broken timer.
 */
export const MOBILE_EVERY_HOURS = 6;

/** The window every mobile figure on the board is drawn over. Apple serves a
 *  year of daily reports and Google keeps every month for the life of the
 *  developer account, so this is a choice about what a card means rather than
 *  a limit either API imposes. */
export const MOBILE_WINDOW_DAYS = 30;

export type MobileSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  /** Apps on Apple's side, packages on Google's — what the run actually saw. */
  apps: number;
  /** New report periods ingested this run. Zero is the ordinary steady state
   *  once a window is filled, not a failure. */
  periods: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_MOBILE = {
  ok: false as const,
  runId: 0,
  skipped: false,
  apps: 0,
  periods: 0,
  accounts: [] as { id: number; label: string; ok: boolean; error?: string }[],
  warnings: [] as string[],
};

/** When this store was last read at all, whatever account did the reading. */
function lastMobileRead(table: "appstore_state" | "play_state"): string | null {
  const row = db.prepare(`SELECT MAX(seen_at) AS ts FROM ${table}`).get() as
    | { ts: string | null }
    | undefined;
  return row?.ts ?? null;
}

function notDue(table: "appstore_state" | "play_state"): string | null {
  const at = lastMobileRead(table);
  if (at && Date.now() - Date.parse(at) < MOBILE_EVERY_HOURS * 3_600_000)
    return `reports not due — read ${ago(at)}`;
  return null;
}

export async function collectAppStore(): Promise<MobileSummary> {
  const runId = startRun("appstore");

  try {
    const skip = notDue("appstore_state");
    if (skip) {
      finishRun(runId, true, skip);
      return { ...EMPTY_MOBILE, ok: true, runId, skipped: true };
    }

    const result = await appstore.collect((id) => ({
      answeredDays: appStoreAnswered(id, "sales"),
      reportedMonths: appStoreAnswered(id, "finance"),
    }));

    if (result.accountsTried === 0) {
      const error = NO_ACCOUNT;
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_MOBILE, runId, error };
    }

    let apps = 0;
    let periods = 0;
    for (const a of result.accounts) {
      if (!a.ok) {
        accounts.markFailed(a.id, a.error ?? "The account did not answer.");
        continue;
      }
      accounts.markOk(a.id);
      apps += a.apps?.length ?? 0;

      writeAppStoreState(a.id, a.label, {
        keyId: a.keyId ?? null,
        issuerId: a.issuerId ?? null,
        vendor: a.vendor ?? null,
        apps: a.apps?.length ?? 0,
      });
      replaceAppStoreApps(a.id, a.label, a.apps ?? []);

      /*
        EVERY DAY APPLE ANSWERED IS RECORDED, INCLUDING THE EMPTY ONES. A day
        with no sales is a measurement — it is stored as `zero` and never
        asked about again — while a day Apple has not generated yet is stored
        as `absent` and asked about tomorrow. Collapsing the two would either
        redraw thirty reports every run or draw a cliff on a day Apple was
        merely slow.
      */
      for (const day of a.sales ?? []) {
        writeAppStoreReport(a.id, "sales", day.day, day.state);
        if (day.state === "reported") {
          writeAppStoreDay(a.id, day.day, day.apps, day.proceeds);
          periods += 1;
        }
      }

      for (const month of a.finance ?? []) {
        writeAppStoreReport(a.id, "finance", month.month, month.state);
        if (month.state === "reported") {
          writeAppStorePayouts(a.id, month.month, month.rows);
          periods += 1;
        }
      }
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("appstore", error);
      return { ...EMPTY_MOBILE, runId, accounts: shapeAccounts(result.accounts), warnings: result.warnings, error };
    }

    /*
      ONE READING, AND IT IS UNITS RATHER THAN MONEY. Downloads over the stored
      window are one number in one unit and make a sparkline worth having.
      Proceeds and payouts are per currency and cannot be a single series
      without an exchange rate nothing here has — so no money reading is
      recorded at all, and the cards read the per-currency tables directly.
    */
    const window = appStoreSales(MOBILE_WINDOW_DAYS);
    record(
      "appstore.downloads",
      window.reduce((n, r) => n + r.downloads, 0),
      { windowDays: MOBILE_WINDOW_DAYS, apps },
    );

    const absent = ok.flatMap((a) => a.absentDays ?? []).length;
    const note =
      `${apps} app${apps === 1 ? "" : "s"}, ${periods} report${periods === 1 ? "" : "s"} ingested` +
      (absent ? ` · ${absent} day(s) Apple has not generated yet` : "") +
      (result.accounts.length > 1
        ? ` · ${ok.length}/${result.accounts.length} accounts`
        : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("appstore", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      apps,
      periods,
      accounts: shapeAccounts(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("appstore", error);
    return { ...EMPTY_MOBILE, runId, error };
  }
}

export async function collectPlay(): Promise<MobileSummary> {
  const runId = startRun("playstore");

  try {
    const skip = notDue("play_state");
    if (skip) {
      finishRun(runId, true, skip);
      return { ...EMPTY_MOBILE, ok: true, runId, skipped: true };
    }

    const result = await play.collect((id) => ({ files: playFiles(id) }));

    if (result.accountsTried === 0) {
      const error = NO_ACCOUNT;
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_MOBILE, runId, error };
    }

    let packages = 0;
    let periods = 0;
    for (const a of result.accounts) {
      if (!a.ok) {
        accounts.markFailed(a.id, a.error ?? "The account did not answer.");
        continue;
      }
      accounts.markOk(a.id);
      packages += a.packages?.length ?? 0;

      writePlayState(a.id, a.label, {
        bucket: a.bucket ?? null,
        serviceAccount: a.serviceAccount ?? null,
        packages: a.packages?.length ?? 0,
      });

      for (const s of a.stats ?? []) writePlayStats(a.id, s.package, s.days);

      /*
        THE FILE ROW IS WRITTEN ONLY AFTER THE MONTH'S ROWS ARE IN. It is the
        record that says "this object has been ingested", and writing it first
        would let a crash between the two turn a half-read month into a month
        that is never read again.
      */
      for (const m of a.earnings ?? []) {
        writePlayEarnings(a.id, m.month, m.rows);
        writePlayFile(a.id, "earnings", m.month, m.file.object, m.file.updated);
        periods += 1;
      }
      for (const m of a.sales ?? []) {
        writePlaySales(a.id, m.month, m.rows);
        writePlayFile(a.id, "sales", m.month, m.file.object, m.file.updated);
        periods += 1;
      }
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("playstore", error);
      return { ...EMPTY_MOBILE, runId, accounts: shapeAccounts(result.accounts), warnings: result.warnings, error };
    }

    // Device installs over the window, in one unit. Money is per currency and
    // stays in its tables, for the same reason it does on Apple's side.
    const window = playStats(MOBILE_WINDOW_DAYS);
    record(
      "play.installs",
      window.reduce((n, r) => n + (r.installs ?? 0), 0),
      { windowDays: MOBILE_WINDOW_DAYS, packages },
    );

    const unchanged = ok.flatMap((a) => a.unchanged ?? []).length;
    const note =
      `${packages} package${packages === 1 ? "" : "s"}, ${periods} report${periods === 1 ? "" : "s"} ingested` +
      (unchanged ? ` · ${unchanged} month(s) unchanged and not re-read` : "") +
      (result.accounts.length > 1
        ? ` · ${ok.length}/${result.accounts.length} accounts`
        : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("playstore", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      apps: packages,
      periods,
      accounts: shapeAccounts(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("playstore", error);
    return { ...EMPTY_MOBILE, runId, error };
  }
}

/** The per-account lines both stores put on the wire, minus the payload the
 *  interface has no use for. */
function shapeAccounts(
  rows: { id: number; label: string; ok: boolean; error?: string }[],
): { id: number; label: string; ok: boolean; error?: string }[] {
  return rows.map((a) => ({ id: a.id, label: a.label, ok: a.ok, error: a.error }));
}

/* -------------------------------------------------------------- cloudflare */

/**
 * How often Cloudflare is asked.
 *
 * SIX HOURS, NOT THIRTY MINUTES, AND THE GRAIN OF THE DATA IS THE REASON.
 * `httpRequests1dGroups` is a DAILY rollup: a figure that moves once a day,
 * plus a partial bucket for today that Cloudflare is still filling in. The DNS
 * records beside it change when a human edits a zone. Asking every half hour is
 * ~1,100 requests a day spent redrawing a number that moved once — the same
 * trade STOCK_EVERY_HOURS and MOBILE_EVERY_HOURS refuse, for the same reason.
 *
 * On this clock the partial day is still refreshed four times before it
 * settles, and a DNS change made at nine is on the page by three.
 *
 * The skip is not a failure and says so. A run log full of "zones not due"
 * reads as restraint rather than as a broken timer.
 */
export const CLOUDFLARE_EVERY_HOURS = 6;

/** The window every Cloudflare figure on the board is drawn over by default.
 *  Ninety days of rollups are available; this is what a card means, not what
 *  the API will serve. */
export const CLOUDFLARE_WINDOW_DAYS = 7;

export type CloudflareSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  zones: number;
  /** Daily rollup rows written this run. Mostly rewrites of days already held,
   *  which is the point — see writeCloudflareTraffic. */
  trafficRows: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_CLOUDFLARE = {
  ok: false as const,
  runId: 0,
  skipped: false,
  zones: 0,
  trafficRows: 0,
  accounts: [] as CloudflareSummary["accounts"],
  warnings: [] as string[],
};

/**
 * Cloudflare: the zones, their records, their daily traffic and whatever the
 * registrar list had to say.
 *
 * AN ACCOUNT FAILS ONLY WHEN ITS ZONE LISTING FAILED. Everything else here is a
 * gap in an answer that arrived: a zone whose records could not be read keeps
 * its row with a note, a zone with no analytics keeps its row with a different
 * note, and a registrar list that was refused is recorded as refused rather
 * than as a portfolio of nothing. An account demoted to "failing" over any of
 * those is an account whose perfectly good token gets re-pasted.
 */
export async function collectCloudflare(): Promise<CloudflareSummary> {
  const runId = startRun("cloudflare");

  try {
    const last = (
      db.prepare("SELECT MAX(seen_at) AS ts FROM cloudflare_state").get() as
        | { ts: string | null }
        | undefined
    )?.ts;
    if (last && Date.now() - Date.parse(last) < CLOUDFLARE_EVERY_HOURS * 3_600_000) {
      const note = `zones not due — read ${ago(last)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_CLOUDFLARE, ok: true, runId, skipped: true };
    }

    const result = await cloudflare.collect();

    if (result.accountsTried === 0) {
      const error = NO_ACCOUNT;
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_CLOUDFLARE, runId, error };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("cloudflare", error);
      return {
        ...EMPTY_CLOUDFLARE,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    /*
      Each account replaces only its own rows, so one token answering 403 costs
      that account's zones and nobody else's. The traffic rows are written once
      for the whole run because they are keyed by Cloudflare's own zone id,
      which is global — the same zone cannot arrive under two accounts.
    */
    for (const a of ok) {
      const zones = result.zones.filter((z) => z.accountId === a.id);
      replaceCloudflareZones(a.id, a.label, zones);
      replaceCloudflareRegistrar(
        a.id,
        a.label,
        result.registrar.filter((r) => r.accountId === a.id),
      );
      writeCloudflareState(a.id, a.label, {
        cfAccountId: a.cfAccountId,
        cfAccountName: a.cfAccountName,
        zones: zones.length,
        registrarReadable: a.registrarReadable,
        registrarCount: a.registrarCount,
        registrarNote: a.registrarNote,
        analyticsZones: a.analyticsZones,
        analyticsNote: a.analyticsNote,
      });
    }
    const trafficRows = writeCloudflareTraffic(result.traffic);

    /*
      TWO READINGS, AND THE FIRST ONE EXCLUDES TODAY.

      Cloudflare is still writing today's bucket, so a seven-day total that
      included it would fall every morning and climb all afternoon — a sawtooth
      describing the collector's clock rather than anything the zones did. The
      window is therefore the seven COMPLETE UTC days ending yesterday, and it
      is recorded as a rolling total the way appstore.downloads is.

      There is no reading for uniques and there will not be one. Cloudflare
      de-duplicates visitors within each zone and each day, so a fleet-wide
      figure would be a sum of overlapping counts — one number in no unit.
      Uniques stay per zone per day, where they are true.
    */
    const zoneCount = result.zones.length;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const since = new Date(Date.now() - CLOUDFLARE_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const complete = result.traffic.filter((r) => r.day >= since && r.day <= yesterday);
    if (complete.length)
      record(
        "cloudflare.requests",
        complete.reduce((n, r) => n + r.requests, 0),
        {
          windowDays: CLOUDFLARE_WINDOW_DAYS,
          through: yesterday,
          zones: new Set(complete.map((r) => r.zoneId)).size,
          accounts: ok.length,
        },
      );
    record("cloudflare.zones", zoneCount, {
      accounts: ok.length,
      withTraffic: ok.reduce((n, a) => n + a.analyticsZones, 0),
    });

    const blind = result.zones.filter((z) => z.trafficNote).length;
    const unreadable = result.zones.filter((z) => z.recordsNote).length;
    const note =
      `${zoneCount} zone${zoneCount === 1 ? "" : "s"}, ${trafficRows} day row(s)` +
      (blind ? ` · ${blind} without analytics` : "") +
      (unreadable ? ` · ${unreadable} without records` : "") +
      (result.accounts.length > 1 ? ` · ${ok.length}/${result.accounts.length} accounts` : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("cloudflare", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      zones: zoneCount,
      trafficRows,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("cloudflare", error);
    return { ...EMPTY_CLOUDFLARE, runId, error };
  }
}

/* ----------------------------------------------------------------- search */

/**
 * How often the two search engines are asked.
 *
 * SIX HOURS, FOR THE REASON GITHUB'S TRAFFIC IS ON A SLOW CLOCK. Neither
 * engine has anything new to say in half an hour. Search Console finalises a
 * day over two to three days and this collector deliberately never reads
 * closer than three days back; Bing's traffic, crawl and query reports are all
 * stamped by DAY. At the ordinary cadence, nineteen Search Console properties
 * at five calls each would be 4,560 requests a day spent redrawing the same
 * finalised numbers — and the last three days of them would still be missing,
 * because they are not finished. On this clock it is 384, and a property whose
 * traffic moved is still seen the same morning.
 *
 * A run that skips says so as a NOTE rather than an error, exactly as the
 * stock quota does: a log full of "not due" reads as restraint, and a log full
 * of failures reads as a broken timer.
 */
export const SEARCH_EVERY_HOURS = 6;

export type SearchSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  /** Properties or verified sites written this run. Zero on a skipped run. */
  sites: number;
  /** Day rows written. Mostly rewrites of days already held, which is the
   *  point: Google revises a day for two to three days after it. */
  days: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_SEARCH = {
  ok: false as const,
  sites: 0,
  days: 0,
  skipped: false,
  accounts: [] as SearchSummary["accounts"],
  warnings: [] as string[],
};

/** The newest row of a table whose column is called `seen_at`, or null when
 *  the table has never been written. The clock's question is "when did we last
 *  spend requests here", which is a fact about the table and not an account. */
function lastSeenAt(table: string): string | null {
  const row = db.prepare(`SELECT MAX(seen_at) AS ts FROM ${table}`).get() as
    | { ts: string | null }
    | undefined;
  return row?.ts ?? null;
}

export async function collectGsc(): Promise<SearchSummary> {
  const runId = startRun("gsc");

  try {
    const at = lastSeenAt("gsc_sites");
    if (at && Date.now() - Date.parse(at) < SEARCH_EVERY_HOURS * 3_600_000) {
      const note = `Search Console not due — read ${ago(at)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_SEARCH, ok: true, runId, skipped: true };
    }

    const result = await gsc.collect();
    if (result.accountsTried === 0) {
      const error = "No account is connected.";
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_SEARCH, runId, error };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    let sites = 0;
    let dayRows = 0;
    let clicks = 0;
    let impressions = 0;

    for (const account of result.accounts) {
      if (!account.ok || !account.properties) continue;
      /*
        Properties this key can no longer see are forgotten BEFORE the new ones
        are written, so a property removed from the service account's access
        leaves the board on the next run rather than sitting there with figures
        nobody can refresh. Its days go with it: they are keyed by property, and
        a series nothing can extend is not a series.
      */
      forgetGscProperties(
        account.id,
        account.properties.map((p) => p.property),
      );

      for (const p of account.properties) {
        sites += 1;
        /*
          A property that failed keeps every day it has already earned — only
          its state row is rewritten, carrying its own error. Wiping its history
          because one call timed out would turn a bad minute into a hole in a
          ninety-day chart.
        */
        if (!p.error) {
          dayRows += writeGscDays(p.property, p.days);
          replaceGscRanked("queries", p.property, p.queries);
          replaceGscRanked("pages", p.property, p.pages);
          clicks += p.totals.clicks;
          impressions += p.totals.impressions;
        }
        writeGscSite({
          property: p.property,
          account_id: account.id,
          account_label: account.label,
          permission: p.permission,
          window_start: p.error ? null : p.window.start,
          window_end: p.error ? null : p.window.end,
          total_clicks: p.error ? null : p.totals.clicks,
          total_impressions: p.error ? null : p.totals.impressions,
          total_position: p.error ? null : p.totals.position,
          /*
            The ranked rows' own sums, written beside the total they are a
            fraction OF. This pair is the evidence for the anonymisation caveat
            every query card carries: on this account it ranges from 2% to 77%
            of a property's impressions, so nothing downstream may present the
            sum of query rows as a total.
          */
          query_rows: p.error ? null : p.queries.length,
          query_impressions: p.error
            ? null
            : p.queries.reduce((a, q) => a + q.impressions, 0),
          query_clicks: p.error ? null : p.queries.reduce((a, q) => a + q.clicks, 0),
          sitemap_state: p.sitemaps.state,
          sitemap_count: p.sitemaps.count,
          sitemap_submitted: p.sitemaps.submitted,
          sitemap_errors: p.sitemaps.errors,
          sitemap_warnings: p.sitemaps.warnings,
          sitemap_pending: p.sitemaps.pending,
          sitemap_downloaded: p.sitemaps.lastDownloaded,
          error: p.error,
        });
      }
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("gsc", error);
      return { ...EMPTY_SEARCH, runId, accounts: outcomeLines(result.accounts), warnings: result.warnings, error };
    }

    /* The note names the window as well as the figures, because a clicks total
       with no window is not a measurement — and this one deliberately stops
       three days short of today. */
    const note =
      `${sites} propert${sites === 1 ? "y" : "ies"} · ` +
      `${impressions.toLocaleString("en-GB")} impressions, ` +
      `${clicks.toLocaleString("en-GB")} clicks over ${gsc.WINDOW_DAYS}d ` +
      `to ${gsc.window(gsc.WINDOW_DAYS).end} · ${dayRows} day rows`;

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("gsc", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      sites,
      days: dayRows,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("gsc", error);
    return { ...EMPTY_SEARCH, runId, error };
  }
}

export async function collectBing(): Promise<SearchSummary> {
  const runId = startRun("bing-webmaster");

  try {
    /*
      THE PHRASE LIST IS A SETTING AND MAY BE EMPTY, which is the ordinary
      state rather than a failure. Bing answers four other questions per site
      without one; with no phrases named there is simply nothing to ask
      GetKeywordStats about, exactly as npm has nothing to ask about without a
      package list. Nothing here invents a phrase to fill the gap.
    */
    const phrases = bing.parseKeywords(configValue("bing-webmaster", "keywords") ?? "");
    forgetBingKeywords(phrases);

    /*
      A PHRASE NOBODY HAS EVER ASKED ABOUT IS ASKED ABOUT IMMEDIATELY, whatever
      the clock says — the escape GitHub's traffic collector keeps for a repo it
      has never seen, and for the same reason: the point of typing a list in at
      nine is to see it, and a card that stays blank until three reads as a
      setting that did not save. The rest of the run goes with it rather than
      being skipped around; it is twelve requests, and a special case that reads
      only the new phrases would be more code than the calls are worth.
    */
    const asked = new Set(bingKeywordStates().map((k) => k.phrase));
    const unasked = phrases.filter((p) => !asked.has(p));

    const at = lastSeenAt("bing_sites");
    if (at && !unasked.length && Date.now() - Date.parse(at) < SEARCH_EVERY_HOURS * 3_600_000) {
      const note = `Bing Webmaster not due — read ${ago(at)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_SEARCH, ok: true, runId, skipped: true };
    }

    const result = await bing.collect(phrases);
    if (result.accountsTried === 0) {
      const error = "No account is connected.";
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_SEARCH, runId, error };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    let sites = 0;
    let dayRows = 0;
    let measured = 0;

    for (const account of result.accounts) {
      if (!account.ok || !account.sites) continue;
      forgetBingSites(account.id, account.sites.map((s) => s.site));

      for (const s of account.sites) {
        sites += 1;
        dayRows += writeBingTrafficDays(
          s.site,
          s.traffic.map((d) => ({ site: s.site, day: d.day, impressions: d.impressions, clicks: d.clicks })),
        );
        dayRows += writeBingCrawlDays(
          s.site,
          s.crawl.map((d) => ({
            site: s.site,
            day: d.day,
            crawled_pages: d.crawledPages,
            in_index: d.inIndex,
            in_links: d.inLinks,
            crawl_errors: d.crawlErrors,
            blocked_robots: d.blockedRobots,
            code_2xx: d.code2xx,
            code_4xx: d.code4xx,
            code_5xx: d.code5xx,
          })),
        );
        writeBingQueries(
          s.site,
          s.queries.map((q) => ({
            site: s.site,
            query: q.query,
            day: q.day,
            impressions: q.impressions,
            clicks: q.clicks,
            position: q.position,
          })),
        );

        /* The newest crawl row is the site's current state; the whole series is
           in bing_crawl_days beside it. Newest by DAY rather than by position
           in the array, because the API's order is not something to rely on. */
        const newest = [...s.crawl].sort((a, b) => a.day.localeCompare(b.day)).at(-1) ?? null;
        writeBingSite({
          site: s.site,
          account_id: account.id,
          account_label: account.label,
          verified: s.verified ? 1 : 0,
          in_index: newest?.inIndex ?? null,
          in_links: newest?.inLinks ?? null,
          crawled_pages: newest?.crawledPages ?? null,
          crawl_errors: newest?.crawlErrors ?? null,
          blocked_robots: newest?.blockedRobots ?? null,
          crawl_day: newest?.day ?? null,
          linked_pages: s.links.linkedPages,
          link_pages_total: s.links.totalPages,
          error: s.error,
        });
      }

      for (const k of account.keywords ?? []) {
        writeBingKeyword(k.phrase, bing.MARKET_LABEL, k.status, k.weeks, k.error);
        if (k.status === "ok") measured += 1;
      }
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("bing-webmaster", error);
      return { ...EMPTY_SEARCH, runId, accounts: outcomeLines(result.accounts), warnings: result.warnings, error };
    }

    /* The keyword clause names what was MEASURED rather than what was asked,
       and it is absent entirely when nothing was asked — "0 of 0 phrases" on a
       run note reads as a failure of a thing nobody requested. */
    const note =
      `${sites} verified site${sites === 1 ? "" : "s"} · ${dayRows} day rows` +
      (phrases.length ? ` · ${measured} of ${phrases.length} phrases measured` : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("bing-webmaster", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      sites,
      days: dayRows,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("bing-webmaster", error);
    return { ...EMPTY_SEARCH, runId, error };
  }
}

/* ------------------------------------------------------------------ social */

/**
 * How often Meta is asked.
 *
 * SIX HOURS, for the reason CLOUDFLARE_EVERY_HOURS and SEARCH_EVERY_HOURS are:
 * the grain of the data, not the cost of the call. Meta aggregates ad insights
 * into whole days and revises the recent ones; a Page's follower count moves
 * when a person presses a button, which on this portfolio is a few times a
 * month. Asking every half hour is ~340 requests a day spent redrawing figures
 * that moved once, and on this clock today's still-settling day is refreshed
 * four times before it closes.
 *
 * A skipped run says so — "Meta not due — read 4h ago" — rather than looking
 * like a broken timer.
 */
export const SOCIAL_EVERY_HOURS = 6;

export type SocialSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  pages: number;
  adAccounts: number;
  /** Daily rows written this run. Mostly rewrites of days already held, which
   *  is the point — see writeMetaAdDays. */
  dayRows: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_SOCIAL = {
  ok: false as const,
  runId: 0,
  skipped: false,
  pages: 0,
  adAccounts: 0,
  dayRows: 0,
  accounts: [] as SocialSummary["accounts"],
  warnings: [] as string[],
};

/**
 * Meta: the Pages, the ad accounts, and what the ads have been doing.
 *
 * AN ACCOUNT FAILS ONLY WHEN `/me` FAILED. Everything under it is a gap in an
 * answer that arrived: a Page listing that refuses while the ad accounts answer
 * is a note on the account, and an ad account whose campaign edge refuses keeps
 * its name, its currency and its spend. An account demoted to "failing" over
 * any of those is an account whose perfectly good token gets re-pasted — the
 * trade Cloudflare and GitHub both make, for the same reason.
 *
 * THREE READINGS, AND EACH ONE IS A FIGURE THAT MOVES.
 *
 * `meta.followers` is the only Page figure this token can measure at all — the
 * reach metrics were retired and everything else needs a Page Access Token it
 * cannot mint — so it is the one Page series worth accumulating, summed across
 * Pages because a follower is a follower of exactly one Page and the counts do
 * add up. `meta.spend` and `meta.leads` are recorded as the WINDOW's own totals
 * sampled every collection, which is a real series about a real thing; nothing
 * stored anywhere says "€61.90 this month" in a way that could decay, because
 * the daily rows behind it are re-read and corrected on every run.
 *
 * Spend is recorded ONLY when every active ad account shares one currency, and
 * the currency travels with the reading. Two ad accounts in two currencies have
 * no single spend figure, and a series that quietly became a sum of euro and
 * dollars is worse than no series — so it stops rather than lying, and the
 * route reports per currency regardless.
 */
export async function collectMeta(): Promise<SocialSummary> {
  const runId = startRun("meta");

  try {
    const last = (
      db.prepare("SELECT MAX(seen_at) AS ts FROM meta_state").get() as
        | { ts: string | null }
        | undefined
    )?.ts;
    if (last && Date.now() - Date.parse(last) < SOCIAL_EVERY_HOURS * 3_600_000) {
      const note = `Meta not due — read ${ago(last)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_SOCIAL, ok: true, runId, skipped: true };
    }

    const result = await meta.collect();

    if (result.accountsTried === 0) {
      const error = NO_ACCOUNT;
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_SOCIAL, runId, error };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The account did not answer.");
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("meta", error);
      return {
        ...EMPTY_SOCIAL,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    for (const a of ok) {
      const pages = result.pages.filter((p) => p.accountId === a.id);
      const adAccounts = result.adAccounts.filter((x) => x.accountId === a.id);
      replaceMetaPages(a.id, a.label, pages);
      replaceMetaAdAccounts(a.id, a.label, adAccounts);
      /* Campaigns are replaced per AD ACCOUNT rather than per plugin account,
         so one ad account's edge refusing cannot clear another's rows. An ad
         account whose campaign list AND insights both failed writes an empty
         set, which is correct: it has nothing to say this run. */
      for (const acct of adAccounts)
        replaceMetaCampaigns(
          acct.id,
          result.campaigns.filter((c) => c.adAccountId === acct.id),
        );
      writeMetaState(a.id, a.label, {
        user: a.user ?? null,
        userId: a.userId ?? null,
        proofed: a.proofed ?? false,
        pages: pages.length,
        pagesChecked: a.pagesChecked ?? 0,
        igLinked: a.instagramLinked ?? 0,
        adAccounts: adAccounts.length,
        note: (a.notes ?? []).join(" · ") || null,
      });
    }

    /* Keyed by the ad account's own global id, so the rows are written once for
       the whole run rather than per plugin account — the same reason
       cloudflare_traffic is. */
    const dayRows = writeMetaAdDays(result.days);

    const pagesWithFollowers = result.pages.filter((p) => p.followers !== null);
    if (pagesWithFollowers.length)
      record(
        "meta.followers",
        pagesWithFollowers.reduce((n, p) => n + (p.followers ?? 0), 0),
        {
          pages: pagesWithFollowers.length,
          /* Named because the two are different questions and Meta has both
             fields: followers_count is people following, fan_count is people
             who liked. A total mixing the two says which Pages contributed
             which. */
          sources: [...new Set(pagesWithFollowers.map((p) => p.followersSource))],
        },
      );

    const active = result.adAccounts.filter((a) => a.active && a.window);
    const currencies = [...new Set(active.map((a) => a.currency ?? "unknown"))];
    if (active.length && currencies.length === 1) {
      const spend = active.reduce((n, a) => n + (a.window?.spend ?? 0), 0);
      record("meta.spend", spend, {
        currency: currencies[0],
        adAccounts: active.length,
        windowDays: meta.WINDOW_DAYS,
      });
      const leads = active.reduce(
        (n, a) => n + (a.window?.leads ?? 0),
        0,
      );
      /* Leads add up where reach does not: a lead is one form submission, and
         two campaigns cannot submit the same one. Recorded with the attribution
         window it was counted over, because the same twelve leads are a
         different number at a different window and a series that silently
         changed windows would draw a step nobody caused. */
      if (active.some((a) => a.window?.leads !== null))
        record("meta.leads", leads, {
          attribution: meta.ATTRIBUTION_LABEL,
          adAccounts: active.length,
        });
    }

    const pageCount = result.pages.length;
    const adCount = result.adAccounts.length;
    const igLinked = result.pages.filter((p) => p.instagram.id).length;
    /*
      THE RUN NOTE SAYS THE INSTAGRAM FINDING OUT LOUD, because it is the one
      thing about this integration a reader would otherwise take for a broken
      collector. "0 of 3 Pages" is a measurement — the question was asked of
      every Page and every Page answered no — and it reads completely
      differently from an absent clause.
    */
    const note =
      `${pageCount} Page${pageCount === 1 ? "" : "s"} · ` +
      `${igLinked} of ${pageCount} with an Instagram Business account · ` +
      `${adCount} ad account${adCount === 1 ? "" : "s"} · ${dayRows} day rows`;

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("meta", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      pages: pageCount,
      adAccounts: adCount,
      dayRows,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("meta", error);
    return { ...EMPTY_SOCIAL, runId, error };
  }
}

/* ------------------------------------------------------------------ demand */

/**
 * How often the three demand sources are asked.
 *
 * SIX HOURS, for the reason SEARCH_EVERY_HOURS and SOCIAL_EVERY_HOURS are —
 * and with a harder floor under it than either. A Reddit thread is posted
 * once and its score matures over a day; Algolia's index of Hacker News is
 * quick, but the window being searched is a YEAR wide and does not move in
 * half an hour. Asking every thirty minutes would be forty-eight requests a
 * day per phrase to redraw the same threads, spent against two free endpoints
 * nobody is obliged to serve us.
 *
 * A phrase newly typed is asked immediately regardless, the escape the Bing
 * keyword collector keeps: the point of typing a watch list in at nine is to
 * see it, and a card blank until three reads as a setting that did not save.
 */
export const DEMAND_EVERY_HOURS = 6;

/**
 * THE WATCH LIST IS ONE LIST WITH THREE DOORS TO IT.
 *
 * A phrase is the same phrase whichever site it was said on, so Reddit and
 * Hacker News share `terms` and the config registry mirrors a write on either
 * onto the other — see routes/pluginConfig.ts. This reads whichever door has
 * a value, so a mirror that has not happened yet (a value written before this
 * shipped, say) still collects rather than reporting an empty list.
 */
export function watchTerms(): string[] {
  const raw =
    configValue("reddit", "terms") ?? configValue("hackernews", "terms") ?? "";
  return demand.parseTerms(raw);
}

const NO_TERMS =
  "No watch phrases configured. Neither source needs a key, but both need to " +
  "know what to watch for — set the list on the plugin page.";

/** The newest answer this source has on record, whatever it said. The clock's
 *  question is "when did we last spend requests here". */
function lastAskedAt(source: string): string | null {
  const row = db
    .prepare("SELECT MAX(asked_at) AS ts FROM demand_queries WHERE source = ?")
    .get(source) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

/**
 * Phrases this source still owes an answer for. They bypass the clock.
 *
 * TWO CASES AND THEY ARE THE SAME CASE. A phrase typed five minutes ago has
 * never been asked, and the escape for it is the one the Bing keyword
 * collector keeps: a card blank until three reads as a setting that did not
 * save. A phrase the last run DEFERRED has not been asked either — Reddit's
 * anonymous budget only stretches to one query a collection, so the tail of
 * the list is left for next time — and if that did not bypass the clock, the
 * tail would wait six hours per phrase and a list of five would take a day and
 * a half to be answered once.
 *
 * A phrase that was THROTTLED or FAILED is deliberately not in here. Those are
 * the source's answers rather than our decisions, and retrying a refusal every
 * thirty minutes is how a polite collector becomes an impolite one.
 */
function pendingTerms(source: string, terms: string[]): string[] {
  const answered = new Set(
    demandQueries(source)
      .filter((q) => q.status !== "skipped")
      .map((q) => q.term),
  );
  return terms.filter((t) => !answered.has(t));
}

export type DemandSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  /** Phrases actually put to the source this run. */
  asked: number;
  /** Phrases deliberately left for the next run — Reddit's budget, never a
   *  failure and never a zero. */
  deferred: number;
  /** Rows written. Mostly rewrites of threads already held, which is the
   *  point: a thread's score goes on moving after it is posted. */
  items: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_DEMAND = {
  ok: false as const,
  skipped: false,
  asked: 0,
  deferred: 0,
  items: 0,
  accounts: [] as DemandSummary["accounts"],
  warnings: [] as string[],
};

/**
 * Reddit, collected.
 *
 * THE CREDENTIAL IS OPTIONAL AND THE FLAG DOES NOT FOLLOW IT. Every other
 * plugin here is connected when an account is; this one is connected when
 * there is a LIST — npm's rule, for npm's reason — because the Atom feed
 * answers anonymously and a feed token only lifts the throttle. An account
 * with no phrases would collect nothing and say "connected" while doing it;
 * phrases with no account collect immediately, four times more slowly.
 *
 * THE TIER THAT ANSWERED IS WRITTEN DOWN PER PHRASE AND PER ROW, and the run
 * note names it. "27 threads from the Atom feed" and "27 threads from SearXNG,
 * unscored and unaged" are different claims and a run log that could not tell
 * them apart would be a log of the wrong thing entirely.
 */
export async function collectReddit(): Promise<DemandSummary> {
  const runId = startRun("reddit");
  const terms = watchTerms();

  if (!terms.length) {
    finishRun(runId, false, undefined, NO_TERMS);
    upsertPlugin("reddit", false, NO_TERMS);
    return { ...EMPTY_DEMAND, runId, error: NO_TERMS };
  }

  // A phrase taken off the list takes its threads with it, or they would go on
  // counting inside every total while appearing under no phrase on the page.
  forgetDemandTerms(terms);

  try {
    const pending = pendingTerms("reddit", terms);
    const at = lastAskedAt("reddit");
    if (at && !pending.length && Date.now() - Date.parse(at) < DEMAND_EVERY_HOURS * 3_600_000) {
      const note = `Reddit not due — asked ${ago(at)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_DEMAND, ok: true, runId, skipped: true };
    }

    /*
      THE SAFETY NET IS ANOTHER PLUGIN'S CREDENTIAL, and reaching for it is
      deliberate rather than convenient: SearXNG is the tier that answers when
      Reddit will not, so a Reddit run that could not see it would degrade to
      nothing on the day the feeds close. Null is the ordinary state — the net
      is simply not strung — and the run says so rather than failing.
    */
    const searx = searxng.borrowKey("collect_reddit_fallback");
    const run = await demand.collectReddit(demandOrderedTerms("reddit", terms), {
      searx,
      reader: "collect_reddit",
    });

    let items = 0;
    if (run.signals.length)
      items = writeDemandItems(
        run.signals.map((s) => ({
          source: s.source,
          id: s.id,
          term: s.term,
          title: s.title,
          url: s.url,
          context: s.context,
          created_at: s.createdAt,
          points: s.points,
          comments: s.comments,
          tier: s.tier,
        })),
      );
    for (const o of run.outcomes)
      writeDemandQuery({
        source: o.source,
        term: o.term,
        status: o.status,
        tier: o.tier,
        items: o.items,
        error: o.error,
      });

    /*
      THE ACCOUNT'S STATE IS ABOUT THE TOKEN AND NOTHING ELSE. A token that
      served a query is working; a run in which Reddit refused every attempt
      while holding a token is the one case where the token itself is
      suspect, and it is recorded against that account rather than against the
      plugin — the same split every other provider here keeps.
    */
    const served = run.outcomes.some((o) => o.tier === "feed+token");
    const answered = run.outcomes.filter((o) => o.status === "ok");
    if (run.account) {
      if (served) accounts.markOk(run.account.id);
      else if (!answered.length)
        accounts.markFailed(
          run.account.id,
          run.outcomes.find((o) => o.error)?.error ??
            "Reddit did not serve a single query with this feed token.",
        );
    }

    if (!answered.length) {
      const error =
        run.outcomes.find((o) => o.error)?.error ?? "Reddit answered nothing at all.";
      finishRun(runId, false, undefined, error);
      upsertPlugin("reddit", true, error);
      return {
        ...EMPTY_DEMAND,
        runId,
        asked: run.asked,
        deferred: run.skipped,
        accounts: run.account
          ? [{ id: run.account.id, label: run.account.label, ok: false, error }]
          : [],
        warnings: run.warnings,
        error,
      };
    }

    /* The note names the TIER and the pacing, because those are the two facts
       that decide what the numbers underneath are worth. */
    const byTier = new Map<string, number>();
    for (const o of answered)
      if (o.tier) byTier.set(o.tier, (byTier.get(o.tier) ?? 0) + 1);
    const tiers = [...byTier.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tier, n]) => `${demand.TIER_LABEL[tier as demand.Tier] ?? tier} (${n})`)
      .join(" · ");
    const note =
      `${answered.length} of ${terms.length} phrase${terms.length === 1 ? "" : "s"} ` +
      `answered · ${items} thread rows · ${tiers}` +
      (run.enrichable
        ? ` · ${run.enriched} of ${run.enrichable} enriched with upvote counts`
        : "") +
      (run.skipped
        ? ` · ${run.skipped} left for the next run at ${run.gapMs / 1000}s a query`
        : "");

    finishRun(runId, true, note, run.warnings.join("; ") || undefined);
    upsertPlugin("reddit", true, run.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      asked: run.asked,
      deferred: run.skipped,
      items,
      accounts: run.account
        ? [{ id: run.account.id, label: run.account.label, ok: served }]
        : [],
      warnings: run.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    upsertPlugin("reddit", true, error);
    return { ...EMPTY_DEMAND, runId, error };
  }
}

/**
 * Hacker News, collected.
 *
 * NO ACCOUNTS AT ALL, and no room for one: Algolia's index is public and there
 * is nothing to seal. So "connected" means "there is a list", exactly as it
 * does for npm — this plugin's flag is written here rather than derived by
 * syncPlugin, whose rule (any account connected) would read false forever.
 *
 * EVERY PHRASE, EVERY RUN, unlike Reddit. There is no throttle to spread the
 * list across runs for, and a phrase asked at a different hour from its
 * neighbour would make "which of these is growing" a comparison across two
 * different windows.
 */
export async function collectHackerNews(): Promise<DemandSummary> {
  const runId = startRun("hackernews");
  const terms = watchTerms();

  if (!terms.length) {
    finishRun(runId, false, undefined, NO_TERMS);
    upsertPlugin("hackernews", false, NO_TERMS);
    return { ...EMPTY_DEMAND, runId, error: NO_TERMS };
  }

  forgetDemandTerms(terms);

  try {
    const pending = pendingTerms("hn", terms);
    const at = lastAskedAt("hn");
    if (at && !pending.length && Date.now() - Date.parse(at) < DEMAND_EVERY_HOURS * 3_600_000) {
      const note = `Hacker News not due — asked ${ago(at)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_DEMAND, ok: true, runId, skipped: true };
    }

    const run = await demand.collectHn(terms);

    let items = 0;
    if (run.signals.length)
      items = writeDemandItems(
        run.signals.map((s) => ({
          source: s.source,
          id: s.id,
          term: s.term,
          title: s.title,
          url: s.url,
          context: s.context,
          created_at: s.createdAt,
          points: s.points,
          comments: s.comments,
          tier: s.tier,
        })),
      );
    for (const o of run.outcomes)
      writeDemandQuery({
        source: o.source,
        term: o.term,
        status: o.status,
        tier: o.tier,
        items: o.items,
        error: o.error,
      });

    const answered = run.outcomes.filter((o) => o.status === "ok");
    if (!answered.length) {
      const error =
        run.outcomes.find((o) => o.error)?.error ?? "Algolia answered nothing at all.";
      finishRun(runId, false, undefined, error);
      upsertPlugin("hackernews", true, error);
      return { ...EMPTY_DEMAND, runId, warnings: run.warnings, error };
    }

    /* Stories and comments are counted apart on the note for the reason they
       are kept apart everywhere else: a comment has no score in this index, so
       a run of nothing but comments is a run that measured nothing. */
    const comments = run.signals.filter((s) => s.context === "comment").length;
    const note =
      `${answered.length} of ${terms.length} phrase${terms.length === 1 ? "" : "s"} ` +
      `answered · ${items} rows · ${run.signals.length - comments} stories, ` +
      `${comments} comments`;

    finishRun(runId, true, note, run.warnings.join("; ") || undefined);
    upsertPlugin("hackernews", true, run.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      asked: terms.length,
      deferred: 0,
      items,
      accounts: [],
      warnings: run.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    upsertPlugin("hackernews", true, error);
    return { ...EMPTY_DEMAND, runId, error };
  }
}

export type SearxngSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  /** Links the probe came back with. Zero is a measurement — every engine
   *  refused — and null is a probe that never completed. */
  results: number | null;
  ms: number | null;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_SEARXNG = {
  ok: false as const,
  skipped: false,
  results: null,
  ms: null,
  accounts: [] as SearxngSummary["accounts"],
  warnings: [] as string[],
};

/**
 * The search node, probed.
 *
 * ONE QUERY A COLLECTION, AND IT IS A REAL ONE. There is no "check my health"
 * endpoint — /healthz answers 401 without the key like everything else, and it
 * says nothing about whether the engines behind the node are working — so the
 * probe IS a search, the way the stock libraries' quota check IS a search.
 * Spending it on a watch phrase rather than on a dummy string costs the node
 * exactly the same and asks something somebody wanted asked.
 *
 * WHAT IS RECORDED AS A READING AND WHAT IS NOT. The round trip and the number
 * of engines that answered are sampled every collection, because each is a
 * single figure about the node AS IT STANDS and the series is the only way to
 * see it degrade — a node that has been down to one engine for a week is the
 * finding, and no single probe can say it. The results count is not a reading:
 * it is a property of the phrase that was searched, and a series of it would
 * be a chart of which term the probe happened to spend itself on.
 */
export async function collectSearxng(): Promise<SearxngSummary> {
  const runId = startRun("searxng");

  try {
    const at = lastSeenAt("searxng_state");
    /*
      THE CLOCK DOES NOT APPLY ACROSS A CHANGE OF INSTANCE, which is the same
      correction MAIL_EVERY_HOURS needed for an account it had never read. A
      clock that exists to avoid REDUNDANT work does not get to call a probe of
      a different node redundant: the endpoint can move from the remote node to
      a locally installed one in a single click, and every row on the page —
      the latency, the engines, the on-site count — would then describe a node
      the box has stopped searching, for up to six hours, with nothing on the
      page able to say so.
    */
    const probed = searxngStates()[0]?.url ?? null;
    const sameNode = probed === null || probed === searxng.endpoint();
    if (at && sameNode && Date.now() - Date.parse(at) < DEMAND_EVERY_HOURS * 3_600_000) {
      const note = `search node not due — probed ${ago(at)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_SEARXNG, ok: true, runId, skipped: true };
    }

    /*
      THE PROBE IS THE QUERY THIS BOX ACTUALLY DEPENDS ON THE NODE FOR: a
      `site:reddit.com` search, which is exactly what Reddit's fallback tier
      asks. A plain query would prove the node answers; this proves it answers
      the KIND of question that matters, and on 2026-09-04 those were different
      facts — ten links came back and not one was on reddit.com.

      The phrase is a watch term where there is one, so the request the node
      serves is a request somebody wanted. Never a randomly generated one: a
      probe whose query changes every run cannot be compared with the last.
    */
    const probeTerm = watchTerms()[0] ?? "self hosted search";
    const probeQuery = `site:${searxng.PROBE_SITE} ${probeTerm}`;
    const result = await searxng.collect(probeQuery);
    if (result.accountsTried === 0) {
      finishRun(runId, false, undefined, NO_ACCOUNT);
      return { ...EMPTY_SEARXNG, runId, error: NO_ACCOUNT };
    }

    let results: number | null = null;
    let ms: number | null = null;
    for (const a of result.accounts) {
      if (a.ok && a.answer) {
        accounts.markOk(a.id);
        const answer = a.answer;
        writeSearxngState({
          account_id: a.id,
          account_label: a.label,
          url: a.url,
          ok: 1,
          query: answer.query,
          results: answer.results.length,
          on_site: searxng.onSite(answer),
          ms: answer.ms,
          engines_ok: answer.answered.length,
          engines_bad: answer.unresponsive.length,
          error: null,
        });
        replaceSearxngEngines(a.id, [
          ...answer.answered.map((e) => ({ engine: e.engine, results: e.results, refused: null })),
          ...answer.unresponsive.map((e) => ({
            engine: e.engine,
            results: 0,
            refused: e.reason,
          })),
        ]);
        record("searxng.latency", answer.ms, { query: answer.query, account: a.label });
        record("searxng.engines", answer.answered.length, {
          refused: answer.unresponsive.length,
        });
        results = (results ?? 0) + answer.results.length;
        ms = ms === null ? answer.ms : Math.max(ms, answer.ms);
      } else {
        accounts.markFailed(a.id, a.error ?? "The node did not answer.");
        /*
          A FAILED PROBE WRITES THE FAILURE AND LEAVES THE ENGINE TABLE ALONE.
          Replacing it with an empty list would draw "no engines are working"
          over a node nobody could reach, which is a different and much more
          alarming claim than the one that is true.
        */
        writeSearxngState({
          account_id: a.id,
          account_label: a.label,
          url: a.url,
          ok: 0,
          query: probeQuery,
          results: null,
          on_site: null,
          ms: null,
          engines_ok: null,
          engines_bad: null,
          error: a.error ?? "The node did not answer.",
        });
      }
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every account failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("searxng", error);
      return {
        ...EMPTY_SEARXNG,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    /* The note names the engines rather than the links, because ten links from
       one engine and ten from five are the same number and not the same node. */
    const answer = ok[0]!.answer!;
    const matched = searxng.onSite(answer);
    const note =
      `${answer.results.length} links for “${answer.query}” in ${answer.ms}ms · ` +
      /* On-site first, because it is the figure that can be zero while the
         result count looks healthy. */
      `${matched} on ${searxng.PROBE_SITE} · ` +
      `${answer.answered.length} engine${answer.answered.length === 1 ? "" : "s"} answered` +
      (answer.unresponsive.length
        ? ` · refused: ${answer.unresponsive.map((u) => `${u.engine} (${u.reason})`).join(", ")}`
        : "");

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("searxng", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      results,
      ms,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("searxng", error);
    return { ...EMPTY_SEARXNG, runId, error };
  }
}

/* -------------------------------------------------------------------- mail */

/**
 * How often the mailboxes and the sending domains are asked.
 *
 * TWO HOURS, and it is the shortest clock on this box after the half-hourly
 * default — which is backwards from every other slow collector here and is the
 * point. Cloudflare, the app stores and Search Console are on six because the
 * figures they report move once a day; an inbox moves while you are looking at
 * it, and "there are four things waiting" read at breakfast is worth nothing by
 * eleven. The same is true of a bounce: `last_event` on a Resend row changes
 * within minutes of a send.
 *
 * It is not the half-hourly default either, because a full Gmail pass is a few
 * hundred requests — the label counters are cheap and the thread reads are not
 * — and redrawing a triage queue forty-eight times a day would spend an order
 * of magnitude more of Google's budget than the answer moves. Two hours is what
 * the previous system's collector settled on over the same mailbox, and it is a figure that
 * has actually been run.
 *
 * A skipped run says so — "Gmail not due — read 1h ago" — rather than looking
 * like a broken timer.
 */
export const MAIL_EVERY_HOURS = 2;

export type MailSummary = {
  ok: boolean;
  runId: number;
  skipped: boolean;
  /** Mailboxes read, or sending domains read. */
  read: number;
  /** Day rows for Gmail; email rows for Resend. Mostly rewrites of rows already
   *  held, which is the point — see writeResendEmails. */
  rows: number;
  accounts: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

const EMPTY_MAIL = {
  ok: false as const,
  runId: 0,
  skipped: false,
  read: 0,
  rows: 0,
  accounts: [] as MailSummary["accounts"],
  warnings: [] as string[],
};

/** When this provider's per-account state table was last written. */
function lastMailRead(table: "gmail_mailboxes" | "resend_state"): string | null {
  return (
    (
      db.prepare(`SELECT MAX(seen_at) AS ts FROM ${table}`).get() as
        | { ts: string | null }
        | undefined
    )?.ts ?? null
  );
}

/**
 * Is this collector due — and if not, is there an account it has never read?
 *
 * THE SECOND HALF IS THE PART WORTH HAVING, and Resend is what forced it. Eleven
 * keys are added one at a time, each through `POST /accounts`, and each add
 * kicks off a collection. With a plain "was anything read in the last two
 * hours" guard, the first key would collect and the other ten would be told the
 * provider was not due — leaving ten sending domains blank until the timer came
 * round, for a reason nothing on the page could state.
 *
 * So a clock that exists to avoid REDUNDANT work does not get to call an
 * account it has never read redundant. An account with no state row of its own
 * makes the run due, whatever the timer says; every other run behaves exactly
 * as the six-hourly collectors do.
 */
function mailNotDue(pluginId: string, table: "gmail_mailboxes" | "resend_state"): boolean {
  const last = lastMailRead(table);
  if (!last || Date.now() - Date.parse(last) >= MAIL_EVERY_HOURS * 3_600_000) return false;
  const seen = new Set(
    (
      db.prepare(`SELECT account_id FROM ${table}`).all() as unknown as {
        account_id: number;
      }[]
    ).map((r) => r.account_id),
  );
  return accounts
    .list(pluginId)
    .filter((a) => a.connected)
    .every((a) => seen.has(a.id));
}

/**
 * Gmail: the mailbox, its labels, its triage queue and its daily volume.
 *
 * AN ACCOUNT FAILS ONLY WHEN THE PROFILE CALL FAILED. Everything under it is a
 * gap in an answer that arrived: a label whose counters refuse keeps its row
 * with nulls, a triage scan that runs out of budget reports a floor and says
 * so, an outreach scan Gmail declines costs nothing else. An account demoted to
 * "failing" over any of those is an account whose perfectly good grant gets
 * re-authorised, which is the trade Cloudflare and GitHub both refuse to make.
 *
 * TWO READINGS, AND BOTH ARE FIGURES THAT MOVE AND ARE STORED NOWHERE ELSE AS
 * HISTORY. `gmail.unread` is the inbox's unread THREAD count — threads rather
 * than messages, because a thread is one thing to deal with and a forty-message
 * thread is not forty of them — and `gmail.needingReply` is the triage queue.
 * Everything else the route computes on the read from rows that get corrected,
 * so nothing here writes down a figure that could decay.
 *
 * THE READINGS ARE THE INBOX'S ONLY, NEVER A SUM ACROSS LABELS. A thread can
 * carry INBOX and a hand-made label at once, so adding the per-label queues
 * counts it twice — the same rule GitHub's unique visitors and Cloudflare's
 * visitors follow, in a place it is much easier to get wrong.
 */
export async function collectGmail(): Promise<MailSummary> {
  const runId = startRun("gmail");

  try {
    if (mailNotDue("gmail", "gmail_mailboxes")) {
      const note = `Gmail not due — read ${ago(lastMailRead("gmail_mailboxes")!)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_MAIL, ok: true, runId, skipped: true };
    }

    const result = await gmail.collect(mailSalt(), gmailKnownDays);

    if (result.accountsTried === 0) {
      const error = NO_ACCOUNT;
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_MAIL, runId, error };
    }

    for (const m of result.mailboxes) {
      if (m.ok) accounts.markOk(m.accountId);
      else accounts.markFailed(m.accountId, m.error ?? "The mailbox did not answer.");
    }

    const ok = result.mailboxes.filter((m) => m.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every mailbox failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("gmail", error);
      return {
        ...EMPTY_MAIL,
        runId,
        accounts: result.mailboxes.map((m) => ({
          id: m.accountId,
          label: m.accountLabel,
          ok: m.ok,
          error: m.error,
        })),
        warnings: result.warnings,
        error,
      };
    }

    let dayRows = 0;
    for (const m of ok) {
      replaceGmailMailbox(
        m.accountId,
        m.accountLabel,
        {
          address: m.address,
          messagesTotal: m.messagesTotal,
          threadsTotal: m.threadsTotal,
          historyId: m.historyId,
          scopes: m.scopes,
          note: m.notes.join(" · ") || null,
        },
        m.labels,
      );
      /* Keyed by the mailbox's ADDRESS rather than by the account row, so a
         re-pasted credential inherits the history it already earned instead of
         starting a second series beside it. */
      if (m.address) {
        dayRows += writeGmailDays(m.address, m.days);
        writeGmailCorrespondents(m.address, m.correspondents);
      }
    }

    const inboxes = ok
      .flatMap((m) => m.labels)
      .filter((l) => l.id === "INBOX");
    const unread = inboxes
      .map((l) => l.threadsUnread)
      .filter((n): n is number => n !== null);
    if (unread.length)
      record("gmail.unread", unread.reduce((a, b) => a + b, 0), {
        mailboxes: unread.length,
        /* Named on the reading, because "unread" has two answers on this API
           and they differ by a fifth on this mailbox: 263 messages against 252
           threads. A series that quietly changed which one it meant would draw
           a step nobody caused. */
        basis: "inbox threads",
      });
    const waiting = inboxes
      .map((l) => l.needingReply)
      .filter((n): n is number => n !== null);
    if (waiting.length)
      record("gmail.needingReply", waiting.reduce((a, b) => a + b, 0), {
        mailboxes: waiting.length,
        scanned: inboxes.reduce((n, l) => n + (l.scanned ?? 0), 0),
        floor: inboxes.some((l) => l.truncated),
        windowDays: gmail.WINDOW_DAYS,
      });

    const labelCount = ok.reduce((n, m) => n + m.labels.length, 0);
    const note =
      `${ok.length} mailbox${ok.length === 1 ? "" : "es"} · ` +
      `${labelCount} label${labelCount === 1 ? "" : "s"} · ` +
      `${waiting.reduce((a, b) => a + b, 0)} waiting on a reply · ` +
      `${dayRows} day rows`;

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("gmail", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      read: ok.length,
      rows: dayRows,
      accounts: result.mailboxes.map((m) => ({
        id: m.accountId,
        label: m.accountLabel,
        ok: m.ok,
        error: m.error,
      })),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("gmail", error);
    return { ...EMPTY_MAIL, runId, error };
  }
}

/**
 * Resend: every key, every domain, every email it will admit to.
 *
 * ONE KEY'S FAILURE IS ONE KEY'S FAILURE. Each account replaces only its own
 * domains, so a revoked key loses its own domain's verification and nothing
 * else, and the run fails only when every key failed — the rule the registrars
 * arrived at and the reason eleven keys are eleven accounts rather than one
 * blob. The email rows are keyed by Resend's own id and written once for the
 * whole run, the way cloudflare_traffic is: they belong to a domain rather than
 * to the credential that happened to read them.
 *
 * NO READING IS RECORDED HERE, deliberately. Every figure a Resend card wants —
 * sends over a window, the bounce rate, the daily line — is a count over rows
 * that are re-read and corrected on every run, so the route computes them when
 * somebody asks. A stored "264 sent this week" would be a number that decayed
 * daily and, worse, one that could not be corrected when an email delivered on
 * Monday bounced on Tuesday.
 */
export async function collectResend(): Promise<MailSummary> {
  const runId = startRun("resend");

  try {
    if (mailNotDue("resend", "resend_state")) {
      const note = `Resend not due — read ${ago(lastMailRead("resend_state")!)}`;
      finishRun(runId, true, note);
      return { ...EMPTY_MAIL, ok: true, runId, skipped: true };
    }

    const result = await resend.collect();

    if (result.accountsTried === 0) {
      const error = NO_ACCOUNT;
      finishRun(runId, false, undefined, error);
      return { ...EMPTY_MAIL, runId, error };
    }

    for (const a of result.accounts) {
      if (a.ok) accounts.markOk(a.id);
      else accounts.markFailed(a.id, a.error ?? "The key did not answer.");
    }

    const ok = result.accounts.filter((a) => a.ok);
    if (!ok.length) {
      const error = result.warnings.join("; ") || "Every key failed.";
      finishRun(runId, false, undefined, error);
      syncPlugin("resend", error);
      return {
        ...EMPTY_MAIL,
        runId,
        accounts: outcomeLines(result.accounts),
        warnings: result.warnings,
        error,
      };
    }

    let emailRows = 0;
    let domainCount = 0;
    for (const a of ok) {
      domainCount += replaceResendDomains(a.id, a.label, a.domains, a.notes.join(" · ") || null);
      emailRows += writeResendEmails(a.emails);
      writeResendState(a.id, a.label, {
        domains: a.domains.length,
        emails: a.emails.length,
        pages: a.walk.pages,
        oldest: a.walk.oldest,
        truncated: a.walk.truncated,
        note: a.notes.join(" · ") || null,
      });
    }

    const verified = ok
      .flatMap((a) => a.domains)
      .filter((d) => d.status === "verified").length;
    const note =
      `${domainCount} sending domain${domainCount === 1 ? "" : "s"}, ` +
      `${verified} verified · ${emailRows} email rows over ` +
      `${resend.WINDOW_DAYS}d · ${ok.length}/${result.accountsTried} keys answered`;

    finishRun(runId, true, note, result.warnings.join("; ") || undefined);
    syncPlugin("resend", result.warnings.join("; ") || null);

    return {
      ok: true,
      runId,
      skipped: false,
      read: domainCount,
      rows: emailRows,
      accounts: outcomeLines(result.accounts),
      warnings: result.warnings,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    syncPlugin("resend", error);
    return { ...EMPTY_MAIL, runId, error };
  }
}
