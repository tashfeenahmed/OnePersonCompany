/**
 * Replicate.
 *
 * THIS IS THE INTEGRATION THAT CANNOT ANSWER "WHAT DID IT COST", AND SAYS SO.
 *
 * There is no WorkDash collector for Replicate — the token over there belongs
 * to `agent/studio.js` and is used to GENERATE things, not to account for
 * them — so what Replicate's API exposes about an account's money was worked
 * out here by asking it. What follows was probed against the live account on
 * 2026-09-04 and is written down so nobody has to find it twice:
 *
 *   GET /v1/account          200 — the username and account type. No money.
 *   GET /v1/predictions      200 — the full prediction history, paginated,
 *                                  ~60 days deep on this account.
 *   GET /v1/hardware         200 — the SKUs (cpu, gpu-t4, gpu-h100 …) and
 *                                  their names, AND NO PRICES.
 *   GET /v1/billing          404
 *   GET /v1/account/billing  404
 *   GET /v1/usage            404
 *
 * So: **Replicate's public API has no billing surface at all.** There is no
 * spend endpoint, no invoice, no credit balance. And the gap cannot be closed
 * from the prediction side either, for two independent reasons:
 *
 *  1. A prediction record carries no hardware SKU and no price. It says which
 *     model ran, whether it succeeded, when, and — in `metrics` — how long the
 *     prediction took. Nothing joins that to a rate, because `/v1/hardware`
 *     publishes no rates and the record does not say which hardware it ran on.
 *  2. For a large part of this account's traffic the SECOND IS NOT THE BILLING
 *     UNIT. `openai/gpt-image-2` and `bytedance/seedance-2.5` are priced per
 *     output — per image, per second of video — not per second of compute, so
 *     even a complete price list for hardware would not price them.
 *
 * A cost card here would therefore be a number this codebase invented. It is
 * not built. What IS built is everything Replicate does report, said in its
 * own units: how many predictions ran, on which models, how many of them
 * failed, how much compute time they took, and how many images, seconds of
 * video and output tokens came out the other end. `cost: null` travels with
 * it — "asked and not told", which is the truth, rather than a zero.
 *
 * WHAT IT READS, and nothing else: GET /v1/account and GET /v1/predictions.
 * Both are reads; the prediction endpoint's write side (POST) is never called,
 * and a token that could only read would serve this file completely.
 *
 * INCREMENTAL BY `created_after`. The listing takes a `created_after` filter,
 * so a collection asks only for predictions newer than the newest one already
 * stored, less a few hours of overlap in case one was still running when it
 * was last seen. Rows are keyed by prediction id and REPLACED, so a prediction
 * caught mid-flight is corrected when it finishes rather than counted twice.
 * The first collection has nothing to be newer than and reads the window.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const REPLICATE_API = "https://api.replicate.com/v1";
const TIMEOUT_MS = 30_000;

/** The paging leash. A hundred predictions to a page, so this reads twenty
 *  pages before it gives up on somebody else's cursor. */
const MAX_PAGES = 20;

/** How far back the FIRST collection reaches. Later ones ask only for what is
 *  newer than they already hold; the rows accumulate past this either way. */
export const WINDOW_DAYS = 30;

/**
 * How far back to re-read on every collection, beyond the newest row held.
 *
 * A prediction that was still running when it was last seen has no
 * `predict_time` and a status of `processing`; six hours of overlap is enough
 * to catch it finishing without re-reading the month. Video jobs on this
 * account run for four and a half minutes, so this is generous by two orders
 * of magnitude and costs one extra page at most.
 */
const OVERLAP_HOURS = 6;

/**
 * What this API will not tell you, stated as a property of the API.
 *
 * It sits here rather than being re-probed every half hour: deliberately
 * calling three endpoints to watch them 404 is noise in someone else's logs to
 * re-learn a fact that changes when Replicate ships a billing API, not when
 * the collector runs. It is dated, and the date is shown, so it reads as
 * something that was checked rather than something that was assumed.
 */
export const CANNOT = {
  checkedOn: "2026-09-04",
  /** What was asked, and what came back. Written as the exchange rather than
   *  as a conclusion, so a card can show the evidence rather than the verdict. */
  asked: [
    { asked: "GET /v1/billing", answer: "404" },
    { asked: "GET /v1/account/billing", answer: "404" },
    { asked: "GET /v1/usage", answer: "404" },
    { asked: "Hardware or price on a prediction", answer: "not in the record" },
    { asked: "Rates on /v1/hardware", answer: "SKUs only, no prices" },
    {
      asked: "Cost of an image or a second of video",
      answer: "priced per output, rate not in the API",
    },
  ],
} as const;

/** One prediction, in the units Replicate reports it in. */
export type PredictionRow = {
  accountId: number;
  accountLabel: string;
  id: string;
  model: string | null;
  status: string | null;
  createdAt: string;
  /**
   * `metrics.predict_time` — seconds the prediction itself took. Null when
   * the prediction never ran or is still running, which is not zero seconds.
   */
  predictSeconds: number | null;
  /** The output-side counters Replicate attaches for the models that have
   *  them. Null where the model does not report that kind of output at all. */
  imageOutputs: number | null;
  videoSeconds: number | null;
  outputTokens: number | null;
  /** "api" or "web" — whether this dashboard's owner started it in a browser
   *  or something they wrote did. */
  source: string | null;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  /** The account's own Replicate username, when it answered. Two Replicate
   *  tokens are two accounts and this is the only thing that names them. */
  username?: string | null;
  predictions: number;
};

