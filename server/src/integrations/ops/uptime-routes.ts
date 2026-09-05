/**
 * The uptime document — every figure on it computed HERE, on every read.
 *
 * The table holds observations and nothing else (see 040_uptime). Availability
 * percentages, latency percentiles, incidents and "is it up right now" are all
 * derived at read time, for the reason the domains route computes its
 * countdowns that way: a stored availability figure describes a window that
 * has moved by the time anybody looks at it, and it survives a collector that
 * stopped running — which is the exact condition it exists to reveal.
 *
 * WHAT AVAILABILITY MEANS HERE, and it is narrower than the word suggests. It
 * is the share of THIS BOX'S CHECKS that succeeded, from a laptop on a
 * domestic connection, at whatever cadence the scheduler managed. Half an hour
 * between checks means an outage shorter than half an hour is very likely
 * invisible, and a laptop asleep from midnight to eight is eight hours nobody
 * asked. So the count of checks is published beside every percentage, and a
 * host with too few is marked rather than drawn as a confident 100%.
 *
 * LATENCY PERCENTILES ARE OVER SUCCESSFUL CHECKS ONLY. A ten-second timeout
 * included in a p95 turns a connection refused — which took two milliseconds —
 * into a "slow site", and the failure is already reported as a failure.
 */
import { Hono } from "hono";
import { configValue } from "../../db.ts";
import { checksSince, parseHosts, target, type CheckRow } from "./uptime.ts";

export const uptimeRoutes = new Hono();

/** Below this many checks in a window, a percentage is a rumour. */
const MIN_CHECKS = 6;
/** The two fixed windows every host reports, whatever `hours` asks for. */
const DAY_HOURS = 24;
const WEEK_HOURS = 24 * 7;

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value));
}

/** Nearest-rank percentile over a sorted array. No interpolation: these are
 *  observed latencies and a p95 that no request actually took is a number
 *  invented by arithmetic. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[clamp(rank, 1, sorted.length) - 1] ?? null;
}

function availability(rows: CheckRow[]) {
  const checks = rows.length;
  const ok = rows.filter((r) => r.ok === 1).length;
  return {
    checks,
    ok,
    failed: checks - ok,
    /** Null rather than 100 when nothing was measured — "asked and not told". */
    percent: checks ? Math.round((ok / checks) * 1000) / 10 : null,
    enough: checks >= MIN_CHECKS,
  };
}

/**
 * Runs of consecutive failures, oldest first.
 *
 * An incident that is still failing has `end: null` and `ongoing: true`; it
 * has NOT ended just because it is the last row we hold. `end` is the time of
 * the first check that succeeded again, which is the earliest moment this box
 * can honestly say the site was back — not the last failure, which would
 * understate every outage by one interval.
 */
function incidents(rows: CheckRow[]) {
  const out: {
    start: string;
    end: string | null;
    ongoing: boolean;
    checks: number;
    status: number | null;
    error: string | null;
  }[] = [];
  let open: (typeof out)[number] | null = null;

  for (const r of rows) {
    if (r.ok === 0) {
      if (!open) {
        open = { start: r.ts, end: null, ongoing: true, checks: 0, status: r.status, error: r.error };
        out.push(open);
      }
      open.checks += 1;
      open.status = r.status;
      open.error = r.error;
    } else if (open) {
      open.end = r.ts;
      open.ongoing = false;
      open = null;
    }
  }
  return out;
}

