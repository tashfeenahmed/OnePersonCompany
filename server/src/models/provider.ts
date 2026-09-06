import { randomUUID } from "node:crypto";
import { budgets, budgeted, runContext } from "../runtime/budgets.ts";
/**
 * MODEL PROVIDERS — where the completions actually come from, and how many at
 * once.
 *
 * Two layers, and the distinction is the whole design:
 *
 *   AGENTS     (chat/backend.ts)  Hermes, OpenClaw. They think: tools, memory,
 *                                 multi-step work. Exactly one is live for chat.
 *   PROVIDERS  (this file)        FreeLLMAPI, a local model, OpenAI, OpenRouter.
 *                                 They complete: turns in, text out, over an
 *                                 OpenAI-shaped wire. Exactly one is the
 *                                 DEFAULT the agents are pointed at.
 *
 * An agent is spawned here and configured to talk to the active provider, so
 * "which model" is decided once, in one place, and every agent inherits it. A
 * provider can also be asked directly — `complete()` below — which is what a
 * plain chat with no agent in front of it uses, and what the agents' spawners
 * use to prove a provider answers before pointing anything at it.
 *
 * THE POLICY LIVES WITH THE PROVIDER, NOT THE CALLER. A local model on one GPU
 * wants calls in SERIES — two at once halves the speed of both and can run the
 * card out of memory; a hosted API wants them in PARALLEL up to some ceiling;
 * two local endpoints want the calls SPREAD across them. Those are facts about
 * the provider, so they are settings on it, and every caller gets the right
 * behaviour without knowing why. The limiter enforces them in-process; it is
 * not a promise the callers keep.
 *
 * NULL MEANS "NO PROVIDER". `activeProvider()` returns null when nothing is
 * connected or chosen. Callers say so in words; a completion that returns ""
 * is indistinguishable from a model that had nothing to say.
 */
import {
  chatCompletion,
  getJson,
  readModel,
  readModelIds,
  readText,
  readUsage,
  type WireTurn,
} from "../chat/wire.ts";

export type ProviderId = "freellmapi" | "local" | "openai" | "openrouter";

/** One endpoint a provider can send to. A provider with several (two local
 *  boxes, say) balances across them; most have exactly one. */
export type Endpoint = {
  /** Where `/chat/completions` and `/models` live — a full base URL ending in
   *  `/v1` or the provider's equivalent. */
  baseUrl: string;
  /** Bearer for this endpoint, or null for a loopback service that needs none. */
  key: string | null;
  /** A name for the endpoint in logs and on the page: "GPU box", "laptop". */
  label: string;
};

/**
 * How many completions a provider will run at once, and how they are spread.
 *
 *   series      one at a time, in arrival order — the right default for a
 *               single local model, and the safe default for anything unknown.
 *   parallel    up to `concurrency` at once. A hosted API's ceiling, not ours.
 *   balance     which endpoint the NEXT call goes to when there are several:
 *               round-robin, or the first one that is not at its limit.
 */
export type Policy = {
  mode: "series" | "parallel";
  /** Ignored in series mode. Clamped to [1, 64]. */
  concurrency: number;
  balance: "round-robin" | "least-busy";
  /** Per-call timeout. A local model warming up can take a while. */
  timeoutMs: number;
};

export const DEFAULT_POLICY: Policy = {
  mode: "series",
  concurrency: 1,
  balance: "round-robin",
  timeoutMs: 120_000,
};

export type ProviderReply = {
  text: string;
  provider: ProviderId;
  endpoint: string;
  model: string | null;
  usage: { prompt: number; completion: number } | null;
  ms: number;
  /** How long the call waited for a slot before it was sent. Visible, because
   *  "the model is slow" and "the queue is long" want different fixes. */
  queuedMs: number;
};

export type CompleteOptions = {
  /** Override the provider's default model for this call. */
  model?: string;
  signal?: AbortSignal;
};

export interface ModelProvider {
  id: ProviderId;
  label: string;
  endpoints: Endpoint[];
  /** The model sent when the caller names none. Null means "let the endpoint
   *  pick" — some (FreeLLMAPI, a local router) route on their own. */
  defaultModel: string | null;
  policy: Policy;
}

