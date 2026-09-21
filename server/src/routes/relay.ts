/**
 * THE RELAY — the default model provider as an OpenAI-shaped door on this
 * port, so that a managed agent's completions stand in the same queue as this
 * process's own.
 *
 * THE PROBLEM IT CLOSES. models/provider.ts has a gate per provider: a
 * "series" policy means one completion at a time, whoever asked. That gate
 * bound every call THIS process made — chat, runs, collectors — and none of
 * the calls Hermes or OpenClaw made, because agents/instance.ts handed each
 * agent the provider's own URL and key and the agent called it directly. On a
 * one-GPU box that is the difference between a policy and a suggestion: the
 * Dell serves one request at a time, an agent turn and a run's turn arrive
 * together, and whichever is second waits with no bytes on the wire until
 * its own stall detector gives up (Hermes: "Stream stale for 900s — no chunks
 * received"; this box: "stopped sending anything for 720 seconds"). Pointed
 * here instead, an agent's request takes a slot from the same gate, and
 * "series" means what it says across everything on this box. A "parallel"
 * provider — FreeLLMAPI, OpenAI — lets the agent's calls run beside this
 * process's up to the concurrency, exactly as before.
 *
 * WHAT IT IS NOT. Not a second provider: it has no policy, no key of its own
 * and no model list — everything it knows it reads from `activeProvider()` at
 * the moment of the call, so switching the default under Models switches the
 * agent's upstream with it (agents/instance.ts still re-points the agent, for
 * the model name in its config). Not budgeted: an agent's turn is reserved
 * against its run by `budgeted()` on the run side, and reserving it again
 * here would charge the same tokens twice. Not a parser: the body goes up as
 * sent and the answer comes down as received, byte for byte, stream or not.
 * The one thing it touches is `model`, filled in when the caller sent none,
 * because an OpenAI-shaped server refuses a request without one.
 *
 * KEEPALIVES WHILE QUEUED, and this is the part that makes "series" survivable
 * for the agent. A streamed request is answered with its headers at once and
 * fed an SSE comment every few seconds while it waits for a slot and then for
 * the upstream's first byte. Comments are invisible to every SSE parser and
 * visible to every stall detector, so an agent whose turn is third in the
 * queue behind a two-hour research run sees a live connection rather than a
 * dead one. A request that does not stream cannot be kept alive that way and
 * is simply held, which is what such a caller asked for.
 *
 * THE DOOR TAKES THE AGENT KEY OR THE OWNER KEY, in either header the rest of
 * the API accepts, and nothing else. It is under /api/relay rather than
 * /api/models on purpose: writes to /api/models are on the owner surface
 * (security/gate.ts) because choosing the provider is the owner's, and an
 * agent that could not reach its own model would be an agent that could not
 * think.
 */
import { Hono, type Context } from "hono";
import { keyScope, presentedKey } from "../auth.ts";
import { acquire, activeProvider, modelFor, type ModelProvider } from "../models/provider.ts";

export const relay = new Hono();

/** How often a waiting stream is told it is still open. Well under any stall
 *  threshold in use (Hermes 180 s, local 900 s; this box 90 s idle in chat). */
export const KEEPALIVE_MS = 10_000;

/** An error in the shape an OpenAI client reads. */
function oaiError(message: string, type = "relay_error"): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

function keyed(c: Context): boolean {
  return keyScope(presentedKey(c.req.raw.headers)) !== null;
}

function upstreamHeaders(p: ModelProvider, key: string | null, accept: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: accept,
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    "User-Agent": `onepersoncompany-relay/1.0 (${p.id})`,
  };
}

/* ------------------------------------------------------------------ models */

/** The one model the agent is pointed at, as a list — what an OpenAI client
 *  asks for on start-up to check the door is a door. */
relay.get("/v1/models", async (c) => {
  if (!keyed(c)) return c.json(oaiError("This door takes the agent key or the owner key.", "unauthorized"), 401);
  const p = activeProvider();
  if (!p) return c.json(oaiError("No model provider is chosen under Models, so there is nothing to relay to.", "no_provider"), 503);
  const endpoint = p.endpoints[0];
  if (!endpoint) return c.json(oaiError(`${p.label} has no endpoint configured.`, "no_provider"), 503);
  try {
    const model = await modelFor(p, endpoint);
    return c.json({ object: "list", data: [{ id: model, object: "model", owned_by: p.id }] });
  } catch (err) {
    return c.json(oaiError(err instanceof Error ? err.message : String(err)), 502);
  }
});

/* -------------------------------------------------------- chat completions */