uptimeRoutes.get("/", (c) => {
  const hours = clamp(Number(c.req.query("hours") ?? DAY_HOURS) || DAY_HOURS, 1, 720);
  const configured = parseHosts(configValue("uptime", "hosts"));

  /* One query, widened to whichever is longer — the requested window or the
     seven days every host reports anyway. Two queries would read the same rows
     twice to answer the same question. */
  const rows = checksSince(Math.max(hours, WEEK_HOURS));
  const byHost = new Map<string, CheckRow[]>();
  for (const r of rows) {
    const held = byHost.get(r.host) ?? [];
    held.push(r);
    byHost.set(r.host, held);
  }

  const cut = (all: CheckRow[], h: number) => {
    const since = new Date(Date.now() - h * 3_600_000).toISOString();
    return all.filter((r) => r.ts >= since);
  };

  const hosts = configured.map((host) => {
    const all = byHost.get(host) ?? [];
    const window = cut(all, hours);
    const last = all.at(-1) ?? null;
    const t = target(host);

    const okLatencies = window
      .filter((r) => r.ok === 1 && r.latency_ms !== null)
      .map((r) => r.latency_ms!)
      .sort((a, b) => a - b);

    /* The last check that actually MEASURED a certificate, which is not
       necessarily the last check: a box that went down this morning still has
       a certificate, and its expiry is exactly what somebody debugging the
       outage wants to see. */
    const tls = [...all].reverse().find((r) => r.tls_days !== null) ?? null;

    /* Only asked of a host the owner typed with an explicit http:// scheme.
       For everything else the question is meaningless — the check was made
       over https to begin with — and null says so rather than "no". */
    const redirectsToHttps =
      t.scheme === "http"
        ? last?.final_url
          ? last.final_url.startsWith("https://")
          : null
        : null;

    return {
      host,
      /** Where the check is actually sent. A bare name is asked over https,
       *  because that is what a browser does now. */
      url: t.url,
      current: last && {
        ts: last.ts,
        ok: last.ok === 1,
        status: last.status,
        latencyMs: last.latency_ms,
        bytes: last.bytes,
        finalUrl: last.final_url,
        error: last.error,
      },
      availability: {
        window: { hours, ...availability(window) },
        day: { hours: DAY_HOURS, ...availability(cut(all, DAY_HOURS)) },
        week: { hours: WEEK_HOURS, ...availability(cut(all, WEEK_HOURS)) },
      },
      latency: {
        unit: "ms",
        basis: "successful checks only, whole exchange including redirects and TLS",
        p50: percentile(okLatencies, 50),
        p95: percentile(okLatencies, 95),
        samples: okLatencies.length,
      },
      tls: {
        daysLeft: tls?.tls_days ?? null,
        measuredAt: tls?.ts ?? null,
        /** Null means the certificate was never read — a plain-http target, or
         *  a handshake that did not complete. It is not "expired". */
        note:
          tls === null
            ? t.scheme === "http"
              ? "Plain http was asked for, so there is no certificate to read."
              : "No certificate has been read yet."
            : null,
      },
      redirectsToHttps,
      incidents: incidents(window),
      note:
        window.length === 0
          ? "No checks yet in this window — the host was added recently, or the collector has not run."
          : window.length < MIN_CHECKS
            ? `Only ${window.length} check(s) in this window; a percentage over fewer than ${MIN_CHECKS} is not worth quoting.`
            : null,
    };
  });

  const measured = hosts.filter((h) => h.current);
  return c.json({
    window: {
      hours,
      /** Said out loud because it bounds everything above: an outage shorter
       *  than the gap between checks is invisible to this whole document. */
      cadence: "one check per host per collection — normally every 30 minutes",
      checkedFrom: "this machine, over its own connection",
    },
    hosts,
    summary: {
      configured: configured.length,
      up: measured.filter((h) => h.current?.ok).length,
      down: measured.filter((h) => h.current && !h.current.ok).length,
      /** Configured but never checked. Not "down": nobody has asked yet. */
      unknown: hosts.length - measured.length,
      soonestTlsExpiry: hosts
        .map((h) => h.tls.daysLeft)
        .filter((d): d is number => d !== null)
        .sort((a, b) => a - b)[0] ?? null,
      lastCheckedAt: rows.at(-1)?.ts ?? null,
    },
  });
});

/**
 * What a venture could be linked to here.
 *
 * The entity IS the host, which is also the hostname — so a venture whose own
 * host matches can be auto-linked without anybody deciding anything.
 */
uptimeRoutes.get("/entities", (c) => {
  const configured = parseHosts(configValue("uptime", "hosts"));
  return c.json({
    entities: configured.map((host) => ({
      plugin: "uptime",
      entity: host,
      label: host,
      host: target(host).hostname,
    })),
  });
});
