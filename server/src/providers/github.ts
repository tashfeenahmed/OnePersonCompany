/**
 * GitHub.
 *
 * WHAT THE OWNER PASTES: one personal access token, per ACCOUNT. A token
 * belongs to exactly one GitHub identity, so a person with a work login and a
 * personal one is two accounts here, each with its own label, its own state
 * and its own last error — the same shape a Hetzner project has, for the same
 * reason.
 *
 * TWO TIERS, AND THE SPLIT IS THE WHOLE DESIGN. It is lifted from workdash's
 * collect_github.py, which is the version that has actually been run against
 * this account:
 *
 *   UNAUTHENTICATED — the public repo list: stars, forks, open issues, last
 *   push, language. One call for the whole account, sixty an hour shared
 *   across everything on this IP.
 *
 *   AUTHENTICATED — all of that, plus PER-REPO TRAFFIC (views and unique
 *   visitors over GitHub's fixed 14-day window, clones, top referrers, top
 *   paths) and private repos. Traffic needs PUSH access to each repo, which is
 *   why it cannot be had anonymously at any rate limit: GitHub does not serve
 *   those endpoints without it, whatever budget you have left.
 *
 * A MISSING TOKEN IS A STATE, NOT AN ERROR. `publicCollect` reads the second
 * tier's worth of a named account with no credential at all, so a plugin with
 * no account connected still answers "24,435 stars across 31 public repos" and
 * says plainly that traffic is the part a token buys. Degrading is the point;
 * an integration that shows nothing until a credential arrives teaches the
 * owner that the credential is mandatory, which here it is not.
 *
 * WHAT IT READS, and nothing else — every one a GET:
 *   GET /user                                the identity the token belongs to
 *   GET /user/repos                          the repos it owns, private included
 *   GET /users/{login}/repos                 the same list as the world sees it
 *   GET /orgs/{org}/repos                    each org the owner NAMED, if any
 *   GET /repos/{full}/traffic/views          14 days of daily views
 *   GET /repos/{full}/traffic/clones         14 days of daily clones
 *   GET /repos/{full}/traffic/popular/…      the top ten referrers and paths
 *
 * THE RATE LIMIT IS PART OF THE ANSWER. Every response carries what is left of
 * the hour, and the last one seen is kept and published — because the first
 * symptom of crossing the ceiling is a dashboard that quietly stops updating,
 * at three in the morning, for a reason nothing on the page can state. A run
 * also reports how many requests IT spent, so "who is burning the budget" has
 * an answer that is not a guess.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;

/**
 * The API version GitHub asks integrations to pin. Without it you are served
 * whatever the default is that quarter, which is how a working collector
 * breaks on a morning nobody deployed anything.
 */
const GH_VERSION = "2022-11-28";
const USER_AGENT = "onepersoncompany-collector/1.0";

/** Two pages of a hundred is two hundred repos, well past anything one person
 *  owns; a third would be a runaway rather than a portfolio. */
const MAX_PAGES = 3;

/**
 * How many repos get a traffic call, and what counts as still alive.
 *
 * Both numbers come from workdash's collector and the reasoning is worth
 * repeating: sorting by stars alone spent thirteen of thirty slots on repos
 * last pushed between 2015 and 2022, several of them showing zero views for
 * the entire fourteen-day window, while a Homebrew tap for a product being
 * launched that fortnight was not in the document at all. A finished repo has
 * nothing a traffic view can tell you, so it is dropped BEFORE the cap rather
 * than left to compete for a slot inside it.
 *
 * The cap is also the cost control: traffic is four calls per repo, so thirty
 * repos is a hundred and twenty requests. See TRAFFIC_EVERY_HOURS for the
 * other half of that arithmetic.
 */
export const MAX_REPOS = 30;
export const ACTIVE_DAYS = 548;

/** GitHub's traffic window is fixed at fourteen days by the API itself —
 *  there is no parameter to widen it — so the number is named here and
 *  travels with every figure derived from it. */
