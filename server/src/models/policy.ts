/**
 * THE LOAD-BALANCING POLICY, AS A SETTING RATHER THAN A CONSTANT.
 *
 * `models/provider.ts` defines what a Policy IS and enforces it in the
 * limiter. This file is the other half: where one is kept, how it is checked,
 * and what each provider's is when nobody has said. It is a separate file
 * because provider.ts is the contract — it holds no import of the database and
 * should not grow one — and because both the factories (which READ a policy on
 * every `activeProvider()`) and the settings route (which WRITES one) need the
 * same four keys spelled the same way. Two spellings of `policy.concurrency`
 * would be two settings, one of which nothing reads.
 *
 * IT LIVES IN `plugin_config`, UNDER THE PROVIDER'S OWN PLUGIN ID, for the
 * reason npm's package list does: it is not a credential, and a value the
 * owner cannot read back is a value they will set twice. The keys are
 * `policy.mode`, `policy.concurrency`, `policy.balance` and `policy.timeoutMs`
 * — a flat namespace rather than one JSON blob in a single row, because a blob
 * has to be parsed before any part of it can be checked and a typo inside it
 * fails as "the policy is broken" rather than as "concurrency is not a
 * number".
 *
 * A MISSING KEY IS NOT AN ERROR AND IS NOT ZERO. It means the owner has not
 * had an opinion, so the provider's own default stands — and the defaults
 * below are opinions about the SERVICE rather than about this app:
 *
 *   local        series, 1 at a time. One GPU serving two completions halves
 *                the speed of both and can run the card out of memory; the
 *                model that is already loaded is the fast one. A person with
 *                two boxes switches this to parallel and gets both.
 *   openai       parallel, 6. A hosted API's ceiling is its own — OpenAI's
 *                per-minute limits are far above anything a one-person
 *                dashboard produces — so this number is not about OpenAI, it
 *                is about not letting a runaway loop here spend six ways at
 *                once before anybody notices.
 *   openrouter   parallel, 4, and a longer timeout. OpenRouter is a router:
 *                the request waits on whichever upstream it picked, and the
 *                free-tier models it can pick are the slow ones.
 *   freellmapi   left to the module that registers it. This file only names
 *                the three it can speak for.
 *
 * WHY VALIDATION LIVES HERE AND NOT IN THE ROUTE. The route is one door onto
 * these values; the factories are another, and a policy read out of a
 * hand-edited row has to be as safe as one that came through a PUT. So the
 * reader clamps and the writer refuses, and neither trusts the other to have
 * done it.
 */
import { configValue, getPlugin, setConfig, upsertPlugin } from "../db.ts";
import { DEFAULT_POLICY, type Policy, type ProviderId } from "./provider.ts";

/** The limits, named once. The route quotes them in its refusals and the
 *  reader clamps to them, so the two can never disagree about what is legal. */
export const POLICY_LIMITS = {
  concurrency: { min: 1, max: 64 },
  /** Five seconds is below any real completion; ten minutes is longer than a
   *  local model warming up a 30B on a laptop, which is the slowest thing this
   *  is ever pointed at. Outside that range the number is a typo. */
  timeoutMs: { min: 5_000, max: 600_000 },
} as const;

export const MODES = ["series", "parallel"] as const;
export const BALANCES = ["round-robin", "least-busy"] as const;

/**
 * What each provider does when nobody has configured it.
 *
 * Spelled out per provider rather than shared, because the whole argument of
 * the Policy type is that a local model and a hosted API want opposite
 * things. A single DEFAULT_POLICY for both would make one of them wrong on
 * every fresh install, and the one it would make wrong is the local model —
 * the case where being wrong costs an out-of-memory rather than a queue.
 */
export const PROVIDER_DEFAULTS: Record<ProviderId, Policy> = {
  freellmapi: { mode: "parallel", concurrency: 4, balance: "round-robin", timeoutMs: 120_000 },
  local: DEFAULT_POLICY,
  openai: { mode: "parallel", concurrency: 6, balance: "least-busy", timeoutMs: 120_000 },
  openrouter: { mode: "parallel", concurrency: 4, balance: "least-busy", timeoutMs: 180_000 },
};

/* -------------------------------------------------------------- reading */

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * The policy in force for one provider, right now.
 *
 * Called on every `activeProvider()` — which is every completion — so it is
 * four indexed reads of a table with a few dozen rows and no cache. A cache
 * here would be a switch the owner flips that does not take effect until a
 * restart, which is the exact failure `registerProvider`'s factory contract
 * exists to avoid.
 */
export function readPolicy(id: ProviderId): Policy {
  const base = PROVIDER_DEFAULTS[id];
  const mode = configValue(id, "policy.mode");
  const balance = configValue(id, "policy.balance");
  return {
    mode: MODES.includes(mode as Policy["mode"]) ? (mode as Policy["mode"]) : base.mode,
    concurrency: clampInt(
      configValue(id, "policy.concurrency"),
      base.concurrency,
      POLICY_LIMITS.concurrency.min,
      POLICY_LIMITS.concurrency.max,
    ),
    balance: BALANCES.includes(balance as Policy["balance"])
      ? (balance as Policy["balance"])
      : base.balance,
    timeoutMs: clampInt(
      configValue(id, "policy.timeoutMs"),
      base.timeoutMs,
      POLICY_LIMITS.timeoutMs.min,
      POLICY_LIMITS.timeoutMs.max,
    ),
  };
}

