/**
 * PRODUCT ENDPOINTS — the numbers a business knows about itself that no vendor
 * can be asked for.
 *
 * Stripe knows what was paid and Umami knows who visited, and neither of them
 * knows how many reels were rendered yesterday, how many planning applications
 * are in the index, or how many chats the widget answered. The product knows
 * that, and the cheapest honest way to get it here is the way the product
 * already publishes it: a JSON endpoint the owner already has, or writes in ten
 * minutes.
 *
 * ONE ACCOUNT IS ONE ENDPOINT, and the account's label is the product's name.
 * The token is optional because most of these are either public or behind a
 * shared secret in a query string the owner pasted into the URL; when there is
 * one it goes out as `Authorization: Bearer`.
 *
 * THE MAPPING IS A SETTING, AND IT IS RESOLVED AT READ TIME. Which numbers in
 * the document matter is a decision, not a discovery — a collector that walked
 * the JSON and recorded every number it found would fill the readings table
 * with version strings and HTTP ports. So the owner names them: one line per
 * metric, `label = path.to.the.number`. The last document is kept so that
 * editing a line can be answered immediately and honestly — "that path matches
 * nothing in what this endpoint actually returns" — rather than half an hour
 * later as a chart of zeroes.
 *
 * A PATH THAT RESOLVES TO NOTHING IS A MAPPING ERROR AND NEVER A ZERO. That is
 * the single rule this whole integration exists to keep: the endpoint answering
 * `{"reels": 0}` and the endpoint not having a `reels` field at all are
 * completely different facts about the business, and a collector that recorded
 * both as 0 would make the second one invisible forever.
 */
import { configValue, db, finishRun, now, record, startRun, syncPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";

export const PLUGIN = "product-stats";

/** How much of a document is kept. Big enough for any status endpoint worth
 *  writing, small enough that a misconfigured URL pointing at a data export
 *  cannot fill the database. */
export const MAX_DOC = 64 * 1024;
/** How long one endpoint gets to answer. */
const TIMEOUT_MS = 15_000;

const UA = "OnePersonCompany/0.1 (+product-stats)";

/* ------------------------------------------------------------------ mapping */

export type Metric = {
  /** The account label this line is for, or null for "every endpoint". */
  account: string | null;
  label: string;
  /** The path as typed, kept so the page can show what was asked for. */
  path: string;
  /** `@count(path)` — the LENGTH of an array, which is the one derived figure
   *  worth supporting, because "how many rows are in this list" is what half
   *  of these endpoints are actually publishing. */
  count: boolean;
};

/**
 * `label = path`, one per line, optionally prefixed `account-label: `.
 *
 * The colon is what separates the two, so a LABEL may not contain one. That is
 * a real restriction and it is the right one: the alternative was a second
 * settings field per account, and settings here are per plugin — which would
 * have meant a field that cannot exist.
 */
export function parseMetrics(raw: string | null | undefined): Metric[] {
  const out: Metric[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    let left = t.slice(0, eq).trim();
    const right = t.slice(eq + 1).trim();
    if (!left || !right) continue;

    let account: string | null = null;
    const colon = left.indexOf(":");
    if (colon > 0) {
      account = left.slice(0, colon).trim();
      left = left.slice(colon + 1).trim();
    }
    if (!left) continue;

    const m = /^@count\((.+)\)$/i.exec(right);
    out.push({
      account,
      label: left,
      path: m ? m[1]!.trim() : right,
      count: !!m,
    });
  }
  return out;
}

/** The lines that apply to one endpoint: the unprefixed ones, plus the ones
 *  naming it. Case-insensitive on the label, because "Example App 1" and
 *  "example-app-1" are the same account to everyone except a string compare. */
export function metricsFor(all: Metric[], accountLabel: string): Metric[] {
  const want = accountLabel.trim().toLowerCase();
  return all.filter((m) => m.account === null || m.account.toLowerCase() === want);
}

/** What is wrong with this mapping, said where it was typed. */
export function checkMetrics(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1)
      return `“${line.slice(0, 40)}” is not a metric. Each line is “label = path.to.number”, optionally prefixed “endpoint label: ”.`;
    const right = line.slice(eq + 1).trim();
    if (!right) return `“${line.slice(0, eq).trim()}” has no path after the “=”.`;
    const path = /^@count\((.+)\)$/i.exec(right)?.[1]?.trim() ?? right;
    if (!/^[A-Za-z0-9_$]+(\[[0-9]+\])*(\.[A-Za-z0-9_$-]+(\[[0-9]+\])*)*$/.test(path))
      return `“${path}” is not a JSON path. Dots between keys, [0] for an array index — for example stats.today.renders, or @count(items).`;
  }
  const labels = lines.map((l) => l.slice(0, l.indexOf("=")).trim().toLowerCase());
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup)
    return `“${dup}” is listed twice. Two metrics with one name on one endpoint make a chart nobody can read — prefix one of them with the endpoint's label.`;
  return null;
}

/* --------------------------------------------------------------- resolution */

export type Resolved =
  | { ok: true; value: number }
  | { ok: false; why: string };

