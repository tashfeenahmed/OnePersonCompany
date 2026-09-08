/**
 * INDEXNOW, AND THE HONEST HALF OF "SUBMITTING A SITEMAP".
 *
 * WHAT INDEXNOW ACTUALLY IS. A host publishes a key as a text file at its own
 * root — `https://example.com/<key>.txt`, whose whole body is the key — and
 * then POSTs a list of changed URLs to an IndexNow endpoint. The endpoint
 * fetches the key file to prove the caller controls the host, and fans the
 * notification out to the participating engines (Bing, Yandex, Seznam, Naver
 * and others; NOT Google, which has never joined). There is no account and no
 * credential: the key file IS the credential, which is why this plugin has
 * settings and no secret.
 *
 * SO THE KEY FILE IS THE WHOLE THING, AND THIS REFUSES TO SUBMIT WITHOUT ONE.
 * A submission for a host whose key file is missing is rejected by the endpoint
 * with a 403 — and worse, a submission that LOOKS accepted while the file is
 * absent would leave the owner believing something happened. So every
 * submission checks the file first, and where it is not there the batch is
 * recorded as a `dry-run` with the exact one-line instruction for fixing it.
 * The attempt is still written to the log: an attempt nobody can see is an
 * attempt nobody can decide to stop making.
 *
 * A 200 OR 202 MEANS RECEIVED, NOT INDEXED. This is the rule the whole feature
 * hangs on. IndexNow's answer is an acknowledgement that a notification was
 * accepted for processing; whether anything crawls the URL, and whether
 * anything indexes it, is a decision made later by a search engine that owes
 * nobody an explanation. Nothing on this box may report a submission as an
 * indexing.
 *
 * SITEMAPS: WHAT STILL WORKS AND WHAT DOES NOT.
 *
 *   Google's `/ping?sitemap=` endpoint IS RETIRED. Google switched it off in
 *   2023 and it answers 404; a dashboard that kept calling it would be
 *   reporting success at pinging a URL that does nothing. This box does not
 *   call it and says so.
 *   Google's Search Console API COULD submit a sitemap — but the credential
 *   here is minted with `webmasters.readonly` on purpose (see providers/gsc.ts),
 *   and Google refuses a submit to that scope. So sitemap submission to Google
 *   is NOT AVAILABLE from this box, and the honest instruction is the one that
 *   works: reference the sitemap from robots.txt, which every crawler reads,
 *   and submit it by hand in Search Console once.
 *   What DOES still work from here is IndexNow: the sitemap is fetched, its
 *   URLs are read, and those URLs are submitted. That is a real notification
 *   about real URLs rather than a ping at a retired endpoint.
 *
 * WHAT THE AUDIT CONTRIBUTES. `venture_audits` keeps every crawl. Comparing the
 * newest against the one before it gives URLs that are NEW (in the latest and
 * not the previous) and URLs that CHANGED (same URL, different title,
 * description or word count) — which is exactly what IndexNow is for and is a
 * comparison of two documents this box already owns rather than a new crawl.
 */
import { configValue, db, now, setConfig, upsertPlugin } from "../../db.ts";
import { hostOf, sameSite } from "../../shared/host.ts";

export const PLUGIN = "indexing";

/** The shared endpoint, which fans out to every participating engine. Bing's
 *  own `www.bing.com/indexnow` takes the same body and reaches only Bing; the
 *  shared one is the right default and the only one this calls. */
const ENDPOINT = "https://api.indexnow.org/indexnow";

/** URLs per submission. IndexNow's own cap is 10,000; this is far lower on
 *  purpose — a batch this size is a change set, and a batch of ten thousand is
 *  a re-submission of the whole site, which is what the protocol asks people
 *  not to do. */
const MAX_URLS = 200;
/** URLs read out of a sitemap. */
const MAX_SITEMAP_URLS = 500;
const TIMEOUT_MS = 20_000;
const UA = "OnePersonCompany/0.1 (+indexing)";

/* --------------------------------------------------------------- the key */

/**
 * The IndexNow key, generated for the owner the first time anything asks.
 *
 * GENERATED RATHER THAN DEMANDED because there is nothing to get right about
 * it: IndexNow wants 8 to 128 hexadecimal characters chosen by the publisher,
 * and asking somebody to invent one is asking them to paste something weaker
 * than `crypto.randomUUID` would have produced. It is written back into the
 * settings so it is visible, editable and — the part that matters — the SAME
 * key tomorrow, because the key file on the site is named after it.
 */
