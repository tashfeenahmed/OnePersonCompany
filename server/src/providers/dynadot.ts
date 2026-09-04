/**
 * Dynadot.
 *
 * WHAT THE OWNER PASTES: an API key AND its signing secret, both from
 * Tools → API. The key alone reads nothing, which is why this plugin has two
 * fields and why the two are told apart when one is missing.
 *
 * WHAT IT READS, and nothing else:
 *   GET /restful/v2/domains   the domains this account holds
 *
 * THE SIGNATURE. Every v2 request carries the key as a bearer token and an
 * X-Signature over
 *
 *     key + "\n" + path?query + "\n" + X-Request-ID + "\n" + body
 *
 * base64(HMAC-SHA256(secret, message)). This sends no request id and no body,
 * so the message ends in two EMPTY segments — which still means two trailing
 * newlines, not none. Sign three fields instead of four and Dynadot rebuilds a
 * different string on its side and rejects a perfectly good key.
 *
 * The path is signed WITH its query string, which is why page one is requested
 * as the bare path: that is the exact request this account was verified with,
 * and paging parameters are added only once the response says there is a second
 * page.
 *
 * The old api3 endpoint is gone — a key that used to work there answers
 * nothing — so this is the v2 surface rather than a fallback beside it. The
 * response shapes it has been seen to use are all read (see rows()), because a
 * dashboard that loses a column to a capitalisation change is worse than one
 * that tries three spellings of the same fact.
 */
import { createHmac } from "node:crypto";
import {
  asBool,
  asDay,
  domainName,
  hosts,
  privacyWord,
  renewOption,
  scrub,
  type DomainRow,
} from "./domains.ts";

const API = "https://api.dynadot.com";
const PATH = "/restful/v2/domains";
const TIMEOUT_MS = 45_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export type Credentials = { key: string; secret: string };

export function signature(key: string, secret: string, pathAndQuery: string): string {
  return createHmac("sha256", secret)
    .update(`${key}\n${pathAndQuery}\n\n`)
    .digest("base64");
}

/** One signed GET. Throws with a scrubbed message; neither half of the pair
 *  ever reaches a run log. */
async function get(
  { key, secret }: Credentials,
  pathAndQuery: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(API + pathAndQuery, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      "X-Signature": signature(key, secret, pathAndQuery),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string; error?: { description?: string } };
      detail = body?.error?.description || body?.message || "";
    } catch {
      /* not JSON */
    }
    throw new Error(scrub(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, key, secret));
  }

  const doc = (await res.json()) as Record<string, unknown>;
  // v2 repeats the HTTP status in the body, and a body that disagrees with a
  // 200 is the body's problem to explain.
  const code = doc.code;
  if (code !== undefined && code !== null && code !== 200 && code !== "200") {
    const node = doc.error as { description?: string } | undefined;
    const message = String(doc.message ?? "error") + (node?.description ? ` — ${node.description}` : "");
    throw new Error(scrub(message, key, secret));
  }
  return doc;
}

/* -------------------------------------------------------------- shapes */

type Raw = Record<string, unknown>;

/** The first key a row actually carries. v2's snake_case, the XML mirror's
 *  PascalCase and api3's own spelling all name the same fact. */