/* ---------------------------------------------------------------- registry */

/**
 * A provider registers a FACTORY, called on every `activeProvider()`, so a
 * rotated key, a changed URL or a switched policy is picked up without a
 * restart. The factory returns null when its plugin is not connected.
 */
const factories = new Map<ProviderId, () => ModelProvider | null>();

export function registerProvider(id: ProviderId, make: () => ModelProvider | null) {
  factories.set(id, make);
}

/** Which provider is the default. Set by the routes module that owns the
 *  config key, the same way chat/backend.ts is handed its choice reader. */
let readChoice: () => ProviderId | null = () => null;
export function setProviderChoiceReader(fn: () => ProviderId | null) {
  readChoice = fn;
}

export function activeProvider(): ModelProvider | null {
  const id = readChoice();
  if (!id) return null;
  return factories.get(id)?.() ?? null;
}

export function providers(): { id: ProviderId; connected: boolean; label: string | null; endpoints: number; policy: Policy | null }[] {
  const ids: ProviderId[] = ["freellmapi", "local", "openai", "openrouter"];
  return ids.map((id) => {
    const p = factories.get(id)?.() ?? null;
    return {
      id,
      connected: p !== null,
      label: p?.label ?? null,
      endpoints: p?.endpoints.length ?? 0,
      policy: p?.policy ?? null,
    };
  });
}

/* ----------------------------------------------------------------- limiter */

/**
 * The in-process gate, one per provider id.
 *
 * It holds a queue of waiters and a count of calls in flight per endpoint.
 * `series` is `parallel` with a ceiling of one; `least-busy` picks the endpoint
 * with the fewest in flight, `round-robin` the next in order. The gate is keyed
 * by provider id rather than by instance because factories return a fresh
 * object every call and the counts must survive that.
 */
type Gate = {
  inFlight: Map<string, number>;
  queue: (() => void)[];
  rr: number;
};
const gates = new Map<ProviderId, Gate>();

function gateFor(id: ProviderId): Gate {
  let g = gates.get(id);
  if (!g) {
    g = { inFlight: new Map(), queue: [], rr: 0 };
    gates.set(id, g);
  }
  return g;
}

function ceiling(policy: Policy): number {
  if (policy.mode === "series") return 1;
  return Math.max(1, Math.min(64, Math.floor(policy.concurrency) || 1));
}

function totalInFlight(g: Gate): number {
  let n = 0;
  for (const v of g.inFlight.values()) n += v;
  return n;
}

/** Wait for a slot, then choose an endpoint. Returns the release function. */
async function acquire(p: ModelProvider): Promise<{ endpoint: Endpoint; release: () => void; queuedMs: number }> {
  const g = gateFor(p.id);
  const started = Date.now();
  // The ceiling is the whole provider's, across all its endpoints — a "series"
  // provider with two endpoints still runs one call at a time. Spreading is a
  // separate question from how many.
  while (totalInFlight(g) >= ceiling(p.policy)) {
    await new Promise<void>((resolve) => g.queue.push(resolve));
  }

  let endpoint: Endpoint;
  if (p.policy.balance === "least-busy") {
    endpoint = [...p.endpoints].sort(
      (a, b) => (g.inFlight.get(a.baseUrl) ?? 0) - (g.inFlight.get(b.baseUrl) ?? 0),
    )[0]!;
  } else {
    endpoint = p.endpoints[g.rr % p.endpoints.length]!;
    g.rr = (g.rr + 1) % Math.max(1, p.endpoints.length);
  }
  g.inFlight.set(endpoint.baseUrl, (g.inFlight.get(endpoint.baseUrl) ?? 0) + 1);

  const release = () => {
    g.inFlight.set(endpoint.baseUrl, Math.max(0, (g.inFlight.get(endpoint.baseUrl) ?? 1) - 1));
    // Wake exactly one waiter; it re-checks the ceiling itself.
    g.queue.shift()?.();
  };
  return { endpoint, release, queuedMs: Date.now() - started };
}

/** What the gate is doing right now — for the settings page. */
export function gateState(id: ProviderId): { inFlight: number; queued: number; byEndpoint: Record<string, number> } {
  const g = gateFor(id);
  return {
    inFlight: totalInFlight(g),
    queued: g.queue.length,
    byEndpoint: Object.fromEntries(g.inFlight),
  };
}