/**
 * One path against one document.
 *
 * EVERY FAILURE IS ITS OWN SENTENCE, because they send the owner to different
 * places: a key that is not there is a typo or a renamed field, a key that
 * holds a string is a path that stopped one level short, and a `@count` of
 * something that is not an array is a misunderstanding of the shape. Returning
 * null for all three would be a chart with a gap and no explanation.
 */
export function resolve(doc: unknown, metric: Metric): Resolved {
  const parts = [...metric.path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) =>
    m[2] !== undefined ? Number(m[2]) : m[1]!,
  );

  let node: unknown = doc;
  const walked: string[] = [];
  for (const part of parts) {
    if (node === null || node === undefined)
      return { ok: false, why: `${walked.join(".") || "the document"} is null, so ${metric.path} goes nowhere.` };
    if (typeof part === "number") {
      if (!Array.isArray(node))
        return { ok: false, why: `${walked.join(".") || "the document"} is not an array, so [${part}] means nothing here.` };
      if (part >= node.length)
        return { ok: false, why: `${walked.join(".") || "the document"} has ${node.length} item(s), so [${part}] is past the end.` };
      node = node[part];
      walked.push(`[${part}]`);
      continue;
    }
    if (typeof node !== "object" || Array.isArray(node))
      return { ok: false, why: `${walked.join(".") || "the document"} is not an object, so “${part}” cannot be read from it.` };
    if (!(part in (node as Record<string, unknown>)))
      return {
        ok: false,
        why: `${walked.length ? walked.join(".") : "the document"} has no “${part}”. It has: ${Object.keys(node as Record<string, unknown>).slice(0, 8).join(", ") || "nothing"}.`,
      };
    node = (node as Record<string, unknown>)[part];
    walked.push(part);
  }

  if (metric.count) {
    if (!Array.isArray(node))
      return { ok: false, why: `${metric.path} is not an array, so @count() has nothing to count.` };
    return { ok: true, value: node.length };
  }

  if (typeof node === "number" && Number.isFinite(node)) return { ok: true, value: node };
  /* A number that arrived as a string is accepted and it is the one leniency
     here: plenty of endpoints publish counts as strings, and refusing them
     would be pedantry aimed at the wrong person. A string that is not a number
     is still a failure with its own sentence. */
  if (typeof node === "string" && node.trim() !== "" && Number.isFinite(Number(node)))
    return { ok: true, value: Number(node) };
  if (typeof node === "boolean") return { ok: true, value: node ? 1 : 0 };
  return {
    ok: false,
    why: `${metric.path} is ${node === null ? "null" : Array.isArray(node) ? "an array" : typeof node}, not a number. ${Array.isArray(node) ? "Did you mean @count(" + metric.path + ")?" : ""}`.trim(),
  };
}

/** The metric one mapped figure's history lives under. */
export function productMetric(accountId: number, label: string): string {
  return `product.${accountId}.${label}`;
}

/* ------------------------------------------------------------------ fetching */

export type Fetched = {
  ok: boolean;
  status: number | null;
  ms: number;
  body: string | null;
  truncated: boolean;
  doc: unknown;
  error: string | null;
};

/** GET one endpoint. Never throws — every failure is a Fetched with a reason,
 *  because the caller has to report one endpoint's failure without losing the
 *  others. */
