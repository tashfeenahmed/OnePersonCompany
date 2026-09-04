/**
 * OpenRouter.
 *
 * WHAT THE OWNER PASTES: a MANAGEMENT key, from openrouter.ai → Settings →
 * Keys → Management. An ordinary inference key answers `/credits` and its own
 * `/key` and is refused by `/activity` and `/keys` with a 403 — so it would
 * connect, show a balance, and never show a single line of what the balance
 * was spent on. `verify` below reads `/key` and refuses anything whose own
 * `is_management_key` is not true, which is a sentence the API says about
 * itself rather than a guess from a prefix.
 *
 * WHAT IT READS, and nothing else:
 *   GET /api/v1/key       what this credential is — used only to verify it
 *   GET /api/v1/credits   purchased, spent, and therefore what is left
 *   GET /api/v1/activity  per DAY per MODEL: cost, requests, tokens (~31 days)
 *   GET /api/v1/keys      per KEY: lifetime, month, week and day totals
 *
 * Strictly GET; `get()` is the only request in the file and takes no body.
 *
 * THE TWO CUTS DO NOT JOIN, AND NOTHING HERE PRETENDS THEY DO. `/activity` is
 * per day per model. `/keys` is per key, and only ever as four running totals.
 * There is no per-day-per-key anywhere in this API, so "which project spent
 * this on which model" is a question OpenRouter cannot answer — the two are
 * stored in two tables, returned in two sections and drawn on two cards, and
 * no code downstream multiplies one by the other to invent the join.
 *
 * THE THREE HEADLINE TOTALS MEASURE THREE DIFFERENT THINGS, and any card
 * showing more than one has to say which is which:
 *   credits.spent   the account's whole life, every key that ever existed
 *   sum of keys     only the keys that still EXIST — a deleted key's spend
 *                   stays in the lifetime figure and leaves this one
 *   activity total  about the last month, whoever spent it
 * They do not add up to each other and they are not supposed to.
 *
 * BYOK IS CARRIED SEPARATELY. `byok_usage_inference` is inference OpenRouter
 * routed to the caller's own provider account and did not bill for. Adding it
 * to `usage` would inflate a figure that means "what OpenRouter charged" with
 * money that was charged somewhere else entirely.
 *
 * A KEY'S HASH AND ITS MASKED LABEL ARE DROPPED ON ARRIVAL. The label is a
 * prefix of the credential itself and the hash identifies it to the API;
 * neither tells a reader anything the key's NAME does not, and there is no
 * column in this schema for either.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 30_000;

export type ActivityRow = {
  accountId: number;
  accountLabel: string;
  /** UTC day, `YYYY-MM-DD` — OpenRouter dates these "2026-09-03 00:00:00". */
  day: string;
  model: string;
  provider: string;
  /** What OpenRouter charged, in USD. Already dollars; nothing converts. */
  usd: number;
  /** Inference routed to the owner's OWN provider key. Not billed here. */
  byokUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export type KeyRow = {
  accountId: number;
  accountLabel: string;
  name: string;
  usd: number;
  usdMonth: number;
  usdWeek: number;
  usdDay: number;
  disabled: boolean;
  createdAt: string | null;
  /** A spend cap, or null for none. Null and 0 are opposite facts: no limit
   *  at all, against a limit with nothing left on it. */
  spendLimit: number | null;
  limitRemaining: number | null;
};

export type CreditsRow = {
  accountId: number;
  accountLabel: string;
  purchased: number;
  spent: number;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
};

export type CollectResult = {
  activity: ActivityRow[];
  keys: KeyRow[];
  /**
   * The accounts whose key listing actually ANSWERED, which is not the same as
   * the accounts with a row in `keys`. An account can hold no keys at all, and
   * an account whose listing 403'd holds none here either — telling them apart
   * is what stops a failed read from wiping the keys the last run stored.
   */
  keysRead: number[];
  credits: CreditsRow[];
  warnings: string[];
  accounts: AccountOutcome[];
  accountsTried: number;
};

/* --------------------------------------------------------------- http */

export class OpenRouterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

async function get<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${OPENROUTER_API}/${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      // OpenRouter attributes calls to a site when asked to. This is a read of
      // the owner's own account, but the header keeps the request recognisable
      // in their logs as this dashboard rather than a stranger with the key.
      "HTTP-Referer": "http://127.0.0.1:8787/",
      "X-Title": "onepersoncompany",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as {
        error?: { message?: string } | string;
      };
      const message =
        typeof body?.error === "string" ? body.error : body?.error?.message;
      detail = message ? ` — ${message}` : "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new OpenRouterError(res.status, `HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

const MANAGEMENT_HINT =
  "That is an inference key. OpenRouter answers /credits to any key and " +
  "refuses /activity and /keys with a 403 unless the key is a MANAGEMENT " +
  "key — so this would connect, show a balance, and never show what the " +
  "balance went on. Mint one at openrouter.ai → Settings → Keys.";

/* ------------------------------------------------------------- verify */

/**
 * Is this a management key?
 *
 * `/key` answers to any valid credential and says what KIND it is, so the
 * check is the API's own word rather than a prefix match or a hopeful 403 from
 * an endpoint we would rather not call twice. A key that is real but of the
 * wrong sort is refused here with the reason, because the alternative is a
 * connected plugin whose spend cards are permanently empty.
 */
export async function verify(
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const doc = await get<{ data?: { is_management_key?: boolean } }>("key", key);
    if (doc.data?.is_management_key !== true)
      return { ok: false, error: MANAGEMENT_HINT };
    return { ok: true };
  } catch (err) {
    if (err instanceof OpenRouterError) {
      if (err.status === 401)
        return { ok: false, error: "OpenRouter rejected that key (401)." };
      if (err.status === 403) return { ok: false, error: MANAGEMENT_HINT };
      return { ok: false, error: err.message };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "OpenRouter did not answer within 30 seconds."
          : `Could not reach OpenRouter (${name}).`,
    };
  }
}

