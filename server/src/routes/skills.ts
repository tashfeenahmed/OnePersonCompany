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
 * IT USED TO BE GET-ONLY AND IS NOT ANY MORE, so the paragraph that said so is
 * replaced rather than left standing over a POST route. The old claim was
 * structural: this file registered no write verb, so "an agent cannot write to
 * the board" was a property of the code. The owner has since asked for exactly
 * that — an agent that can create, edit, move and archive his cards, and set up
 * a venture — and a rule you have been asked to break is better broken in the
 * open than kept by making him do the typing.
 *
 * WHAT REPLACES IT IS NARROWER THAN "NO WRITES" AND WIDER THAN NOTHING. There
 * is one write route below, `POST /api/skills/:id/:action`, and it can reach
 * exactly the actions the registry names: a method, a path and a parameter list
 * written down by hand beside the rules for using them. It composes no URL from
 * anything a caller sent, forwards no parameter it does not recognise, and has
 * no passthrough for a body. So the set of things an agent can change through
 * here is a list you can read in one file, and every route on this server that
 * is not on that list — the credential store, the plugin doors, the agent
 * processes, sending mail as the owner — is as unreachable as it was when
 * nothing wrote at all.
 *
 * THE CALLER ALWAYS POSTS, whatever the real route wants. `POST
 * /api/skills/board/delete_card` is a DELETE on `/api/board/cards/12` and an
 * agent never has to know that, because a caller that had to choose a verb is a
 * caller that can choose the wrong one — and because "every action is a POST
 * with a JSON body" is one sentence to learn where "look up the method first"
 * is a lookup that fails silently as a 404 or, worse, succeeds as the wrong
 * thing.
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
  type SkillAction,
  type SkillParam,
  type SkillView,
} from "../skills/registry.ts";

export const skillRoutes = new Hono();

/* ------------------------------------------------------------------- shapes */

/** One parameter as a caller sees it. `in` is published because it is the only
 *  thing that distinguishes a value that is part of the address of a thing from
 *  one that describes it, and a reader looking at `/api/mailbox/threads/:id`
 *  should not have to infer which of its parameters fills that segment. */
function shapeParam(p: SkillParam, fallbackIn: "query" | "body") {
  return {
    name: p.name,
    type: p.type,
    required: p.required,
    default: p.fallback ?? null,
    in: p.in ?? fallbackIn,
    about: p.about,
  };
}

function shapeView(v: SkillView) {
  return {
    key: v.key,
    /* The REAL path, published rather than hidden. An agent that would rather
       call the route directly should be able to, and a reader debugging a
       surprising figure needs to know which document it came out of. */
    route: v.path,
    about: v.about,
    params: v.params.map((p) => shapeParam(p, "query")),
  };
}

/**
 * One action, as a caller sees it.
 *
 * `call` IS SPELLED OUT PER ACTION rather than left to the pattern at the top
 * of the catalog, because this is the half a model gets wrong: it has just read
 * `method: "DELETE"` and `route: "/api/board/cards/:id"` and the obvious next
 * move is to send a DELETE to that path. Both of those fields are here — they
 * say what will HAPPEN — and beside them is the one URL this proxy actually
 * answers on, so the obvious next move is right there to copy instead.
 */
function shapeAction(id: string, a: SkillAction) {
  return {
    key: a.key,
    /* What the real route is asked, so a reader can find the code. */
    method: a.method,
    route: a.path,
    /* What the CALLER sends. Always a POST with a JSON body. */
    call: `${apiBase()}/api/skills/${id}/${a.key}`,
    about: a.about,
    /* Irreversible from here — the same claim the MCP layer publishes as
       `destructiveHint`. False is a statement too: it means there is a way
       back. */
    destructive: a.destructive === true,
    params: a.params.map((p) => shapeParam(p, "body")),
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
    /* ALWAYS AN ARRAY, EMPTY WHERE THERE ARE NONE. An absent key would make
       "this skill cannot write" and "this document was generated by an older
       version of the server" the same shape, and the first of those is a claim
       a reader is entitled to see made explicitly. */
    actions: (s.actions ?? []).map((a) => shapeAction(s.id, a)),
    asks: s.asks,
    /* Whether calling it reaches off this machine. Published because the MCP
       layer turns it into an `openWorldHint` annotation, and a client is
       entitled to decide how much approval a tool needs from it. */
    openWorld: s.openWorld === true,
    url: `${base}/api/skills/${s.id}`,
  };
}

