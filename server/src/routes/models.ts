/**
 * THE MODELS ROUTE — which provider completes, how many at once, and one door
 * to make it prove it.
 *
 * It is to `models/provider.ts` what `routes/chat.ts` is to
 * `chat/backend.ts`: the seam holds the contract and the limiter and has no
 * import of the database; this file owns the config keys, hands the seam its
 * choice reader, and imports the three adapters for the side effect of their
 * registration. Every argument routes/chat.ts makes about that arrangement
 * applies here unchanged, which is why it is arranged the same way.
 *
 * FIVE THINGS LIVE HERE AND NOTHING ELSE: list the providers with what the
 * limiter is doing right now, choose the default, set one's policy, ask one
 * endpoint what it serves, and take a completion.
 *
 * WHY `POST /complete` GOES TO THE DEFAULT PROVIDER AND TAKES NO `provider`
 * FIELD. Because `complete()` in models/provider.ts takes none, and that is
 * deliberate on its side: it is the ONE path a completion takes, so the
 * limiter cannot be bypassed by a caller that forgot about it. A route that
 * could name a provider would need a second entry point past the gate, and the
 * first thing to go through it would be a test harness — which is exactly the
 * traffic the gate exists to count. So testing a second provider means making
 * it the default for a moment, which is one PUT and is honest about what it
 * changed.
 *
 * THE DEFAULT MAY BE UNSET, AND THAT IS THE SHIPPING STATE. Nothing here picks
 * a provider on the owner's behalf. A completion with none chosen fails with
 * `NoProviderError`'s own sentence, which names the four and says where to
 * choose — and the alternative, quietly defaulting to whichever is connected,
 * is a dashboard that starts spending somebody's OpenRouter credits because a
 * key happened to be in the vault.
 */
import { Hono } from "hono";
import { WireError, type WireTurn } from "../chat/wire.ts";
import {
  NoProviderError,
  activeProvider,
  complete,
  gateState,
  providers,
  setProviderChoiceReader,
  type ProviderId,
} from "../models/provider.ts";
import {
  PROVIDER_DEFAULTS,
  clearPolicy,
  policyIsDefault,
  readPolicy,
  validatePolicy,
  writePolicy,
} from "../models/policy.ts";
import { PROVIDER_IDS, readModelProvider, writeModelProvider } from "./pluginConfig.ts";
import { configValue } from "../db.ts";
/*
  THE THREE ADAPTERS, IMPORTED FOR THEIR REGISTRATION AND USED FOR THEIR
  HELPERS. `registerProvider` is called as a side effect of loading each of
  them, exactly as `registerBackend` is for the two agents — so index.ts's
  import of THIS file is what makes `activeProvider()` able to return anything
  at all, and that ordering is commented there. They are imported by name
  rather than for side effects alone because a bare `import "./x.ts"` with no
  binding is the line somebody deletes as dead six months from now.
*/
import * as local from "../providers/local.ts";
import * as openaiChat from "../providers/openai-chat.ts";
import * as openrouterChat from "../providers/openrouter-chat.ts";
/* The fourth adapter. It registers itself on import like the three above, and
   is also imported by routes/plugins.ts and routes/freellmapi.ts — so the
   registration happens whichever of them loads first. */
import * as freellmapi from "../providers/freellmapi.ts";

export const models = new Hono();

/**
 * THE WIRING THAT MAKES `activeProvider()` WORK, done at import.
 *
 * models/provider.ts exposes `setProviderChoiceReader` for the reason
 * chat/backend.ts exposes `setChoiceReader`: a seam that reached into the
 * config store would be a seam with an opinion about where a setting lives.
 * The FUNCTION is passed rather than the value, so switching the default
 * provider takes effect on the next completion rather than the next restart.
 */
setProviderChoiceReader(readModelProvider);

/** Longest single message accepted by `/complete`. The same figure
 *  routes/chat.ts uses, for the same reason: a paste that is really a file is
 *  refused here rather than at the model, where it arrives as an opaque 400
 *  after a long wait and a token bill. */
