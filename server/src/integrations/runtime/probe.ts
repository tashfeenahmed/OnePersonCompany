/**
 * DOES THIS CONNECTION GIVE TOOLS, OR ONLY TEXT? — measured, once, per
 * provider and model.
 *
 * WHY IT IS MEASURED AND NOT DECLARED. There is no field anywhere that answers
 * this. `/v1/models` lists ids and nothing about capabilities; a provider's
 * documentation is about the PROVIDER, and the four this app supports are all
 * routers or aggregators serving models that differ from each other; and the
 * owner's own model setting is frequently `auto`, which means "whatever the
 * gateway picks today". The only honest source is the wire: send one trivial
 * tool with one trivial question and see whether a call comes back.
 *
 * THREE OUTCOMES AND THE THIRD IS NOT A VERDICT.
 *
 *   tools   a tool call came back. The connection gives tools.
 *   text    the server answered in prose while holding a tool it was told to
 *           call, OR refused the `tools` field outright with a 4xx. Both mean
 *           the same thing to the owner: connecting this model gives a chat
 *           that cannot check live business data.
 *   error   the probe could not be completed — the endpoint was unreachable,
 *           the key was refused, the call timed out. This must NEVER be shown
 *           as "this model cannot use tools", because it says nothing about
 *           the model at all. The settings page reports it as "not measured"
 *           with the reason.
 *
 * IT COSTS ONE SMALL COMPLETION AND IS CACHED FOR A WEEK (store.ts). The probe
 * goes through `completeTooled`, so it queues behind the provider's own policy
 * and lands in `budget_usage` exactly like any other call — a capability check
 * that jumped the limiter would be the one caller able to put a second
 * completion on a single GPU.
 */
import { WireError } from "../../chat/wire.ts";
import { activeModel, completeTooled } from "../../models/provider.ts";
import { parseToolCalls } from "./tools.ts";
import { capability, isFresh, writeCapability, type Capability, type ToolMode } from "./store.ts";

/** The whole probe surface: one function, one string parameter, no side
 *  effects on the box. It is not a skill tool and never will be — a model that
 *  could ask "can I call tools" would be asking a question it is in the middle
 *  of answering. */
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "opc_probe_echo",
    description:
      "Echo one word back. This exists only to prove that tool calling works on this connection.",
    parameters: {
      type: "object",
      properties: { word: { type: "string", description: "The word to echo." } },
      required: ["word"],
    },
  },
};

const PROBE_TURNS = [
  {
    role: "system" as const,
    content:
      "You are being checked for tool support. Do not write prose. Call the tool you have been given.",
  },
  {
    role: "user" as const,
    content: 'Call opc_probe_echo with word set to "pong". Answer with the tool call and nothing else.',
  },
];

/**
 * A 4xx THAT MENTIONS THE FIELD IS A VERDICT; ANY OTHER FAILURE IS NOT.
 *
 * An OpenAI-compatible server that does not implement function calling refuses
 * the request rather than ignoring the field — llama.cpp built without a
 * grammar, an older vLLM, a proxy that validates its own allow-list of body
 * keys. That refusal IS the answer and is worth caching, because otherwise
 * every turn would pay for a 400 to learn the same thing. A 401, a 502, a
 * timeout or a connection refused tell us about the credential or the network
 * and nothing about the model, so they are recorded as `error` and re-probed.
 */
export function verdictFor(err: unknown): { mode: ToolMode; detail: string } {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (err instanceof WireError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403)
    return {
      mode: /tool|function/i.test(message) ? "text" : "error",
      detail: message.slice(0, 300),
    };
  return { mode: "error", detail: message.slice(0, 300) };
}

export type ProbeResult = Capability & { fromCache: boolean };

/**
 * The measurement, cached.
 *
 * `force` re-probes a fresh row — the button on the settings page, for the
 * owner who has just upgraded their gateway and does not want to wait a week
 * to be believed. An `error` row is never treated as fresh: a probe that could
 * not be run is a question still open, and caching "we could not tell" for a
 * week would hide a connection that started working ten minutes later.
 */
export async function probeTools(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<
  ProbeResult | { error: string }
> {
  let target: Awaited<ReturnType<typeof activeModel>>;
  try {
    target = await activeModel();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The provider's model list could not be read." };
  }
  if (!target)
    return {
      error:
        "No model provider is connected. Connect FreeLLMAPI, a local model, OpenAI or OpenRouter " +
        "under Integrations and choose one as the default.",
    };
  /*
    NOTHING IS MEASURED WHEN "WHICH MODEL" HAS NO ONE ANSWER. A provider with
    several endpoints and no named model sends whichever model the endpoint the
    limiter picked happens to serve; a measurement cached under the first one
    would be a claim about a model half the turns never reach, and the chat
    path would act on it. Refused with the fix, which is one field on the
    provider's own page.
  */
  if (target.ambiguous)
    return {
      error:
        `${target.label} has more than one endpoint and they do not all serve the same model, ` +
        `so which model answers depends on which endpoint the limiter picks. Name a model on ` +
        `the provider's page and this can be measured.`,
    };

  const cached = capability(target.provider, target.model);
  if (!opts.force && cached && cached.mode !== "error" && isFresh(cached))
    return { ...cached, fromCache: true };

  try {
    const reply = await completeTooled(PROBE_TURNS, {
      tools: [PROBE_TOOL],
      toolChoice: "auto",
      signal: opts.signal,
    });
    const { calls, shape } = parseToolCalls(reply.message);
    const called = calls.some((c) => c.name === PROBE_TOOL.function.name);
    const mode: ToolMode = called ? "tools" : "text";
    const detail = called
      ? `Answered with ${shape === "openai" ? "an OpenAI-shaped" : `a ${shape}`} tool call on ${target.label} (${reply.model ?? target.model}).`
      : `Answered in prose while holding a tool it was told to call${
          reply.text ? `: “${reply.text.trim().slice(0, 120)}”` : ""
        }.`;
    writeCapability(target.provider, target.model, mode, detail);
    return { provider: target.provider, model: target.model, mode, detail, checkedAt: new Date().toISOString(), fromCache: false };
  } catch (err) {
    const { mode, detail } = verdictFor(err);
    writeCapability(target.provider, target.model, mode, detail);
    return { provider: target.provider, model: target.model, mode, detail, checkedAt: new Date().toISOString(), fromCache: false };
  }
}

/**
 * WHAT THE CHAT PATH ASKS, and it never probes.
 *
 * A turn that had to measure the model before answering would pay for a second
 * completion on the first message of every week, in front of somebody waiting.
 * So the loop reads the cache and, on a miss, uses TEXT — the behaviour this
 * app has always had — while `onStart` and the settings page do the measuring.
 * Being wrong in that direction costs a turn that could have used tools; being
 * wrong the other way costs a 400 in the middle of an answer.
 */
export function knownMode(provider: string, model: string): Capability | null {
  const c = capability(provider, model);
  if (!c) return null;
  if (c.mode === "error") return null;
  return isFresh(c) ? c : null;
}
