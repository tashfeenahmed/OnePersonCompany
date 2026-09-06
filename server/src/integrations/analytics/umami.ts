/**
 * Umami — self-hosted web analytics, read through its own v2 HTTP API.
 *
 * ONE ACCOUNT IS ONE INSTANCE, not one website. An Umami install carries every
 * site its owner pointed at it, and a single login sees all of them; two
 * installs are two logins, two URLs and two failure states. So the unit that
 * owns a credential here is the INSTANCE, exactly as a Hetzner account owns a
 * project, and the websites inside it are rows rather than accounts.
 *
 * THE URL IS HALF THE CREDENTIAL AND IS STORED AS A VAULT FIELD. The same
 * arrangement providers/hermes.ts and the App Store vendor number keep, for
 * the same reason: Umami runs wherever the owner put it, there is no endpoint
 * to hard-code, and a base URL stored apart from the key that matches it is
 * the failure `accounts.writeCredentials` exists to prevent — it writes the
 * whole set or none of it. It is not a secret and it reads back; it is here
 * because it belongs to the pair.
 *
 * TWO WAYS IN, BECAUSE UMAMI HAS TWO. A self-hosted instance authenticates a
 * username and password at `/api/auth/login` and answers a bearer token good
 * for a day; Umami Cloud and any instance with an API key issued instead
 * answers `x-umami-api-key` directly and has no login endpoint at all. Both
 * are accepted, neither is guessed at: a set with a token uses the key header,
 * a set with a username and password logs in, and a set with neither is
 * refused at the door rather than stored to fail hourly.
 *
 * WHAT IT READS, and nothing else:
 *   POST /api/auth/login                                  a bearer, when logging in
 *   GET  /api/websites                                    which sites this login sees
 *   GET  /api/websites/{id}/stats?startAt&endAt           the window's five figures
 *   GET  /api/websites/{id}/pageviews?startAt&endAt&unit  the daily line
 *   GET  /api/websites/{id}/metrics?type=url|referrer|event   the rankings
 *
 * TIMESTAMPS ARE MILLISECOND EPOCHS on the wire (`startAt`, `endAt`), and the
 * DAY BOUNDARIES ARE THE INSTANCE'S, not this box's. Umami buckets by the
 * timezone its own configuration names, so a "day" in `umami_days` is that
 * instance's day and this code does not restate it as UTC. Every document
 * downstream says so rather than implying a calendar it does not control.
 *
 * VERSIONS DISAGREE ABOUT FIELD NAMES AND THIS FILE ABSORBS THAT. `/stats`
 * answers `{value, prev}` objects on 2.x and bare numbers on some builds; the
 * unique-visitor figure is `visitors` on current versions and `uniques` on
 * older ones; `/websites` is a paginated `{data: […]}` object now and was a
 * bare array. Each is read through one tolerant accessor below, because the
 * alternative is a dashboard that empties itself when somebody upgrades their
 * own analytics server.
 */

const TIMEOUT_MS = 25_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/** How many rows a ranking asks for. Twenty is what a card can show without
 *  becoming a table, and the rows are a ranking rather than a total in any
 *  case — see migration 031. */
export const TOP_LIMIT = 20;

/** The window every stats figure on this integration is about, and the length
 *  of the comparison window before it. Thirty COMPLETE days: today is in
 *  progress and a partial day drawn beside thirty finished ones is a cliff. */
export const WINDOW_DAYS = 30;

/** How much daily history one collection asks for. Ninety days is a quarter,
 *  which is what a daily line can show without the points becoming a smear,
 *  and Umami serves it in one request. */
export const DAYS_HISTORY = 90;

export type Credentials = {
  url: string;
  username?: string;
  password?: string;
  token?: string;
};

export type Website = { id: string; name: string | null; domain: string | null };

export type Stats = {
  pageviews: number | null;
  visitors: number | null;
  visits: number | null;
  bounces: number | null;
  totaltime: number | null;
};

export type DayPoint = { day: string; pageviews: number; sessions: number };

export type TopRow = { name: string; count: number };

export class UmamiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UmamiError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------- url */