/* ---------------------------------------------------------------- complete */

export class NoProviderError extends Error {
  constructor() {
    super(
      "No model provider is connected. Connect FreeLLMAPI, a local model, OpenAI or OpenRouter under Integrations and choose one as the default.",
    );
    this.name = "NoProviderError";
  }
}

/**
 * One completion through the active provider, under its policy.
 *
 * This is the only path a completion takes, so the limiter cannot be bypassed
 * by a caller that forgot about it. The wire call itself is `chatCompletion` in
 * chat/wire.ts — the same parser the agents use — so a provider and an agent
 * reading the same endpoint agree about what it said.
 */
/**
 * Which model name goes on the wire.
 *
 * The caller's override, then the provider's default, then — for a provider
 * that names none, which FreeLLMAPI and a local router both legitimately do —
 * the first id the endpoint's own `/models` lists, asked once per endpoint and
 * remembered. An OpenAI-shaped server refuses a request with no `model`, so
 * "let the endpoint pick" still has to send SOMETHING, and the honest something
 * is the first thing it said it serves.
 */
const discovered = new Map<string, string>();

async function modelFor(p: ModelProvider, e: Endpoint, override?: string): Promise<string> {
  if (override) return override;
  if (p.defaultModel) return p.defaultModel;
  const cached = discovered.get(e.baseUrl);
  if (cached) return cached;
  const doc = await getJson<unknown>(
    `${e.baseUrl}/models`,
    e.key ? { Authorization: `Bearer ${e.key}` } : {},
    p.label,
  );
  const first = readModelIds(doc)[0];
  if (!first) throw new Error(`${p.label} at ${e.label} lists no models, and none was chosen.`);
  discovered.set(e.baseUrl, first);
  return first;
}

/** Forget a discovered model for an endpoint — call after its URL or key changes. */
export function forgetDiscovered(baseUrl: string) {
  discovered.delete(baseUrl);
}

/**
 * One completion through the active provider, under its policy.
 *
 * This is the only path a completion takes, so the limiter cannot be bypassed
 * by a caller that forgot about it. The wire call itself is `chatCompletion` in
 * chat/wire.ts — the same parser the agents use — so a provider and an agent
 * reading the same endpoint agree about what it said.
 */
export async function complete(turns: WireTurn[], opts: CompleteOptions = {}): Promise<ProviderReply> {
  const work = () => budgeted({ turns, model: opts.model, provider: activeProvider()?.id }, maxOutputTokens => completeUnmetered(turns, opts, maxOutputTokens));
  if (runContext.getStore()) return work();
  return runContext.run({ id: `direct:${randomUUID()}`, venture: null, automation: true, signal: opts.signal ?? AbortSignal.timeout(budgets().runSeconds * 1000), sequence: 0, resume: false }, work);
}
async function completeUnmetered(turns: WireTurn[], opts: CompleteOptions, maxOutputTokens?: number): Promise<ProviderReply> {
  const p = activeProvider();
  if (!p) throw new NoProviderError();
  if (!p.endpoints.length) throw new Error(`${p.label} has no endpoint configured.`);

  const { endpoint, release, queuedMs } = await acquire(p);
  const started = Date.now();
  try {
    (opts.signal ?? runContext.getStore()?.signal)?.throwIfAborted();
    const model = await modelFor(p, endpoint, opts.model);
    const doc = await chatCompletion({
      base: endpoint.baseUrl,
      key: endpoint.key,
      model,
      turns,
      service: `${p.label} (${endpoint.label})`,
      timeoutMs: p.policy.timeoutMs,
      signal: opts.signal ?? runContext.getStore()?.signal,
      body: maxOutputTokens ? { max_tokens: maxOutputTokens } : undefined,
    });
    const text = readText(doc);
    if (text === null) throw new Error(`${p.label} answered with no text.`);
    return {
      text,
      provider: p.id,
      endpoint: endpoint.label,
      model: readModel(doc) ?? model,
      usage: readUsage(doc),
      ms: Date.now() - started,
      queuedMs,
    };
  } finally {
    release();
  }
}
