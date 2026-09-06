/**
 * Spaceship.
 *
 * WHAT THE OWNER PASTES: an API key and its secret, issued as a pair in
 * Account → API manager. Two static headers, no signature.
 *
 * WHAT IT READS, and nothing else:
 *   GET /api/v1/domains?take=100&skip=N   the domains this account holds
 *
 * It is a list call on an account-management surface — read-only, unmetered,
 * and it cannot change anything.
 *
 * THE USER-AGENT IS LOAD-BEARING. Spaceship sits behind bot protection that
 * refuses a request on the strength of its agent string alone; the collector
 * this replaces hit this with Python's default urllib name, and the same
 * request under an honest tool name was answered. Node's fetch sends `node` by default,
 * which is the same shape of problem, so this names itself.
 *
 * Of the three registrar reads this codebase makes, Spaceship's carries the
 * most: privacy level, registration date, and the nameservers the name actually
 * delegates to.
 */
import {
  asDay,
  domainName,
  hosts,
  privacyWord,
  scrub,
  type DomainRow,
} from "./domains.ts";

const API = "https://spaceship.dev/api/v1/domains";
const TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const USER_AGENT = "onepersoncompany-collector/1.0";

export type Credentials = { key: string; secret: string };

type RawDomain = {
  name?: string;
  unicodeName?: string;
  expirationDate?: string;
  registrationDate?: string;
  autoRenew?: unknown;
  eppStatuses?: unknown;
  privacyProtection?: { level?: unknown };
  nameservers?: { hosts?: unknown };
  lifecycleStatus?: unknown;
};

async function page(
  { key, secret }: Credentials,
  skip: number,
  take = PAGE_SIZE,
): Promise<{ items: RawDomain[]; total: number | null }> {
  const res = await fetch(`${API}?take=${take}&skip=${skip}`, {
    headers: {
      Accept: "application/json",
      "X-API-Key": key,
      "X-API-Secret": secret,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string; message?: string };
      detail = body?.detail || body?.message || "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new Error(
      scrub(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, key, secret),
    );
  }

  const doc = (await res.json()) as { items?: unknown; total?: unknown };
  if (!Array.isArray(doc.items)) throw new Error("unexpected response shape");
  return {
    items: doc.items as RawDomain[],
    total: typeof doc.total === "number" ? doc.total : null,
  };
}

function row(d: RawDomain): DomainRow | null {
  const name = domainName(d.name ?? d.unicodeName);
  if (!name) return null;

  /*
    Spaceship reports no `locked` flag. It reports the EPP statuses the registry
    actually holds, and clientTransferProhibited IS the lock — so the lock is
    derived from the statuses rather than reported as unknown. An eppStatuses
    that is not a list leaves it null, because "the field was missing" and "the
    domain is unlocked" are different findings.
  */
  let locked: boolean | null = null;
  if (Array.isArray(d.eppStatuses)) {
    locked = d.eppStatuses.some(
      (s) => typeof s === "string" && s.trim().toLowerCase() === "clienttransferprohibited",
    );
  }

  const lifecycle = String(d.lifecycleStatus ?? "").trim();

  return {
    name,
    source: "spaceship",
    registrar: "Spaceship",
    expiresAt: asDay(d.expirationDate),
    registeredOn: asDay(d.registrationDate),
    autoRenew: typeof d.autoRenew === "boolean" ? d.autoRenew : null,
    locked,
    status: lifecycle || null,
    privacy: privacyWord(d.privacyProtection?.level),
    nameservers: hosts(d.nameservers?.hosts),
  };
}

/**
 * Is this pair real, and what does it see?
 *
 * One page of one, so a typo is refused at the point it was made rather than
 * becoming a silently empty dashboard an hour later. An account that holds no
 * domains is a valid answer and not an error — a new account is a real thing.
 */
export async function verify(
  creds: Credentials,
): Promise<{ ok: true; domains: number } | { ok: false; error: string }> {
  try {
    const { items, total } = await page(creds, 0, 1);
    return { ok: true, domains: total ?? items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error";
    if (message.includes("HTTP 401") || message.includes("HTTP 403"))
      return { ok: false, error: `Spaceship refused that key and secret (${message}).` };
    return { ok: false, error: `Spaceship: ${message}` };
  }
}

/**
 * Every domain in ONE account.
 *
 * take/skip against a response that reports its own `total`, so the loop ends
 * on the count the API gave rather than on an empty page. The page cap guards a
 * `total` that never gets reached; a page that adds nothing new is the end of
 * the list however the API counts it.
 *
 * Called once per connected account by the collector, and it throws rather
 * than returning an empty list when a page fails: an account that could not be
 * read has not said it holds nothing, and the difference is a portfolio
 * quietly emptying itself on the dashboard.
 */
export async function domainsFor(creds: Credentials): Promise<DomainRow[]> {
  const byName = new Map<string, DomainRow>();
  let skip = 0;
  let total: number | null = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await page(creds, skip);
    if (total === null) total = res.total;

    const before = byName.size;
    for (const d of res.items) {
      const parsed = row(d);
      if (parsed) byName.set(parsed.name, parsed);
    }
    if (byName.size === before) break;

    skip += PAGE_SIZE;
    if (total !== null && byName.size >= total) break;
    if (res.items.length < PAGE_SIZE) break;
  }

  return [...byName.values()];
}
