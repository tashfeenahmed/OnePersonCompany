/**
 * Stock media libraries — Pexels and Pixabay.
 *
 * THESE ARE NOT LIKE THE OTHER INTEGRATIONS, AND THE DIFFERENCE DECIDES WHAT
 * GETS BUILT. Hetzner, the registrars, GitHub, OpenAI and OpenRouter are
 * MEASUREMENT sources: you ask them what happened and they answer with a bill,
 * a fleet, a portfolio, a history. Pexels and Pixabay are CONSUMPTION APIs —
 * the previous system called them to search for b-roll, Pexels first and
 * Pixabay as the fallback when Pexels has no match. Nothing over there
 * recorded what came back, and neither service keeps
 * an account history you can ask for later.
 *
 * So there is no spend to chart (both are free), no usage history (neither
 * publishes one), and no library-size trend worth having. Inventing any of
 * those is exactly the failure this codebase keeps refusing to commit.
 *
 * WHAT THERE IS, AND IT IS WORTH HAVING: a monthly request quota, reported on
 * every response in headers. Probed live on 2026-09-04, Pexels answers
 *
 *     x-ratelimit-limit      25000
 *     x-ratelimit-remaining  24999
 *     x-ratelimit-reset      1789613377   (unix seconds)
 *
 * which is a real number about a real constraint: the workers share that
 * allowance, and "the reel pipeline stops finding footage on the 28th" is a
 * thing you would rather know on the 14th. Sampled over time it is also a burn
 * rate, which is the only series either of these APIs can honestly produce.
 *
 * THE MEASUREMENT COSTS SOME OF THE THING IT MEASURES. Every quota check spends
 * one request out of the same allowance. At the ordinary half-hourly cadence
 * that is ~1,440 a month — 5.8% of Pexels' 25,000 spent watching Pexels, which
 * is an absurd trade for a counter that moves slowly. So the stock collectors
 * run on their own six-hour clock (see STOCK_EVERY_HOURS in the collector):
 * ~120 requests a month, under half a percent, and a quota that is being burned
 * fast is still caught the same day. This is the same reasoning that puts
 * GitHub's traffic read on a slow clock, and for the same reason.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

const TIMEOUT_MS = 20_000;

/**
 * An honest User-Agent.
 *
 * Pixabay sits behind Cloudflare, which answers an unrecognised client with a
 * challenge PAGE and an HTTP 200 — the previous system documents being caught by
 * exactly this and reading the HTML as JSON. Naming the tool is both the polite
 * thing and the one that gets answered.
 */
const USER_AGENT = "onepersoncompany-collector/1.0";

/**
 * One library's quota, as its own headers report it.
 *
 * Every field is nullable because a header that is absent is not a zero. A
 * service that stops sending `x-ratelimit-remaining` has told us nothing about
 * how much is left, and a card drawing that as "0 remaining" would raise an
 * alarm about the one thing that did not happen.
 */
export type Quota = {
  limit: number | null;
  remaining: number | null;
  /** ISO, from the unix seconds the header carries. */
  resetsAt: string | null;
  /** Derived, and only when both halves are real. */
  used: number | null;
};

export type StockResult = {
  quota: Quota;
  /** What the probe searched for and how many the library holds for it. Not a
   *  metric — evidence that the key really answered a real query. */
  probe: { term: string; results: number | null };
};

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The three headers both services use, read case-insensitively because
 *  Pexels spells them lower-case and Pixabay capitalises them. */
export function readQuota(headers: Headers): Quota {
  const limit = num(headers.get("x-ratelimit-limit"));
  const remaining = num(headers.get("x-ratelimit-remaining"));
  const reset = num(headers.get("x-ratelimit-reset"));
  return {
    limit,
    remaining,
    // Seconds since the epoch on both. A value small enough to be a DURATION
    // rather than an instant is treated as one — Pixabay's docs describe its
    // reset as seconds remaining in the window, and a 1970 date on a card is a
    // worse answer than an honest null.
    resetsAt:
      reset === null
        ? null
        : new Date((reset < 1e9 ? Date.now() / 1000 + reset : reset) * 1000).toISOString(),
    used: limit !== null && remaining !== null ? limit - remaining : null,
  };
}

export class StockError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StockError";
    this.status = status;
  }
}

/**
 * A response that is really JSON.
 *
 * The content-type check is not defensive programming for its own sake: it is
 * the Cloudflare challenge page, which arrives as HTML under a 200 and turns
 * into a baffling parse error three frames away from the cause. Named here, it
 * is one sentence the owner can act on.
 */
