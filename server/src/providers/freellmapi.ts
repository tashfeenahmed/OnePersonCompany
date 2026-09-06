/**
 * FreeLLMAPI — one OpenAI-shaped key in front of about thirty free providers.
 *
 * WHAT IT IS, BECAUSE THE NAME MISLEADS. It is not a hosted service somebody
 * else runs. It is the owner's own open-source gateway, a separate project
 * from this one: a Node server that holds keys for
 * ~34 providers that publish a free tier, aggregates their catalogs into one
 * `/v1/models`, and routes each completion to whichever of them can serve the
 * model right now — failing over when one is rate-limited. Every instance of
 * it is somebody's own; there is no shared endpoint.
 *
 * SO THERE ARE TWO WAYS TO HAVE ONE, AND THIS FILE SERVES BOTH:
 *
 *   HOSTED   an instance already running somewhere else, reached over the
 *            network with the unified key it issued — a box the owner keeps,
 *            on whatever host they keep it.
 *   MANAGED  an instance installed into DATA_DIR/freellmapi/ and run as a
 *            child of this process on 127.0.0.1:3001, by freellmapi/instance.ts.
 *
 * They are the same software and the same wire, so they are ONE PLUGIN WITH
 * TWO ACCOUNTS rather than two plugins: each account is a base URL and the key
 * that endpoint issued, and the owner says which one answers. That is the same
 * shape SearXNG takes over its remote node and its managed one, for the same
 * reason — switching where the words come from must not be a re-paste.
 *
 * WHAT IS *NOT* HERE, AND IT COST AN AFTERNOON TO ESTABLISH. `freellmapi.co`
 * is a static marketing site on Cloudflare Pages: probed 2026-09-05, every
 * path under `/v1` answers 404 as HTML, and a POST to any of them is 405
 * because static hosting has no POST. `api.freellmapi.co` is a different thing
 * again — the CATALOG and LICENCE API (`/v1/latest`, `/v1/license`,
 * `/v1/account`, `/v1/checkout`), which sells the live model catalog and
 * cannot complete a chat turn. Neither is an inference endpoint, and the
 * catalog entry that used to describe this plugin as "the in-house catalog
 * API" was describing that second thing. There is no default base URL that
 * works for a stranger, which is exactly why the base URL is a FIELD.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT WAS MEASURED, against the owner's instance on 2026-09-05:
 *
 *     GET /v1/models          200, 631 ids, `auto` and a system-specific
 *                             alias among them — the router's own aliases
 *     GET /v1/models  no key  401 application/json. The key is real auth,
 *                             not decoration
 *     POST /v1/chat/completions
 *                             200. The body carries `_routed_via`
 *                             {platform, model} — the answer names the
 *                             provider that actually wrote it, which is why
 *                             `readModel` on the reply is worth showing
 *
 * That last one is the reason `defaultModel` may legitimately be null: `auto`
 * is a real id this endpoint serves, so "let the endpoint pick" is a choice
 * the endpoint published rather than a guess made here. The model that
 * answered comes back ON the reply and is shown.
 */
import { getJson, parseEndpoint, readModelIds, WireError } from "../chat/wire.ts";
import {
  registerProvider,
  type Endpoint,
  type ModelProvider,
  type Policy,
} from "../models/provider.ts";
import { readPolicy } from "../models/policy.ts";
import * as accounts from "../accounts.ts";
import { configValue, getPlugin, setConfig, upsertPlugin } from "../db.ts";

export const PLUGIN = "freellmapi";
export const DISPLAY = "FreeLLMAPI";

/** The vault stem. Two fields, so the first account's entries are exactly
 *  `freellmapi-base-url` and `freellmapi-key` — the second being the name
 *  the previous system's own vault uses, which makes moving the credential a copy. */
export const SECRET_STEM = "freellmapi";
export const FIELDS = ["base-url", "key"] as const;

/**
 * Where the owner's existing instance answers.
 *
 * A PLACEHOLDER THE FORM OFFERS, never something written on the owner's
 * behalf and never a URL this file will call. It shows the SHAPE a hosted
 * instance's base takes — scheme, host, `/v1` — because the commonest way to
 * get this wrong is to paste the marketing site or to leave the version
 * segment off. A real address here would be one person's box shipped to
 * everybody, and an example host cannot be reached by accident.
 */
export const DEFAULT_BASE = "https://llm.example.com/v1";

/** The managed instance. 3001 is the repo's own default (`PORT` in its
 *  `.env.example`), and loopback is the bind this process gives it. */
