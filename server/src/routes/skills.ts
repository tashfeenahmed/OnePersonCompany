/**
 * THE SKILLS SURFACE — one base URL and one shape, so an agent that wants to
 * know what this business is doing has exactly one thing to learn.
 *
 * WHY A PROXY AT ALL, GIVEN THE ROUTES ARE ALREADY THERE. They are, and an
 * agent could curl `/api/stripe` directly — but then the thing it has to know
 * is nineteen paths, four different parameter names, and which of them take a
 * `days` that is clamped to 400 and which take an `hours` clamped to 720. That
 * is a list a model gets wrong at the tail. `GET /api/skills/<id>` is one
 * pattern with one vocabulary, and the registry is the only place a path is
 * written down — so a route that moves is one edit here rather than nineteen
 * SKILL.md files and an MCP schema quietly pointing at a 404.
 *
 * IT IS GET-ONLY, STRUCTURALLY. This file registers no `post`, `put`, `patch`
 * or `delete`, and the one outbound call below sends no method but GET. So
 * "an agent cannot write to the board, cannot store a credential and cannot
 * mark a thread read through here" is a property of the code rather than a
 * promise in a comment — the same claim providers/stripe.ts and
 * providers/meta.ts make about their own outbound halves.
 *
 * THE PROXY IS A LOOPBACK FETCH RATHER THAN AN INTERNAL DISPATCH, and that is
 * a deliberate trade. The alternative — handing this module the root app's
 * `fetch` so the request never leaves the process — is faster by about a
 * millisecond and was declined for two reasons. It would need index.ts to wire
 * a function into this file after every route is mounted, which is an import
 * ordering rule nothing enforces and somebody eventually breaks; and it would
 * mean the skills proxy exercises a code path no other caller uses. As written,
 * a skill call is byte-for-byte the request a person with curl would make, so a
 * document that is right here is right there.
 */
import { Hono } from "hono";
import {
  ENTRIES,
  UNIVERSAL_RULES,
  apiBase,
  entry,
  isLive,
  livePlugins,
  preamble,
  skills,
  view,
  type Skill,
  type SkillView,
} from "../skills/registry.ts";

export const skillRoutes = new Hono();

/* ------------------------------------------------------------------- shapes */

function shapeView(v: SkillView) {
  return {
    key: v.key,
    /* The REAL path, published rather than hidden. An agent that would rather
       call the route directly should be able to, and a reader debugging a
       surprising figure needs to know which document it came out of. */
    route: v.path,
    about: v.about,
    params: v.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      default: p.fallback ?? null,
      about: p.about,
    })),
  };
}

function shape(s: Skill) {
  const base = apiBase();
  return {
    id: s.id,
    title: s.title,
    connected: isLive(s),
    plugins: s.plugins,
    /* WHICH of the named plugins is actually answering. "Domains" over one
       registrar and over two are different answers, and a reader who is told
       only "connected" cannot tell them apart. */
    connectedPlugins: livePlugins(s),
    about: s.about,
    rules: s.rules,
    views: s.views.map(shapeView),
    asks: s.asks,
    /* Whether calling it reaches off this machine. Published because the MCP
       layer turns it into an `openWorldHint` annotation, and a client is
       entitled to decide how much approval a tool needs from it. */
    openWorld: s.openWorld === true,
    url: `${base}/api/skills/${s.id}`,
  };
}

/* ------------------------------------------------------------------- routes */

/**
 * THE PREAMBLE IS REGISTERED FIRST AND THAT ORDERING IS LOAD-BEARING.
 *
 * Hono matches in registration order, so `/:id` below would otherwise swallow
 * `/prompt` and answer it as "no skill called prompt". Registering the literal
 * path first is the fix; the alternative — reserving the word `prompt` in the
 * registry — puts a rule about this file inside a file that should not know
 * this file exists.
 *
 * It answers `text/plain` because its one consumer pastes it into a system
 * turn. A JSON envelope would mean every caller unwrapping a string before
 * using it as a string.
 */
skillRoutes.get("/prompt", (c) =>
  c.text(preamble(), 200, { "content-type": "text/plain; charset=utf-8" }),
);

/**
 * The catalog.
 *
 * IT LISTS WHAT IS NOT CONNECTED TOO, in its own block, and that is not
 * padding. "There is no AdSense figure" and "nobody has connected AdSense" are
 * different sentences, and an agent that can only see the connected half has to
 * answer the first when the second is true. `connected` on each entry is the
 * flag a caller filters on; `disconnected` is the list it can name.
 */