export async function fetchEndpoint(url: string, token: string | null): Promise<Fetched> {
  const started = Date.now();
  const empty = { status: null, body: null, truncated: false, doc: null };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return {
      ok: false, ...empty, ms: Date.now() - started,
      error: cause?.code ?? (err instanceof Error ? err.message : String(err)),
    };
  }

  /* Read at most the cap plus one byte, so "exactly at the cap" and "larger
     than the cap" are distinguishable rather than both looking complete. */
  let body = "";
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
        if (body.length > MAX_DOC) {
          truncated = true;
          body = body.slice(0, MAX_DOC);
          break;
        }
      }
    } catch (err) {
      return {
        ok: false, ...empty, status: res.status, ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  const ms = Date.now() - started;
  if (!res.ok)
    return {
      ok: false, status: res.status, ms, body, truncated, doc: null,
      error: `HTTP ${res.status} ${res.statusText}`.trim(),
    };
  if (truncated)
    return {
      ok: false, status: res.status, ms, body, truncated, doc: null,
      error: `The document is larger than ${MAX_DOC / 1024} KB. It is kept truncated and NOT parsed — half a JSON document mapped as if it were whole is worse than no figure. Publish a smaller summary endpoint.`,
    };

  try {
    return { ok: true, status: res.status, ms, body, truncated, doc: JSON.parse(body), error: null };
  } catch {
    return {
      ok: false, status: res.status, ms, body, truncated, doc: null,
      error: `It answered ${res.status} but not with JSON${body ? ` — it starts “${body.slice(0, 60).replace(/\s+/g, " ")}”` : ""}.`,
    };
  }
}

/**
 * Verify, for the credential registry.
 *
 * The endpoint has to answer JSON, and that is checked rather than assumed:
 * the most common thing at a URL somebody thought was an API is an HTML login
 * page answering 200, which every "is it reachable" check in the world calls a
 * success.
 */
export async function verify(values: Record<string, string>): Promise<string | null> {
  const url = (values.url ?? "").trim();
  if (!url) return "Paste the URL of an endpoint that answers JSON — your product's own /stats or /api/health.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `“${url}” is not a URL. It needs a scheme: https://example.com/stats.`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return "Only http and https endpoints can be read here.";

  const token = (values.token ?? "").trim();
  const got = await fetchEndpoint(url, token || null);
  if (got.ok) return null;
  if (got.status === 401 || got.status === 403)
    return token
      ? `The endpoint refused the token (${got.status}). It is sent as “Authorization: Bearer <token>” — check that is the header it wants.`
      : `The endpoint needs authentication (${got.status}). Paste a token, or put the key in the URL if that is how it is read.`;
  return got.error ?? "The endpoint did not answer.";
}

/* -------------------------------------------------------------------- store */

export function writeDoc(
  accountId: number,
  url: string,
  f: Fetched,
) {
  db.prepare(
    `INSERT INTO product_docs (account_id, ts, ok, status, ms, truncated, doc, url, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       ts = excluded.ts, ok = excluded.ok, status = excluded.status,
       ms = excluded.ms, truncated = excluded.truncated,
       -- A failed fetch KEEPS the last good document. The metrics on the page
       -- then go on saying what they last said, dated, beside the reason the
       -- endpoint went quiet — which is the true picture. Replacing it with
       -- null would turn one bad minute into a page with no figures on it.
       doc = COALESCE(excluded.doc, product_docs.doc),
       url = excluded.url,
       error = excluded.error`,
  ).run(
    accountId,
    now(),
    f.ok ? 1 : 0,
    f.status,
    f.ms,
    f.truncated ? 1 : 0,
    f.ok ? f.body : null,
    url,
    f.error,
  );
}

export type DocRow = {
  account_id: number;
  ts: string;
  ok: number;
  status: number | null;
  ms: number | null;
  truncated: number | null;
  doc: string | null;
  url: string | null;
  error: string | null;
};

export function docRows(): DocRow[] {
  return db.prepare("SELECT * FROM product_docs").all() as unknown as DocRow[];
}

export function forgetGoneAccounts(): number {
  const live = accounts.list(PLUGIN).map((a) => a.id);
  const rows = docRows().filter((r) => !live.includes(r.account_id));
  let gone = 0;
  for (const r of rows)
    gone += Number(
      db.prepare("DELETE FROM product_docs WHERE account_id = ?").run(r.account_id).changes,
    );
  return gone;
}

/* ---------------------------------------------------------------- collector */

export type ProductSummary = {
  ok: boolean;
  runId: number;
  endpoints: number;
  answered: number;
  values: number;
  warnings: string[];
  error?: string | null;
  note?: string | null;
};

export async function collectProducts(): Promise<ProductSummary> {
  const runId = startRun(PLUGIN);
  forgetGoneAccounts();
  const metrics = parseMetrics(configValue(PLUGIN, "metrics"));
  const { ready, broken } = accounts.credentialed(PLUGIN, ["url"], "collect_products");
  const warnings = broken.map(
    (b) => `${b.account.label}: missing ${b.missing.join(", ")} — the account is connected but incomplete.`,
  );

  if (!ready.length && !broken.length) {
    const error = "No endpoint is connected. Add one as a URL on the plugin page.";
    finishRun(runId, false, undefined, error);
    syncPlugin(PLUGIN, error);
    return { ok: false, runId, endpoints: 0, answered: 0, values: 0, warnings, error };
  }

  let answered = 0;
  let values = 0;

  for (const { account, values: creds } of ready) {
    const url = (creds.url ?? "").trim();
    const got = await fetchEndpoint(url, (creds.token ?? "").trim() || null);
    writeDoc(account.id, url, got);

    if (!got.ok) {
      accounts.markFailed(account.id, got.error ?? "The endpoint did not answer.");
      warnings.push(`${account.label}: ${got.error}`);
      continue;
    }
    accounts.markOk(account.id);
    answered += 1;

    for (const metric of metricsFor(metrics, account.label)) {
      const r = resolve(got.doc, metric);
      if (!r.ok) {
        /* Reported, never recorded. See this file's header: a path that
           matches nothing is not a zero, and the route re-resolves it on every
           read so the message stays current with the mapping. */
        warnings.push(`${account.label} · ${metric.label}: ${r.why}`);
        continue;
      }
      record(productMetric(account.id, metric.label), r.value, { endpoint: account.label });
      values += 1;
    }
  }

  const endpoints = ready.length + broken.length;
  if (!answered) {
    const error = warnings.join("; ") || "No endpoint answered.";
    finishRun(runId, false, undefined, error);
    syncPlugin(PLUGIN, error);
    return { ok: false, runId, endpoints, answered, values, warnings, error };
  }

  const note =
    `${answered}/${endpoints} endpoint${endpoints === 1 ? "" : "s"}` +
    (metrics.length ? `, ${values} mapped figure(s)` : ", no metrics mapped yet");
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin(PLUGIN, warnings.join("; ") || null);

  return { ok: true, runId, endpoints, answered, values, warnings, note };
}