export function indexNowKey(): string {
  const stored = (configValue(PLUGIN, "key") ?? "").trim();
  if (/^[a-f0-9]{8,128}$/i.test(stored)) return stored.toLowerCase();
  const generated = crypto.randomUUID().replace(/-/g, "");
  setConfig(PLUGIN, "key", generated);
  return generated;
}

export const keyFileUrl = (host: string, key: string) => `https://${host}/${key}.txt`;

/** The one-line instruction, in one place so the page, the log and the agent
 *  all say the same words. */
export function instructionFor(host: string, key: string): string {
  return `Put a file at ${keyFileUrl(host, key)} whose entire contents are the single line \`${key}\`, served as text/plain over HTTPS with a 200. That file is the whole credential: IndexNow fetches it to prove this box speaks for ${host}, and until it is there every submission for this host is refused.`;
}

export type KeyFileCheck = { hosted: boolean; status: number | null; url: string; why: string };

/** Is the key file actually there? Checked before every submission, because a
 *  submission without it is refused by the endpoint anyway and the refusal is
 *  more useful said here. */
export async function checkKeyFile(host: string, key: string): Promise<KeyFileCheck> {
  const url = keyFileUrl(host, key);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { hosted: false, status: res.status, url, why: `${url} answered HTTP ${res.status}.` };
    const body = (await res.text()).trim();
    if (body === key) return { hosted: true, status: res.status, url, why: `${url} answers 200 with the key and nothing else.` };
    return {
      hosted: false,
      status: res.status,
      url,
      why: `${url} answers 200 but its body is not the key — it starts “${body.slice(0, 40)}”. The file must contain the key and nothing else.`,
    };
  } catch (err) {
    return { hosted: false, status: null, url, why: `${url} could not be fetched — ${err instanceof Error ? err.message : String(err)}.` };
  }
}

/* ------------------------------------------------------------- the sitemaps */

/** `host = url` lines, one per host, with the default filled in. A bare URL
 *  with no `host =` prefix is read as being for its own host. */
export function parseSitemaps(raw: string | null | undefined): { host: string; url: string }[] {
  const out: { host: string; url: string }[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    const host = eq > 0 ? hostOf(t.slice(0, eq)) : null;
    const url = (eq > 0 ? t.slice(eq + 1) : t).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      const u = new URL(url);
      out.push({ host: host || hostOf(u.hostname) || u.hostname, url: u.toString() });
    } catch {
      /* A line that is not a URL is dropped by the settings check before it
         gets here; dropping it again is belt and braces rather than silence. */
    }
  }
  return out;
}

/** The sitemaps configured for a host, or the conventional one. The default is
 *  NOT a claim that it exists — `sitemapUrls` reports what happened when it was
 *  fetched. */
export function sitemapsFor(host: string): { url: string; configured: boolean }[] {
  const all = parseSitemaps(configValue(PLUGIN, "sitemaps"));
  const mine = all.filter((s) => sameSite(host, s.host));
  return mine.length ? mine.map((s) => ({ url: s.url, configured: true })) : [{ url: `https://${host}/sitemap.xml`, configured: false }];
}

