/**
 * FreeLLMAPI's own door: what is installed, what is running, which account
 * answers, and what that account's endpoint says it can serve.
 *
 * WHY THIS IS NOT PART OF /api/models. That route is the SEAM — it answers
 * "which of the four providers is the default and what is the limiter doing",
 * in terms every provider shares, and it must keep answering that when a fifth
 * arrives. This route is about the one thing no other provider has: a program
 * on this machine that this process installed, runs, and can leave orphaned on
 * a port. Folding a child process's pid and install log into a document about
 * four interchangeable providers would make the general thing carry one
 * provider's specifics forever. It is the same split SearXNG takes between
 * `/api/search` and `/api/searxng/instance`.
 *
 * WHAT IT WILL NEVER RETURN. The unified key, in any form: not the value, not
 * a prefix, not a length. `hasKey` is a boolean, the log tail is scrubbed
 * before it is even written down (see instance.ts's `scrub`), and the account
 * rows carry entry names and dates the way every other plugin's do. The base
 * URL IS returned in full, because an address the owner typed is not a secret
 * and a panel that hid it could not tell them which instance is answering.
 */
import { Hono } from "hono";
import * as instance from "../freellmapi/instance.ts";
import * as freellmapi from "../providers/freellmapi.ts";
import { readModelProvider } from "./pluginConfig.ts";

export const freellmapiRoutes = new Hono();

/* ------------------------------------------------------------------ models */

/**
 * The endpoint's catalog, cached for a minute per endpoint.
 *
 * IT IS A NETWORK CALL AND THIS ROUTE IS POLLED. The panel refreshes every
 * couple of seconds while an install runs, and asking a gateway for 600 model
 * ids at that cadence would spend its proxy rate limit — 120 requests a minute
 * per client IP by default — on redrawing a list that changes when somebody
 * adds a provider key. A minute is short enough that adding one and coming back
 * shows it, and long enough that the poll costs one request in thirty.
 *
 * A FAILURE IS CACHED TOO, for the same span. Without that, an endpoint that is
 * down turns every poll into a fifteen-second timeout and the panel stops
 * answering at all — which reads as the dashboard being broken rather than the
 * gateway.
 */
const CATALOG_TTL_MS = 60_000;
type Cached = { at: number; ids: string[]; error: string | null };
let catalog: (Cached & { baseUrl: string }) | null = null;

async function models(baseUrl: string | null): Promise<Cached> {
  if (!baseUrl) return { at: Date.now(), ids: [], error: null };
  if (catalog && catalog.baseUrl === baseUrl && Date.now() - catalog.at < CATALOG_TTL_MS)
    return catalog;
  const answer = await freellmapi.models();
  const next: Cached = {
    at: Date.now(),
    ids: answer.ok ? answer.ids : [],
    error: answer.ok ? null : answer.error,
  };
  catalog = { ...next, baseUrl };
  return next;
}

/** Drop the cache — called after anything that could change which endpoint is
 *  being read or what it serves. Cheaper than reasoning about staleness. */
function forgetCatalog() {
  catalog = null;
}

/* ------------------------------------------------------------------ report */

async function document() {
  const { accounts, inUse } = freellmapi.report();
  const cat = await models(inUse?.baseUrl ?? null);
  return {
    instance: instance.report(),
    accounts,
    /** Which account a completion would go to right now, and why it is that
     *  one. Null with a sentence rather than an empty object: "nothing is
     *  connected" and "the one you chose is disconnected" are different
     *  states and the panel says which. */
    inUse: inUse
      ? {
          accountId: inUse.accountId,
          label: inUse.label,
          baseUrl: inUse.baseUrl,
          local: inUse.local,
        }
      : null,
    /** The owner's explicit choice, which may name an account that is gone.
     *  Shown beside `inUse` so "I picked the hosted one and the local one is
     *  answering" is a visible fact rather than a mystery. */
    chosenAccountId: freellmapi.chosenAccountId(),
    /** What the model provider seam thinks. `isDefault` is the one the Chat
     *  page and every agent inherit. */
    provider: {
      id: freellmapi.PLUGIN,
      isDefault: readModelProvider() === freellmapi.PLUGIN,
      model: freellmapi.model(),
      policy: freellmapi.policy(),
    },
    models: {
      ids: cat.ids,
      count: cat.ids.length,
      readAt: new Date(cat.at).toISOString(),
      error: cat.error,
    },
    hostedPlaceholder: freellmapi.DEFAULT_BASE,
    localUrl: freellmapi.LOCAL_URL,
  };
}