async function json(res: Response, label: string): Promise<Record<string, unknown>> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new StockError(
      res.status,
      `${label} answered with a page rather than JSON — usually a bot challenge in front of the API.`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ pexels */

const PEXELS_API = "https://api.pexels.com";

/**
 * One search, for the quota headers it comes back with.
 *
 * The VIDEO endpoint specifically, because that is the one the faceless and
 * reel workers actually call — Pexels tracks its windows per API family, and
 * the two endpoints answered with reset stamps two hours apart when this was
 * probed. Measuring the photo quota would be measuring an allowance nothing
 * here spends.
 */
export async function pexelsProbe(key: string, term = "ocean"): Promise<StockResult> {
  const res = await fetch(
    `${PEXELS_API}/videos/search?query=${encodeURIComponent(term)}&per_page=1`,
    {
      headers: { Authorization: key, Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (res.status === 401) throw new StockError(401, "Pexels rejected that key.");
  if (res.status === 429)
    throw new StockError(429, "Pexels is rate-limiting this key — the monthly quota may be spent.");
  if (!res.ok) throw new StockError(res.status, `Pexels answered HTTP ${res.status}.`);

  const body = await json(res, "Pexels");
  return {
    quota: readQuota(res.headers),
    probe: { term, results: typeof body.total_results === "number" ? body.total_results : null },
  };
}

/* ----------------------------------------------------------------- pixabay */

const PIXABAY_API = "https://pixabay.com/api/videos/";

/**
 * The same, for Pixabay.
 *
 * UNVERIFIED AGAINST A LIVE KEY. There is no `pixabay-key` in the vault — the
 * name is declared in the previous system's known secrets and no value was
 * ever stored — so this is written from the published API and the shape the
 * system it replaces already handles, and it has never been run against a
 * real response. The quota reader above is deliberately tolerant for that reason:
 * absent headers produce nulls, and the cards say "not reported" rather than
 * drawing a confident zero for a service nobody has actually asked.
 *
 * Pixabay takes its key in the QUERY STRING rather than a header, which is why
 * any error text from it goes through the caller's scrub before it is stored.
 */
export async function pixabayProbe(key: string, term = "ocean"): Promise<StockResult> {
  const url = `${PIXABAY_API}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(term)}&per_page=3`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 400 || res.status === 401)
    throw new StockError(res.status, "Pixabay rejected that key.");
  if (res.status === 429)
    throw new StockError(429, "Pixabay is rate-limiting this key — try again shortly.");
  if (!res.ok) throw new StockError(res.status, `Pixabay answered HTTP ${res.status}.`);

  const body = await json(res, "Pixabay");
  return {
    quota: readQuota(res.headers),
    probe: { term, results: typeof body.totalHits === "number" ? body.totalHits : null },
  };
}

/* ------------------------------------------------------------------ shared */

export type Library = "pexels" | "pixabay";

const PROBES: Record<Library, (key: string, term?: string) => Promise<StockResult>> = {
  pexels: pexelsProbe,
  pixabay: pixabayProbe,
};

export const DISPLAY: Record<Library, string> = {
  pexels: "Pexels",
  pixabay: "Pixabay",
};

/** Take the key back out of anything the service said, before it is stored on
 *  a run row the interface displays. Pixabay puts the key in the URL, and an
 *  error that echoes the URL would otherwise carry it into a log. */
export function scrub(text: string, key: string): string {
  return (key.length >= 6 ? text.split(key).join("[redacted]") : text).slice(0, 220);
}

/**
 * Is this key real?
 *
 * A one-result search, which is the cheapest call either API has and the only
 * way to find out — neither publishes a "validate this key" endpoint, so the
 * check IS a request and it spends one from the allowance it is checking.
 */
export async function verify(
  library: Library,
  key: string,
): Promise<{ ok: true; quota: Quota } | { ok: false; error: string }> {
  try {
    const { quota } = await PROBES[library](key);
    return { ok: true, quota };
  } catch (err) {
    const message =
      err instanceof StockError
        ? err.message
        : err instanceof Error && err.name === "TimeoutError"
          ? `${DISPLAY[library]} did not answer within 20 seconds.`
          : `Could not reach ${DISPLAY[library]}.`;
    return { ok: false, error: scrub(message, key) };
  }
}

export type AccountResult = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  quota?: Quota;
  probe?: StockResult["probe"];
};

export type CollectResult = {
  accounts: AccountResult[];
  accountsTried: number;
  warnings: string[];
};

/**
 * Every account on one library.
 *
 * Per-account failure is that account's own, the way it is everywhere else
 * here: a second key that has been revoked costs its own row and nothing else,
 * and the run fails only when every account failed.
 */
export async function collect(library: Library, reader?: string): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed(
    library,
    ["key"],
    reader ?? `collect_${library}`,
  );
  const out: AccountResult[] = [];
  const warnings: string[] = [];

  // An account whose credential never made it into the vault is its own
  // failure, reported against that account rather than silently skipped.
  for (const { account } of broken) {
    out.push({ id: account.id, label: account.label, ok: false, error: "No key stored." });
    warnings.push(`${account.label}: no key stored`);
  }

  for (const { account, values } of ready) {
    const key = (values.key ?? "").trim();
    try {
      const result = await PROBES[library](key);
      out.push({
        id: account.id,
        label: account.label,
        ok: true,
        quota: result.quota,
        probe: result.probe,
      });
    } catch (err) {
      const message = scrub(err instanceof Error ? err.message : "Error", key);
      out.push({ id: account.id, label: account.label, ok: false, error: message });
      warnings.push(`${account.label}: ${message}`);
    }
  }

  return { accounts: out, accountsTried: ready.length + broken.length, warnings };
}

export type { Account };
