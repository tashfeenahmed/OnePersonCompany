/**
 * OpenAI — the organization Costs API.
 *
 * WHAT THE OWNER PASTES: an ORG ADMIN key, the `sk-admin-…` kind minted at
 * Settings → Organization → Admin keys. Everything under `/v1/organization/*`
 * is the admin surface: an ordinary project key (`sk-proj-…`) is refused with
 * a 401 there no matter how many scopes it carries, and that refusal is worth
 * saying out loud rather than showing as an empty month. `verify` below turns
 * it into a sentence naming the kind of key that would work.
 *
 * WHAT IT READS, and nothing else:
 *   GET /v1/organization/costs?bucket_width=1d&group_by=project_id
 *
 * Strictly GET. There is no other request in this file, and the Costs API has
 * no write side to reach by accident.
 *
 * ONE CUT, AND IT JOINS. Grouped by project, the Costs API gives per DAY per
 * PROJECT in one set of rows, so "what did the org spend on the 3rd" and "what
 * did this project spend this month" are two sums over the SAME rows and agree
 * to the cent. That is a claim OpenRouter's API cannot make about its two cuts
 * and this one can, which is why the rows are stored at that grain and every
 * total is computed from them at read time.
 *
 * WHAT IT CANNOT ANSWER: per MODEL. The Costs API groups by project OR by line
 * item ("GPT-4o input tokens"), never both, and the line-item cut is a billing
 * taxonomy rather than a model list. It is deliberately not fetched, and there
 * is no widget downstream promising a per-model split — the catalog's old
 * `openai.models` card was removed rather than filled with a guess.
 *
 * THE BUCKETS RUN A DAY BEHIND. Costs aggregate into UTC day buckets and the
 * recent ones lag: spend can take about a day to appear, and today's bucket is
 * partial by definition. Nothing here smooths that over — the collection
 * REPLACES a day's row when it is read again, so yesterday's half-arrived
 * figure is corrected rather than added to, and the route says which day is
 * the last complete one so no card reads a partial bucket as a fall in spend.
 *
 * The project NAME comes back on the cost rows themselves (`project_name`), so
 * this makes no second call to /organization/projects to join one on. A name
 * the API did not send leaves the raw `proj_…` id in place: a label guessed
 * from somewhere else is a join dressed up as a fact.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const OPENAI_API = "https://api.openai.com/v1";
const TIMEOUT_MS = 30_000;

/** The cursor loop's leash. Thirty-one day-buckets fit one page today; if
 *  OpenAI ever shrinks its pages this still reads a sane window instead of
 *  spinning against someone else's pagination forever. */
const MAX_PAGES = 12;

/** How far back each collection asks. The rows accumulate beyond it — a day
 *  once written stays written — so this is the refresh window, not the
 *  history. Thirty days is what the Costs API is happy to hand over in one
 *  page and what "spend this month" means to the person paying it. */
export const WINDOW_DAYS = 30;

/** One day of one project's spend, in the currency OpenAI billed it in. */
export type CostRow = {
  accountId: number;
  accountLabel: string;
  /** UTC day, `YYYY-MM-DD`, taken from the bucket's own start time. */
  day: string;
  projectId: string;
  projectName: string;
  usd: number;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  rows: number;
};

export type CollectResult = {
  rows: CostRow[];
  warnings: string[];
  accounts: AccountOutcome[];
  accountsTried: number;
};

/* --------------------------------------------------------------- http */

export class OpenAIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenAIError";
    this.status = status;
  }
}