/** The URLs a sitemap lists. A sitemap index is followed one level. */
export async function sitemapUrls(url: string, depth = 0): Promise<{ urls: string[] } | { error: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml,text/xml" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `${url} answered HTTP ${res.status}` };
    const body = (await res.text()).slice(0, 4_000_000);
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);
    if (/<sitemapindex/i.test(body) && depth === 0) {
      const urls: string[] = [];
      for (const child of locs.slice(0, 10)) {
        const got = await sitemapUrls(child, 1);
        if ("urls" in got) urls.push(...got.urls);
        if (urls.length >= MAX_SITEMAP_URLS) break;
      }
      return { urls: urls.slice(0, MAX_SITEMAP_URLS) };
    }
    return { urls: locs.slice(0, MAX_SITEMAP_URLS) };
  } catch (err) {
    return { error: `${url} could not be fetched — ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* --------------------------------------------------- what the audit found */

type AuditPage = { url: string; title: string | null; description: string | null; words: number };

function auditPages(doc: string): AuditPage[] {
  try {
    const parsed = JSON.parse(doc) as { pages?: AuditPage[] };
    return Array.isArray(parsed.pages) ? parsed.pages : [];
  } catch {
    return [];
  }
}

export type AuditDelta = {
  host: string | null;
  newUrls: string[];
  changedUrls: string[];
  /** Null when there is nothing to compare, with the reason on `why`. */
  comparedAt: string | null;
  why: string;
};

/**
 * New and changed URLs, from the two newest audits of the venture on this host.
 *
 * CHANGED IS TITLE, DESCRIPTION OR WORD COUNT. That is what the audit records
 * per page; a body-text hash would be better and does not exist. It is stated
 * rather than implied, because "changed" is exactly the sort of word a reader
 * will assume means more than it does.
 */
export function auditDelta(host: string): AuditDelta {
  const rows = db
    .prepare(
      `SELECT a.ts AS ts, a.doc AS doc FROM venture_audits a JOIN ventures v ON v.id = a.venture_id
        WHERE v.host = ? ORDER BY a.ts DESC LIMIT 2`,
    )
    .all(host) as unknown as { ts: string; doc: string }[];
  if (!rows.length)
    return { host, newUrls: [], changedUrls: [], comparedAt: null, why: `No audit has ever been run for ${host}, so nothing can be called new or changed.` };
  if (rows.length === 1)
    return {
      host,
      newUrls: [],
      changedUrls: [],
      comparedAt: null,
      why: `There is one audit for ${host} (${rows[0]!.ts}) and nothing before it. "New" and "changed" are comparisons, so neither can be computed from a single crawl.`,
    };

  const latest = auditPages(rows[0]!.doc);
  const before = new Map(auditPages(rows[1]!.doc).map((p) => [p.url, p]));
  const newUrls: string[] = [];
  const changedUrls: string[] = [];
  for (const p of latest) {
    const old = before.get(p.url);
    if (!old) newUrls.push(p.url);
    else if (old.title !== p.title || old.description !== p.description || old.words !== p.words) changedUrls.push(p.url);
  }
  return {
    host,
    newUrls,
    changedUrls,
    comparedAt: rows[0]!.ts,
    why: `The audit of ${rows[0]!.ts} against the one of ${rows[1]!.ts}: ${newUrls.length} URLs the earlier crawl did not have, ${changedUrls.length} whose title, description or word count moved. "Changed" means one of those three fields, which is what the audit records.`,
  };
}

/* ------------------------------------------------------------- submitting */

export type SubmitResult = {
  host: string;
  endpoint: string;
  key: string;
  keyFile: KeyFileCheck;
  submitted: number;
  urls: string[];
  status: number | null;
  outcome: string;
  response: string | null;
  what: string;
};

/** What IndexNow's statuses mean, quoted rather than paraphrased into a
 *  boolean. */
function outcomeOf(status: number): { outcome: string; what: string } {
  if (status === 200) return { outcome: "received", what: "200: the notification was RECEIVED. It is not a crawl and it is not an indexing." };
  if (status === 202)
    return { outcome: "accepted", what: "202: accepted, and the key is still being validated. Received, not indexed." };
  if (status === 400) return { outcome: "refused", what: "400: the request was malformed — usually a URL that is not on the host being claimed." };
  if (status === 403) return { outcome: "refused", what: "403: the key file could not be verified from the host. IndexNow fetched it and did not find the key." };
  if (status === 422)
    return { outcome: "refused", what: "422: at least one URL does not belong to the host, or the key does not match the schema." };
  if (status === 429) return { outcome: "refused", what: "429: too many requests. Submit changes, not the whole site." };
  return { outcome: "refused", what: `HTTP ${status} from the IndexNow endpoint.` };
}

function log(host: string, urls: string[], status: number | null, outcome: string, response: string | null, reason: string) {
  const ts = now();
  const stmt = db.prepare(
    "INSERT INTO growth_indexing (host, url, endpoint, submitted_at, status, outcome, response, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const url of urls) stmt.run(host, url, ENDPOINT, ts, status, outcome, response, reason);
}

/**
 * One submission.
 *
 * `dryRun` IS A REAL MODE AND NOT A TEST HOOK: it is what the page offers
 * before the key file exists, and what the log records when the check fails. It
 * writes the same rows with outcome `dry-run` so the attempt, its URLs and its
 * reason are all visible.
 */
export async function submit(opts: {
  host: string;
  urls: string[];
  reason: string;
  dryRun?: boolean;
}): Promise<SubmitResult | { error: string }> {
  const host = hostOf(opts.host);
  if (!host) return { error: `“${opts.host}” is not a hostname.` };

  const key = indexNowKey();
  const urls: string[] = [];
  for (const raw of opts.urls) {
    let u: URL;
    try {
      u = new URL(String(raw));
    } catch {
      return { error: `“${String(raw).slice(0, 120)}” is not a URL.` };
    }
    /* EVERY URL MUST BE ON THE HOST BEING CLAIMED. IndexNow answers 422 for a
       batch that mixes hosts, and refusing here says which URL rather than
       leaving the owner to read a status code. */
    if (!sameSite(host, u.hostname))
      return { error: `${u.toString()} is not on ${host}. One submission is one host — that is the protocol's rule, not this app's.` };
    urls.push(u.toString());
    if (urls.length >= MAX_URLS) break;
  }
  if (!urls.length) return { error: "There are no URLs to submit." };

  const keyFile = await checkKeyFile(host, key);
  const base = { host, endpoint: ENDPOINT, key, keyFile, submitted: urls.length, urls };

  if (!keyFile.hosted || opts.dryRun) {
    const what = keyFile.hosted
      ? `Dry run: nothing was sent. ${urls.length} URLs would have gone to ${ENDPOINT}.`
      : `Refused to submit: the key file is not in place. ${keyFile.why} ${instructionFor(host, key)}`;
    log(host, urls, null, "dry-run", what, opts.reason);
    return { ...base, status: null, outcome: "dry-run", response: null, what };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": UA },
      body: JSON.stringify({ host, key, keyLocation: keyFileUrl(host, key), urlList: urls }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.text().catch(() => "")).slice(0, 400);
    const { outcome, what } = outcomeOf(res.status);
    log(host, urls, res.status, outcome, body || null, opts.reason);
    return { ...base, status: res.status, outcome, response: body || null, what };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(host, urls, null, "unreachable", message, opts.reason);
    return { ...base, status: null, outcome: "unreachable", response: message, what: `The IndexNow endpoint could not be reached — ${message}` };
  }
}

/* --------------------------------------------------------------- the read */

export type IndexingDoc = Awaited<ReturnType<typeof indexingFor>>;

export async function indexingFor(hostRaw: string, opts: { check: boolean }) {
  const host = hostOf(hostRaw) ?? "";
  const key = indexNowKey();
  const rows = db
    .prepare("SELECT * FROM growth_indexing WHERE host = ? ORDER BY submitted_at DESC, id DESC LIMIT 100")
    .all(host) as unknown as {
    id: number;
    host: string;
    url: string;
    endpoint: string;
    submitted_at: string;
    status: number | null;
    outcome: string;
    response: string | null;
    reason: string;
  }[];

  return {
    host,
    key,
    keyLocation: keyFileUrl(host, key),
    instruction: instructionFor(host, key),
    /** Only checked when asked — it is a request to somebody else's server and
     *  a page that polls would make one every few seconds. */
    keyFile: opts.check ? await checkKeyFile(host, key) : null,
    autoSubmit: (configValue(PLUGIN, "autoSubmit") ?? "off").trim().toLowerCase() === "on",
    sitemaps: sitemapsFor(host),
    audit: auditDelta(host),
    submissions: rows.map((r) => ({
      id: r.id,
      url: r.url,
      endpoint: r.endpoint,
      submittedAt: r.submitted_at,
      status: r.status,
      outcome: r.outcome,
      response: r.response,
      reason: r.reason,
    })),
    engines:
      "IndexNow reaches the engines that joined it — Bing, Yandex, Seznam, Naver and others fan out from the shared endpoint. GOOGLE HAS NEVER JOINED and is not notified by any of this.",
    google:
      "Google's sitemap ping endpoint (/ping?sitemap=) was retired in 2023 and this box does not call it. Search Console's API could submit a sitemap, but the credential here is minted read-only on purpose, and Google refuses a submit to that scope. What works for Google: reference the sitemap from robots.txt, and submit it once by hand in Search Console.",
    means:
      "A 200 or 202 from IndexNow means the notification was RECEIVED. It is not a crawl, it is not an indexing, and nothing here may be reported as either.",
  };
}

/* ------------------------------------------------------------ overview */

/**
 * Every venture host's IndexNow standing on one page, computed on the read.
 *
 * THE PORTFOLIO QUESTION IS "WHICH SITES HAVE NEVER TOLD ANYBODY ANYTHING",
 * and the per-host document above cannot answer it without one request per
 * host. So this is the log folded by host — how many notifications were
 * RECEIVED, how many were refused, how many this box declined to send because
 * the key file was not hosted — and the newest row's date. NOTHING HERE
 * TOUCHES THE NETWORK: the key file is not re-checked, because a board that
 * refreshes would make one request to every owner's server every time.
 *
 * `received` counts 200s and 202s, and a received notification is not a crawl
 * and not an indexing — `means` says so on the wire so no card can promise
 * more than the protocol does.
 */
export function indexingOverview() {
  const hosts = db
    .prepare("SELECT DISTINCT host FROM ventures WHERE host IS NOT NULL AND host <> '' ORDER BY host")
    .all() as unknown as { host: string }[];
  const rows = db
    .prepare(
      `SELECT host, outcome, COUNT(*) AS n, MAX(submitted_at) AS last
         FROM growth_indexing GROUP BY host, outcome`,
    )
    .all() as unknown as { host: string; outcome: string; n: number; last: string }[];
  const newest = db
    .prepare(
      `SELECT host, outcome, submitted_at, reason FROM growth_indexing g
        WHERE id = (SELECT id FROM growth_indexing WHERE host = g.host ORDER BY submitted_at DESC, id DESC LIMIT 1)`,
    )
    .all() as unknown as { host: string; outcome: string; submitted_at: string; reason: string }[];
  const latest = new Map(newest.map((r) => [r.host, r]));

  const perHost = hosts.map(({ host }) => {
    const h = hostOf(host) ?? host;
    const mine = rows.filter((r) => r.host === h);
    const tally = (outcome: string) => mine.filter((r) => r.outcome === outcome).reduce((a, r) => a + r.n, 0);
    const last = latest.get(h) ?? null;
    return {
      host: h,
      submissions: mine.reduce((a, r) => a + r.n, 0),
      received: tally("received") + tally("accepted"),
      refused: tally("refused") + tally("unreachable"),
      /* Attempts this box refused to make because the key file was missing —
         kept apart from a refusal by IndexNow, which is somebody else's no. */
      dryRun: tally("dry-run"),
      last: last ? { at: last.submitted_at, outcome: last.outcome, reason: last.reason } : null,
    };
  });

  return {
    hosts: perHost,
    autoSubmit: (configValue(PLUGIN, "autoSubmit") ?? "off").trim().toLowerCase() === "on",
    told: perHost.filter((h) => h.received > 0).length,
    never: perHost.filter((h) => h.submissions === 0).length,
    means:
      "A received notification is what IndexNow ACKNOWLEDGED. It is not a crawl and not an indexing. Google has never joined IndexNow and is told nothing by any of this.",
    generatedAt: now(),
  };
}

/* ------------------------------------------------------- the automatic pass */

/** How often the automatic pass looks. Fifteen minutes is far below how often
 *  an audit is re-run and far above anything that could be called polling. */
const PASS_MS = 15 * 60_000;

/**
 * Auto-submit, when it is switched on.
 *
 * It submits the NEW and CHANGED urls of an audit it has not already submitted
 * for, one host at a time, and it recognises "already submitted" by looking for
 * a row in this area's own log newer than the audit — which needs no state of
 * its own and cannot double-submit after a restart.
 */
async function autoPass(): Promise<void> {
  if ((configValue(PLUGIN, "autoSubmit") ?? "off").trim().toLowerCase() !== "on") return;
  const hosts = db.prepare("SELECT DISTINCT host FROM ventures WHERE host IS NOT NULL AND host <> ''").all() as unknown as {
    host: string;
  }[];
  for (const { host } of hosts) {
    const delta = auditDelta(host);
    if (!delta.comparedAt) continue;
    const urls = [...delta.newUrls, ...delta.changedUrls];
    if (!urls.length) continue;
    const seen = db
      .prepare("SELECT submitted_at FROM growth_indexing WHERE host = ? ORDER BY submitted_at DESC LIMIT 1")
      .get(host) as { submitted_at: string } | undefined;
    if (seen && seen.submitted_at >= delta.comparedAt) continue;
    const reason = delta.newUrls.length ? "audit-new" : "audit-changed";
    try {
      await submit({ host, urls, reason });
    } catch (err) {
      console.error(`[growth] auto-submit for ${host} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function startIndexingTimer() {
  /* CONNECTED IS DERIVED FROM THE SETTINGS, on backlinks' rule: this plugin has
     no credential, so "connected" means the owner has configured something —
     a sitemap line or auto-submit — rather than that a key exists, because a
     key exists the moment anything reads it. */
  refreshConnected();
  const timer = setInterval(() => {
    void autoPass().catch(() => {});
  }, PASS_MS);
  timer.unref?.();
}

export function refreshConnected() {
  const sitemaps = parseSitemaps(configValue(PLUGIN, "sitemaps")).length > 0;
  const auto = (configValue(PLUGIN, "autoSubmit") ?? "off").trim().toLowerCase() === "on";
  upsertPlugin(PLUGIN, sitemaps || auto, null);
}
