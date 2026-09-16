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
  /** For short structured writers: request JSON and suppress optional thinking
   * on compatible routers, without changing the workspace's chat settings. */
  jsonObject?: boolean;
  /**
   * MORE OUTPUT ROOM THAN THE WORKSPACE DEFAULT, for this one call.
   *
   * A structured writer is not a chat turn. Asked for a scene list, a reasoning
   * model can spend the workspace's whole `maxOutputTokens` thinking and emit no
   * JSON at all — which is what happened on run r-c4k493, and what 179 of 486
   * stored checkpoints stopping at exactly 4096 completion tokens look like.
   *
   * ONLY UPWARDS, AND ONLY SO FAR. `runtime/budgets.ts` raises a smaller request
   * back to the workspace default and clamps a larger one to
   * `OUTPUT_TOKENS_CEILING`, and reserves what is actually asked for — so the
   * daily and venture budgets see the real number before the call is made.
   */
  maxOutputTokens?: number;
  /**
   * WHAT THE IMAGES IN THIS CALL ARE WORTH, IN TOKENS.
   *
   * `runtime/budgets.ts` reserves a call at the UTF-8 byte length of its turns,
   * which is a sound estimate for text and a nonsense one for a picture: a
   * 300 KB screenshot base64s to 400 KB and would reserve four hundred thousand
   * tokens and the dollars to match, so an owner with a daily budget would have
   * every vision call refused for a cost nobody incurred.
   *
   * A caller sending images therefore declares what they are worth, and this
   * file swaps each data URI for a placeholder of that many bytes BEFORE the
   * budget sees the turns. The wire still gets the real image; only the
   * estimate is corrected, and a provider that reports real usage overwrites
   * the estimate anyway. Absent, nothing changes.
   */
  imageTokens?: number;
};

/**
 * A TURN THAT CAN CARRY A PICTURE.
 *
 * WHY THIS EXISTS AT ALL. `WireTurn` is `{ role, content: string }` and that
 * was the whole of what this file could send, which is why
 * `integrations/security/shotsqa.ts` spent a paragraph of its header saying
 * that nothing on this box could ask a model to look at a screenshot. This is
 * the smallest thing that changes that: the OpenAI content-parts shape, which
 * every endpoint this file talks to either understands or refuses with a 400.
 *
 * IT IS A WIDENING AND NOT A CAPABILITY CLAIM. Nothing here knows whether the
 * model behind the active provider can see; declaring a `vision: true` flag on
 * `ModelProvider` would be this file asserting something it cannot check,
 * since FreeLLMAPI and a local router both legitimately answer `defaultModel:
 * null` and route per request. So the capability is PROBED by the caller that
 * wants it — see `integrations/seoops/vision.ts` — and this file only makes
 * the probe expressible.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type VisionTurn = { role: "user" | "assistant" | "system"; content: string | ContentPart[] };

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
 * THE TURNS AS THE BUDGET SHOULD SEE THEM.
 *
 * Identity when there is no image or no declared cost, so nothing about a text
 * completion changes. With images, each data URI is replaced by a placeholder
 * whose byte length is the declared token cost divided across them — because
 * `reserve()` measures bytes, and a placeholder of N bytes reserves N tokens.
 * That is a blunt instrument and it is the one the budget actually uses; the
 * alternative is a second estimator inside budgets.ts that every caller would
 * have to keep in step.
 *
 * It also changes the resume checkpoint key, which is fine: the key only has to
 * be deterministic for the same request, and this is.
 */
function budgetShape(turns: VisionTurn[], imageTokens?: number): unknown {
  if (imageTokens === undefined) return turns;
  const images = turns.reduce(
    (n, t) => n + (typeof t.content === "string" ? 0 : t.content.filter((p) => p.type === "image_url").length),
    0,
  );
  if (!images) return turns;
  const per = Math.max(1, Math.round(imageTokens / images));
  return turns.map((t) =>
    typeof t.content === "string"
      ? t
      : {
          role: t.role,
          content: t.content.map((part) =>
            part.type === "image_url" ? { type: "image_url", estimate: "x".repeat(per) } : part,
          ),
        },
  );
}

/**
 * One completion through the active provider, under its policy.
 *
 * This is the only path a completion takes, so the limiter cannot be bypassed
 * by a caller that forgot about it. The wire call itself is `chatCompletion` in
 * chat/wire.ts — the same parser the agents use — so a provider and an agent
 * reading the same endpoint agree about what it said.
 */
