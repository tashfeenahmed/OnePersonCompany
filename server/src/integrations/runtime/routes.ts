/**
 * /api/runtime — what the agent runtime can do, and what its scheduler has done.
 *
 * Two questions, two shapes, and they are on one route prefix because they are
 * one subject: the runtime the owner's agent is. `GET /tools` answers "does
 * connecting this model give me a chat that can check my business data"; `GET
 * /jobs` answers "what is my agent scheduled to do and did it happen".
 *
 * NOTHING HERE CREATES A SCHEDULED JOB, and that absence is the design. Both
 * managed runtimes have a scheduler; this app has a run queue and a nightly
 * pipeline of its own. A third place to create recurring work would be a third
 * clock, and the first question about any missed job would become "which of
 * the three was it in". So this reads, and says whose the scheduling is.
 */
import { Hono } from "hono";
import { configValue } from "../../db.ts";
import { activeProvider } from "../../models/provider.ts";
import { probeTools } from "./probe.ts";
import { readings } from "./jobs.ts";
import { deliverPending, ingest, PASS_MINUTES } from "./relay.ts";
import {
  capabilities,
  capability,
  isFresh,
  lastResult,
  results,
  resultCounts,
  settings,
  MAX_DELIVERY_ATTEMPTS,
} from "./store.ts";

export const runtimeRoutes = new Hono();

/* ------------------------------------------------------------------- tools */

/**
 * WHICH MODE THIS CONNECTION GIVES, in the words the settings page prints.
 *
 * THE ANSWER IS NEVER GUESSED FROM THE PROVIDER. "OpenAI supports function
 * calling" is true of the company and useless about the model the owner
 * actually chose, which on three of the four providers here is routed by a
 * gateway. So the mode comes from a MEASUREMENT (probe.ts) and, when there is
 * none yet, this says "not measured" rather than picking the flattering
 * answer. A page that claimed tools and then failed mid-answer would be worse
 * than one that said it did not know.
 *
 * IT DOES NOT PROBE. A GET that spent a completion would be a settings page
 * that costs money to open, and a page polled every few seconds would spend it
 * repeatedly. `POST /tools/probe` is the button.
 */
runtimeRoutes.get("/tools", (c) => {
  const s = settings();
  const p = activeProvider();
  if (!p)
    return c.json({
      provider: null,
      model: null,
      mode: null,
      why:
        "No model provider is chosen, so a chat with no agent live has nothing to send to at " +
        "all. Choose one under Settings → Models.",
      settings: s,
      measuredAt: null,
      stale: false,
      detail: null,
    });

  /* The MODEL as configured, not as resolved: resolving asks the endpoint for
     its list, which is a network call, and this route is polled. A provider
     that names no model is reported as "the endpoint's choice", which is what
     it is. */
  const configured = (configValue(p.id, "model") ?? "").trim() || p.defaultModel;
  /*
    A PROVIDER THAT NAMES NO MODEL IS THE COMMON CASE, not an edge one:
    FreeLLMAPI and a local router both legitimately route on their own, and
    `complete()` resolves that to the first id the endpoint's `/models` lists.
    Resolving it HERE would be a network call on a polled route, so instead the
    last measurement taken for this provider is shown, with the model it was
    taken against named beside it. Saying "cannot be measured" while the chat
    path was happily using a cached row under the resolved id would be the page
    and the loop disagreeing about the same fact.
  */
  const known =
    (configured ? capability(p.id, configured) : null) ??
    capabilities().find((c) => c.provider === p.id) ??
    null;
  const measuredModel = known?.model ?? configured;

  return c.json({
    provider: p.id,
    label: p.label,
    model: measuredModel,
    /* What the owner NAMED, beside what was measured. Null here is "the
       endpoint chooses", which is a real answer rather than a blank. */
    configuredModel: configured,
    /* null = never measured. 'error' = the probe could not be run, which says
       nothing about the model and must not be drawn as "text-only". */
    mode: known?.mode ?? null,
    measuredAt: known?.checkedAt ?? null,
    stale: known ? !isFresh(known) : false,
    detail: known?.detail ?? null,
    settings: s,
    why: !s.tools
      ? "Tool use is switched off for direct model providers, so this connection is text-only whatever the model can do."
      : known === null && !configured
        ? "This provider lets its endpoint choose the model, so nothing has been measured yet. Run the check — it resolves the model the way a real turn does and measures that one."
        : known === null
          ? "Not measured yet. Run the check to find out whether this model can call tools."
          : known.mode === "tools"
            ? "This connection gives TOOLS: a chat with no agent live can read your connected integrations through the skills registry."
            : known.mode === "text"
              ? "This connection is TEXT-ONLY: the model answers from the conversation and cannot read your business data. Connect Hermes or OpenClaw, or choose a model that supports function calling."
              : "The check could not be completed, so the mode is unknown — this is not a verdict about the model.",
  });
});

