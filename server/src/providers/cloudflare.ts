/**
 * Cloudflare.
 *
 * WHAT THE OWNER PASTES: one API token, and it should be scoped to READ. The
 * token this was built against is deliberately zone-read-only, and that is not
 * a limitation to work around — it is the shape of the integration. A token
 * that can edit a zone's settings or deploy a Pages project is a token that can
 * take twenty-three live sites down; a dashboard has no business holding one.
 * So every gap this file reports is reported as a gap, and none of them is
 * closed by asking for more power.
 *
 * FOUR SOURCES, AND EACH ONE DEGRADES ON ITS OWN. The shape is lifted from
 * workdash's `collectors/collect_domains.py`, which is the version that has
 * actually been run against this account:
 *
 *   zones        REST      the only hard dependency. Without it there is no
 *                          document at all, so a failure here fails the run.
 *   dns_records  REST      per zone. A zone that cannot be read keeps its row
 *                          with a `recordsNote` and NULL counts — not zero
 *                          records, which is a different and alarming claim.
 *   registrar    REST      account-scoped. Most domains are registered
 *                          elsewhere, so an empty answer is the NORMAL one and
 *                          not an error. A token without the permission gets
 *                          `readable: false` and one honest line, which is a
 *                          third answer again.
 *   analytics    GraphQL   batched at TEN ZONES PER QUERY — Cloudflare's hard
 *                          cap on zone-scoped queries, not a tuning knob. A
 *                          zone with no answer is null with a reason, because
 *                          a zone nobody could measure and a zone nobody
 *                          visited must never look the same.
 *
 * Everything read here is on the Cloudflare Free plan and costs nothing.
 * `httpRequests1dGroups` in particular is the pre-aggregated, UNSAMPLED daily
 * rollup that powers the free zone analytics dashboard — the adaptive sampled
 * datasets beside it would put a confidence interval on every figure this
 * dashboard prints, for a grain nothing here needs.
 *
 * WHAT WAS PROBED, AND WHAT IT SAID. 2026-09-04, against the live token:
 *
 *   GET  /user/tokens/verify              200, status "active"
 *   GET  /zones?per_page=50               200, 23 zones, one account, all Free
 *   GET  /zones/{id}/dns_records          200, 247 records across the 23
 *   GET  /accounts/{id}/registrar/domains 200, EMPTY — nothing is registered
 *                                         at Cloudflare Registrar
 *   GET  /accounts/{id}/registrar/registrations  200, empty likewise
 *   POST /graphql httpRequests1dGroups    200, every zone, full field set,
 *                                         90 days of daily rollups available
 *   GET  /accounts?per_page=50            200 and an EMPTY list — the token
 *                                         cannot enumerate accounts, which is
 *                                         why the account id is taken off the
 *                                         zones (they each carry one) rather
 *                                         than from a listing call
 *   GET  /zones/{id}/settings             403 9109 Unauthorized
 *   GET  /accounts/{id}/pages/projects    403 10000 Authentication error
 *   POST /graphql accounts{…1dGroups}     "not authorized for that account"
 *   POST /graphql firewallEventsAdaptive  "zone does not have access to path"
 *
 * The refusals are in CANNOT below, written as the exchange rather than as a
 * conclusion, so a card can show the evidence instead of the verdict.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_GRAPHQL = `${CLOUDFLARE_API}/graphql`;

const TIMEOUT_MS = 30_000;

/** The paging leash on the REST list endpoints. Fifty zones a page and 100
 *  records a zone, so this is generous by an order of magnitude — it exists so
 *  a bug in somebody else's `total_pages` cannot hang a collector forever. */
const MAX_PAGES = 25;

/**
 * Cloudflare refuses a zone-scoped GraphQL query covering more than ten zones
 * — "too many zones requested", extension code `quota`, verified against this
 * account. It is a protocol limit rather than a batch size worth tuning, which
 * is why it is a constant with a sentence attached rather than a config value.
 */
export const GRAPHQL_ZONE_BATCH = 10;

/**
 * How many days of daily rollups each collection asks for.
 *
 * Ninety are available on this account (probed), but rows here are keyed by
 * (zone, day) and REPLACED, so history accumulates run over run regardless —
 * thirty is what a first collection has to draw with, not a ceiling on what is
 * kept. The route decides how many of them a card reads.
 */
export const WINDOW_DAYS = 30;

/**
 * What this token, and in places this API, will not tell you.
 *
 * Dated and stated as a property of the API rather than re-probed on a timer:
 * deliberately calling four endpoints every six hours to watch them 403 is
 * noise in somebody else's logs, to re-learn a fact that changes when the
 * owner re-scopes a token — not when the collector runs.
 */