relay.post("/v1/chat/completions", async (c) => {
  if (!keyed(c)) return c.json(oaiError("This door takes the agent key or the owner key.", "unauthorized"), 401);
  const p = activeProvider();
  if (!p) return c.json(oaiError("No model provider is chosen under Models, so there is nothing to relay to.", "no_provider"), 503);
  if (!p.endpoints.length) return c.json(oaiError(`${p.label} has no endpoint configured.`, "no_provider"), 503);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await c.req.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json(oaiError("The body must be a JSON object in the chat completions shape.", "invalid_request"), 400);
  }
  const stream = body.stream === true;
  const clientGone = c.req.raw.signal;

  if (!stream) return relayPlain(c, p, body, clientGone);
  return relayStream(p, body, clientGone);
});

/**
 * A request that wants the whole answer at once: hold the caller until a
 * slot is free, forward, hand the answer back with its status. `x-opc-queued-ms`
 * says how long it stood in line, which is the number the owner needs when
 * "the model is slow" and "the queue is long" are the two candidates.
 */
async function relayPlain(c: Context, p: ModelProvider, body: Record<string, unknown>, clientGone: AbortSignal) {
  const { endpoint, release, queuedMs } = await acquire(p);
  try {
    if (clientGone.aborted) return c.json(oaiError("The caller went away while queued.", "cancelled"), 408);
    if (typeof body.model !== "string" || !body.model.trim()) body.model = await modelFor(p, endpoint);
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(p, endpoint.key, "application/json"),
      body: JSON.stringify(body),
      signal: AbortSignal.any([clientGone, AbortSignal.timeout(p.policy.timeoutMs)]),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "application/json",
        "x-opc-queued-ms": String(queuedMs),
        "x-opc-endpoint": endpoint.label,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(oaiError(`${p.label} (${endpoint.label}) could not be reached — ${message}`, "upstream_error"), 502);
  } finally {
    release();
  }
}

/**
 * A streamed request: headers now, comments while waiting, then the
 * upstream's frames byte for byte.
 *
 * AN ERROR AFTER THE HEADERS HAVE GONE IS AN ERROR IN THE STREAM. Once `200`
 * and `text/event-stream` are on the wire there is no status left to send, so
 * a refused or unreachable upstream becomes one `data:` frame carrying an
 * `error` object — which is what an OpenAI-compatible gateway that loses its
 * upstream mid-stream sends, and what providers/hermes.ts and the agents'
 * own clients already read as "stopped mid-answer" — and then `[DONE]`.
 */
function relayStream(p: ModelProvider, body: Record<string, unknown>, clientGone: AbortSignal): Response {
  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let release: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    release?.();
    release = null;
  };

  const out = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const push = (bytes: Uint8Array) => {
        try {
          ctrl.enqueue(bytes);
        } catch {
          /* The reader is gone; the abort below ends the upstream. */
        }
      };
      const say = (text: string) => push(encoder.encode(text));
      const fail = (message: string) => {
        say(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        say("data: [DONE]\n\n");
      };
      const onGone = () => upstreamAbort.abort(new Error("The caller went away."));
      clientGone.addEventListener("abort", onGone, { once: true });

      /* Alive from the first millisecond: the queue can be long. */
      say(": queued\n\n");
      keepalive = setInterval(() => say(": waiting\n\n"), KEEPALIVE_MS);

      try {
        const slot = await acquire(p);
        release = slot.release;
        if (clientGone.aborted) return;
        if (typeof body.model !== "string" || !body.model.trim()) body.model = await modelFor(p, slot.endpoint);
        say(`: slot ${slot.endpoint.label} after ${slot.queuedMs}ms\n\n`);

        const res = await fetch(`${slot.endpoint.baseUrl}/chat/completions`, {
          method: "POST",
          headers: upstreamHeaders(p, slot.endpoint.key, "text/event-stream"),
          body: JSON.stringify(body),
          signal: upstreamAbort.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          fail(`${p.label} (${slot.endpoint.label}) answered ${res.status}${text ? ` — ${text.slice(0, 400)}` : ""}`);
          return;
        }
        /* The upstream is talking; its own frames are the keepalive now. */
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) push(value);
        }
      } catch (err) {
        if (!clientGone.aborted) fail(`${p.label} could not be reached — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clientGone.removeEventListener("abort", onGone);
        stop();
        try {
          ctrl.close();
        } catch {
          /* already closed by a cancel */
        }
      }
    },
    cancel() {
      upstreamAbort.abort(new Error("The caller went away."));
      stop();
    },
  });

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