export const TRAFFIC_DAYS = 14;

export type Popular = {
  /** A referrer host, or a path on github.com. */
  name: string;
  /** The page's own title, for paths. Null for referrers, which have none. */
  title: string | null;
  count: number;
  uniques: number;
};

export type DayPoint = { day: string; value: number };

/**
 * One repo's traffic.
 *
 * THE DAILY SERIES AND THE WINDOW TOTALS ARE NOT THE SAME MEASUREMENT, and
 * conflating them is the easiest lie this file could tell. `views` sums to the
 * window total exactly, because a view is a view. `uniques` does NOT: GitHub
 * de-duplicates visitors across the whole fourteen days for the header figure
 * and within each day for the series, so adding the daily uniques
 * double-counts anybody who came back on Tuesday. Both are kept, and the ones
 * that can be added and the one that cannot are labelled as such everywhere
 * downstream.
 */
export type Traffic = {
  views: DayPoint[];
  uniques: DayPoint[];
  clones: DayPoint[];
  cloneUniques: DayPoint[];
  /** GitHub's own de-duplicated figures for the whole window. Null for a
   *  field whose endpoint refused — never zero, which would read as "nobody
   *  came" rather than "we were not allowed to ask". */
  totals: {
    views: number | null;
    uniques: number | null;
    clones: number | null;
    cloneUniques: number | null;
  };
  referrers: Popular[];
  paths: Popular[];
  /** Which of the four calls refused, and why. Null when all four answered. */
  note: string | null;
};

export type Repo = {
  fullName: string;
  owner: string;
  name: string;
  /** True when the owner is an organisation rather than a person — two repos
   *  in two accounts can share a name, and a row that cannot say which one it
   *  is is a row the reader has to go and check. */
  org: boolean;
  private: boolean;
  fork: boolean;
  archived: boolean;
  stars: number;
  forks: number;
  /**
   * GitHub's `open_issues_count`, WHICH COUNTS OPEN PULL REQUESTS TOO. Named
   * for what it is rather than "issues", because separating them costs a call
   * per repo and the two differ by a lot on an active repo. Every label
   * downstream says "issues & PRs" for the same reason.
   */
  openIssues: number;
  watchers: number;
  language: string | null;
  /** The repo's own "Website" field, null when it was never filled in. */
  homepage: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  createdAt: string | null;
};

export type Identity = {
  login: string;
  name: string | null;
  followers: number | null;
  publicRepos: number | null;
};

/** What is left of this hour, as the last response said. */
export type Rate = {
  remaining: number | null;
  limit: number | null;
  /** When the budget refills. Kept so a reader can be told the figure above
   *  has since been made irrelevant, rather than shown a stale number. */
  resetAt: string | null;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  login: string | null;
  repos: number;
  /** How many requests THIS account spent this run. */
  requests: number;
  rate: Rate;
  identity: Identity | null;
  /** Whether traffic was asked for at all this run — see TRAFFIC_EVERY_HOURS. */
  traffic: boolean;
};

export type CollectResult = {
  repos: (Repo & { accountId: number; accountLabel: string })[];
  /** Keyed by full name. Only the repos traffic was actually asked about. */
  traffic: Map<string, Traffic>;
  accounts: AccountOutcome[];
  accountsTried: number;
  warnings: string[];
  /** How many repos were dropped for age, and how many lost the ranking.
   *  Three different reasons a repo can be missing; see selectRepos. */
  dormant: number;
  truncated: number;
};

/* ------------------------------------------------------------------ http */

