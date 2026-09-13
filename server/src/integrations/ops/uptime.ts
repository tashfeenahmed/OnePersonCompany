import { recordInfrastructure } from "../activity/infrastructure.ts";
/**
 * IS IT UP — asked of the owner's own sites, from this box, every tick.
 *
 * WHY A LIST AND NOT A CREDENTIAL. There is nothing to authenticate against:
 * an uptime check is an ordinary request any stranger could make, which is
 * exactly what makes it worth making — it measures the site the way a visitor
 * meets it, through the same DNS, the same CDN and the same certificate. So
 * "connected" here means what it means for npm: there is a list to check.
 *
 * WHAT IS MEASURED, PRECISELY, because every one of these is a decision:
 *
 *   ok         The final response after redirects carried a status below 400.
 *              A 301 that lands on a 200 is up. A 403 is DOWN — the site is
 *              not serving the owner's page to the owner's checker, and
 *              "Cloudflare is challenging this IP" is a real outage for
 *              somebody. The status is recorded beside it so the two can be
 *              told apart.
 *   latency    Wall clock for the WHOLE exchange including every redirect,
 *              DNS and the TLS handshake. It is not a ping and not TTFB, and
 *              it is measured from a laptop on a domestic line, so it is a
 *              trend rather than a service level.
 *   bytes      Content-Length on a HEAD, or what the GET actually read (up to
 *              a cap). Not stored to bill anybody: a page that suddenly
 *              answers 200 with 0 bytes is the failure an uptime check most
 *              often misses.
 *   tls_days   Days until the certificate the host presents expires, read by
 *              a separate TLS connect. NULL is "not measured" — never zero.
 *
 * THE TLS PROBE DELIBERATELY DOES NOT VERIFY THE CHAIN. An expired or
 * self-signed certificate is the case where "how many days left" matters most,
 * and a verifying connect would refuse to tell us. Whether the chain is
 * TRUSTED is what the HTTP check above already answers, loudly, as a failure
 * with the OpenSSL reason in `error`.
 *
 * A HOST IS STORED AS THE OWNER TYPED IT, lower-cased. It is the entity key
 * venture_links points at, so it has to survive a redirect moving: normalising
 * `acme.ie` to `https://www.acme.ie/` the day a redirect changed would orphan
 * every link that named it.
 */
import { configValue, db, finishRun, startRun, upsertPlugin } from "../../db.ts";
import { pruneOne, registerRetention, retentionFor } from "../../shared/retention.ts";
import { connect } from "node:tls";

/* ------------------------------------------------------------------ the list */

/** How long a single host's whole check may take, redirects included. */
const BUDGET_MS = 10_000;
/** How many redirects are followed before the chain is called a loop. */
const MAX_HOPS = 5;
/** How much of a GET body is read to count bytes. Big enough for any page
 *  worth checking, small enough that a misconfigured host serving an ISO
 *  cannot fill this laptop's disk. */
const MAX_BODY = 2 * 1024 * 1024;
/** How long checks are kept. See 040_uptime. */
export const RETAIN_DAYS = 30;
registerRetention({
  table: "uptime_checks",
  column: "ts",
  days: RETAIN_DAYS,
  source: "area",
  note:
    "One row per host per check, which is the densest history on the box. Thirty days answers " +
    "“has this been flapping” and “what was the outage last week”; older than that the question " +
    "is about a site that has since been changed.",
});

/** The user agent every request here carries. A checker that arrives
 *  anonymously is a checker whose traffic the owner cannot recognise in his
 *  own logs, and cannot exclude from his own analytics. */
const UA = "OnePersonCompany/0.1 (+uptime)";

/**
 * The list, as hosts.
 *
 * Split on newlines and commas, trimmed, `#` comments dropped, lower-cased,
 * de-duplicated with the first spelling winning. A URL keeps its scheme and
 * path; a bare name does not gain one here — `target()` decides that, at the
 * moment of the request, so the stored key stays what was typed.
 */