/* ------------------------------------------------------------ collect */

type RawActivity = {
  date?: string;
  model?: string;
  model_permaslug?: string;
  provider_name?: string;
  usage?: number;
  byok_usage_inference?: number;
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
};

type RawKey = {
  name?: string;
  usage?: number;
  usage_monthly?: number;
  usage_weekly?: number;
  usage_daily?: number;
  disabled?: boolean;
  created_at?: string;
  limit?: number | null;
  limit_remaining?: number | null;
};

export function keyAccounts(reader: string): { account: Account; key: string }[] {
  return accounts
    .credentialed("openrouter", ["key"], reader)
    .ready.map(({ account, values }) => ({ account, key: values.key! }));
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every connected account, and within each one, three independent reads.
 *
 * THE THREE SECTIONS FAIL SEPARATELY. The balance is worth having without the
 * breakdowns and each breakdown is worth having without the other, so one 500
 * on `/activity` costs the activity table and nothing else. An account is
 * marked failing only when all three said nothing — which is what a revoked
 * key looks like, and is the only case where the page should stop showing this
 * account's numbers.
 */
export async function collect(
  reader = "collect_openrouter",
): Promise<CollectResult> {
  const pairs = keyAccounts(reader);
  const activity: ActivityRow[] = [];
  const keys: KeyRow[] = [];
  const keysRead: number[] = [];
  const credits: CreditsRow[] = [];
  const warnings: string[] = [];
  const outcomes: AccountOutcome[] = [];

  for (const { account, key } of pairs) {
    const label = account.label;
    let answered = 0;
    const failures: string[] = [];

    const soft = async <T,>(what: string, fn: () => Promise<T>) => {
      try {
        const v = await fn();
        answered += 1;
        return v;
      } catch (err) {
        const error = describe(err);
        failures.push(`${what}: ${error}`);
        warnings.push(`${label} · ${what}: ${error}`);
        return null;
      }
    };

    const cr = await soft("credits", () =>
      get<{ data?: { total_credits?: number; total_usage?: number } }>(
        "credits",
        key,
      ),
    );
    if (cr?.data)
      credits.push({
        accountId: account.id,
        accountLabel: label,
        purchased: num(cr.data.total_credits),
        spent: num(cr.data.total_usage),
      });

    const act = await soft("activity", () =>
      get<{ data?: RawActivity[] }>("activity", key),
    );
    if (act?.data) {
      /*
        Summed onto (day, model, provider). OpenRouter reports one row per
        ENDPOINT, and one provider can serve a model through more than one of
        them — two rows for gemini-3.7-flash on the same day, one Vertex and
        one AI Studio, are two halves of one answer. The endpoint id itself is
        a routing detail nothing on this dashboard asks a question about.
      */
      const byKey = new Map<string, ActivityRow>();
      for (const r of act.data) {
        const day = (r.date ?? "").slice(0, 10);
        if (!day) continue;
        const model = r.model ?? r.model_permaslug ?? "unknown";
        const provider = r.provider_name ?? "unknown";
        const id = `${day} ${model} ${provider}`;
        const row = byKey.get(id) ?? {
          accountId: account.id,
          accountLabel: label,
          day,
          model,
          provider,
          usd: 0,
          byokUsd: 0,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
        };
        row.usd += num(r.usage);
        row.byokUsd += num(r.byok_usage_inference);
        row.requests += num(r.requests);
        row.promptTokens += num(r.prompt_tokens);
        row.completionTokens += num(r.completion_tokens);
        row.reasoningTokens += num(r.reasoning_tokens);
        byKey.set(id, row);
      }
      activity.push(...byKey.values());
    }

    const ks = await soft("keys", () => get<{ data?: RawKey[] }>("keys", key));
    if (ks) keysRead.push(account.id);
    for (const k of ks?.data ?? []) {
      keys.push({
        accountId: account.id,
        accountLabel: label,
        name: k.name || "(unnamed)",
        usd: num(k.usage),
        usdMonth: num(k.usage_monthly),
        usdWeek: num(k.usage_weekly),
        usdDay: num(k.usage_daily),
        disabled: Boolean(k.disabled),
        createdAt: k.created_at ? k.created_at.slice(0, 10) : null,
        // null is "no cap", which is a different fact from a cap of zero.
        spendLimit: k.limit ?? null,
        limitRemaining: k.limit_remaining ?? null,
      });
    }

    outcomes.push(
      answered
        ? { id: account.id, label, ok: true }
        : { id: account.id, label, ok: false, error: failures.join("; ") },
    );
  }

  return {
    activity,
    keys,
    keysRead,
    credits,
    warnings,
    accounts: outcomes,
    accountsTried: pairs.length,
  };
}

function describe(err: unknown): string {
  if (err instanceof OpenRouterError)
    return err.status === 403 ? MANAGEMENT_HINT : err.message;
  return err instanceof Error ? err.name : "Error";
}