const MAX_MESSAGE = 32_000;

/* ------------------------------------------------------------------ shapes */

/**
 * One provider as the settings page reads it.
 *
 * SIX FACTS RATHER THAN ONE, and they come apart exactly as the chat
 * backends' three do. A provider can be connected and not the default; the
 * default and not connected (chosen before a key was pasted); connected with
 * no endpoints (impossible today, and reported rather than assumed away). The
 * gate figures are added because "the model is slow" and "the queue is long"
 * are two different complaints with two different fixes, and only one of them
 * is about the model.
 */
function shapeProvider(
  p: { id: ProviderId; connected: boolean; label: string | null; endpoints: number },
  chosen: ProviderId | null,
) {
  const gate = gateState(p.id);
  return {
    ...p,
    /* The one that will actually be asked. At most one of these is true. */
    live: chosen === p.id && p.connected,
    default: chosen === p.id,
    /* Read from config rather than from the factory, so it is reported even
       for a provider that is not connected — "the model is set and the key is
       missing" is a state worth being able to see. Null is "let the endpoint
       choose", which is a real answer and not a blank. */
    model: (configValue(p.id, "model") ?? "").trim() || null,
    policy: readPolicy(p.id),
    /* Whether those four numbers are the owner's or this codebase's. A page
       that presented our opinion as their decision would be lying quietly. */
    policyIsDefault: policyIsDefault(p.id),
    policyDefaults: PROVIDER_DEFAULTS[p.id],
    gate: {
      inFlight: gate.inFlight,
      queued: gate.queued,
      /* Keyed by base URL, which is an address and not a credential — the same
         thing the SearXNG settings field shows in full. Only endpoints that
         have taken a call appear, because the gate counts calls rather than
         endpoints; the page draws the endpoint list from the plugin and looks
         its counter up here. */
      byEndpoint: Object.entries(gate.byEndpoint).map(([baseUrl, inFlight]) => ({
        baseUrl,
        inFlight,
      })),
    },
  };
}

function state() {
  const chosen = readModelProvider();
  const live = activeProvider();
  const rows = providers().map((p) => shapeProvider(p, chosen));
  return {
    providers: rows,
    chosen,
    live: live?.id ?? null,
    liveLabel: live?.label ?? null,
    /* The server's own sentence for "nothing will complete", so the page
       states the reason rather than reverse-engineering one from the flags. */
    why:
      live !== null
        ? null
        : chosen === null
          ? rows.some((p) => p.connected)
            ? "No provider is chosen. Pick one to make it the default every agent inherits."
            : "No model provider is connected. Add a local endpoint, or paste an inference key on OpenAI or OpenRouter."
          : `${chosen} is chosen and is not connected — its endpoint or its inference key is not in the vault yet.`,
  };
}

/* ------------------------------------------------------------------ routes */

/** Who could complete, who is chosen, and what the limiter is doing. Cheap:
 *  the hosted adapters decide "connected" from entry names, and the local one
 *  reads its URLs through a cache keyed on the ciphertext's own timestamp, so
 *  a page polling this decrypts nothing. */
models.get("/providers", (c) => c.json(state()));

/**
 * Choose the default.
 *
 * `null` is a legal body and means "nothing completes" — a state worth being
 * able to reach deliberately, because the alternative to switching a provider
 * off is deleting its credentials. Answered with the WHOLE state rather than
 * an ok, so choosing one that turns out not to be connected says so without a
 * second request.
 */
models.put("/provider", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { provider?: unknown } | null;
  if (!body || !("provider" in body))
    return c.json(
      { error: `Expected { provider: ${PROVIDER_IDS.map((i) => `"${i}"`).join(" | ")} | null }.` },
      400,
    );

  const value = body.provider;
  if (value !== null && !PROVIDER_IDS.includes(value as ProviderId))
    return c.json(
      {
        error:
          `“${String(value)}” is not a model provider. The four are ` +
          `${PROVIDER_IDS.join(", ")}, and null means none of them.`,
      },
      400,
    );

  writeModelProvider((value as ProviderId | null) ?? null);
  return c.json(state());
});