export const CANNOT = {
  checkedOn: "2026-09-04",
  asked: [
    { asked: "GET /zones/{id}/settings", answer: "403 — Unauthorized to access requested resource" },
    { asked: "GET /accounts/{id}/pages/projects", answer: "403 — Authentication error" },
    { asked: "GET /accounts (list)", answer: "200 with an empty list — the token cannot enumerate accounts" },
    { asked: "GraphQL accounts { httpRequests1dGroups }", answer: "not authorized for that account" },
    { asked: "GraphQL firewallEventsAdaptiveGroups", answer: "this zone does not have access to that path" },
    { asked: "Bot, WAF or Turnstile figures", answer: "the same account-level surface, refused" },
  ],
  /** Said once, so a card does not have to derive it from six refusals. */
  summary:
    "This token reads zones, their DNS records and their daily traffic rollups. " +
    "It cannot read zone settings, Pages projects, or anything account-scoped " +
    "beyond the registrar list — and it is not meant to.",
} as const;

/* ------------------------------------------------------------------ shapes */

/** SPF / DMARC / DKIM / MX, derived from records already on hand. */
export type EmailFlags = {
  mx: boolean;
  spf: boolean;
  dmarc: boolean;
  /** The `p=` of the DMARC record, when there is a record to read it from.
   *  Null where DMARC is delegated by CNAME — present, but the policy lives on
   *  somebody else's side and guessing it would be inventing a posture. */
  dmarcPolicy: string | null;
  /**
   * The one flag with three states rather than two. A selector under
   * `*._domainkey` proves DKIM; its absence proves nothing at all when the zone
   * shows no sign of handling mail, and it is only meaningfully false when the
   * domain clearly does send mail and the selector namespace is both empty and
   * undelegated.
   */
  dkim: boolean | null;
};

export type ZoneRow = {
  accountId: number;
  accountLabel: string;
  /** Cloudflare's own zone id — the tag every GraphQL query is keyed by. */
  id: string;
  name: string;
  /** Cloudflare's word: active, pending, moved, deactivated … */
  status: string | null;
  paused: boolean;
  plan: string | null;
  /** "full" or "partial" (CNAME setup). A partial zone is not serving the
   *  whole domain, which changes what its traffic figure is a figure OF. */
  type: string | null;
  createdOn: string | null;
  /** The nameservers CLOUDFLARE assigns this zone. The other half of the drift
   *  join lives in the `domains` table, put there by the registrars. */
  nameServers: string[] | null;
  /** Null, never zero, when the record listing could not be read. */
  records: number | null;
  proxied: number | null;
  /** A CNAME to *.pages.dev — the only trace of a Pages project this token can
   *  see, since the Pages API itself answers 403. Null when records failed. */
  onPages: boolean | null;
  email: EmailFlags | null;
  /** Why the records are null, when they are. */
  recordsNote: string | null;
  /** Why this zone has no traffic rows, when it has none. */
  trafficNote: string | null;
  /** The Cloudflare account this zone sits in — carried on the zone object,
   *  which is the only place this token can read it. */
  cfAccountId: string | null;
  cfAccountName: string | null;
};

/**
 * One zone's traffic on one UTC day.
 *
 * Every optional field is null rather than zero when the field set that
 * actually landed did not include it — see PROFILES. A `threats` of null means
 * "this query could not ask", and a `threats` of 0 means Cloudflare counted
 * none. Folding those together is how a security card starts lying.
 */
export type TrafficRow = {
  zoneId: string;
  day: string;
  requests: number;
  cached: number;
  bytes: number;
  threats: number | null;
  pageViews: number | null;
  /**
   * Cloudflare de-duplicates visitors WITHIN each day. So this adds up over
   * zones about as well as GitHub's uniques add up over repos — which is to
   * say it does not, and everything downstream that sums it says so.
   */
  uniques: number | null;
  s2xx: number | null;
  s3xx: number | null;
  s4xx: number | null;
  s5xx: number | null;
  /** Which field set answered: "full", "noStatus" or "minimal". It is what
   *  tells a null threats count apart from a genuine zero. */
  fields: string;
};

/** A domain registered AT Cloudflare. Empty is the ordinary answer here. */
export type RegistrarRow = {
  accountId: number;
  accountLabel: string;
  name: string;
  expiresAt: string | null;
  autoRenew: boolean | null;
  locked: boolean | null;
  registrar: string | null;
  status: string | null;
};