export const LOCAL_PORT = 3001;
export const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}/v1`;
/** The label the installer gives the account it connects. Named once, here,
 *  because instance.ts creates the row and this file has to recognise it. */
export const LOCAL_LABEL = "Local instance";

/* ------------------------------------------------------------------ policy */

/**
 * PARALLEL, FOUR AT A TIME, and the number is a measurement rather than a
 * mood. The value itself lives in `PROVIDER_DEFAULTS` in models/policy.ts,
 * beside the other three providers' so they can be read against each other;
 * the REASON lives here, beside the endpoint it is a fact about.
 *
 * WHY NOT SERIES. Series is right for a single local model because two calls
 * at once halve the speed of both and can run one card out of memory — the
 * contention is OURS. Nothing here is contended by our own concurrency: every
 * completion is executed on somebody else's machine, and the gateway is a
 * router with a failover loop, not a GPU. Serialising would mean the chat
 * page waits behind a Telegram turn for no reason at all.
 *
 * WHY NOT UNBOUNDED. The scarce thing is upstream free-tier allowance, which
 * is counted per minute and spent by failover retries as well as by answers.
 * The gateway also rate-limits its own proxy surface — `PROXY_RATE_LIMIT_RPM`
 * defaults to 120 per client IP in the repo's `.env.example`, which is two a
 * second sustained. Four in flight at the five-to-thirty seconds a free
 * provider actually takes is comfortably inside that; forty would spend a
 * provider's minute on one burst and then fail over into the next provider's.
 *
 * WHY THE SAME NUMBER FOR BOTH MODES. Hosted and managed are the same program
 * routing to the same kind of upstream. The bottleneck is the free tier at the
 * far end, and that does not care which of the two machines asked.
 *
 * WHY ROUND-ROBIN RATHER THAN LEAST-BUSY, unlike the other two hosted
 * providers: this provider has exactly one endpoint at a time (see
 * `endpoints()`), so the two are the same behaviour and the cheaper one is
 * the honest thing to declare.
 *
 * The timeout is two minutes rather than the wire's sixty seconds: this
 * gateway's own failover budget is 45 seconds and its per-provider ceilings
 * run to 180, so a turn that fails over twice is legitimately slow and cutting
 * it at sixty would report a timeout for a request that was about to answer.
 *
 * All four numbers are overridable per provider from the models page —
 * `readPolicy` is consulted on every completion, so a change takes effect on
 * the next call rather than at the next restart.
 */
export function policy(): Policy {
  return readPolicy(PLUGIN);
}

/* ------------------------------------------------------------------- urls */

/** The base URL as this will actually call it, or null when it is not one.
 *  `parseEndpoint` also strips a pasted `/models` or `/chat/completions`,
 *  because a person copying an endpoint out of a README copies the endpoint. */
export function normalise(raw: string): string | null {
  const parsed = parseEndpoint(raw, DISPLAY);
  return parsed.ok ? parsed.base : null;
}

/** Is this base URL the managed instance's? Compared by ORIGIN AND PORT rather
 *  than by string, so `http://localhost:3001/v1` and the canonical spelling
 *  are the same endpoint — which they are, and a stored value that differs by
 *  a hostname must not make the panel claim two instances exist. */