/**
 * Set one provider's policy.
 *
 * A PARTIAL BODY IS THE NORMAL CASE — a concurrency box that has just been
 * changed sends one field — and models/policy.ts is where that is checked, so
 * the same rules apply to a value written by a hand-edited row as to one that
 * came through here. The whole state comes back, because changing a policy is
 * the one setting whose effect (a queue draining, a number of calls in flight)
 * is visible in the document this route already returns.
 */
models.put("/:id/policy", async (c) => {
  const id = c.req.param("id") as ProviderId;
  if (!PROVIDER_IDS.includes(id))
    return c.json({ error: `“${id}” is not a model provider.` }, 404);

  const body: unknown = await c.req.json().catch(() => null);
  const checked = validatePolicy(body);
  if (!checked.ok) return c.json({ error: checked.error }, 400);

  const policy = writePolicy(id, checked.patch);
  return c.json({ id, policy, ...state() });
});

/** Forget the four keys, so this provider's own default stands again. Offered
 *  as a button rather than making the owner retype four numbers they never
 *  chose in the first place. */
models.delete("/:id/policy", (c) => {
  const id = c.req.param("id") as ProviderId;
  if (!PROVIDER_IDS.includes(id))
    return c.json({ error: `“${id}” is not a model provider.` }, 404);
  const policy = clearPolicy(id);
  return c.json({ id, policy, ...state() });
});

/**
 * What each local endpoint is actually serving, asked live.
 *
 * A LIVE READ RATHER THAN A STORED LIST, because a model is pulled and deleted
 * by a person at a terminal and a catalog written down at connect time would
 * be wrong within a day. Every endpoint is asked in parallel and each one
 * reports its own failure: a laptop that is closed must not take the GPU box's
 * model list off the page, which is the same per-account degradation every
 * collector in this project keeps.
 *
 * It does NOT go through the limiter. The gate exists to protect a GPU from
 * two completions at once; a model listing is a few bytes off disk and
 * queueing it behind a running completion would make the page wait a minute to
 * draw a dropdown.
 */
models.get("/local/models", async (c) => {
  const live = local.endpoints();
  const rows = await Promise.all(
    live.map(async ({ account, endpoint }) => {
      const res = await local.models(endpoint, c.req.raw.signal);
      return {
        accountId: account.id,
        label: account.label,
        baseUrl: endpoint.baseUrl,
        /* Whether a bearer is being sent, never the bearer. A local endpoint
           with no key is the ordinary case and the page should be able to say
           so without the owner opening the vault. */
        hasKey: endpoint.key !== null,
        models: res.ok ? res.models : [],
        error: res.ok ? null : res.error,
      };
    }),
  );
  return c.json({
    endpoints: rows,
    /* Which of them the next call would use, when the owner has named one.
       Null means "the first id the endpoint lists", which is a real answer. */
    model: (configValue("local", "model") ?? "").trim() || null,
  });
});

/**
 * One completion, through the default provider, under its policy.
 *
 * THIS IS THE PLAIN-CHAT PATH AND THE TEST SURFACE AT ONCE, and it is one
 * route rather than two on purpose: a test that took a different path from the
 * real thing would prove the wrong path works. `POST /api/chat` reaches the
 * same `complete()` when no agent is live.
 *
 * `message` or `turns`, not both. A single sentence is what a curl wants and
 * what a button on the settings page sends; a turn list is what a caller with
 * a conversation already in hand has. Neither is stored: this route writes no
 * row, which is the whole difference between it and the chat route.
 */