/**
 * The base URL, as Umami will actually be reached at.
 *
 * A trailing slash is removed and a trailing `/api` is NOT: an owner who
 * pasted `https://umami.example.com/api` meant the same instance, and
 * `/api/api/websites` is a 404 that reads as "wrong credentials". Anything
 * that is not http(s) is refused, because a `file:` or `javascript:` base is
 * not a mistake this code should carry forward.
 */
export function normaliseUrl(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return value.replace(/\/api$/, "");
}

/* ------------------------------------------------------------------ http */

async function request(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new UmamiError(
      0,
      name === "TimeoutError"
        ? `That instance did not answer within ${TIMEOUT_MS / 1000} seconds.`
        : `Could not reach that instance (${name}).`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    /* Umami answers HTML for a wrong path and JSON for a wrong credential.
       Both are truncated to a sentence: a page of markup in an error field is
       a page of markup on the plugin card. */
    let reason = text.trim().slice(0, 200);
    try {
      const doc = JSON.parse(text) as {
        message?: string;
        error?: string | { message?: string; code?: string };
      };
      // Current releases wrap it: `{error: {message, code, status}}`.
      const nested = typeof doc.error === "object" && doc.error ? doc.error.message : doc.error;
      reason = doc.message ?? nested ?? reason;
    } catch {
      if (/^\s*</.test(text))
        reason = "that URL answered HTML rather than JSON — is it the Umami root?";
    }
    throw new UmamiError(res.status, `HTTP ${res.status}${reason ? ` ${reason}` : ""}`);
  }

  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new UmamiError(
      res.status,
      "that instance answered 200 with something that is not JSON — is it Umami?",
    );
  }
}

/**
 * A session: the base URL plus the header every read will carry.
 *
 * The API key path makes NO CALL to build one — the header is the credential —
 * so an instance with a key spends one request per read rather than two. The
 * login path spends one, once per collection, and the token it returns is held
 * for that collection only: Umami's tokens last about a day and caching one
 * across runs would mean holding a live bearer in memory for the life of the
 * process to save one request every six hours.
 */
export type Session = { url: string; headers: Record<string, string>; via: "token" | "login" };

export async function open(values: Credentials): Promise<Session> {
  const url = normaliseUrl(values.url ?? "");
  if (!url) throw new UmamiError(0, "That is not an http(s) URL.");

  const token = (values.token ?? "").trim();
  if (token) return { url, headers: { "x-umami-api-key": token }, via: "token" };

  const username = (values.username ?? "").trim();
  const password = values.password ?? "";
  if (!username || !password)
    throw new UmamiError(
      0,
      "No API key, and no username and password either — there is nothing to sign in with.",
    );

  const doc = (await request(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })) as { token?: string } | null;

  if (!doc?.token)
    throw new UmamiError(200, "That instance accepted the login and returned no token.");
  return { url, headers: { Authorization: `Bearer ${doc.token}` }, via: "login" };
}

const get = (session: Session, path: string) =>
  request(`${session.url}${path}`, { method: "GET", headers: session.headers });

/* -------------------------------------------------------------- readers */

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** `{value, prev}` on 2.x, a bare number on some builds. Both mean the same
 *  figure and neither is worth a version check. */
function figure(v: unknown): number | null {
  if (v && typeof v === "object" && "value" in (v as Record<string, unknown>))
    return num((v as { value?: unknown }).value);
  return num(v);
}

/** `{data: […]}` on current versions, a bare array on older ones. */
function websiteRows(doc: unknown): unknown[] {
  return Array.isArray(doc)
    ? doc
    : ((doc as { data?: unknown } | null)?.data as unknown[]) ?? [];
}

/** The websites this login can see. */
export async function websites(session: Session): Promise<Website[]> {
  let rows = websiteRows(await get(session, "/api/websites?pageSize=200"));
  /*
    AN ADMIN THAT OWNS NOTHING. `/api/websites` lists what the login OWNS or
    is on a team for, and a second admin created so this dashboard has a login
    of its own owns nothing — every site belongs to the person who set the
    instance up. Umami answers that case at `/api/admin/websites`, admin role
    only, where every site is listed. Tried only when the first list is empty,
    and a refusal there (a plain `user` login) is the empty list it started
    with, not an error: a login that sees no sites is a true fact to report.
  */
  if (!rows.length) {
    try {
      rows = websiteRows(await get(session, "/api/admin/websites?pageSize=200"));
    } catch {
      rows = [];
    }
  }
  const out: Website[] = [];
  for (const raw of rows) {
    const r = raw as { id?: unknown; name?: unknown; domain?: unknown };
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    out.push({
      id,
      name: typeof r.name === "string" ? r.name : null,
      domain: typeof r.domain === "string" ? r.domain : null,
    });
  }
  return out;
}