export class GithubError extends Error {
  status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

/** Every response's rate headers, so the caller can keep the last one it saw
 *  without every call site knowing the header names. */
function readRate(h: Headers): Rate {
  const num = (v: string | null) => {
    const n = Number(v);
    return v === null || !Number.isFinite(n) ? null : n;
  };
  const reset = num(h.get("x-ratelimit-reset"));
  return {
    remaining: num(h.get("x-ratelimit-remaining")),
    limit: num(h.get("x-ratelimit-limit")),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
  };
}

/**
 * One GET, and there is no other kind in this file.
 *
 * A read-only collector that could theoretically write is a collector somebody
 * has to audit before every change, so no function here builds a request with
 * a method or a body.
 *
 * `token` may be null, which is the unauthenticated tier — the same code path
 * at sixty requests an hour instead of five thousand, with the traffic and
 * private repos simply not available.
 */
async function ghGet<T>(
  path: string,
  token: string | null,
): Promise<{ body: T; rate: Rate }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GH_VERSION,
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new GithubError(
      null,
      name === "TimeoutError"
        ? "GitHub did not answer within 20 seconds"
        : `could not reach GitHub (${name})`,
    );
  }

  const rate = readRate(res.headers);

  if (!res.ok) {
    /*
      GitHub puts a human sentence in the body of most refusals and it is
      usually the actual answer — "Must have push access to repository" is a
      complete explanation of a 403 that a bare status code turns into a
      support question. So it is read rather than discarded.
    */
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body?.message ?? "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new GithubError(
      res.status,
      `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return { body: (await res.json()) as T, rate };
}

/* ---------------------------------------------------------------- verify */

/**
 * Is this token real, and whose is it?
 *
 * Called before a token is stored, so a typo is refused at the point it was
 * made rather than becoming a silently empty dashboard an hour later. It
 * returns the LOGIN as well as the yes, because that is the natural name for
 * the account row: "Account 2" says nothing, "tashfeenahmed" says everything.
 */
export async function verify(
  token: string,
): Promise<{ ok: true; identity: Identity } | { ok: false; error: string }> {
  try {
    const { body } = await ghGet<{
      login?: string;
      name?: string | null;
      followers?: number;
      public_repos?: number;
    }>("/user", token);
    if (!body?.login)
      return { ok: false, error: "GitHub answered without a login." };
    return {
      ok: true,
      identity: {
        login: body.login,
        name: body.name ?? null,
        followers: body.followers ?? null,
        publicRepos: body.public_repos ?? null,
      },
    };
  } catch (err) {
    if (err instanceof GithubError) {
      if (err.status === 401)
        return {
          ok: false,
          error: "GitHub rejected that token (401). Expired, or mistyped.",
        };
      if (err.status === 403)
        return {
          ok: false,
          error:
            "GitHub refused that token (403) — either the rate limit is spent " +
            "or the token has no scope at all.",
        };
      return { ok: false, error: `GitHub: ${err.message}` };
    }
    return { ok: false, error: "Could not reach GitHub." };
  }
}

/* ----------------------------------------------------------------- repos */

type RawRepo = {
  full_name?: string;
  name?: string;
  owner?: { login?: string; type?: string };
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  watchers_count?: number;
  language?: string | null;
  homepage?: string | null;
  default_branch?: string;
  pushed_at?: string | null;
  created_at?: string | null;
};

function shapeRepo(r: RawRepo): Repo | null {
  const fullName = r.full_name?.trim();
  if (!fullName) return null;
  const owner = r.owner?.login ?? fullName.split("/")[0]!;
  return {
    fullName,
    owner,
    name: r.name ?? fullName.split("/")[1] ?? fullName,
    org: r.owner?.type === "Organization",
    private: !!r.private,
    fork: !!r.fork,
    archived: !!r.archived,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    watchers: r.watchers_count ?? 0,
    language: r.language ?? null,
    // An empty "Website" field is null rather than "", so a consumer's
    // `if (repo.homepage)` reads correctly.
    homepage: r.homepage?.trim() || null,
    defaultBranch: r.default_branch ?? null,
    pushedAt: r.pushed_at ?? null,
    createdAt: r.created_at ?? null,
  };
}

/** Page a repo listing. Sorted by push date, so a walk that hits the ceiling
 *  keeps the repos that are alive rather than an arbitrary hundred. */
async function walk(
  path: string,
  token: string | null,
  params: Record<string, string>,
  spend: (r: Rate) => void,
): Promise<Repo[]> {
  const out: Repo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      per_page: "100",
      page: String(page),
      sort: "pushed",
      direction: "desc",
      ...params,
    });
    const { body, rate } = await ghGet<RawRepo[]>(`${path}?${query}`, token);
    spend(rate);
    if (!Array.isArray(body) || !body.length) break;
    for (const raw of body) {
      const repo = shapeRepo(raw);
      if (repo) out.push(repo);
    }
    if (body.length < 100) break;
  }
  return out;
}

/**
 * Every repo one credential can see, and what it cost to find out.
 *
 * `/user/repos` is the authenticated view and includes private repositories;
 * `/users/{login}/repos` is what the world sees. A token that has expired
 * falls back to the public list rather than failing the run, because losing
 * the private repos and the traffic is a smaller loss than losing the whole
 * document — and the fallback is reported rather than silently taken.
 */
async function ownRepos(
  login: string | null,
  token: string | null,
  spend: (r: Rate) => void,
): Promise<{ repos: Repo[]; note: string | null }> {
  if (token) {
    try {
      return {
        repos: await walk(
          "/user/repos",
          token,
          { affiliation: "owner", visibility: "all" },
          spend,
        ),
        note: null,
      };
    } catch (err) {
      if (!login) throw err;
      const why = err instanceof Error ? err.message : "Error";
      return {
        repos: await walk(`/users/${login}/repos`, null, { type: "owner" }, spend),
        note: `the token could not list repositories (${why}); fell back to the public list`,
      };
    }
  }
  if (!login) throw new GithubError(null, "no token and no login to read");
  return {
    repos: await walk(`/users/${login}/repos`, null, { type: "owner" }, spend),
    note: null,
  };
}

/**
 * The named organisations, and only the named ones.
 *
 * `affiliation=organization_member` was the blunt version and is deliberately
 * not used: this owner belongs to an org with a hundred dormant repositories
 * that would flood the candidate list, lose the ranking anyway, and inflate
 * "N repositories beyond the thirty shown" into a number that means nothing.
 * So the list is EXPLICIT, set by the owner, and the summary states which orgs
 * were walked — so "missing because it lost the ranking" and "missing because
 * nobody asked" stay two different sentences.
 */
async function orgRepos(
  orgs: string[],
  token: string | null,
  spend: (r: Rate) => void,
): Promise<{ repos: Repo[]; notes: string[] }> {
  const repos: Repo[] = [];
  const notes: string[] = [];
  for (const org of orgs) {
    try {
      repos.push(...(await walk(`/orgs/${org}/repos`, token, { type: "all" }, spend)));
    } catch (err) {
      // One misspelt org name must not cost the repos that did answer.
      notes.push(
        `org ${org} could not be listed (${err instanceof Error ? err.message : "Error"})`,
      );
    }
  }
  return { repos, notes };
}

/* ------------------------------------------------------------- selection */

const pushedMs = (r: Repo) => (r.pushedAt ? Date.parse(r.pushedAt) : NaN);

/**
 * Public before private, then stars, then recency, then name.
 *
 * PUBLIC FIRST is the one that surprises, and it is the whole point: this data
 * exists to answer "who is looking at the repos", and a private repo cannot be
 * looked at. Every private row in workdash's last run carried views 0 and
 * clones 0 except the two the owner's own CI touches. Stars stay the second
 * key rather than the first because they are still the right answer to "which
 * of these is the channel"; what they were never able to say is which are
 * still alive. Name breaks the last tie so the ordering is stable between
 * runs rather than shuffling.
 */
function rank(a: Repo, b: Repo): number {
  if (a.private !== b.private) return a.private ? 1 : -1;
  if (a.stars !== b.stars) return b.stars - a.stars;
  const pa = pushedMs(a);
  const pb = pushedMs(b);
  if (pa !== pb) return (Number.isNaN(pb) ? 0 : pb) - (Number.isNaN(pa) ? 0 : pa);
  return a.fullName.localeCompare(b.fullName);
}

/**
 * Which repos get a traffic call. The dormant sweep happens BEFORE the ranking
 * and not as part of it, because the two answer different questions and the
 * summary reports them as two separate sentences.
 *
 * A repo that never said when it was pushed is KEPT: this sweep drops what is
 * known to be abandoned, and a missing field is not knowledge.
 */
export function selectRepos(
  repos: Repo[],
  now = Date.now(),
  max = MAX_REPOS,
  activeDays = ACTIVE_DAYS,
): { kept: Repo[]; dormant: number; truncated: number } {
  const floor = now - activeDays * 86_400_000;
  const active: Repo[] = [];
  let dormant = 0;
  for (const r of repos) {
    const ts = pushedMs(r);
    if (!Number.isNaN(ts) && ts < floor) dormant++;
    else active.push(r);
  }
  active.sort(rank);
  return {
    kept: active.slice(0, max),
    dormant,
    truncated: Math.max(0, active.length - max),
  };
}

/* --------------------------------------------------------------- traffic */

type RawSeries = {
  count?: number;
  uniques?: number;
  views?: { timestamp?: string; count?: number; uniques?: number }[];
  clones?: { timestamp?: string; count?: number; uniques?: number }[];
};

const day = (iso: string | undefined) =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;

/**
 * One repo's traffic, over four endpoints that can each refuse on their own.
 *
 * NEVER THROWS. Every one of these needs PUSH access, and on a repo the token
 * can read but not push to — a fork, an org repo, a collaborator invite that
 * was never accepted — GitHub answers 403 "Must have push access to
 * repository". That is not a failure in this collector's sense; it is the
 * honest answer to a question this credential is not allowed to ask. Each
 * refusal lands in the note and nothing else moves: twenty-nine repos with
 * traffic and one without is a better answer than no answer.
 */
export async function trafficFor(
  fullName: string,
  token: string,
  spend: (r: Rate) => void,
): Promise<Traffic | null> {
  const problems: string[] = [];
  let answered = false;

  const out: Traffic = {
    views: [],
    uniques: [],
    clones: [],
    cloneUniques: [],
    totals: { views: null, uniques: null, clones: null, cloneUniques: null },
    referrers: [],
    paths: [],
    note: null,
  };

  const ask = async <T,>(path: string, key: string, take: (d: T) => void) => {
    try {
      const { body, rate } = await ghGet<T>(`/repos/${fullName}/${path}`, token);
      spend(rate);
      take(body);
      answered = true;
    } catch (err) {
      // An unreadable payload is a null field with a reason, never a zero.
      // "Nobody visited" and "GitHub changed the shape" are different facts,
      // and a trend line can only keep them apart if we do.
      problems.push(`${key}: ${err instanceof Error ? err.message : "Error"}`);
    }
  };

  await ask<RawSeries>("traffic/views", "views", (d) => {
    out.totals.views = Number.isFinite(d.count) ? Number(d.count) : null;
    out.totals.uniques = Number.isFinite(d.uniques) ? Number(d.uniques) : null;
    for (const p of d.views ?? []) {
      const at = day(p.timestamp);
      if (!at) continue;
      out.views.push({ day: at, value: Number(p.count ?? 0) });
      out.uniques.push({ day: at, value: Number(p.uniques ?? 0) });
    }
  });

  await ask<RawSeries>("traffic/clones", "clones", (d) => {
    out.totals.clones = Number.isFinite(d.count) ? Number(d.count) : null;
    out.totals.cloneUniques = Number.isFinite(d.uniques) ? Number(d.uniques) : null;
    for (const p of d.clones ?? []) {
      const at = day(p.timestamp);
      if (!at) continue;
      out.clones.push({ day: at, value: Number(p.count ?? 0) });
      out.cloneUniques.push({ day: at, value: Number(p.uniques ?? 0) });
    }
  });

  await ask<{ referrer?: string; count?: number; uniques?: number }[]>(
    "traffic/popular/referrers",
    "referrers",
    (d) => {
      for (const r of d ?? []) {
        if (!r.referrer) continue;
        out.referrers.push({
          name: r.referrer,
          title: null,
          count: Number(r.count ?? 0),
          uniques: Number(r.uniques ?? 0),
        });
      }
    },
  );

  await ask<{ path?: string; title?: string; count?: number; uniques?: number }[]>(
    "traffic/popular/paths",
    "paths",
    (d) => {
      for (const r of d ?? []) {
        if (!r.path) continue;
        out.paths.push({
          name: r.path,
          title: r.title ?? null,
          count: Number(r.count ?? 0),
          uniques: Number(r.uniques ?? 0),
        });
      }
    },
  );

  // Nothing came back at all: null rather than an object of nulls, so a
  // consumer's `if (traffic)` reads correctly.
  if (!answered) return null;
  out.note = problems.length ? problems.join("; ") : null;
  return out;
}

/* --------------------------------------------------------------- collect */

/** The accounts with a usable token, in the order they were added. */
export function tokenAccounts(reader: string): { account: Account; token: string }[] {
  return accounts
    .credentialed("github", ["token"], reader)
    .ready.map(({ account, values }) => ({ account, token: values.token! }));
}

export type CollectOptions = {
  reader?: string;
  /** The organisations the owner asked for, by name. Empty means none, which
   *  is a decision rather than an oversight and is reported as one. */
  orgs?: string[];
  /** Which accounts should spend requests on traffic this run. See
   *  TRAFFIC_EVERY_HOURS in the collector: the series is day-grained, so
   *  asking for it every half hour spends thousands of requests redrawing the
   *  same fourteen buckets. */
  wantTraffic?: (accountId: number) => boolean;
  /**
   * A repo nothing has ever been asked about, which is collected even on a run
   * where traffic is not otherwise due.
   *
   * "Not due" means "we already have yesterday's numbers for this"; it must
   * not mean "this repo, which arrived four minutes ago when an organisation
   * was added, will show nothing for six hours". A gap and a stale figure are
   * different problems and only the second one is worth waiting out.
   */
  trafficMissing?: (fullName: string) => boolean;
};

/**
 * Every connected account, one after another.
 *
 * ONE ACCOUNT FAILING LOSES ONLY THAT ACCOUNT — the rule this whole codebase
 * holds. An account that cannot list its repos is recorded as failing and the
 * loop carries on; the repos, traffic and stars every other account produced
 * arrive exactly as if it had not been there.
 *
 * A REPO SEEN TWICE IS COUNTED ONCE. Two accounts can both see one repo — a
 * personal account that is also a member of the org it belongs to is the
 * ordinary case, and the personal listing and the org walk overlap for the
 * same reason. Counted twice it doubles the stars; dropped quietly it makes an
 * account look empty for no stated reason. So it is counted once, under the
 * account that saw it first, and the duplicate is a warning that names both.
 */
export async function collect(opts: CollectOptions = {}): Promise<CollectResult> {
  const reader = opts.reader ?? "collect_github";
  const orgs = opts.orgs ?? [];
  const pairs = tokenAccounts(reader);

  const repos: (Repo & { accountId: number; accountLabel: string })[] = [];
  const traffic = new Map<string, Traffic>();
  const outcomes: AccountOutcome[] = [];
  const warnings: string[] = [];
  const firstSeen = new Map<string, string>();
  let dormant = 0;
  let truncated = 0;

  for (const { account, token } of pairs) {
    const label = account.label;
    let requests = 0;
    let rate: Rate = { remaining: null, limit: null, resetAt: null };
    const spend = (r: Rate) => {
      requests += 1;
      // The LAST rate seen wins: it is the one that is still true.
      if (r.remaining !== null) rate = r;
    };

    let identity: Identity | null = null;
    try {
      const { body, rate: r } = await ghGet<{
        login?: string;
        name?: string | null;
        followers?: number;
        public_repos?: number;
      }>("/user", token);
      spend(r);
      identity = {
        login: body.login ?? "",
        name: body.name ?? null,
        followers: body.followers ?? null,
        publicRepos: body.public_repos ?? null,
      };
    } catch (err) {
      // Not fatal on its own — the repo listing below is what actually
      // matters, and a token that can list repos but not read /user is odd
      // rather than useless.
      warnings.push(
        `${label}: could not read the account (${err instanceof Error ? err.message : "Error"})`,
      );
    }

    let mine: Repo[];
    try {
      const own = await ownRepos(identity?.login ?? null, token, spend);
      if (own.note) warnings.push(`${label}: ${own.note}`);
      mine = own.repos;
    } catch (err) {
      const error = `${err instanceof Error ? err.message : "Error"} listing repositories`;
      warnings.push(`${label}: ${error}`);
      outcomes.push({
        id: account.id,
        label,
        ok: false,
        error,
        login: identity?.login ?? null,
        repos: 0,
        requests,
        rate,
        identity,
        traffic: false,
      });
      continue;
    }

    const fromOrgs = await orgRepos(orgs, token, spend);
    for (const note of fromOrgs.notes) warnings.push(`${label}: ${note}`);

    const seen: Repo[] = [];
    for (const r of [...mine, ...fromOrgs.repos]) {
      const owner = firstSeen.get(r.fullName);
      if (owner !== undefined) {
        if (owner !== label)
          warnings.push(
            `${label}: ${r.fullName} was already seen under “${owner}” — counted once`,
          );
        continue;
      }
      firstSeen.set(r.fullName, label);
      seen.push(r);
    }

    const selected = selectRepos(seen);
    dormant += selected.dormant;
    truncated += selected.truncated;

    for (const r of seen)
      repos.push({ ...r, accountId: account.id, accountLabel: label });

    /*
      Traffic, sequentially and only for the selection. Four calls per repo
      fired all at once at somebody else's rate limiter to save a few seconds
      on a job that runs on a timer is a poor trade, and a repo that refuses
      costs its own note and nothing else.
    */
    const wantsTraffic = opts.wantTraffic?.(account.id) ?? true;
    for (const r of selected.kept) {
      if (!wantsTraffic && !(opts.trafficMissing?.(r.fullName) ?? false)) continue;
      const t = await trafficFor(r.fullName, token, spend);
      if (t) traffic.set(r.fullName, t);
    }

    outcomes.push({
      id: account.id,
      label,
      ok: true,
      login: identity?.login ?? null,
      repos: seen.length,
      requests,
      rate,
      identity,
      traffic: wantsTraffic,
    });
  }

  return {
    repos,
    traffic,
    accounts: outcomes,
    accountsTried: pairs.length,
    warnings,
    dormant,
    truncated,
  };
}

/**
 * The unauthenticated tier, for a named login.
 *
 * Not wired to a route today, and here on purpose: it is the half of this
 * integration that needs no credential, and keeping it written down is what
 * stops the two tiers from quietly becoming one. Sixty requests an hour shared
 * across the whole IP, public repos only, and no traffic at any budget.
 */
export async function publicCollect(
  login: string,
): Promise<{ repos: Repo[]; rate: Rate }> {
  let rate: Rate = { remaining: null, limit: null, resetAt: null };
  const repos = await walk(`/users/${login}/repos`, null, { type: "owner" }, (r) => {
    rate = r;
  });
  return { repos, rate };
}