/** Whether this provider's policy is the default or the owner's own — so the
 *  page can say "default" beside a number nobody chose rather than presenting
 *  an opinion of this file's as a decision of theirs. */
export function policyIsDefault(id: ProviderId): boolean {
  return (
    configValue(id, "policy.mode") === null &&
    configValue(id, "policy.concurrency") === null &&
    configValue(id, "policy.balance") === null &&
    configValue(id, "policy.timeoutMs") === null
  );
}

/* -------------------------------------------------------------- writing */

/**
 * Check a policy body, field by field, and say what is wrong with it.
 *
 * A PARTIAL BODY IS LEGAL AND IS THE COMMON CASE: dragging the concurrency
 * slider sends `{ concurrency: 4 }` and must not have to restate the mode, the
 * balance and the timeout — a form that resends everything is a form that
 * overwrites a field somebody changed in another tab a second ago.
 *
 * Every refusal names the value that was sent and the range that would be
 * accepted, because "invalid concurrency" tells the owner nothing they did not
 * already suspect.
 */
export function validatePolicy(
  body: unknown,
): { ok: true; patch: Partial<Policy> } | { ok: false; error: string } {
  if (!body || typeof body !== "object")
    return { ok: false, error: "Expected { mode?, concurrency?, balance?, timeoutMs? }." };

  const raw = body as Record<string, unknown>;
  const known = ["mode", "concurrency", "balance", "timeoutMs"];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length)
    return {
      ok: false,
      error:
        `Unknown policy field(s): ${unknown.join(", ")}. A policy is ` +
        `${known.join(", ")} and nothing else — a field nothing reads would ` +
        `look exactly like one that had been set.`,
    };

  const patch: Partial<Policy> = {};

  if ("mode" in raw) {
    const v = raw.mode;
    if (v !== "series" && v !== "parallel")
      return {
        ok: false,
        error: `“${String(v)}” is not a mode. The two are series (one call at a time) and parallel (up to the concurrency).`,
      };
    patch.mode = v;
  }

  if ("concurrency" in raw) {
    const v = Number(raw.concurrency);
    const { min, max } = POLICY_LIMITS.concurrency;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max)
      return {
        ok: false,
        error:
          `Concurrency is a whole number from ${min} to ${max}; ` +
          `“${String(raw.concurrency)}” is not one. ${max} is not a limit of ` +
          `this box, it is the point past which a number is a typo.`,
      };
    patch.concurrency = v;
  }

  if ("balance" in raw) {
    const v = raw.balance;
    if (v !== "round-robin" && v !== "least-busy")
      return {
        ok: false,
        error:
          `“${String(v)}” is not a balance. The two are round-robin (the next ` +
          `endpoint in order) and least-busy (the one with the fewest calls in ` +
          `flight).`,
      };
    patch.balance = v;
  }

  if ("timeoutMs" in raw) {
    const v = Number(raw.timeoutMs);
    const { min, max } = POLICY_LIMITS.timeoutMs;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max)
      return {
        ok: false,
        error:
          `The timeout is milliseconds, from ${min} (${min / 1000}s) to ${max} ` +
          `(${max / 60_000} minutes); “${String(raw.timeoutMs)}” is not in that ` +
          `range. Below the floor no real completion finishes; above the ceiling ` +
          `a hung endpoint holds a socket for longer than anybody waits.`,
      };
    patch.timeoutMs = v;
  }

  return { ok: true, patch };
}

/**
 * Write a policy patch, and answer with what is now in force.
 *
 * The plugins row is created on demand for the reason `writeChatBackend` does
 * it: `plugin_config` has a foreign key onto `plugins`, and a policy is a
 * perfectly reasonable thing to set on a provider before its first endpoint is
 * pasted.
 */
export function writePolicy(id: ProviderId, patch: Partial<Policy>): Policy {
  if (!getPlugin(id)) upsertPlugin(id, false, null);
  if (patch.mode !== undefined) setConfig(id, "policy.mode", patch.mode);
  if (patch.concurrency !== undefined)
    setConfig(id, "policy.concurrency", String(patch.concurrency));
  if (patch.balance !== undefined) setConfig(id, "policy.balance", patch.balance);
  if (patch.timeoutMs !== undefined)
    setConfig(id, "policy.timeoutMs", String(patch.timeoutMs));
  return readPolicy(id);
}

/** Forget every policy key, so the provider's own default stands again. The
 *  page offers it as "back to the default" rather than making the owner guess
 *  which four numbers this file would have used. */
export function clearPolicy(id: ProviderId): Policy {
  for (const key of ["policy.mode", "policy.concurrency", "policy.balance", "policy.timeoutMs"])
    setConfig(id, key, "");
  return readPolicy(id);
}