/**
 * One website's five figures over one window.
 *
 * `visitors` is read from `visitors` and falls back to `uniques`, which is
 * what versions before 2.9 called the same de-duplicated count. It is the one
 * figure on this integration that may never be added to another — see the
 * route and the skill, which both say so out loud.
 */
export async function stats(
  session: Session,
  websiteId: string,
  startAt: number,
  endAt: number,
): Promise<Stats> {
  const doc = (await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/stats?startAt=${startAt}&endAt=${endAt}`,
  )) as Record<string, unknown> | null;
  return {
    pageviews: figure(doc?.pageviews),
    visitors: figure(doc?.visitors ?? doc?.uniques),
    visits: figure(doc?.visits ?? doc?.sessions),
    bounces: figure(doc?.bounces),
    totaltime: figure(doc?.totaltime),
  };
}

/**
 * The daily line.
 *
 * Umami returns `{pageviews: [{x, y}], sessions: [{x, y}]}`, where `x` is a
 * timestamp in the INSTANCE'S timezone and `y` the count. The two arrays are
 * joined on the day rather than by position: a day with pageviews and no
 * sessions is present in one array and absent from the other on some versions,
 * and zipping them by index would shift the whole line by one.
 */
export async function pageviews(
  session: Session,
  websiteId: string,
  startAt: number,
  endAt: number,
): Promise<DayPoint[]> {
  const doc = (await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/pageviews` +
      `?startAt=${startAt}&endAt=${endAt}&unit=day`,
  )) as { pageviews?: unknown; sessions?: unknown; visitors?: unknown } | null;

  const bucket = (raw: unknown): Map<string, number> => {
    const map = new Map<string, number>();
    for (const p of Array.isArray(raw) ? raw : []) {
      const row = p as { x?: unknown; y?: unknown; t?: unknown; v?: unknown };
      const at = row.x ?? row.t;
      const day =
        typeof at === "string"
          ? at.slice(0, 10)
          : typeof at === "number"
            ? new Date(at).toISOString().slice(0, 10)
            : null;
      const y = num(row.y ?? row.v);
      if (!day || y === null) continue;
      map.set(day, (map.get(day) ?? 0) + y);
    }
    return map;
  };

  const views = bucket(doc?.pageviews);
  const sessions = bucket(doc?.sessions ?? doc?.visitors);
  const days = [...new Set([...views.keys(), ...sessions.keys()])].sort();
  return days.map((day) => ({
    day,
    pageviews: views.get(day) ?? 0,
    sessions: sessions.get(day) ?? 0,
  }));
}

export type MetricKind = "url" | "referrer" | "event";

/** A ranking of one kind, top `TOP_LIMIT`. Umami answers `[{x, y}]`; a row
 *  with no `x` is Umami's own "(none)" bucket — direct traffic, an event with
 *  no name — and is kept under that label rather than dropped, because
 *  dropping it would make the rows below it look like the whole picture. */