export type AccountOutcome = {
  id: number;
  label: string;
  /** False only when the ZONE listing failed. A zone whose records or traffic
   *  could not be read is a gap in an answer that arrived, and an account
   *  demoted to "failing" over a gap is an account whose perfectly good token
   *  gets re-pasted. */
  ok: boolean;
  error?: string;
  cfAccountId: string | null;
  cfAccountName: string | null;
  zones: number;
  /** Did the registrar list answer at all, and what did it say? Three states:
   *  readable with rows, readable and empty (the normal one here), or refused. */
  registrarReadable: boolean;
  registrarCount: number;
  registrarNote: string | null;
  /** How many zones came back with traffic, and why the rest did not. */
  analyticsZones: number;
  analyticsNote: string | null;
};

export type CollectResult = {
  zones: ZoneRow[];
  traffic: TrafficRow[];
  registrar: RegistrarRow[];
  accounts: AccountOutcome[];
  accountsTried: number;
  warnings: string[];
};

/* -------------------------------------------------------------------- http */

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
  }
}

type CfEnvelope<T> = {
  success?: boolean;
  result?: T;
  result_info?: { page?: number; total_pages?: number; total_count?: number; cursor?: string };
  errors?: { code?: number; message?: string }[];
};

/** Cloudflare's errors[] flattened to one line. A bare status code sends the
 *  owner to the docs for something the API already explained: a 403 here comes
 *  back as "Unauthorized to access requested resource", which names the fix. */
function describeErrors(body: CfEnvelope<unknown> | null): string | null {
  const errs = body?.errors ?? [];
  if (!errs.length) return null;
  return (
    errs
      .slice(0, 3)
      .map((e) => `${e.code ? `${e.code}: ` : ""}${e.message ?? "error"}`.slice(0, 140))
      .join("; ")
      .slice(0, 220) || null
  );
}

/**
 * One round trip that never throws.
 *
 * The body is parsed even on an error status, because that is where Cloudflare
 * puts the reason — and the reason is the whole value of a 403 here. Callers
 * decide what is fatal; almost none of them think anything is.
 */
async function request<T>(
  url: string,
  token: string,
  payload?: unknown,
): Promise<{ status: number; body: CfEnvelope<T> | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: CfEnvelope<T> | null = null;
    try {
      body = (await res.json()) as CfEnvelope<T>;
    } catch {
      /* not JSON; the status is all there is */
    }
    if (!res.ok || body?.success === false)
      return {
        status: res.status,
        body,
        error: describeErrors(body) ?? `HTTP ${res.status}`,
      };
    return { status: res.status, body, error: null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return {
      status: 0,
      body: null,
      error:
        name === "TimeoutError"
          ? "Cloudflare did not answer within 30 seconds."
          : `Could not reach Cloudflare (${name}).`,
    };
  }
}

/**
 * The tolerant call: rows, paging info, and a reason instead of an exception.
 *
 * There is no strict counterpart. Every REST read here goes through this,
 * because in this integration exactly one failure is fatal — the zone listing —
 * and the collector decides that by looking at the reason it got back rather
 * than by catching an exception thrown three frames away from the cause.
 */
async function getSoft<T>(
  path: string,
  token: string,
): Promise<{ rows: T[]; info: CfEnvelope<T[]>["result_info"]; error: string | null }> {
  const { body, error } = await request<T[]>(`${CLOUDFLARE_API}/${path}`, token);
  if (error) return { rows: [], info: {}, error };
  const result = body?.result;
  const rows = Array.isArray(result) ? result : result == null ? [] : [result as T];
  return { rows, info: body?.result_info ?? {}, error: null };
}

/**
 * Page/per_page pagination for the REST list endpoints.
 *
 * THE FIRST REQUEST SENDS NO `page` PARAMETER, and that is load-bearing rather
 * than tidy. Cloudflare's registrar list answers an explicit `page=1` on an
 * EMPTY collection with "Page bigger than the number of pages" — total_pages is
 * 0, so page 1 is already past the end — which turns "no domains registered
 * here", the ordinary answer on this account, into an error. Omitting the
 * parameter means page one everywhere else and a clean empty success there.
 */