skillRoutes.get("/", (c) => {
  const live = skills();
  return c.json({
    baseUrl: apiBase(),
    /* The shape every skill call takes, said once. */
    call: `${apiBase()}/api/skills/<id>?<params>`,
    method: "GET",
    count: live.length,
    /* The four rules that are true of every document below. They are repeated
       into each skill pack and each MCP tool description, and this is the one
       place they are written. */
    rules: UNIVERSAL_RULES,
    skills: live.map(shape),
    disconnected: ENTRIES.filter((s) => !isLive(s)).map((s) => ({
      id: s.id,
      title: s.title,
      /* WHY it is not here — the plugins that would have to be connected. A
         bare "unavailable" sends somebody looking for a bug. */
      needs: s.plugins,
    })),
    generatedAt: new Date().toISOString(),
  });
});

/**
 * The proxy. One id, optional `view`, and whatever parameters the view takes.
 *
 * AN UNKNOWN ID ANSWERS 404 WITH THE LIST, rather than with the word "unknown".
 * A model that guessed `revenue` instead of `stripe` is one line away from the
 * right answer, and telling it what exists is cheaper than a second turn — the
 * same reason `_locate_skill` in Hermes' own toolbox answers a miss with the
 * twenty names it does have.
 *
 * A DISCONNECTED ID ANSWERS 409 AND NOT 404, because those are different
 * findings: the skill exists, the credential does not, and an agent told "no
 * such thing" would go on to say the business has no app-store revenue rather
 * than that nobody connected the App Store.
 *
 * UNKNOWN QUERY PARAMETERS ARE REFUSED rather than forwarded. Forwarding them
 * would be harmless today — every route below reads the parameters it wants and
 * ignores the rest — but a silently ignored `month=august` is how an agent ends
 * up captioning a 30-day window as August, which is the exact class of error
 * this whole feature exists to prevent. Being told the parameter does not exist
 * is one retry; being answered as if it did is a wrong number with a confident
 * label on it.
 */
skillRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const s = entry(id);
  if (!s)
    return c.json(
      {
        error: `There is no skill called "${id}".`,
        skills: ENTRIES.map((e) => e.id),
      },
      404,
    );

  if (!isLive(s))
    return c.json(
      {
        error:
          `${s.title} has no data here: none of its integrations are connected ` +
          `(${s.plugins.join(", ")}). That is a missing credential, not a business ` +
          `with nothing in it — do not report it as zero.`,
        id: s.id,
        needs: s.plugins,
      },
      409,
    );

  const wanted = c.req.query("view") ?? null;
  const v = view(s, wanted);
  if (!v)
    return c.json(
      {
        error: `${s.id} has no view called "${wanted}".`,
        views: s.views.map((x) => x.key),
      },
      404,
    );

  const known = new Set(v.params.map((p) => p.name));
  const sent = new URLSearchParams();
  for (const [k, val] of Object.entries(c.req.query())) {
    if (k === "view") continue;
    if (!known.has(k))
      return c.json(
        {
          error: `${s.id}${v.key === "default" ? "" : `?view=${v.key}`} takes no parameter "${k}".`,
          params: v.params.map((p) => ({ name: p.name, about: p.about })),
        },
        400,
      );
    sent.set(k, val);
  }
  const missing = v.params.filter((p) => p.required && !sent.has(p.name));
  if (missing.length)
    return c.json(
      {
        error: `${s.id} needs ${missing.map((p) => `"${p.name}"`).join(", ")}.`,
        params: v.params.map((p) => ({ name: p.name, about: p.about })),
      },
      400,
    );

  const qs = sent.toString();
  const url = `${apiBase()}${v.path}${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      /* The caller's own signal. An agent that gave up, or a closed tab behind
         it, ends the inner request too rather than leaving this process waiting
         on itself for an answer nobody will read. */
      signal: c.req.raw.signal,
    });
    const body = await res.text();
    /*
      PASSED THROUGH VERBATIM, INCLUDING THE STATUS. Re-wrapping the document in
      an envelope of this file's own — `{ skill, data }` — was the obvious thing
      and is wrong twice: it would put a second shape between the agent and the
      route's own contract, and it would mean the honesty rules in the pack
      describe fields at a path they are no longer at.
    */
    return new Response(body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return c.json({ error: `${s.id} could not be read: ${why}`, route: v.path }, 502);
  }
});