freellmapiRoutes.get("/", async (c) => c.json(await document()));

/* ---------------------------------------------------------------- instance */

/**
 * Begin an install.
 *
 * 202 AND NOT 200, because nothing is installed when this answers — a clone,
 * eight hundred packages, two TypeScript builds and a Vite build are minutes.
 * The state is polled from `GET /api/freellmapi`, which carries the step and
 * the last lines of output; this returns only whether the job STARTED.
 */
freellmapiRoutes.post("/instance/install", async (c) => {
  const started = instance.install();
  if (!started.ok) return c.json({ error: started.error, ...(await document()) }, 409);
  return c.json(await document(), 202);
});

freellmapiRoutes.post("/instance/start", async (c) => {
  const started = await instance.start();
  if (!started.ok) return c.json({ error: started.error, ...(await document()) }, 409);
  forgetCatalog();
  return c.json(await document());
});

freellmapiRoutes.post("/instance/stop", async (c) => {
  await instance.stop("asked to stop from the plugin page");
  forgetCatalog();
  return c.json(await document());
});

/**
 * Re-read the key out of the gateway's own database and re-seal it.
 *
 * The one button for "I rotated the key on its Keys page". There is no field
 * on this request and there is nothing to paste: the value is already on this
 * machine, in a file this process wrote the path of, and asking a person to
 * copy it into a form would be asking them to carry a credential through a
 * clipboard for no reason.
 */
freellmapiRoutes.post("/instance/reconnect", async (c) => {
  const done = instance.reconnect();
  if (!done.ok) return c.json({ error: done.error, ...(await document()) }, 409);
  forgetCatalog();
  return c.json(await document());
});

/* ----------------------------------------------------------------- account */

/**
 * Choose which account answers, or clear the choice.
 *
 * `null` IS A LEGAL BODY and means automatic — the local instance while it is
 * running, the hosted one otherwise. That is a state worth being able to
 * return to, because the alternative to "stop preferring the hosted one" would
 * be deleting it.
 *
 * AN ACCOUNT THAT IS NOT THIS PLUGIN'S IS REFUSED, by id, against the rows
 * this plugin actually has. Account ids are global, so a number from another
 * plugin's page would otherwise be stored happily and then silently ignored by
 * the provider — which is the shape of failure that looks like a saved
 * setting.
 */
freellmapiRoutes.put("/account", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { accountId?: unknown } | null;
  if (!body || !("accountId" in body))
    return c.json({ error: "Expected { accountId: <number> | null }." }, 400);

  const value = body.accountId;
  if (value === null) {
    freellmapi.setChosenAccount(null);
    forgetCatalog();
    return c.json(await document());
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    return c.json({ error: "accountId must be a positive integer, or null for automatic." }, 400);

  const { accounts } = freellmapi.report();
  const row = accounts.find((a) => a.id === value);
  if (!row)
    return c.json(
      {
        error:
          `Account ${value} is not one of FreeLLMAPI's. It has ` +
          `${accounts.length ? accounts.map((a) => `${a.id} (${a.label})`).join(", ") : "none"}.`,
      },
      404,
    );

  freellmapi.setChosenAccount(value);
  forgetCatalog();
  return c.json(await document());
});
