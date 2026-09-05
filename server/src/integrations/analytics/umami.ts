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
      const doc = JSON.parse(text) as { message?: string; error?: string };
      reason = doc.message ?? doc.error ?? reason;
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

/** The websites this login can see. `{data: […]}` on current versions, a bare
 *  array on older ones. */
export async function websites(session: Session): Promise<Website[]> {
  const doc = await get(session, "/api/websites?pageSize=200");
  const rows = Array.isArray(doc)
    ? doc
    : ((doc as { data?: unknown } | null)?.data as unknown[]) ?? [];
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
  const doc = await get(
    session,
    `/api/websites/${encodeURIComponent(websiteId)}/metrics` +
      `?startAt=${startAt}&endAt=${endAt}&type=${kind}&limit=${TOP_LIMIT}`,
  );
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