async function get<T>(
  path: string,
  key: string,
  params: Record<string, string | number>,
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
  );
  const res = await fetch(`${OPENAI_API}/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // OpenAI explains itself in the body; a bare status sends the owner to the
    // docs for something the API already said.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? ` — ${body.error.message}` : "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new OpenAIError(res.status, `HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * The sentence a 401 or a 403 on this surface deserves.
 *
 * Both status codes mean the same thing here nine times in ten — a project key
 * where an admin key belongs — and "HTTP 401" alone would send the owner to
 * rotate a key that was never the right sort of key.
 */
const ADMIN_KEY_HINT =
  "OpenAI refused that key on the organization API. It needs an ORG ADMIN key " +
  "(sk-admin-…), minted at Settings → Organization → Admin keys; a project key " +
  "(sk-proj-…) is refused here whatever scopes it has.";

/* ------------------------------------------------------------- verify */

/**
 * Is this an admin key, and does the Costs API answer it?
 *
 * Asked against the endpoint the collector actually uses, over a one-day
 * window, rather than against a cheaper listing: a key that can list projects
 * and cannot read costs would pass the cheaper check and then produce an empty
 * spend page an hour later, which is the failure this call exists to prevent.
 */
export async function verify(
  key: string,
): Promise<{ ok: true; org: string | null } | { ok: false; error: string }> {
  try {
    const doc = await get<CostsPage>("organization/costs", key, {
      start_time: Math.floor(Date.now() / 1000) - 2 * 86_400,
      bucket_width: "1d",
      limit: 2,
      group_by: "project_id",
    });
    // The org's own name rides on the rows. It is the one thing that tells the
    // owner WHICH organization this key reads, which matters the moment there
    // is more than one account here.
    const org =
      doc.data
        ?.flatMap((b) => b.results ?? [])
        .find((r) => r.organization_name)?.organization_name ?? null;
    return { ok: true, org };
  } catch (err) {
    if (err instanceof OpenAIError) {
      if (err.status === 401 || err.status === 403)
        return { ok: false, error: ADMIN_KEY_HINT };
      return { ok: false, error: err.message };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "OpenAI did not answer within 30 seconds."
          : `Could not reach OpenAI (${name}).`,
    };
  }
}

/* ------------------------------------------------------------ collect */

type CostsResult = {
  amount?: { currency?: string; value?: number };
  project_id?: string | null;
  project_name?: string | null;
  organization_name?: string | null;
};

type CostsPage = {
  data?: { start_time?: number; results?: CostsResult[] }[];
  has_more?: boolean;
  next_page?: string | null;
};

/** The accounts holding a key, in the order they were added. */
export function keyAccounts(reader: string): { account: Account; key: string }[] {
  return accounts
    .credentialed("openai", ["key"], reader)
    .ready.map(({ account, values }) => ({ account, key: values.key! }));
}

const utcDay = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

/**
 * Every connected organization, one after another.
 *
 * ONE ACCOUNT FAILING LOSES ONLY THAT ACCOUNT, exactly as it does for Hetzner:
 * a revoked admin key takes its own org's rows off the page and leaves the
 * other org's spend where it was. The alternative — a run that fails whole —
 * would blank a bill because a second organization stopped answering.
 */
export async function collect(reader = "collect_openai"): Promise<CollectResult> {
  const pairs = keyAccounts(reader);
  const rows: CostRow[] = [];
  const warnings: string[] = [];
  const outcomes: AccountOutcome[] = [];
  const start = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400;

  for (const { account, key } of pairs) {
    const label = account.label;
    const before = rows.length;

    try {
      const params: Record<string, string | number> = {
        start_time: start,
        bucket_width: "1d",
        limit: WINDOW_DAYS + 1,
        group_by: "project_id",
      };
      for (let page = 0; page < MAX_PAGES; page++) {
        const doc = await get<CostsPage>("organization/costs", key, params);
        for (const bucket of doc.data ?? []) {
          const day = utcDay(bucket.start_time ?? 0);
          for (const r of bucket.results ?? []) {
            const currency = (r.amount?.currency ?? "usd").toLowerCase();
            if (currency !== "usd") {
              /*
                Has never happened. If it ever does, a silent sum across
                currencies would be a number no invoice ever said — so the
                amount is dropped and the drop is reported, which is the only
                honest pair of moves available.
              */
              const note = `${label}: skipped a ${currency} amount on ${day}`;
              if (!warnings.includes(note)) warnings.push(note);
              continue;
            }
            const usd = Number(r.amount?.value ?? 0);
            if (!Number.isFinite(usd)) continue;
            rows.push({
              accountId: account.id,
              accountLabel: label,
              day,
              // A bucket with spend nobody attributed to a project is a real
              // row and keeps its own name rather than being folded into
              // whichever project happens to sort first.
              projectId: r.project_id ?? "(unattributed)",
              projectName: r.project_name ?? r.project_id ?? "(unattributed)",
              usd,
            });
          }
        }
        if (!doc.has_more || !doc.next_page) break;
        params.page = doc.next_page;
      }
      outcomes.push({
        id: account.id,
        label,
        ok: true,
        rows: rows.length - before,
      });
    } catch (err) {
      const error = describe(err);
      warnings.push(`${label}: ${error}`);
      outcomes.push({ id: account.id, label, ok: false, error, rows: 0 });
    }
  }

  return { rows, warnings, accounts: outcomes, accountsTried: pairs.length };
}

function describe(err: unknown): string {
  if (err instanceof OpenAIError)
    return err.status === 401 || err.status === 403
      ? ADMIN_KEY_HINT
      : err.message;
  return err instanceof Error ? err.name : "Error";
}