export async function complete(turns: VisionTurn[], opts: CompleteOptions = {}): Promise<ProviderReply> {
  const work = () =>
    /* The allowance is part of the request, so it is part of the budget shape
       the checkpoint key is hashed from: a resumed run must not replay the
       truncated reply a smaller allowance produced. */
    budgeted({ turns: budgetShape(turns, opts.imageTokens), model: opts.model, provider: activeProvider()?.id, ...(opts.jsonObject ? { jsonObject: true } : {}), ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}) }, maxOutputTokens =>
      completeUnmetered(turns, opts, maxOutputTokens),
    false, opts.maxOutputTokens);
  if (runContext.getStore()) return work();
  return runContext.run({ id: `direct:${randomUUID()}`, venture: null, automation: true, signal: opts.signal ?? AbortSignal.timeout(budgets().runSeconds * 1000), sequence: 0, resume: false }, work);
}
async function completeUnmetered(turns: VisionTurn[], opts: CompleteOptions, maxOutputTokens?: number): Promise<ProviderReply> {
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
      /* The one cast in this file. `chatCompletion` types its messages as
         `WireTurn[]` and serialises them straight onto the wire; a content
         ARRAY is what the OpenAI image shape is, and widening wire.ts's own
         type would touch every caller that reads `turn.content` as a string
         for no gain. Contained here, beside the reason. */
      turns: turns as unknown as WireTurn[],
      service: `${p.label} (${endpoint.label})`,
      timeoutMs: p.policy.timeoutMs,
      signal: opts.signal ?? runContext.getStore()?.signal,
      body: {
        ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        ...(opts.jsonObject ? { response_format: { type: "json_object" } } : {}),
        /* `"none"` AND NOT `"minimal"`, checked against the router's own source
           rather than guessed. FreeLLMAPI accepts the whole OpenAI scale —
           `REASONING_EFFORTS = ['none','minimal','low','medium','high']` in its
           lib/sampling-params.ts — and `normalizeReasoningEffort` never throws:
           a value it does not know is DROPPED, not turned into a 400 (its #619).
           Per upstream, the same file then either strips the knob (mistral,
           cohere, cloudflare, aihorde), clamps it to the nearest value that
           upstream takes (github and radeon both land on `low`, and sail's
           adapter lifts none/minimal to `low` for gpt-oss), or — for Gemini —
           maps it through `toGeminiExtendedConfig`, where 'none' and 'minimal'
           BOTH become `thinkingBudget: 0`. So "minimal" buys no extra safety
           anywhere and costs thinking tokens on every upstream that honours the
           full scale, which is exactly the ones this flag exists for. The
           2026-08-31 incident where `none` was rejected and `minimal` worked was
           OpenRouter's own API, not this router — and OpenRouter is handled on
           its own line below. */
        ...(opts.jsonObject && p.id === "freellmapi" ? { reasoning_effort: "none" } : {}),
        ...(opts.jsonObject && p.id === "openrouter" ? { reasoning: { enabled: false } } : {}),
        ...(opts.jsonObject && p.id === "local" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      },
    });
    const text = readText(doc);
    if (text === null && !opts.jsonObject) throw new Error(`${p.label} answered with no text.`);
    return {
      text: text ?? "",
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

/* ------------------------------------------------------- completion with tools */

/**
 * A TURN THAT MAY CARRY TOOL CALLS, on the same wire and through the same gate.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON `complete()`. The two return
 * genuinely different things. `complete()` promises TEXT and throws when a
 * server answers with none, which is right for a plain chat turn: an empty
 * bubble is indistinguishable from a bug. A tool round legitimately has no
 * text at all — the model's whole answer that round is "call this" — so the
 * same rule here would turn every successful tool call into a failure. A
 * `tools?: []` parameter that changed whether the function throws is a
 * function every caller would have to narrow before using.
 *
 * WHAT IS SHARED IS EVERYTHING THAT MATTERS: the same limiter, so a tool loop
 * cannot put two completions on one GPU at once; the same model resolution, so
 * "let the endpoint pick" means the same thing; the same budget reservation,
 * so every round of a loop lands in `budget_usage` against the run that made
 * it and the configured ceilings bound the loop without the loop knowing they
 * exist.
 *
 * THE TURNS ARE WIDER THAN `WireTurn` because a tool conversation is not three
 * roles of plain strings: an assistant turn carries `tool_calls`, and a result
 * is a `tool` role with a `tool_call_id`. Those shapes belong to the DIALECT
 * (integrations/runtime/tools.ts builds them) rather than to the wire, so this
 * takes them as opaque objects and passes them through. The cast at the
 * `chatCompletion` call is the one place that widening is admitted: the
 * function's own parameter is `WireTurn[]` because every other caller sends
 * exactly that, and widening it there would mean every caller of the wire
 * having an opinion about tool calls.
 *
 * THE RAW MESSAGE COMES BACK UNREAD. `chat/wire.ts`'s `readText` falls back to
 * the model's reasoning when the content is empty, which is right for a final
 * answer and wrong for a tool round — it would put the scratchpad in the
 * transcript between calls. So the message travels whole and the caller's
 * parser decides.
 */
export type ToolWireTurn = WireTurn | Record<string, unknown>;

export type ToolCompleteOptions = CompleteOptions & {
  /** Already in the provider's dialect. Absent or empty sends no `tools` field
   *  at all, which is how the final "answer with what you have" round asks a
   *  question without inviting another call. */
  tools?: unknown[];
  toolChoice?: "auto" | "none";
};

export type ToolProviderReply = {
  /** The assistant message exactly as the server sent it. */
  message: unknown;
  /** The same message through `chat/wire.ts`'s `readText` — content first,
   *  the model's working as a FALLBACK when there is none. That fallback is
   *  right for a FINAL answer and wrong for a tool round, so a caller in a
   *  loop reads `message` with its own parser and uses this only on the round
   *  that answers. Empty string rather than null: a round with no prose has an
   *  empty answer, not a missing one. */
  text: string;
  finishReason: string | null;
  provider: ProviderId;
  endpoint: string;
  model: string | null;
  usage: { prompt: number; completion: number } | null;
  ms: number;
  queuedMs: number;
};

export async function completeTooled(
  turns: ToolWireTurn[],
  opts: ToolCompleteOptions = {},
): Promise<ToolProviderReply> {
  const work = () =>
    budgeted({ turns, model: opts.model, provider: activeProvider()?.id, ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}) }, (maxOutputTokens) =>
      completeTooledUnmetered(turns, opts, maxOutputTokens),
    false, opts.maxOutputTokens);
  /* A caller already inside a run context keeps it — which is the whole point
     for a tool loop: every round of one turn reserves against ONE run id, so
     the per-run call and dollar ceilings bound the loop rather than each of
     its rounds separately. */
  if (runContext.getStore()) return work();
  return runContext.run(
    {
      id: `direct:${randomUUID()}`,
      venture: null,
      automation: true,
      signal: opts.signal ?? AbortSignal.timeout(budgets().runSeconds * 1000),
      sequence: 0,
      resume: false,
    },
    work,
  );
}