/* ---------------------------------------------------------------- the path */

/**
 * Put the values a caller sent into the `:name` segments of a registry path.
 *
 * ENCODED, EVERY TIME. A Gmail thread id is base-16 and a venture slug is
 * `[a-z0-9-]`, so nothing in practice needs escaping — which is exactly why it
 * has to be done here rather than trusted to stay that way. A value that
 * carried a `/` or a `?` and was pasted in raw would be a caller choosing a
 * route, and the whole argument for this proxy is that it does not let one.
 *
 * A SEGMENT WITH NO PARAMETER IS LEFT ALONE, literally, rather than filled with
 * an empty string. It can only happen if a registry entry names a path
 * parameter that its `:name` does not match, and a `:key` arriving at the route
 * as the four characters `:key` produces an honest 404 that says so — where an
 * empty segment would produce a request for something else entirely.
 */
function fillPath(path: string, values: Map<string, string>): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
    const v = values.get(name);
    return v === undefined ? whole : encodeURIComponent(v);
  });
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
    /* And the shape every write takes, said once beside it. Always a POST with
       a JSON body, whatever verb the route behind it wants — see the file
       header. `actions` on a skill is empty where it has none, which is most of
       them. */
    act: `${apiBase()}/api/skills/<id>/<action>`,
    actMethod: "POST",
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

  const known = new Map(v.params.map((p) => [p.name, p]));
  const sent = new URLSearchParams();
  /* A PATH PARAMETER STILL ARRIVES AS A QUERY STRING, which is the point of
     having the registry say where it goes. `?id=18f2…` is the same shape as
     every other parameter a caller sends here, and this file is what knows that
     the value belongs in a segment of `/api/mailbox/threads/:id` rather than
     after the question mark. A caller that had to compose that path would be a
     caller that could compose a different one. */
  const inPath = new Map<string, string>();
  for (const [k, val] of Object.entries(c.req.query())) {
    if (k === "view") continue;
    const p = known.get(k);
    if (!p)
      return c.json(
        {
          error: `${s.id}${v.key === "default" ? "" : `?view=${v.key}`} takes no parameter "${k}".`,
          params: v.params.map((x) => ({ name: x.name, about: x.about })),
        },
        400,
      );
    if (p.in === "path") inPath.set(k, val);
    else sent.set(k, val);
  }
  const missing = v.params.filter(
    (p) => p.required && !sent.has(p.name) && !inPath.has(p.name),
  );
  if (missing.length)
    return c.json(
      {
        error: `${s.id} needs ${missing.map((p) => `"${p.name}"`).join(", ")}.`,
        params: v.params.map((p) => ({ name: p.name, about: p.about })),
      },
      400,
    );

  const qs = sent.toString();
  const url = `${apiBase()}${fillPath(v.path, inPath)}${qs ? `?${qs}` : ""}`;

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

/**
 * THE ACTIONS. One id, one action key, a JSON body, and a real write behind it.
 *
 * IT IS ALWAYS A POST HERE AND USUALLY SOMETHING ELSE THERE — see the file
 * header. The registry says which verb the route behind actually wants and this
 * is the only place that has to know.
 *
 * ABSENT AND NULL ARE FORWARDED AS THEMSELVES, and that is the one thing this
 * function does with a value rather than to it. `routes/board.ts` spends a
 * paragraph on the difference — a field left out is untouched, a field sent as
 * null is cleared — and a proxy that dropped nulls on the way through would
 * silently turn "remove the due date" into "change nothing", which is a write
 * that reports success and does not happen. So a key present in the body is a
 * key present in the forwarded body, whatever it holds; only a key that is not
 * there at all is not there at all.
 *
 * NOTHING IS TYPE-CHECKED HERE BEYOND THE PATH, and that is deliberate. The
 * routes below already refuse a title that is not a string, an urgency that is
 * not 0–3 and a due date that is not a day — each with a sentence saying what
 * it wanted, written where the rule lives. Re-implementing those checks here
 * would be a second opinion about what is legal, and the failure mode of a
 * second opinion is the day one of them is relaxed and the other is not. What
 * this file checks is what only it can: that the parameter EXISTS, that the
 * required ones were sent, and that a value going into a URL segment is a
 * scalar. Everything else is the route's own 400, passed back verbatim.
 */