export function isLocal(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
    return loopback && url.port === String(LOCAL_PORT);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ verify */

export type VerifyResult =
  | { ok: true; models: number; sample: string[] }
  | { ok: false; error: string };

/**
 * Is this endpoint a FreeLLMAPI, and does it accept this key?
 *
 * ONE CALL, AND IT IS THE ONE THAT MATTERS. `/v1/models` is the cheapest
 * request this gateway serves and it is authenticated — measured above, a
 * missing key is 401 there — so a single round trip proves the address, the
 * key and that the router has a catalog to route into. A health endpoint that
 * answered without the key would prove only that something is listening.
 *
 * AN EMPTY CATALOG IS A REFUSAL. A gateway with no provider keys configured
 * answers 200 with `data: []`, and storing that would connect a provider that
 * cannot complete anything — the shape of failure this codebase keeps
 * refusing, because it looks like an answer. The sentence says what to do.
 */
export async function verify(input: {
  baseUrl: string;
  key: string;
}): Promise<VerifyResult> {
  const base = normalise(input.baseUrl);
  if (!base)
    return {
      ok: false,
      error:
        `“${input.baseUrl.slice(0, 60)}” is not a URL this can call — it needs a ` +
        `scheme and a host, like ${LOCAL_URL} or ${DEFAULT_BASE}.`,
    };

  try {
    const doc = await getJson<unknown>(
      `${base}/models`,
      { Authorization: `Bearer ${input.key}` },
      DISPLAY,
    );
    const ids = readModelIds(doc);
    if (!ids.length)
      return {
        ok: false,
        error:
          `${base} answered, and its catalog is EMPTY. That is a FreeLLMAPI with ` +
          `no provider keys in it yet: open its dashboard, add a key for at least ` +
          `one free provider, and connect this again.`,
      };
    return { ok: true, models: ids.length, sample: ids.slice(0, 8) };
  } catch (err) {
    if (err instanceof WireError && err.status === 401)
      return {
        ok: false,
        error:
          `${base} refused that key. The unified key is on the gateway's own ` +
          `dashboard under Keys, and begins \`freellmapi-\`.`,
      };
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Could not reach ${base}.`,
    };
  }
}

/* --------------------------------------------------------------- accounts */

export type Chosen = {
  accountId: number;
  label: string;
  baseUrl: string;
  key: string;
  local: boolean;
};

/**
 * Whether the managed instance is actually answering right now.
 *
 * A FUNCTION HANDED IN RATHER THAN AN IMPORT, because the alternative is a
 * cycle: freellmapi/instance.ts needs this file's URLs, its plugin id and its
 * account label, so this file cannot import it back. instance.ts calls the
 * setter at boot; until it does, "is the local one up" answers false, which is
 * the honest answer for a process that has not started one.
 *
 * It is deliberately the LIVE health rather than the stored `instance` flag.
 * That flag is what the owner last asked for and survives a restart; this
 * question is "would a completion sent there be answered", and a crashed child
 * still has `running` written down.
 */
let localHealthy: () => boolean = () => false;
export function setLocalHealth(fn: () => boolean) {
  localHealthy = fn;
}

/** The config key holding the owner's choice of account, or "" for automatic.
 *  Written by routes/freellmapi.ts, read here on every call. */
const ACCOUNT_KEY = "account";

/**
 * Which account answers, with its credentials.
 *
 * THE DEFAULT IS THE LOCAL ONE WHEN IT IS RUNNING, and that is a deliberate
 * ordering rather than a coin toss: a completion that can be served on this
 * machine costs nobody's free-tier allowance and cannot be taken away by a box
 * being rebooted. When the local instance is not up, the hosted account
 * answers — which is the whole point of having both, and is what makes
 * stopping the child a safe thing to do mid-conversation.
 *
 * AN EXPLICIT CHOICE OVERRULES THAT and is never quietly ignored — but it is
 * also never allowed to point at an account that no longer exists or has been
 * disconnected, because an id left behind by a deleted account would otherwise
 * mean "no provider" with nothing on the page able to say why.
 */
export function chosen(reader = "freellmapi_provider"): Chosen | null {
  return pick(accounts.credentialed(PLUGIN, ["base-url", "key"], reader).ready);
}

/**
 * The selection rule itself, over rows already read.
 *
 * SEPARATE FROM `chosen()` FOR ONE REASON: `report()` needs both the rule's
 * answer and the rows it chose between, and calling `chosen()` beside its own
 * read would decrypt every account twice and write two `secret_access` rows
 * per page load. That table is the answer to "what touched the key last
 * night", and doubling every entry for the sake of a convenience would make it
 * a worse answer.
 */
function pick(ready: accounts.Credentialed[]): Chosen | null {
  if (!ready.length) return null;

  const shape = (r: accounts.Credentialed): Chosen | null => {
    const baseUrl = normalise((r.values["base-url"] ?? "").trim());
    const key = (r.values.key ?? "").trim();
    if (!baseUrl || !key) return null;
    return {
      accountId: r.account.id,
      label: r.account.label,
      baseUrl,
      key,
      local: isLocal(baseUrl),
    };
  };

  const wanted = Number(configValue(PLUGIN, ACCOUNT_KEY) ?? "");
  if (Number.isInteger(wanted) && wanted > 0) {
    const picked = ready.find((r) => r.account.id === wanted);
    if (picked) return shape(picked);
    /* Falls through to automatic. The row it named is gone or disconnected,
       and refusing outright would turn a deleted account into a silent
       "no provider is connected" on a page with a working one on it. */
  }

  const usable = ready.map(shape).filter((c): c is Chosen => c !== null);
  if (!usable.length) return null;
  if (localHealthy()) {
    const local = usable.find((c) => c.local);
    if (local) return local;
  }
  return usable.find((c) => !c.local) ?? usable[0]!;
}

/** Store the owner's choice. `null` clears it back to automatic. The plugins
 *  row is created on demand because the foreign key says it has to exist
 *  before a setting can point at it. */
export function setChosenAccount(id: number | null) {
  if (!getPlugin(PLUGIN)) upsertPlugin(PLUGIN, false, null);
  setConfig(PLUGIN, ACCOUNT_KEY, id === null ? "" : String(id));
}

/** The choice as stored, whether or not it still names a live account. The
 *  page shows this beside the account actually in use, so "I chose the hosted
 *  one and the local one is answering" is a visible fact rather than a
 *  mystery. */
export function chosenAccountId(): number | null {
  const value = Number(configValue(PLUGIN, ACCOUNT_KEY) ?? "");
  return Number.isInteger(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------- account bookkeeping */

/**
 * What happened on the last completion, recorded against the account that took
 * it.
 *
 * PER ACCOUNT, BECAUSE THAT IS THE UNIT THAT CAN BE BROKEN. The hosted
 * instance going down must show as a red line on the hosted row and leave the
 * local one green, exactly as one dead Hetzner token loses one project. The
 * caller is routes/models.ts's `noteOutcome`, which is the one place that sees
 * both the outcome and the provider it came from.
 *
 * IT LOOKS THE ACCOUNT UP AGAIN RATHER THAN TRUSTING THE ENDPOINT LABEL. An
 * account can be renamed between a call being sent and its answer arriving,
 * and attributing a failure by label would then stamp it on nothing — or, if
 * the name has been reused, on the wrong endpoint. A red line on the wrong
 * machine is worse than no red line: it sends the owner to restart something
 * that was working.
 */
export function noteOk() {
  const c = chosen("freellmapi_outcome");
  if (c) accounts.markOk(c.accountId);
}

export function noteFailure(error: string) {
  const c = chosen("freellmapi_outcome");
  if (c) accounts.markFailed(c.accountId, error.slice(0, 300));
}

/* ------------------------------------------------------------- the factory */

/**
 * The model the endpoint is asked for.
 *
 * EMPTY IS A REAL VALUE and means "whatever this endpoint lists first", which
 * models/provider.ts discovers from `/models` and remembers per endpoint. That
 * is the right default here rather than a hard-coded id, for the reason Hermes
 * gives: one gateway can front very different pools and nothing on this box
 * can know which model the owner wants. It is also not a fiction — `auto` is
 * an id this gateway genuinely publishes and lists first, so "let it pick" is
 * the router's own alias rather than a guess made here.
 */
export function model(): string | null {
  const value = (configValue(PLUGIN, "model") ?? "").trim();
  return value || null;
}

/** The endpoint list, which is deliberately ONE entry.
 *
 *  Balancing across the hosted and the managed instance was the obvious
 *  alternative and is wrong: they hold different provider keys, so the two
 *  have different catalogs and different remaining allowance, and a
 *  round-robin would make "which model answered" depend on the parity of the
 *  request count. One is chosen, it is named on the page, and the other is a
 *  click away. */
export function endpoints(): Endpoint[] {
  const c = chosen();
  if (!c) return [];
  return [{ baseUrl: c.baseUrl, key: c.key, label: c.label }];
}

registerProvider(PLUGIN, (): ModelProvider | null => {
  const list = endpoints();
  if (!list.length) return null;
  return {
    id: PLUGIN,
    label: DISPLAY,
    endpoints: list,
    defaultModel: model(),
    policy: policy(),
  };
});

/* ------------------------------------------------------------------ report */

/** What `/api/freellmapi` says about one account. Never a value: `base-url`
 *  is echoed because it is an address the owner typed and not a secret, and
 *  the key is represented by nothing at all. */
export type AccountReport = {
  id: number;
  label: string;
  connected: boolean;
  baseUrl: string | null;
  local: boolean;
  inUse: boolean;
  lastOkAt: string | null;
  lastError: string | null;
};

export function report(): { accounts: AccountReport[]; inUse: Chosen | null } {
  const { ready, broken } = accounts.credentialed(
    PLUGIN,
    ["base-url", "key"],
    "freellmapi_report",
  );
  /* One read, two answers — see `pick`. */
  const inUse = pick(ready);
  const rows: AccountReport[] = [];

  for (const { account, values } of ready) {
    const baseUrl = normalise((values["base-url"] ?? "").trim());
    rows.push({
      id: account.id,
      label: account.label,
      connected: account.connected,
      baseUrl,
      local: baseUrl ? isLocal(baseUrl) : false,
      inUse: inUse?.accountId === account.id,
      lastOkAt: account.lastOkAt,
      lastError: account.lastError,
    });
  }
  for (const { account, missing } of broken)
    rows.push({
      id: account.id,
      label: account.label,
      connected: account.connected,
      baseUrl: null,
      local: false,
      inUse: false,
      lastOkAt: account.lastOkAt,
      lastError: `Incomplete: no ${missing.join(", ")} stored.`,
    });

  rows.sort((a, b) => a.id - b.id);
  return { accounts: rows, inUse };
}

/** The catalog the endpoint in use publishes. A live read rather than a stored
 *  list, because a gateway's catalog changes when a provider key is added to
 *  it and a remembered one would be a picker full of models nobody can call. */
export async function models(): Promise<
  { ok: true; ids: string[] } | { ok: false; error: string }
> {
  const c = chosen("freellmapi_models");
  if (!c) return { ok: false, error: "No FreeLLMAPI account is connected." };
  try {
    const doc = await getJson<unknown>(
      `${c.baseUrl}/models`,
      { Authorization: `Bearer ${c.key}` },
      DISPLAY,
    );
    return { ok: true, ids: readModelIds(doc) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unreadable." };
  }
}