/**
 * Measure it now.
 *
 * A POST because it spends a completion — which is also why `/api/runtime` is
 * on the owner surface: a route that bills the owner is not one an agent gets
 * to press on its own reasoning. `force` is not read from the request:
 * the button always re-measures, because the only reason to press it is that
 * the cached answer is believed to be wrong. A parameter that could be sent as
 * the string "false" and read as truthy is the wave-one lesson this app paid
 * for in a published Facebook post.
 */
runtimeRoutes.post("/tools/probe", async (c) => {
  const r = await probeTools({ force: true, signal: c.req.raw.signal });
  if ("error" in r) return c.json({ error: r.error }, 409);
  return c.json(r);
});

/* -------------------------------------------------------------------- jobs */

runtimeRoutes.get("/jobs", (c) => {
  const list = readings().map((r) => ({
    ...r,
    jobs: r.jobs.map((j) => {
      const seen = lastResult(j.runtime, j.id);
      return {
        ...j,
        /* WHAT THIS BOX ACTUALLY READ, beside what the runtime claims. They
           can disagree — a run that died before writing its output leaves a
           last_status in the runtime's store and no file here — and showing
           both is the only way that disagreement is visible. */
        lastSeen: seen
          ? {
              ref: seen.ref,
              at: seen.at,
              status: seen.status,
              delivered: seen.delivered_at !== null,
              suppressedBy: seen.suppressed_by,
              deliveryError: seen.delivery_error,
            }
          : null,
      };
    }),
  }));
  return c.json({
    runtimes: list,
    counts: resultCounts(),
    settings: settings(),
    passMinutes: PASS_MINUTES,
    maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
    /* Said once, here, so every reader of this document knows whose the
       scheduling is without having to infer it from the absence of a POST. */
    scheduling:
      "Scheduled jobs belong to the runtime that runs them. This dashboard reads them and " +
      "relays their results; it does not create, edit or fire them.",
    generatedAt: new Date().toISOString(),
  });
});

runtimeRoutes.get("/results", (c) => {
  const runtime = c.req.query("runtime") ?? undefined;
  const jobId = c.req.query("job") ?? undefined;
  const asked = Number(c.req.query("limit") ?? 40);
  const limit = Number.isFinite(asked) ? asked : 40;
  const rows = results({ runtime, jobId, limit });
  return c.json({
    count: rows.length,
    results: rows.map((r) => ({
      id: r.id,
      runtime: r.runtime,
      jobId: r.job_id,
      jobName: r.job_name,
      ref: r.ref,
      at: r.at,
      status: r.status,
      chars: r.chars,
      /* The body is published: it is the owner's own scheduled job's output,
         it is what the relay would have sent, and a results page that showed
         only "delivered" would be unable to answer "what did it say". */
      body: r.body,
      seenAt: r.seen_at,
      deliveredAt: r.delivered_at,
      deliveryError: r.delivery_error,
      attempts: r.attempts,
      suppressedBy: r.suppressed_by,
      deferredUntil: r.deferred_until,
    })),
    counts: resultCounts(),
    generatedAt: new Date().toISOString(),
  });
});

/**
 * Walk both stores now, and push whatever is due.
 *
 * A POST because it can put a message on somebody's phone. It is not a skill
 * ACTION and will not become one: an agent that could trigger its own
 * scheduler's relay is an agent that can make the owner's phone buzz on its
 * own reasoning. This is the panel's refresh button and the owner's.
 *
 * AND THAT SENTENCE IS NOW ENFORCED RATHER THAN ASSERTED. Leaving an action
 * out of the registry keeps it off the SKILLS proxy and nothing more: the
 * agent key opens every route the owner gate does not list, and a managed
 * Hermes has a shell and that key. `/api/runtime` is on `OWNER_SURFACE`
 * (integrations/security/gate.ts) as a write-only rule, which covers this
 * route and `/tools/probe` — one puts a message on a phone, the other spends a
 * completion — and leaves both GETs open, because what they answer is what the
 * `jobs` skill already publishes.
 */
runtimeRoutes.post("/jobs/refresh", async (c) => {
  const found = ingest();
  const sent = await deliverPending();
  return c.json({ ...found, ...sent, counts: resultCounts() });
});