async function paged<T>(
  path: string,
  token: string,
  perPage = 100,
): Promise<{ rows: T[]; error: string | null; total: number | null }> {
  const out: T[] = [];
  let total: number | null = null;
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${path}${sep}per_page=${perPage}${page > 1 ? `&page=${page}` : ""}`;
    const { rows, info, error } = await getSoft<T>(url, token);
    if (error) return { rows: out, error, total };
    out.push(...rows);
    if (typeof info?.total_count === "number") total = info.total_count;
    const pages = info?.total_pages ?? 1;
    if (!pages || page >= pages) break;
  }
  return { rows: out, error: null, total };
}

/* ------------------------------------------------------------------ verify */

export type VerifyResult =
  | { ok: true; zones: number; cfAccountName: string | null }
  | { ok: false; error: string };

/**
 * Is this token real, and can it actually read a zone?
 *
 * TWO CALLS, because the two questions are different and only one of them is
 * the one that matters. `/user/tokens/verify` proves the token exists and is
 * active — it answers 200 for a token scoped to nothing at all. The zone
 * listing proves it carries Zone:Read, which is what every figure downstream
 * rests on. A token that passed the first check and failed the second would
 * connect happily and then show an empty dashboard for a reason nothing on the
 * page could state, which is the most expensive shape of failure here.
 */
export async function verify(token: string): Promise<VerifyResult> {
  const check = await request<{ id?: string; status?: string }>(
    `${CLOUDFLARE_API}/user/tokens/verify`,
    token,
  );
  if (check.error)
    return {
      ok: false,
      error:
        check.status === 400 || check.status === 401
          ? "Cloudflare rejected that token. It is the value shown once when the token was created at dash.cloudflare.com/profile/api-tokens."
          : check.error,
    };
  const status = check.body?.result?.status;
  if (status && status !== "active")
    return { ok: false, error: `Cloudflare reports that token as "${status}", not active.` };

  const zones = await getSoft<RawZone>("zones?per_page=50", token);
  if (zones.error)
    return {
      ok: false,
      error:
        `The token is valid but could not list zones — ${zones.error}. ` +
        `It needs Zone → Zone → Read (and, for the DNS cards, Zone → DNS → Read). ` +
        `Nothing here needs an Edit permission.`,
    };
  if (!zones.rows.length)
    return {
      ok: false,
      error:
        "The token is valid and lists no zones at all. Either it is scoped to " +
        "specific zones that no longer exist, or its Zone Resources are set to " +
        "an account with none.",
    };
  return {
    ok: true,
    zones: zones.rows.length,
    cfAccountName: zones.rows[0]?.account?.name ?? null,
  };
}

/* ------------------------------------------------------------------- zones */

type RawZone = {
  id?: string;
  name?: string;
  status?: string;
  paused?: boolean;
  type?: string;
  created_on?: string;
  name_servers?: string[];
  plan?: { name?: string };
  account?: { id?: string; name?: string };
};

type RawRecord = {
  type?: string;
  name?: string;
  content?: string;
  proxied?: boolean;
};

/* ------------------------------------------------- email, from the records */

const txt = (r: RawRecord) => (r.content ?? "").trim().replace(/^"|"$/g, "").trim();

/**
 * SPF / DMARC / DKIM / MX from records that were fetched anyway.
 *
 * The records are read for the host and proxy counts; throwing them away
 * afterwards meant the dashboard could see where a domain pointed but never
 * whether it could be SPOOFED, which is the more actionable of the two. The
 * flags are the deliverable and cost no extra request.
 */
export function emailFlags(records: RawRecord[], zoneName: string): EmailFlags {
  const apex = zoneName.toLowerCase().replace(/\.$/, "");
  const dmarcHost = `_dmarc.${apex}`;
  const dkimSuffix = `_domainkey.${apex}`;

  let mx = false;
  let spf = false;
  let dmarc = false;
  let dmarcPolicy: string | null = null;
  let dkimRecords = false;
  let dkimDelegated = false;

  for (const r of records) {
    const name = (r.name ?? "").toLowerCase().replace(/\.$/, "");
    if (r.type === "MX" && name === apex) mx = true;
    else if (r.type === "TXT") {
      const value = txt(r);
      const low = value.toLowerCase();
      if (name === apex && low.startsWith("v=spf1")) spf = true;
      else if (name === dmarcHost && low.startsWith("v=dmarc1")) {
        dmarc = true;
        for (const part of value.split(";")) {
          const trimmed = part.trim();
          if (trimmed.toLowerCase().startsWith("p=")) {
            dmarcPolicy = trimmed.slice(2).trim().toLowerCase() || null;
            break;
          }
        }
      }
    } else if (r.type === "CNAME" && name === dmarcHost) {
      // Delegated to a DMARC reporting provider: the record is present, but the
      // policy is on their side. Present with an unknown policy, not absent.
      dmarc = true;
    }
    if (name.endsWith(dkimSuffix) && name !== dkimSuffix) {
      if (r.type === "NS") dkimDelegated = true;
      else if (r.type === "TXT" || r.type === "CNAME") dkimRecords = true;
    }
  }

  const dkim = dkimRecords ? true : dkimDelegated || !(mx || spf) ? null : false;
  return { mx, spf, dmarc, dmarcPolicy, dkim };
}

/* --------------------------------------------------------------- analytics */

/**
 * The field sets, tried widest first.
 *
 * `threats` is marked @Deprecated in Cloudflare's schema and
 * `responseStatusMap` is the widest selection of the three, so a query asking
 * for everything fails WHOLE if either is ever withdrawn. Falling back to a
 * thinner selection keeps the request count — by far the most useful figure —
 * flowing, with the fields that were dropped reported as null rather than as
 * zero. Which profile answered travels with every row for exactly that reason.
 */
const PROFILES: { name: string; fields: string }[] = [
  {
    name: "full",
    fields:
      "sum { requests cachedRequests bytes threats pageViews " +
      "responseStatusMap { edgeResponseStatus requests } } uniq { uniques }",
  },
  { name: "noStatus", fields: "sum { requests cachedRequests bytes threats pageViews } uniq { uniques }" },
  { name: "minimal", fields: "sum { requests cachedRequests bytes }" },
];

const TRAFFIC_QUERY = (fields: string) => `query Traffic($tags: [string!]!, $start: Date!, $end: Date!) {
  viewer {
    zones(filter: { zoneTag_in: $tags }, limit: ${GRAPHQL_ZONE_BATCH}) {
      zoneTag
      httpRequests1dGroups(
        limit: 100
        filter: { date_geq: $start, date_lt: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        ${fields}
      }
    }
  }
}`;

type GqlDay = {
  dimensions?: { date?: string };
  sum?: {
    requests?: number;
    cachedRequests?: number;
    bytes?: number;
    threats?: number;
    pageViews?: number;
    responseStatusMap?: { edgeResponseStatus?: number; requests?: number }[];
  };
  uniq?: { uniques?: number };
};

type GqlZone = { zoneTag?: string; httpRequests1dGroups?: GqlDay[] };

/**
 * GraphQL answers HTTP 200 for a query it refused, with the refusal in
 * `errors`. Treating the status as the answer is how a permission problem
 * becomes a zone with no traffic.
 */
async function graphql(
  token: string,
  tags: string[],
  fields: string,
  start: string,
  end: string,
): Promise<{ zones: GqlZone[] | null; error: string | null }> {
  const res = await request<never>(CLOUDFLARE_GRAPHQL, token, {
    query: TRAFFIC_QUERY(fields),
    variables: { tags, start, end },
  });
  const doc = res.body as unknown as
    | { data?: { viewer?: { zones?: GqlZone[] } }; errors?: { message?: string }[] }
    | null;
  const gqlError = doc?.errors?.length
    ? doc.errors
        .slice(0, 3)
        .map((e) => (e.message ?? "error").slice(0, 140))
        .join("; ")
    : null;
  if (gqlError) return { zones: null, error: gqlError };
  if (res.error) return { zones: null, error: res.error };
  const zones = doc?.data?.viewer?.zones;
  return Array.isArray(zones)
    ? { zones, error: null }
    : { zones: null, error: "GraphQL answered with no data." };
}

/**
 * Which retry, if any, could possibly help.
 *
 *   rate    nothing will; stop, or the 300-queries-per-five-minutes budget
 *           turns a slow quarter of an hour into a locked-out one.
 *   fields  the selection is wrong for this account — proving that zone by
 *           zone is the same finding, ten times, at ten times the cost.
 *   auth    might be the whole token, might be one zone. Worth exactly two
 *           probes to find out, which is what the collector below spends.
 *   zone    ordinary per-zone trouble; split the batch and carry on.
 */
function classify(error: string): "rate" | "fields" | "auth" | "zone" {
  const low = error.toLowerCase();
  if (/rate limit|too many requests|429/.test(low)) return "rate";
  if (/cannot query field|unknown field|unknown argument|syntax error|no such type|not available|is disabled|too many zones/.test(low))
    return "fields";
  if (/authentic|authoriz|permission|denied|forbidden|invalid api token|401|403/.test(low))
    return "auth";
  return "zone";
}

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const maybeInt = (v: unknown): number | null => {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function absorb(zone: GqlZone, profile: string, out: TrafficRow[]) {
  const zoneId = zone.zoneTag;
  if (!zoneId) return;
  for (const day of zone.httpRequests1dGroups ?? []) {
    const date = day.dimensions?.date;
    if (!date) continue;
    const sum = day.sum ?? {};
    let s2xx: number | null = null;
    let s3xx: number | null = null;
    let s4xx: number | null = null;
    let s5xx: number | null = null;
    if (sum.responseStatusMap) {
      s2xx = s3xx = s4xx = s5xx = 0;
      for (const entry of sum.responseStatusMap) {
        const bucket = Math.floor(int(entry.edgeResponseStatus) / 100);
        const n = int(entry.requests);
        if (bucket === 2) s2xx += n;
        else if (bucket === 3) s3xx += n;
        else if (bucket === 4) s4xx += n;
        else if (bucket === 5) s5xx += n;
      }
    }
    out.push({
      zoneId,
      day: date,
      requests: int(sum.requests),
      cached: int(sum.cachedRequests),
      bytes: int(sum.bytes),
      threats: maybeInt(sum.threats),
      pageViews: maybeInt(sum.pageViews),
      uniques: maybeInt(day.uniq?.uniques),
      s2xx,
      s3xx,
      s4xx,
      s5xx,
      fields: profile,
    });
  }
}

/**
 * Every zone's daily rollups, for as many zones as Cloudflare will answer for.
 *
 * Batches of ten, because that is the cap. A failed batch is retried one zone
 * at a time so that a single unreadable zone cannot blank out nine healthy
 * ones — except when the error indicts the whole query, and except when two
 * zones in a row report a permission problem and no zone anywhere has yet
 * succeeded, which is what a token missing analytics access looks like. That
 * costs three queries to establish rather than thirty-six.
 *
 * A zone the response simply OMITTED is a zone the query answered for and had
 * nothing to say about — genuinely no traffic — so it is absorbed as an empty
 * day list rather than left to become a null. That distinction is the whole
 * point of this function: a zone nobody visited and a zone nobody could
 * measure must not look the same.
 */
async function collectTraffic(
  token: string,
  zoneIds: string[],
  start: string,
  end: string,
): Promise<{ rows: TrafficRow[]; answered: Set<string>; notes: Map<string, string> }> {
  const rows: TrafficRow[] = [];
  const answered = new Set<string>();
  const notes = new Map<string, string>();

  const take = (zones: GqlZone[], profile: string, batch: string[]) => {
    for (const z of zones) {
      if (!z.zoneTag || answered.has(z.zoneTag)) continue;
      absorb(z, profile, rows);
      answered.add(z.zoneTag);
    }
    for (const tag of batch) if (!answered.has(tag)) answered.add(tag);
  };

  const giveUp = (reason: string) => {
    for (const tag of zoneIds) if (!answered.has(tag)) notes.set(tag, reason);
  };

  let pending = [...zoneIds];
  for (const profile of PROFILES) {
    if (!pending.length) break;
    let stillFailing: string[] = [];
    let retireProfile = false;

    for (let i = 0; i < pending.length; i += GRAPHQL_ZONE_BATCH) {
      const batch = pending.slice(i, i + GRAPHQL_ZONE_BATCH);
      const { zones, error } = await graphql(token, batch, profile.fields, start, end);
      if (!error && zones) {
        take(zones, profile.name, batch);
        continue;
      }
      const kind = classify(error!);
      if (kind === "rate") {
        giveUp(error!);
        return { rows, answered, notes };
      }
      if (kind === "fields") {
        retireProfile = true;
        break;
      }

      let authStreak = 0;
      for (const tag of batch) {
        const one = await graphql(token, [tag], profile.fields, start, end);
        if (!one.error && one.zones) {
          take(one.zones, profile.name, [tag]);
          authStreak = 0;
          continue;
        }
        stillFailing.push(tag);
        notes.set(tag, one.error!);
        const kindOne = classify(one.error!);
        if (kindOne === "rate") {
          giveUp(one.error!);
          return { rows, answered, notes };
        }
        if (kindOne === "auth") {
          authStreak += 1;
          // Two in a row and nothing has ever worked: it is the token, not the
          // zones, and thirty more probes would say so thirty more times.
          if (authStreak >= 2 && !answered.size) {
            giveUp(one.error!);
            return { rows, answered, notes };
          }
        } else authStreak = 0;
      }
    }

    if (retireProfile) stillFailing = pending.filter((t) => !answered.has(t));
    pending = stillFailing.filter((t) => !answered.has(t));
  }

  for (const tag of pending) if (!notes.has(tag)) notes.set(tag, "No analytics answer.");
  for (const tag of answered) notes.delete(tag);
  return { rows, answered, notes };
}

/* --------------------------------------------------------------- registrar */

type RawRegistrarDomain = {
  id?: string;
  name?: string;
  expires_at?: string;
  locked?: boolean;
  current_registrar?: string;
  registry_statuses?: string;
};

type RawRegistration = {
  domain_name?: string;
  name?: string;
  expires_at?: string;
  auto_renew?: boolean;
  locked?: boolean;
  status?: string;
};

const isoDay = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/**
 * The domains registered AT Cloudflare, which on this account is none.
 *
 * TWO ENDPOINTS, because neither alone has the whole picture.
 * `/registrar/domains` is the long-standing list and carries `expires_at`,
 * `locked` and `current_registrar` — and no auto-renew field at all.
 * `/registrar/registrations` is the newer resource that does carry auto_renew,
 * and may 404 on an account the beta has not reached, which is why it is a
 * top-up rather than the primary read.
 *
 * AN EMPTY LIST IS THE NORMAL ANSWER AND NOT AN ERROR. Every name on this
 * account is registered at Dynadot, Spaceship or somewhere with no API here;
 * "0 domains at Cloudflare Registrar" is a measurement. What is NOT the same
 * thing is a token that cannot ask — which comes back as `readable: false` and
 * a sentence, so a reader never mistakes a refusal for a portfolio.
 */
async function collectRegistrar(
  token: string,
  cfAccountId: string,
): Promise<{ rows: Omit<RegistrarRow, "accountId" | "accountLabel">[]; readable: boolean; note: string | null }> {
  const byName = new Map<string, Omit<RegistrarRow, "accountId" | "accountLabel">>();

  const listed = await paged<RawRegistrarDomain>(
    `accounts/${cfAccountId}/registrar/domains`,
    token,
    50,
  );
  if (listed.error)
    return {
      rows: [],
      readable: false,
      note: `Cloudflare Registrar list refused: ${listed.error}`,
    };

  for (const r of listed.rows) {
    const name = (r.name ?? r.id ?? "").trim().toLowerCase();
    if (!name) continue;
    byName.set(name, {
      name,
      expiresAt: isoDay(r.expires_at),
      // Absent from this endpoint entirely. Null, never false — a registrar
      // that does not report auto-renew is not a registrar reporting it off.
      autoRenew: null,
      locked: typeof r.locked === "boolean" ? r.locked : null,
      registrar: r.current_registrar || null,
      status: r.registry_statuses || null,
    });
  }

  /*
    The cursor-paginated beta resource, read quietly. Its whole job is to add
    auto_renew, so a 404 here means that field stays null — which is a smaller
    failure than losing the expiry dates the call above already returned.
  */
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path =
      `accounts/${cfAccountId}/registrar/registrations?per_page=50` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const { rows, info, error } = await getSoft<RawRegistration>(path, token);
    if (error) break;
    for (const r of rows) {
      const name = (r.domain_name ?? r.name ?? "").trim().toLowerCase();
      if (!name) continue;
      const entry = byName.get(name) ?? {
        name,
        expiresAt: null,
        autoRenew: null,
        locked: null,
        registrar: null,
        status: null,
      };
      const expires = isoDay(r.expires_at);
      if (expires) entry.expiresAt = expires;
      if (typeof r.auto_renew === "boolean") entry.autoRenew = r.auto_renew;
      if (typeof r.locked === "boolean") entry.locked = r.locked;
      if (r.status) entry.status = r.status;
      byName.set(name, entry);
    }
    cursor = info?.cursor || undefined;
    if (!cursor) break;
  }

  return { rows: [...byName.values()], readable: true, note: null };
}

/* ----------------------------------------------------------------- collect */

/** UTC calendar days, which is the grain Cloudflare's rollup is keyed by. */
const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/**
 * Every connected Cloudflare account, in one pass.
 *
 * Per-account failure is that account's own, the way it is everywhere here: a
 * second token that has been revoked costs its own row and nothing else, and
 * the run fails only when every account failed.
 *
 * THE WINDOW INCLUDES TODAY, deliberately, and every row says which day it is.
 * Today's bucket is partial — Cloudflare is still writing it — so it is stored
 * as the measurement it is and left out of the windows the route computes. A
 * partial bucket that is stored and marked is correctable tomorrow; one that is
 * never fetched is a hole, and one that is fetched and summed with the rest is
 * a Tuesday that looks like a collapse in traffic.
 */
export async function collect(reader = "collect_cloudflare"): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed("cloudflare", ["token"], reader);

  const zones: ZoneRow[] = [];
  const traffic: TrafficRow[] = [];
  const registrar: RegistrarRow[] = [];
  const outcomes: AccountOutcome[] = [];
  const warnings: string[] = [];

  for (const { account } of broken) {
    outcomes.push({
      id: account.id,
      label: account.label,
      ok: false,
      error: "No API token stored.",
      cfAccountId: null,
      cfAccountName: null,
      zones: 0,
      registrarReadable: false,
      registrarCount: 0,
      registrarNote: null,
      analyticsZones: 0,
      analyticsNote: null,
    });
    warnings.push(`${account.label}: no API token stored`);
  }

  const start = utcDay(-WINDOW_DAYS);
  const end = utcDay(1); // date_lt, so this includes today's partial bucket

  for (const { account, values } of ready) {
    const token = (values.token ?? "").trim();
    const label = account.label;

    let raw: RawZone[];
    try {
      const listed = await paged<RawZone>("zones", token, 50);
      if (listed.error) throw new CloudflareError(0, listed.error);
      raw = listed.rows;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      warnings.push(`${label}: ${error}`);
      outcomes.push({
        id: account.id,
        label,
        ok: false,
        error,
        cfAccountId: null,
        cfAccountName: null,
        zones: 0,
        registrarReadable: false,
        registrarCount: 0,
        registrarNote: null,
        analyticsZones: 0,
        analyticsNote: null,
      });
      continue;
    }

    const usable = raw.filter((z): z is RawZone & { id: string; name: string } =>
      Boolean(z.id && z.name),
    );

    /*
      THE ACCOUNT ID COMES OFF THE ZONES. Every zone object carries the account
      it lives in, and this token cannot enumerate accounts — `GET /accounts`
      answers 200 with an empty list rather than 403, so a fallback to a
      listing call would silently produce no account id and no registrar read
      at all. Taking it from the data that already arrived is both correct and
      one request cheaper.
    */
    const cfAccountId = usable.find((z) => z.account?.id)?.account?.id ?? null;
    const cfAccountName = usable.find((z) => z.account?.name)?.account?.name ?? null;

    let registrarReadable = false;
    let registrarNote: string | null = null;
    let registrarCount = 0;
    if (cfAccountId) {
      const reg = await collectRegistrar(token, cfAccountId);
      registrarReadable = reg.readable;
      registrarNote = reg.note;
      registrarCount = reg.rows.length;
      for (const row of reg.rows)
        registrar.push({ ...row, accountId: account.id, accountLabel: label });
      if (reg.note) warnings.push(`${label}: ${reg.note}`);
    } else {
      registrarNote = "No account id on any zone, so the registrar list was not asked for.";
    }

    const { rows: trafficRows, answered, notes } = await collectTraffic(
      token,
      usable.map((z) => z.id),
      start,
      end,
    );
    traffic.push(...trafficRows);

    for (const z of usable) {
      const records = await paged<RawRecord>(`zones/${z.id}/dns_records`, token, 100);
      const failed = Boolean(records.error);
      if (failed) warnings.push(`${label} · ${z.name}: DNS records unreadable — ${records.error}`);
      const recs = failed ? [] : records.rows;

      zones.push({
        accountId: account.id,
        accountLabel: label,
        id: z.id,
        name: z.name,
        status: z.status ?? null,
        paused: Boolean(z.paused),
        plan: z.plan?.name ?? null,
        type: z.type ?? null,
        createdOn: z.created_on ? z.created_on.slice(0, 10) : null,
        nameServers: z.name_servers?.length ? z.name_servers : null,
        // Null, not zero: an unreadable listing tells us nothing about how many
        // records a zone has, and "0 records" would read as a broken zone.
        records: failed ? null : recs.length,
        proxied: failed ? null : recs.filter((r) => r.proxied).length,
        /*
          THE ONLY TRACE OF A PAGES PROJECT THIS TOKEN CAN SEE. The Pages API
          answers 403, so a CNAME to *.pages.dev is the evidence — which is
          why this is a boolean about DNS rather than a project count.
        */
        onPages: failed
          ? null
          : recs.some(
              (r) => r.type === "CNAME" && (r.content ?? "").endsWith(".pages.dev"),
            ),
        // Null, not all-false: unreadable records say nothing whatever about a
        // zone's mail posture, and four false flags would read as an alarm.
        email: failed ? null : emailFlags(recs, z.name),
        recordsNote: failed ? `DNS records unreadable: ${records.error}` : null,
        trafficNote: answered.has(z.id) ? null : (notes.get(z.id) ?? "No analytics answer."),
        cfAccountId: z.account?.id ?? null,
        cfAccountName: z.account?.name ?? null,
      });
    }

    const analyticsNotes = [...new Set([...notes.values()])];
    outcomes.push({
      id: account.id,
      label,
      ok: true,
      cfAccountId,
      cfAccountName,
      zones: usable.length,
      registrarReadable,
      registrarCount,
      registrarNote,
      analyticsZones: usable.filter((z) => answered.has(z.id)).length,
      analyticsNote: analyticsNotes.join("; ").slice(0, 220) || null,
    });
    if (analyticsNotes.length)
      warnings.push(`${label}: analytics — ${analyticsNotes.join("; ").slice(0, 160)}`);
  }

  return {
    zones,
    traffic,
    registrar,
    accounts: outcomes,
    accountsTried: ready.length + broken.length,
    warnings,
  };
}

export type { Account };