export type CollectResult = {
  rows: PredictionRow[];
  warnings: string[];
  accounts: AccountOutcome[];
  accountsTried: number;
};

/* --------------------------------------------------------------- http */

export class ReplicateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReplicateError";
    this.status = status;
  }
}

async function get<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body?.detail ? ` — ${body.detail}` : "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new ReplicateError(res.status, `HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------- verify */

/**
 * Is this token real, and whose account does it read?
 *
 * `/v1/account` rather than a prediction listing: it is the cheapest thing the
 * token can be asked, and its answer — the username — is the one fact that
 * makes two Replicate accounts distinguishable on the page.
 */
export async function verify(
  token: string,
): Promise<
  { ok: true; username: string | null } | { ok: false; error: string }
> {
  try {
    const doc = await get<{ username?: string }>(
      `${REPLICATE_API}/account`,
      token,
    );
    return { ok: true, username: doc.username ?? null };
  } catch (err) {
    if (err instanceof ReplicateError) {
      if (err.status === 401)
        return {
          ok: false,
          error:
            "Replicate rejected that token (401). It is the `r8_…` API token " +
            "from replicate.com/account/api-tokens.",
        };
      return { ok: false, error: err.message };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Replicate did not answer within 30 seconds."
          : `Could not reach Replicate (${name}).`,
    };
  }
}

/* ------------------------------------------------------------ collect */

type RawPrediction = {
  id?: string;
  model?: string;
  status?: string;
  created_at?: string;
  source?: string;
  metrics?: Record<string, unknown>;
};

type Page = { next?: string | null; results?: RawPrediction[] };

export function tokenAccounts(
  reader: string,
): { account: Account; token: string }[] {
  return accounts
    .credentialed("replicate", ["token"], reader)
    .ready.map(({ account, values }) => ({ account, token: values.token! }));
}

/** A metric Replicate attached, or null. Null is "this model does not report
 *  that", which is not the same as none of it. */
function metric(metrics: Record<string, unknown> | undefined, key: string) {
  const v = metrics?.[key];
  const n = Number(v);
  return v === undefined || v === null || !Number.isFinite(n) ? null : n;
}

/**
 * Every connected Replicate account's prediction history since `since`.
 *
 * `since` is a per-account instant supplied by the caller — the newest
 * prediction already stored, less the overlap — because the provider does not
 * read the database and the collector does. An account with no entry reads the
 * window, which is what a first collection does.
 */
export async function collect(
  since: Map<number, string | null>,
  reader = "collect_replicate",
): Promise<CollectResult> {
  const pairs = tokenAccounts(reader);
  const rows: PredictionRow[] = [];
  const warnings: string[] = [];
  const outcomes: AccountOutcome[] = [];
  const windowStart = new Date(
    Date.now() - WINDOW_DAYS * 86_400_000,
  ).toISOString();

  for (const { account, token } of pairs) {
    const label = account.label;
    const before = rows.length;

    let username: string | null = null;
    try {
      username =
        (await get<{ username?: string }>(`${REPLICATE_API}/account`, token))
          .username ?? null;
    } catch (err) {
      // The account call is a courtesy — it names the account on the page. Its
      // failure is not the history's failure, so it is a warning and the
      // listing below is still attempted.
      warnings.push(`${label}: account name unreadable (${describe(err)})`);
    }

    const seen = since.get(account.id);
    const after = seen
      ? new Date(Date.parse(seen) - OVERLAP_HOURS * 3_600_000).toISOString()
      : windowStart;

    try {
      let url: string | null =
        `${REPLICATE_API}/predictions?created_after=${encodeURIComponent(after)}`;
      for (let page = 0; page < MAX_PAGES && url; page++) {
        const doc: Page = await get<Page>(url, token);
        for (const p of doc.results ?? []) {
          if (!p.id || !p.created_at) continue;
          rows.push({
            accountId: account.id,
            accountLabel: label,
            id: p.id,
            model: p.model ?? null,
            status: p.status ?? null,
            createdAt: p.created_at,
            predictSeconds: metric(p.metrics, "predict_time"),
            imageOutputs: metric(p.metrics, "image_output_count"),
            videoSeconds: metric(p.metrics, "video_output_duration_seconds"),
            outputTokens: metric(p.metrics, "token_output_count"),
            source: p.source ?? null,
          });
        }
        url = doc.next ?? null;
      }
      outcomes.push({
        id: account.id,
        label,
        ok: true,
        username,
        predictions: rows.length - before,
      });
    } catch (err) {
      const error = describe(err);
      warnings.push(`${label}: ${error}`);
      outcomes.push({
        id: account.id,
        label,
        ok: false,
        error,
        username,
        predictions: 0,
      });
    }
  }

  return { rows, warnings, accounts: outcomes, accountsTried: pairs.length };
}

function describe(err: unknown): string {
  if (err instanceof ReplicateError) return err.message;
  return err instanceof Error ? err.name : "Error";
}