models.post("/complete", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    message?: unknown;
    turns?: unknown;
    model?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected { message } or { turns }." }, 400);

  const turns: WireTurn[] = [];
  if (typeof body.message === "string") {
    if (!body.message.trim()) return c.json({ error: "There is no message to send." }, 400);
    if (body.message.length > MAX_MESSAGE)
      return c.json(
        {
          error:
            `That message is ${body.message.length.toLocaleString()} characters, ` +
            `over the ${MAX_MESSAGE.toLocaleString()} limit — anything larger is a ` +
            `file rather than a message.`,
        },
        413,
      );
    turns.push({ role: "user", content: body.message });
  } else if (Array.isArray(body.turns)) {
    for (const raw of body.turns) {
      const t = raw as { role?: unknown; content?: unknown };
      if (t?.role !== "user" && t?.role !== "assistant" && t?.role !== "system")
        return c.json(
          { error: `Each turn needs a role of user, assistant or system — “${String(t?.role)}” is none of them.` },
          400,
        );
      if (typeof t.content !== "string" || !t.content.trim())
        return c.json({ error: "Each turn needs some content." }, 400);
      turns.push({ role: t.role, content: t.content });
    }
    if (!turns.length) return c.json({ error: "There are no turns to send." }, 400);
  } else {
    return c.json({ error: "Expected { message: \"…\" } or { turns: [{ role, content }] }." }, 400);
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;

  const chosen = activeProvider();
  try {
    const reply = await complete(turns, { model, signal: c.req.raw.signal });
    noteOutcome(reply.provider, reply.endpoint, null);
    return c.json(reply);
  } catch (err) {
    if (err instanceof NoProviderError) return c.json({ error: err.message, ...state() }, 503);
    const message =
      err instanceof Error ? err.message : "The provider failed for a reason it did not give.";
    if (chosen) noteOutcome(chosen.id, null, message);
    console.error(`[models] ${chosen?.id ?? "?"} failed — ${message}`);
    const status = err instanceof WireError && err.status === 504 ? 504 : 502;
    return c.json({ error: message, provider: chosen?.id ?? null }, status);
  }
});

/* ------------------------------------------------------------- attribution */

/**
 * Record a completion against the ACCOUNT that answered.
 *
 * Exported because routes/chat.ts's fallback needs the same thing and must not
 * grow its own copy of "which adapter owns which plugin". A completion IS the
 * health check for every one of these providers — there is no collector behind
 * a model server — so a plugin page saying "connected" about an endpoint that
 * refused the last four calls would be telling the owner something untrue.
 *
 * `endpointLabel` is only meaningful for `local`, which has several; the
 * hosted providers have one account and one endpoint, so the label carries no
 * information they do not already have.
 *
 * A FAILED LOCAL COMPLETION IS ATTRIBUTED ONLY WHEN THERE IS ONE ENDPOINT.
 * `complete()` throws without saying which box it was talking to, and there is
 * no honest way to recover that from here — so with two endpoints connected, a
 * failure is left unattributed rather than pinned on whichever one sorts
 * first. A red line on the wrong machine is worse than no red line: it sends
 * the owner to restart a runner that was working.
 */
export function noteOutcome(
  id: ProviderId,
  endpointLabel: string | null,
  error: string | null,
) {
  if (id === "local") {
    const live = local.endpoints();
    const label = endpointLabel ?? (live.length === 1 ? live[0]!.account.label : null);
    if (!label) return;
    if (error) local.noteFailure(label, error);
    else local.noteOk(label);
  } else if (id === "openai") {
    if (error) openaiChat.noteFailure(error);
    else openaiChat.noteOk();
  } else if (id === "openrouter") {
    if (error) openrouterChat.noteFailure(error);
    else openrouterChat.noteOk();
  } else if (id === "freellmapi") {
    /* Its adapter looks the account up itself rather than being handed a
       label: with two endpoints connected, "which one took this call" is a
       question only `chosen()` can answer, and it is the same function the
       call was routed through. */
    if (error) freellmapi.noteFailure(error);
    else freellmapi.noteOk();
  }
}