export function parseHosts(raw: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of (raw ?? "").split(/[\s,]+/)) {
    const t = piece.trim().toLowerCase();
    if (!t || t.startsWith("#")) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Is this something that can be requested? A hostname, or an http(s) URL.
 *  Anything else is refused where it was typed rather than becoming a run
 *  error every half hour for a month. */
export function validHost(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (/^https?:\/\//.test(v)) {
    try {
      const u = new URL(v);
      return u.hostname === "localhost" || HOSTNAME.test(u.hostname);
    } catch {
      return false;
    }
  }
  if (v.includes("/") || v.includes(" ")) return false;
  const bare = v.split(":")[0]!;
  return bare === "localhost" || HOSTNAME.test(bare);
}

export type Target = {
  url: string;
  /** What the owner asked for. An http:// host is one whose redirect to https
   *  is itself part of the measurement; a bare name is asked over https,
   *  because that is what a browser does now. */
  scheme: "http" | "https";
  hostname: string;
  port: number;
};

export function target(host: string): Target {
  const url = /^https?:\/\//.test(host) ? new URL(host) : new URL(`https://${host}`);
  const scheme = url.protocol === "http:" ? "http" : "https";
  return {
    url: url.toString(),
    scheme,
    hostname: url.hostname,
    port: Number(url.port) || (scheme === "https" ? 443 : 80),
  };
}

/* ----------------------------------------------------------------- the check */

export type Check = {
  host: string;
  ts: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  tlsDays: number | null;
  bytes: number | null;
  finalUrl: string | null;
  error: string | null;
  /** The chain as it was walked, for the run note. Not stored — the final URL
   *  is what the page needs and a chain is only interesting while it is
   *  wrong. */
  hops: string[];
};

function reason(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${cause.code}${cause.message ? ` — ${cause.message}` : ""}`;
    return err.message;
  }
  return String(err);
}

/**
 * One request chain, followed by hand.
 *
 * `redirect: "manual"` rather than fetch's own following, for two reasons that
 * are both about honesty: the cap is five hops and fetch's is twenty, and the
 * chain itself is a measurement — "http://acme.ie answers 200 without ever
 * reaching https" is the whole point of listing an http:// host.
 */
async function walk(
  start: string,
  method: "HEAD" | "GET",
  deadline: number,
): Promise<{ status: number; finalUrl: string; hops: string[]; bytes: number | null }> {
  let url = start;
  const hops: string[] = [];

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`gave up after ${BUDGET_MS} ms`);

    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: { "user-agent": UA, accept: "*/*" },
      signal: AbortSignal.timeout(left),
    });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop === MAX_HOPS)
        throw new Error(`more than ${MAX_HOPS} redirects — starting at ${start}`);
      hops.push(url);
      url = new URL(location, url).toString();
      continue;
    }

    let bytes: number | null = null;
    if (method === "HEAD") {
      const len = res.headers.get("content-length");
      bytes = len === null ? null : Number(len);
      await res.body?.cancel().catch(() => {});
    } else if (res.body) {
      let read = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          read += value.byteLength;
          if (read >= MAX_BODY) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      bytes = read;
    } else {
      bytes = 0;
    }

    return { status: res.status, finalUrl: url, hops, bytes };
  }
  throw new Error(`more than ${MAX_HOPS} redirects — starting at ${start}`);
}

/**
 * The certificate's expiry, in days, or null.
 *
 * Null every time it could not be read — a plain-http target, a refused
 * connection, a handshake this Node cannot complete. Null is "asked and not
 * told"; there is no path here that turns an unanswered question into 0 days
 * left, which is the one wrong answer a certificate countdown can give.
 */
export function tlsDaysLeft(hostname: string, port: number, ms = 6_000): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const socket = connect(
        { host: hostname, port, servername: hostname, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate();
          const validTo = cert && typeof cert.valid_to === "string" ? cert.valid_to : null;
          socket.end();
          if (!validTo) return done(null);
          const at = Date.parse(validTo);
          done(Number.isFinite(at) ? Math.floor((at - Date.now()) / 86_400_000) : null);
        },
      );
      socket.setTimeout(ms, () => {
        socket.destroy();
        done(null);
      });
      socket.on("error", () => {
        socket.destroy();
        done(null);
      });
    } catch {
      done(null);
    }
  });
}

/**
 * One host, checked.
 *
 * HEAD first because it is the cheapest true answer, and GET after it because
 * a great many servers — nginx with a rewrite, most Next.js hosts, anything
 * behind a WAF — answer HEAD with 403 or 405 while serving the page perfectly.
 * A checker that believed the HEAD would report an outage that no visitor can
 * see, which is worse than a checker that spends one extra request.
 */
export async function check(host: string): Promise<Check> {
  const t = target(host);
  const started = Date.now();
  const deadline = started + BUDGET_MS;

  let status: number | null = null;
  let finalUrl: string | null = null;
  let bytes: number | null = null;
  let hops: string[] = [];
  let error: string | null = null;

  try {
    const head = await walk(t.url, "HEAD", deadline);
    status = head.status;
    finalUrl = head.finalUrl;
    bytes = head.bytes;
    hops = head.hops;
    if (head.status >= 400) {
      const get = await walk(t.url, "GET", deadline);
      status = get.status;
      finalUrl = get.finalUrl;
      bytes = get.bytes;
      hops = get.hops;
    }
  } catch (headErr) {
    try {
      const get = await walk(t.url, "GET", deadline);
      status = get.status;
      finalUrl = get.finalUrl;
      bytes = get.bytes;
      hops = get.hops;
    } catch (getErr) {
      /* Both doors refused. The HEAD's reason is usually the true one — a DNS
         failure or a refused connection — and the GET's is the same thing said
         again, so the HEAD's is reported unless it was the one that timed out
         first. */
      error = reason(headErr) === reason(getErr) ? reason(getErr) : `${reason(headErr)} (HEAD), ${reason(getErr)} (GET)`;
    }
  }

  const latencyMs = Date.now() - started;
  /* Asked of whatever the chain ENDED on, since that is the certificate a
     visitor's browser actually validates. A host that never answered is asked
     at the address it was typed as, which is still worth knowing. */
  const endpoint = finalUrl ? target(finalUrl) : t;
  const tlsDays =
    endpoint.scheme === "https"
      ? await tlsDaysLeft(endpoint.hostname, endpoint.port)
      : null;

  return {
    host,
    ts: new Date(started).toISOString(),
    ok: status !== null && status < 400,
    status,
    latencyMs,
    tlsDays,
    bytes,
    finalUrl,
    error,
    hops,
  };
}

/* -------------------------------------------------------------------- store */

export function writeCheck(c: Check) {
  recordInfrastructure([{ key: `uptime:${c.host}:ok`, source: "uptime", label: c.host, ts: c.ts, value: c.ok,
    detail: { status: c.status, error: c.error }, describe: (_before, after) => after ? "site check recovered" : "site check failed" }]);
  db.prepare(
    `INSERT INTO uptime_checks
       (host, ts, ok, status, latency_ms, tls_days, bytes, final_url, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, ts) DO UPDATE SET
       ok = excluded.ok, status = excluded.status,
       latency_ms = excluded.latency_ms, tls_days = excluded.tls_days,
       bytes = excluded.bytes, final_url = excluded.final_url,
       error = excluded.error`,
  ).run(
    c.host,
    c.ts,
    c.ok ? 1 : 0,
    c.status,
    c.latencyMs,
    c.tlsDays,
    c.bytes,
    c.finalUrl,
    c.error,
  );
}

export type CheckRow = {
  host: string;
  ts: string;
  ok: number;
  status: number | null;
  latency_ms: number | null;
  tls_days: number | null;
  bytes: number | null;
  final_url: string | null;
  error: string | null;
};

export function checksSince(hours: number): CheckRow[] {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db
    .prepare("SELECT * FROM uptime_checks WHERE ts >= ? ORDER BY ts ASC")
    .all(since) as unknown as CheckRow[];
}

/** A host taken off the list takes its checks with it — otherwise it goes on
 *  counting inside "3 of 4 hosts up" while appearing nowhere on the page. */
export function forgetHosts(keep: string[]): number {
  const rows = db.prepare("SELECT DISTINCT host FROM uptime_checks").all() as unknown as {
    host: string;
  }[];
  let gone = 0;
  for (const r of rows) {
    if (keep.includes(r.host)) continue;
    gone += Number(db.prepare("DELETE FROM uptime_checks WHERE host = ?").run(r.host).changes);
  }
  return gone;
}

export function pruneChecks(): number {
  return pruneOne(retentionFor("uptime_checks")!);
}

/* ---------------------------------------------------------------- collector */

export type UptimeSummary = {
  ok: boolean;
  runId: number;
  hosts: number;
  up: number;
  down: number;
  pruned: number;
  warnings: string[];
  error?: string | null;
  note?: string | null;
};

/**
 * Every host, checked once, ONE AT A TIME.
 *
 * Sequential rather than parallel because several of these names resolve to
 * the same box: checking them at once would measure the latency of this
 * script's own contention rather than the server's. It also keeps the check
 * indistinguishable from a visitor, which is what makes it comparable.
 *
 * A HOST THAT FAILS IS NOT A RUN THAT FAILS. The whole purpose of the table is
 * to record failures, so a down host is a row with ok = 0 and the run
 * succeeds. The run fails only when there is no list at all.
 */
export async function collectUptime(): Promise<UptimeSummary> {
  const runId = startRun("uptime");
  const hosts = parseHosts(configValue("uptime", "hosts"));

  if (!hosts.length) {
    const error =
      "No hosts configured. Uptime needs no key, but it does need to know " +
      "which addresses are yours — set them on the plugin page.";
    finishRun(runId, false, undefined, error);
    upsertPlugin("uptime", false, error);
    return { ok: false, runId, hosts: 0, up: 0, down: 0, pruned: 0, warnings: [], error };
  }

  forgetHosts(hosts);

  const warnings: string[] = [];
  let up = 0;
  for (const host of hosts) {
    try {
      const result = await check(host);
      writeCheck(result);
      if (result.ok) up += 1;
      else warnings.push(`${host}: ${result.error ?? `HTTP ${result.status}`}`);
    } catch (err) {
      /* Nothing in check() is supposed to throw — it turns every failure into
         a row. If one gets out anyway, the host is the casualty rather than
         the run, and it is named. */
      warnings.push(`${host}: ${reason(err)}`);
    }
  }

  const pruned = pruneChecks();
  const down = hosts.length - up;
  const note =
    `${up}/${hosts.length} up` +
    (down ? `, ${down} down` : "") +
    (pruned ? `, ${pruned} check(s) aged out` : "");
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  upsertPlugin("uptime", true, warnings.join("; ") || null);

  return { ok: true, runId, hosts: hosts.length, up, down, pruned, warnings, note };
}