function first(d: Raw, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = d[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** The per-domain dicts, wherever this API version put them. */
function rows(doc: unknown): Raw[] {
  let list: unknown = null;
  const containers: Raw[] = [];

  if (Array.isArray(doc)) {
    list = doc;
  } else if (doc && typeof doc === "object") {
    containers.push(doc as Raw);
    for (const c of containers) {
      for (const key of ["data", "Data", "ListDomainInfoResponse", "ListDomainInfoContent"]) {
        const node = c[key];
        if (node && typeof node === "object" && !Array.isArray(node)) {
          containers.push(node as Raw);
        }
      }
    }
    for (const c of containers) {
      for (const key of [
        "domain_info_list",
        "domainInfoList",
        "domainInfo",
        "DomainInfoList",
        "MainDomains",
        "domains",
      ]) {
        let node = c[key];
        // The XML mirror wraps the list in a node of the same name.
        if (node && typeof node === "object" && !Array.isArray(node)) {
          const inner = node as Raw;
          node = inner[key] ?? inner.Domain;
        }
        if (Array.isArray(node)) {
          list = node;
          break;
        }
      }
      if (list) break;
    }
  }

  const out: Raw[] = [];
  for (const r of (list as unknown[]) ?? []) {
    if (!r || typeof r !== "object") continue;
    const inner = (r as Raw).Domain;
    out.push(inner && typeof inner === "object" ? (inner as Raw) : (r as Raw));
  }
  return out;
}

function row(d: Raw): DomainRow | null {
  const name = domainName(first(d, "domain_name", "DomainName", "name", "Name"));
  if (!name) return null;

  const glue = first(d, "glue_info", "GlueInfo", "NameServerSettings");
  let ns: string[] | null = null;
  if (glue && typeof glue === "object") {
    const servers = (glue as Raw).nameserver_list ?? (glue as Raw).NameServerList;
    if (Array.isArray(servers)) {
      ns = hosts(
        servers.map((s) =>
          s && typeof s === "object"
            ? ((s as Raw).server_name ?? (s as Raw).ServerName)
            : null,
        ),
      );
    }
  }

  const status = first(d, "status", "Status");

  return {
    name,
    source: "dynadot",
    registrar: "Dynadot",
    expiresAt: asDay(first(d, "expiration_date", "ExpirationDate", "Expiration", "expiration")),
    registeredOn: asDay(first(d, "registration_date", "RegistrationDate", "Registration")),
    autoRenew: renewOption(first(d, "renew_option", "RenewOption")),
    locked: asBool(first(d, "locked", "Locked")),
    status: status === null ? null : String(status).trim() || null,
    privacy: privacyWord(first(d, "privacy", "Privacy")),
    nameservers: ns,
  };
}

/** v2's pagination_result.has_next_page, when it sent one. Absent reads as "no
 *  more" — the row-count check beside this call is what keeps a truncated list
 *  from being wrongly declared complete. */
function hasNextPage(doc: Raw): boolean {
  const node = (doc.data && typeof doc.data === "object" ? doc.data : doc) as Raw;
  const page = (node.pagination_result ?? node.paginationResult) as Raw | undefined;
  if (!page || typeof page !== "object") return false;
  return asBool(page.has_next_page ?? page.hasNextPage) === true;
}

/* -------------------------------------------------------------- public */

export async function verify(
  creds: Credentials,
): Promise<{ ok: true; domains: number } | { ok: false; error: string }> {
  try {
    const doc = await get(creds, PATH);
    return { ok: true, domains: rows(doc).length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error";
    if (message.includes("HTTP 401") || message.includes("HTTP 403"))
      return {
        ok: false,
        error:
          `Dynadot refused that pair (${message}). Both halves must come from ` +
          `Tools → API, and the key must be activated for this IP.`,
      };
    return { ok: false, error: `Dynadot: ${message}` };
  }
}

/**
 * One account's whole portfolio.
 *
 * ONE ACCOUNT, not "the Dynadot credential" — a person can hold two logins and
 * two portfolios, and the collector above calls this once per account so that
 * a 401 on the second one leaves the first one's names on the page. Which is
 * also why this throws rather than returning an empty list on failure: an
 * account that could not be read has NOT told us it holds nothing, and a
 * returned [] would be written over its rows as if it had.
 */
export async function domainsFor(creds: Credentials): Promise<DomainRow[]> {
  const byName = new Map<string, DomainRow>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pq = page === 1 ? PATH : `${PATH}?page_size=${PAGE_SIZE}&page=${page}`;
    let doc: Raw;
    try {
      doc = await get(creds, pq);
    } catch (err) {
      // The first page is already in hand; a refused second page is a short
      // list, not a dead column.
      if (page > 1) break;
      throw err;
    }

    const list = rows(doc);
    const before = byName.size;
    for (const r of list) {
      const parsed = row(r);
      if (parsed) byName.set(parsed.name, parsed);
    }
    if (!list.length || byName.size === before) break;
    if (!hasNextPage(doc) && list.length < PAGE_SIZE) break;
  }

  return [...byName.values()];
}