async function completeTooledUnmetered(
  turns: ToolWireTurn[],
  opts: ToolCompleteOptions,
  maxOutputTokens?: number,
): Promise<ToolProviderReply> {
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
      /* See the header: the wire's parameter is narrower than a tool
         conversation, and the widening is admitted here rather than there. */
      turns: turns as WireTurn[],
      service: `${p.label} (${endpoint.label})`,
      timeoutMs: p.policy.timeoutMs,
      signal: opts.signal ?? runContext.getStore()?.signal,
      body: {
        ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
      },
    });
    const raw = doc as unknown as {
      choices?: { message?: unknown; finish_reason?: string | null }[];
    };
    const choice = raw.choices?.[0];
    return {
      message: choice?.message ?? null,
      /* `readText` on the typed view, which is the same reader every other
         caller uses — and an empty string rather than null, because a tool
         round with no prose is normal here. */
      text: readText(doc) ?? "",
      finishReason: choice?.finish_reason ?? null,
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

/**
 * WHICH MODEL A CALL WOULD ACTUALLY NAME, resolved the same way `complete()`
 * resolves it.
 *
 * Exported for one caller and one reason: the tool-capability probe caches its
 * measurement per provider AND MODEL, and a cache keyed on "whatever the
 * endpoint felt like" would be a cache that never hits. The resolution order is
 * the caller's override, the provider's chosen default, then the first id the
 * endpoint's own `/models` lists — the last of which is a network call, which
 * is why this is async and why the result is remembered per endpoint by
 * `modelFor` itself.
 *
 * Null when nothing is connected, on the same rule `activeProvider()` keeps: a
 * caller that gets null says so in words rather than reporting a model name it
 * invented.
 */
export async function activeModel(
  override?: string,
): Promise<{
  provider: ProviderId;
  label: string;
  model: string;
  endpoint: string;
  /**
   * TRUE WHEN "WHICH MODEL" HAS NO ONE ANSWER, and it is not a rare corner.
   *
   * `acquire()` picks whichever ENDPOINT is free or next in the rotation, and
   * a provider that names no default model resolves one per endpoint out of
   * that endpoint's own `/models`. Two local boxes serving different models is
   * the configuration this provider exists for. A caller that cached a
   * measurement under the first endpoint's answer would be storing a fact
   * about a model half the calls never reach — so the ambiguity is REPORTED
   * rather than papered over, and the caller declines to cache instead of
   * caching something untrue.
   *
   * It is false whenever a model is NAMED — by the caller or by the provider —
   * because then every endpoint is sent the same one, however many there are.
   */
  ambiguous: boolean;
} | null> {
  const p = activeProvider();
  if (!p || !p.endpoints.length) return null;
  const first = p.endpoints[0]!;
  const model = await modelFor(p, first, override);
  /* A named model is the same on every endpoint, so there is nothing to
     compare and no `/models` call to pay for. */
  if (override || p.defaultModel || p.endpoints.length === 1)
    return { provider: p.id, label: p.label, model, endpoint: first.label, ambiguous: false };

  let ambiguous = false;
  for (const e of p.endpoints.slice(1)) {
    try {
      if ((await modelFor(p, e)) !== model) ambiguous = true;
    } catch {
      /* An endpoint that cannot be asked is one we cannot rule out. Reporting
         ambiguity is the safe direction: it costs a measurement, not a wrong
         one. */
      ambiguous = true;
    }
    if (ambiguous) break;
  }
  return { provider: p.id, label: p.label, model, endpoint: first.label, ambiguous };
}