skillRoutes.post("/:id/:action", async (c) => {
  const id = c.req.param("id");
  const key = c.req.param("action");
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
          `${s.title} is not connected here (${s.plugins.join(", ")}), so there is ` +
          `nothing to change. That is a missing credential, not an empty business.`,
        id: s.id,
        needs: s.plugins,
      },
      409,
    );

  const actions = s.actions ?? [];
  const a = actions.find((x) => x.key === key);
  if (!a)
    return c.json(
      {
        /* THE TWO MISSES ARE DIFFERENT SENTENCES. "This skill reads and does not
           write" sends a caller to ask the owner; "there is no action by that
           name" sends it to the list, one line away from the right call. Given
           the same answer, an agent would try the second reading of the first. */
        error: actions.length
          ? `${s.id} has no action called "${key}".`
          : `${s.id} only reads — it has no actions, and nothing here can change it.`,
        actions: actions.map((x) => x.key),
      },
      404,
    );

  /* An empty body is `{}` rather than a parse error, so an action whose every
     parameter is optional can be called with nothing — and a body that is
     present and malformed still says so, rather than being quietly read as
     empty and answered as "you left out the title". */
  const raw = await c.req.text();
  let body: Record<string, unknown> = {};
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "The body of an action is JSON, and that was not." }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return c.json(
        {
          error: "The body of an action is a JSON object of its parameters.",
          params: a.params.map((p) => ({ name: p.name, about: p.about })),
        },
        400,
      );
    body = parsed as Record<string, unknown>;
  }

  const known = new Map(a.params.map((p) => [p.name, p]));
  const forward: Record<string, unknown> = {};
  const inPath = new Map<string, string>();

  for (const [k, val] of Object.entries(body)) {
    /* `{"due": undefined}` cannot survive JSON, but a client that built the
       body in JavaScript and stringified it can leave the key out — which is
       the same thing and is handled by not being here at all. */
    if (val === undefined) continue;
    const p = known.get(k);
    if (!p)
      return c.json(
        {
          error: `${s.id}/${a.key} takes no parameter "${k}".`,
          params: a.params.map((x) => ({ name: x.name, about: x.about })),
        },
        400,
      );
    if (p.in === "path") {
      if (val === null || (typeof val !== "string" && typeof val !== "number"))
        return c.json(
          {
            error:
              `"${k}" is part of the address of the thing you are changing, so it ` +
              `has to be a ${p.type} — it cannot be null or a structure.`,
            params: a.params.map((x) => ({ name: x.name, about: x.about })),
          },
          400,
        );
      inPath.set(k, String(val));
    } else forward[k] = val;
  }

  const missing = a.params.filter(
    (p) => p.required && !(p.name in forward) && !inPath.has(p.name),
  );
  if (missing.length)
    return c.json(
      {
        error: `${s.id}/${a.key} needs ${missing.map((p) => `"${p.name}"`).join(", ")}.`,
        params: a.params.map((p) => ({ name: p.name, about: p.about })),
      },
      400,
    );

  const url = `${apiBase()}${fillPath(a.path, inPath)}`;

  try {
    const res = await fetch(url, {
      method: a.method,
      headers: { "content-type": "application/json" },
      /*
        A BODY EVEN WHEN IT IS EMPTY, AND EVEN ON A DELETE. `{}` is a legal
        document and every route behind these either ignores the body or reads
        it with a `.catch(() => null)` that turns a missing one into its own 400
        — and that 400 ("Nothing to change. Send title, body, urgency, due or
        ventureId.") is a better answer than anything this file could invent for
        the same case. One rule, no branch, and the route keeps its own voice.
      */
      body: JSON.stringify(forward),
      /* The caller's own signal, for the reason the GET above takes it: an
         agent that gave up should not leave this process waiting on itself. A
         write that is cut off mid-flight is a write the route either completed
         or did not, which is why every one of them answers with the whole
         document — the next read settles it. */
      signal: c.req.raw.signal,
    });
    const text = await res.text();
    /* PASSED THROUGH VERBATIM, STATUS AND ALL, exactly as the reads are. Every
       board mutation answers with the WHOLE BOARD rather than with the card —
       see routes/board.ts on why — and re-wrapping that would put a second
       shape between an agent and the document its rules describe. A 409 saying
       the board moved under the drag is likewise the route's own sentence, and
       it is a better one than "the write failed". */
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error:
          `${s.id}/${a.key} could not be carried out: ${why}. Whether the change ` +
          `landed is unknown from here — read the skill again before trying it twice.`,
        route: a.path,
      },
      502,
    );
  }
});