export async function metrics(
  session: Session,
  websiteId: string,
  kind: MetricKind,
  startAt: number,
  endAt: number,
): Promise<TopRow[]> {
  /*
    THE PAGE RANKING HAS TWO NAMES. Umami called it `type=url` for years and
    current releases call it `type=path`, answering the old name with a bare
    400 — the same 400 a malformed window gets, so it cannot be told apart by
    status alone. The new name is asked first and the old one only when the
    new one is refused, which keeps one instance on one request per site and
    lets an old instance cost a second. The kind stays `url` everywhere else
    here: it is the column the rows are stored under, and renaming a column
    to follow a vendor is how history splits in two.
  */
  const types = kind === "url" ? ["path", "url"] : [kind];
  let doc: unknown = null;
  for (let i = 0; i < types.length; i++) {
    try {
      doc = await get(
        session,
        `/api/websites/${encodeURIComponent(websiteId)}/metrics` +
          `?startAt=${startAt}&endAt=${endAt}&type=${types[i]}&limit=${TOP_LIMIT}`,
      );
      break;
    } catch (err) {
      const last = i === types.length - 1;
      if (last || !/HTTP 400\b/.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  const rows = Array.isArray(doc)
    ? doc
    : ((doc as { data?: unknown } | null)?.data as unknown[]) ?? [];
  const out: TopRow[] = [];
  for (const raw of rows) {
    const r = raw as { x?: unknown; y?: unknown };
    const count = num(r.y);
    if (count === null) continue;
    const name = typeof r.x === "string" && r.x.trim() ? r.x : "(none)";
    out.push({ name, count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, TOP_LIMIT);
}

/* ------------------------------------------------------------- windows */

/** Midnight UTC of the day `back` days before today, as a ms epoch. The
 *  boundaries this box asks about; the boundaries Umami BUCKETS by are its
 *  own, and every document downstream says so. */
export function dayStart(back: number, from = new Date()): number {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - back);
  return d.getTime();
}

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The window pair: the last `days` COMPLETE days, and the `days` before those.
 *
 * `end` is midnight at the start of today minus one millisecond, so today —
 * which is in progress — is outside both windows. A comparison against a
 * window that includes a partial day is a comparison that says traffic fell
 * every morning.
 */
export function windows(days = WINDOW_DAYS, from = new Date()) {
  const end = dayStart(0, from) - 1;
  const start = dayStart(days, from);
  const prevEnd = start - 1;
  const prevStart = dayStart(days * 2, from);
  return { start, end, prevStart, prevEnd };
}

/* -------------------------------------------------------------- verify */

/**
 * Is this instance reachable with this credential, and does it see anything?
 *
 * BOTH HALVES ARE CHECKED, because neither proves the other. A login that
 * succeeds against an instance whose websites list is empty is the wrong
 * instance or the wrong user, and it would otherwise connect happily and
 * report a portfolio of nothing forever — the most expensive shape of failure
 * on this dashboard, because it looks like an answer. An empty list is NOT
 * refused, though: a fresh Umami with no site yet is a real state, and it is
 * reported as a note rather than as a failure.
 */
export async function verify(
  values: Credentials,
): Promise<
  | { ok: true; via: "token" | "login"; websites: Website[]; note: string | null }
  | { ok: false; error: string }
> {
  try {
    const session = await open(values);
    const sites = await websites(session);
    return {
      ok: true,
      via: session.via,
      websites: sites,
      note: sites.length
        ? null
        : "That instance answered, and it has no websites on it yet — there is nothing to collect until one is added in Umami.",
    };
  } catch (err) {
    if (err instanceof UmamiError) {
      if (err.status === 401 || err.status === 403)
        return {
          ok: false,
          error:
            `${err.message} — the URL is right and the credential is not. ` +
            "A self-hosted instance wants the username and password you sign " +
            "in with; Umami Cloud wants an API key from Settings → API.",
        };
      if (err.status === 404)
        return {
          ok: false,
          error:
            `${err.message} — that URL is reachable but has no Umami API on ` +
            "it. Paste the address you open the dashboard at, without a path.",
        };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ==========================================================================
 * DIMENSIONS, EVENTS AND QUERY STRINGS — added by the webanalytics area,
 * 2026-09-06, for gap rows 32 and 33.
 *
 * EVERYTHING ABOVE THIS LINE STAYS EXACTLY AS IT WAS. The collector in
 * `analytics/collect.ts` calls `stats`, `pageviews` and `metrics` and calls
 * nothing here; this section is read only by
 * `integrations/webanalytics/umami-collect.ts`. Two collectors, two clocks,
 * one session helper — which is the whole reason this lives in this file
 * rather than in a second module that would re-learn the login, the two
 * authentication paths, the version-tolerant accessors and the `type=path`
 * versus `type=url` rename the hard way.
 *
 * WHAT THE CONNECTED INSTANCE ACTUALLY ANSWERS, probed live against
 * Umami 2.x (self-hosted, login auth) on 2026-09-06. This is a MEASUREMENT of
 * one instance, not a claim about the product, and every reader below records
 * which endpoint answered it so a different build's absence reads as absence
 * rather than as nought:
 *
 *   /metrics?type=…   country device browser os language screen city region
 *                     path title referrer query event tag   ANSWERED 200
 *                     host url                               REFUSED 400
 *   /events?event=<name>        raw event rows, `count` is the OCCURRENCES
 *   /sessions?event=<name>      session rows, `count` is the PARTICIPANTS
 *   /event-data/fields          property names, types and totals for the site
 *   /event-data/events?event=   per-event property VALUES with their totals
 *   /event-data/stats           how many events and properties exist at all
 *   /stats?event=<name>         answered 200 with FIVE ZEROS — the filter is
 *                               not honoured on this build, and a zero that
 *                               looks like a measurement is the worst answer
 *                               available. Nothing here calls it.
 *
 * WHAT EACH `y` COUNTS, and it is not one thing. Measured on three live sites
 * by summing every row of a metric and comparing with `/stats`:
 *
 *   country device browser os language screen   sums to VISITORS
 *       (543/527, 1167/1164, 1883/1883 — the shortfall is rows Umami dropped
 *        because the field was null on that session, and it is reported as
 *        `unattributed` rather than hidden)
 *   referrer query path title                   Umami's own count for a
 *       pageview-keyed metric. It is NOT the window's pageview total and this
 *       code does not claim it is; it is comparable with ITSELF across
 *       windows, which is all the surge heuristics need.
 *
 * So every row this section stores carries the population it counted, in
 * words, and nothing downstream adds a visitor-counted row to a view-counted
 * one.
 * ======================================================================== */

/**
 * The dimensions the webanalytics collector reads, and what each one counts.
 *
 * `screen` is here because it is the one field on this API that can catch a
 * browser nobody is looking at — see `webanalytics/bots.ts`. `referrer` is
 * here even though `analytics/collect.ts` already stores a 30-day top twenty,
 * because a surge is a comparison of two windows and that table holds one.
 */
export const DIMENSIONS = [
  "country",
  "device",
  "browser",
  "os",
  "language",
  "screen",
  "referrer",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Which population a dimension's `y` counts. Measured, not assumed — see the
 *  section header. */
export const DIMENSION_COUNTS: Record<Dimension, "visitors" | "views"> = {
  country: "visitors",
  device: "visitors",
  browser: "visitors",
  os: "visitors",
  language: "visitors",
  screen: "visitors",
  referrer: "views",
};

/**
 * How many rows a dimensional read asks for.
 *
 * Far above `TOP_LIMIT` because these rows are a DISTRIBUTION rather than a
 * ranking: a share is only meaningful against the whole, and a truncated tail
 * makes every share too big.
 *
 * IT IS NOT ENOUGH FOR EVERY SITE, and an earlier version of this comment
 * claimed it was. On one live site the `screen` dimension returned exactly 500
 * rows in all three windows — the cap, not the distribution — which made its screen
 * shares wrong against a short denominator AND made the route publish the
 * missing tail as "sessions with no screen". So the cap is now REPORTED:
 * `breakdown` returns `capped`, the flag is stored on every row of the block,
 * the route publishes the tail as missing rather than as a null field, and the
 * bot heuristics refuse to fire on a capped dimension because a share against
 * an unknown denominator is not a share.
 *
 * The number stays 500 rather than rising: raising it makes the cap rarer
 * without making it detectable, which is the failure this is fixing.
 */
export const DIMENSION_LIMIT = 500;

/** How many event names one site's collection looks at in detail. Twelve
 *  because each one costs two further requests (participants, properties) and
 *  an events list past twelve is instrumentation nobody reads. */
export const EVENT_DETAIL_LIMIT = 12;

/** How many distinct values of one string property are kept. */
export const PROPERTY_VALUE_LIMIT = 12;

/** A raw metric row, before it is named. */
const metricRows = (doc: unknown): { x?: unknown; y?: unknown }[] =>
  (Array.isArray(doc) ? doc : ((doc as { data?: unknown } | null)?.data as unknown[]) ?? []) as {
    x?: unknown;
    y?: unknown;
  }[];

/**
 * One dimension's distribution over one window, AND whether it is the whole of
 * one.
 *
 * A row whose `x` is absent is Umami's own "(none)" bucket and is KEPT under
 * that label, exactly as `metrics` keeps it: dropping it would make every
 * share below it too large, which is the specific error this whole section
 * exists to avoid.
 *
 * `capped` IS THE SAME ERROR ARRIVING BY A DIFFERENT DOOR. Umami answers at
 * most `limit` rows and says nothing about a tail, so a block that came back
 * exactly `limit` long is a block whose total is a floor rather than a total.
 * The flag travels with the rows so that nothing downstream computes a share
 * against it without knowing.
 */
export async function breakdown(
  session: Session,
  websiteId: string,
  dimension: Dimension,
  startAt: number,
  endAt: number,
  limit = DIMENSION_LIMIT,
): Promise<{ rows: TopRow[]; capped: boolean }> {
  const doc = await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/metrics` +
      `?startAt=${startAt}&endAt=${endAt}&type=${dimension}&limit=${limit}`,
  );
  const raw = metricRows(doc);
  const out: TopRow[] = [];
  for (const r of raw) {
    const count = num(r.y);
    if (count === null) continue;
    out.push({ name: typeof r.x === "string" && r.x.trim() ? r.x : "(none)", count });
  }
  /* The CAP is measured on what Umami sent, not on what survived parsing: a
     row dropped here for an unreadable count is still a row Umami counted
     towards the limit. */
  return { rows: out.sort((a, b) => b.count - a.count), capped: raw.length >= limit };
}

/** The custom events fired in a window, with their OCCURRENCE counts. Never
 *  a count of people — see `participants` below, which is a different call
 *  against a different table. */
export async function eventNames(
  session: Session,
  websiteId: string,
  startAt: number,
  endAt: number,
  limit = 50,
): Promise<TopRow[]> {
  const doc = await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/metrics` +
      `?startAt=${startAt}&endAt=${endAt}&type=event&limit=${limit}`,
  );
  const out: TopRow[] = [];
  for (const r of metricRows(doc)) {
    const count = num(r.y);
    if (count === null || typeof r.x !== "string" || !r.x.trim()) continue;
    out.push({ name: r.x, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * HOW MANY DISTINCT SESSIONS FIRED ONE EVENT — the figure gap row 33 is about.
 *
 * `/sessions?event=<name>` answers a page of session rows and a `count` of the
 * whole filtered set, so ONE request with `pageSize=1` buys the number and
 * none of the rows. Verified live: `payment-completed` 358 occurrences / 358
 * sessions, `checkout-started` 5,978 occurrences / 4,434 sessions. Those two
 * being different by a third IS the gap — an events ranking alone would have
 * reported the larger figure as though it were people.
 *
 * IT IS SESSIONS, NOT PEOPLE, and the endpoint that answered is returned so
 * the document can say so. Umami's session identity is a hash of the site, the
 * address and the user agent: one person on a phone and a laptop is two, and
 * one office behind one address may be one. `null` means the endpoint refused
 * — it is not nought, and it is not the occurrence count.
 */
export async function participants(
  session: Session,
  websiteId: string,
  eventName: string,
  startAt: number,
  endAt: number,
): Promise<{ count: number | null; endpoint: string; error: string | null }> {
  const endpoint = "/sessions?event=";
  try {
    const doc = (await get(
      session,
      `/api/websites/${encodeURIComponent(websiteId)}/sessions` +
        `?startAt=${startAt}&endAt=${endAt}&event=${encodeURIComponent(eventName)}&pageSize=1`,
    )) as { count?: unknown } | null;
    return { count: num(doc?.count), endpoint, error: null };
  } catch (err) {
    return { count: null, endpoint, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One property value of one event, as `/event-data/events` reports it.
 *  `dataType` is Umami's own integer; the names are in `PROPERTY_TYPES`. */
export type PropertyValue = {
  property: string;
  dataType: number;
  value: string;
  total: number;
};

/** Umami's `data_type` integers. 4 is a date and 5 an array on the builds
 *  seen; both are carried through as themselves rather than coerced. */
export const PROPERTY_TYPES: Record<number, string> = {
  1: "string",
  2: "number",
  3: "boolean",
  4: "date",
  5: "array",
};

/**
 * Every property VALUE one event carried in a window, with how often.
 *
 * Umami has no aggregate for a numeric property — it answers the value list
 * and the count of each — so the sum, mean and range this area publishes are
 * computed from these rows by `webanalytics/store.ts` and are exact rather
 * than sampled, PROVIDED the value list was not truncated. The truncation is
 * reported rather than assumed away.
 */
export async function eventProperties(
  session: Session,
  websiteId: string,
  eventName: string,
  startAt: number,
  endAt: number,
): Promise<PropertyValue[]> {
  const doc = await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/event-data/events` +
      `?startAt=${startAt}&endAt=${endAt}&event=${encodeURIComponent(eventName)}`,
  );
  const out: PropertyValue[] = [];
  for (const raw of Array.isArray(doc) ? doc : []) {
    const r = raw as {
      propertyName?: unknown;
      dataType?: unknown;
      propertyValue?: unknown;
      total?: unknown;
    };
    const property = typeof r.propertyName === "string" ? r.propertyName : null;
    const total = num(r.total);
    if (!property || total === null) continue;
    out.push({
      property,
      dataType: num(r.dataType) ?? 0,
      value: typeof r.propertyValue === "string" ? r.propertyValue : String(r.propertyValue ?? ""),
      total,
    });
  }
  return out;
}

/** Whether this site has any event properties at all. One cheap request that
 *  saves twelve when the answer is no. */
export async function eventDataStats(
  session: Session,
  websiteId: string,
  startAt: number,
  endAt: number,
): Promise<{ events: number | null; properties: number | null }> {
  const doc = (await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/event-data/stats?startAt=${startAt}&endAt=${endAt}`,
  )) as { events?: unknown; properties?: unknown } | null;
  return { events: num(doc?.events), properties: num(doc?.properties) };
}

/**
 * The query strings pageviews arrived with, as Umami stores them: VERBATIM,
 * never split. The campaign that paid for a visit is sitting in here as text
 * and this is the only place on the HTTP API it appears.
 */
export async function queryStrings(
  session: Session,
  websiteId: string,
  startAt: number,
  endAt: number,
  limit = DIMENSION_LIMIT,
): Promise<TopRow[]> {
  const doc = await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/metrics` +
      `?startAt=${startAt}&endAt=${endAt}&type=query&limit=${limit}`,
  );
  const out: TopRow[] = [];
  for (const r of metricRows(doc)) {
    const count = num(r.y);
    if (count === null || typeof r.x !== "string" || !r.x.trim()) continue;
    out.push({ name: r.x, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

export type Utm = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
};

/**
 * The five UTM parameters out of one raw query string.
 *
 * LOWERCASED ON THE KEY AND ON THE VALUE, so `?utm_Source=Google` and
 * `?utm_source=google` are one row rather than two. `URLSearchParams` does the percent-decoding
 * and the `+`-for-space that a hand-rolled regex gets wrong.
 *
 * A string with no UTM at all returns five nulls, and the caller drops it: a
 * row of five nulls is every organic visit on the site and carries nothing.
 */
export function parseUtm(query: string): Utm {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  const pick = (key: string): string | null => {
    for (const [k, v] of params) {
      if (k.trim().toLowerCase() !== key) continue;
      const value = v.trim().toLowerCase();
      if (value) return value.slice(0, 200);
    }
    return null;
  };
  return {
    source: pick("utm_source"),
    medium: pick("utm_medium"),
    campaign: pick("utm_campaign"),
    content: pick("utm_content"),
    term: pick("utm_term"),
  };
}

/**
 * A window of `days` COMPLETE days, ending `offset` days before today.
 *
 * `offset: 0` is the last `days` finished days; `offset: days` is the `days`
 * before those. Built on `dayStart` so it keeps the one rule the whole
 * integration keeps: TODAY IS NEVER IN A WINDOW, because a partial day drawn
 * beside finished ones is a cliff that appears every morning.
 */
export function windowAt(days: number, offset = 0, from = new Date()) {
  const end = dayStart(offset, from) - 1;
  const start = dayStart(offset + days, from);
  return { start, end, startDay: isoDay(start), endDay: isoDay(end) };
}
