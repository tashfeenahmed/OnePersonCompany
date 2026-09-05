/**
 * THE MCP SERVER — the same registry, spoken over stdio, for agents that have
 * no skills mechanism and no way to be given one.
 *
 * WHY THIS EXISTS WHEN THE SKILL PACKS ALREADY WORK. They work for Hermes,
 * because Hermes reads a directory of Markdown and has a terminal to curl with.
 * OpenClaw has neither: probed against `openclaw config schema`, there is no
 * config key for a skills directory and no raw HTTP tool to hand it a URL. The
 * only door into that agent is `mcp.servers.<id>` — an MCP server it spawns and
 * whose tools it registers. So the choice was an MCP server or an OpenClaw with
 * no access to any of this, and it is also what makes every OTHER MCP-capable
 * agent work without a line of code being written for it.
 *
 * ZERO DEPENDENCIES, AND THAT IS THE WHOLE REASON IT IS HAND-WRITTEN. The
 * official SDK would be a third runtime dependency on a box whose argument is
 * that it has two, and it would be a dependency of a process spawned by an
 * agent rather than by us — so an install that fails leaves a tool list that is
 * silently empty rather than an error anybody sees. JSON-RPC 2.0 over
 * newline-delimited stdin/stdout is about a hundred lines, and this is them.
 *
 * IT IS A CLIENT OF /api/skills AND HOLDS NO REGISTRY OF ITS OWN. The tool list
 * is built by asking the API what is connected RIGHT NOW, on every
 * `tools/list` — so a plugin connected while the agent is running appears
 * without this process being restarted, and one disconnected disappears. The
 * alternative, importing the registry directly, would have been shorter and
 * would have meant this process holding a second opinion about what is
 * connected: it has no database handle, and giving it one would put a second
 * writer near a SQLite file whose whole design says there is one.
 *
 * EVERY TOOL IS A GET. `tools/call` builds a query string and fetches; there is
 * no method parameter and no body, so an agent cannot reach a write through
 * here even if it invented one — the same structural claim routes/skills.ts
 * makes one layer up.
 *
 * Run it by hand:
 *   OPC_API=http://127.0.0.1:8787 node --experimental-strip-types src/skills/mcp.ts
 * and pipe JSON-RPC frames at it, one per line.
 */

/* ------------------------------------------------------------------- wire */

type Id = string | number | null;
type Request = { jsonrpc: "2.0"; id?: Id; method: string; params?: Record<string, unknown> };

/** The protocol revision this speaks. A client that asks for a different one is
 *  echoed its own, which is what the spec asks for and what every client here
 *  has actually sent — refusing a version we would have handled identically is
 *  a connection lost for a string comparison. */
const PROTOCOL = "2025-06-18";

const API = (process.env.OPC_API ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

/**
 * ONE SERVER PER INTEGRATION, BY DEFAULT.
 *
 * MCP's shape is "a server has tools", and the first cut registered ONE server
 * carrying eighteen tools — correct MCP, and wrong for the owner, who opened
 * the agent's tool list and saw a single entry called One Person Company where
 * they expected Stripe, Hetzner, Domains… each as its own thing. That is a
 * fair expectation: in every agent UI the SERVER is the unit a person sees,
 * enables, trusts and disables. So each integration is registered as its own
 * server, and this process, told `OPC_SKILL=<id>`, answers for that one skill
 * only and names itself after it. Unset, it is the all-in-one server for any
 * MCP client that would rather have one.
 */
const ONLY = (process.env.OPC_SKILL ?? "").trim() || null;

/* ------------------------------------------------------------- the catalog */

type CatalogParam = {
  name: string;
  type: "number" | "string";
  required: boolean;
  default: number | string | null;
  about: string;
};
type CatalogView = { key: string; route: string; about: string; params: CatalogParam[] };
type CatalogSkill = {
  id: string;
  title: string;
  about: string;
  rules: string[];
  views: CatalogView[];
  asks: string[];
  openWorld: boolean;
};
type Catalog = { rules: string[]; skills: CatalogSkill[] };

/**
 * Ask the API what is connected.
 *
 * NOT CACHED, on purpose. `tools/list` is called once at connect and again when
 * a client is told the list changed; that is a handful of requests to loopback
 * over the life of a session, and a cache would be the reason a newly connected
 * plugin stayed invisible until somebody restarted an agent — which is the
 * exact failure this whole feature is built to avoid.
 */
async function catalog(): Promise<Catalog> {
  const res = await fetch(`${API}/api/skills`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${API}/api/skills answered ${res.status}`);
  return (await res.json()) as Catalog;
}

/* --------------------------------------------------------------- the tools */

/**
 * One tool per connected skill, with the honesty rules IN THE DESCRIPTION.
 *
 * That placement is the one design decision in this file. A tool description is
 * the only text an MCP client is guaranteed to put in front of the model — a
 * separate `rules` field in the result would arrive AFTER the model had already
 * decided what to do with the numbers, and a resource the client may or may not
 * read is a rule that may or may not exist. It costs tokens in every turn and
 * it is worth them: the failure it prevents is a confident wrong figure, which
 * is the only kind of wrong answer the owner cannot catch.
 */
function toolFor(s: CatalogSkill) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  /* `view` exists only where there is a choice to make. A one-view skill with a
     `view` parameter is a parameter whose only legal value is "default", which
     a model will eventually pass wrong. */
  if (s.views.length > 1)
    properties.view = {
      type: "string",
      enum: s.views.map((v) => v.key),
      description: s.views.map((v) => `${v.key}: ${v.about}`).join(" | "),
    };

  for (const v of s.views)
    for (const p of v.params) {
      /* Parameters are unioned across views, and the description says which
         view a parameter belongs to when the skill has several — the alternative
         is a per-view schema, which MCP has no way to express. */
      const scope = s.views.length > 1 ? ` (view: ${v.key})` : "";
      properties[p.name] = {
        type: p.type,
        description: `${p.about}${scope}${p.default !== null ? ` Default ${p.default}.` : ""}`,
      };
      if (p.required && !required.includes(p.name)) required.push(p.name);
    }

  const rules = s.rules.map((r) => `- ${r}`).join("\n");
  return {
    name: `opc_${s.id}`,
    title: s.title,
    /*
      THE ANNOTATIONS, WHICH ARE A CLAIM AND NOT DECORATION.

      Without them OpenClaw's probe says "tools have no safety annotations;
      calls require approval in prompting session postures" — every read of the
      fleet becomes a prompt somebody has to answer. These are all GETs through
      a proxy that registers no write verb, so `readOnlyHint` is true and
      `destructiveHint` is false as facts about the code rather than as a
      convenience.

      `openWorldHint` is the one that is not uniform, and it is why the registry
      carries a flag for it: `search` performs a live web search and everything
      else reads a document a collector already wrote to a SQLite file on this
      machine. Declaring the search tool closed-world to save a field would be a
      false statement in exactly the field a client trusts when deciding whether
      to ask first.
    */
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: s.openWorld === true,
    },
    description:
      `${s.about}\n\nAnswers questions like: ${s.asks.join(" / ")}\n\n` +
      `RULES FOR REPORTING THIS — they are not optional:\n${rules}`,
    inputSchema: { type: "object", properties, required },
  };
}

/**
 * Run one tool: build the query string, GET the proxy, hand back the document.
 *
 * The JSON is returned as TEXT rather than as structured content, because the
 * documents behind these routes are deep and irregular — Stripe's carries a
 * currency-keyed list of objects — and a client that flattens structured
 * content into a table would be flattening exactly the nesting the honesty
 * rules are about. Text is what the model reads anyway.
 */
async function call(name: string, args: Record<string, unknown>) {
  const id = name.replace(/^opc_/, "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const url = `${API}/api/skills/${encodeURIComponent(id)}${qs.size ? `?${qs}` : ""}`;
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  return {
    content: [{ type: "text", text }],
    /* A non-200 is reported as a tool ERROR rather than as content, so the model
       is told the call failed instead of being handed an error document to read
       as data. The body still travels, because these routes explain themselves:
       a 409 here names the credential that is missing. */
    isError: !res.ok,
  };
}

/* ------------------------------------------------------------- the dispatch */

function reply(id: Id, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: Id, code: number, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(msg: Request) {
  /* A NOTIFICATION HAS NO ID AND GETS NO ANSWER. `notifications/initialized`
     is the one every client sends, and replying to it is a protocol error that
     some clients treat as a fatal handshake failure. */
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const asked = (msg.params?.protocolVersion as string | undefined) ?? PROTOCOL;
      reply(id, {
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: ONLY ? `opc-${ONLY}` : "opc-skills",
          title: ONLY ? `${ONLY} · One Person Company` : "One Person Company · all skills",
          version: "1.0.0",
        },
        instructions:
          "Every tool here reads this one-person company's own live dashboard data " +
          "over loopback. They are all reads. Each tool's description carries the " +
          "rules for reporting its figures honestly — follow them exactly, and say " +
          "'not reported' rather than inventing a number the document does not carry.",
      });
      return;
    }

    case "ping":
      reply(id, {});
      return;

    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "tools/list": {
      try {
        const doc = await catalog();
        const mine = ONLY ? doc.skills.filter((sk) => sk.id === ONLY) : doc.skills;
        if (ONLY && !mine.length) {
          /* This server's integration is not connected right now. An empty list
             here means exactly that, and only that — the aggregate server keeps
             the "API down is an error" rule above. */
          reply(id, { tools: [] });
          return;
        }
        reply(id, { tools: mine.map(toolFor) });
      } catch (err) {
        /* THE API BEING DOWN IS AN ERROR AND NOT AN EMPTY LIST. An empty list is
           indistinguishable from "nothing is connected", and an agent told that
           will answer questions about this business out of its own head. */
        fail(id, -32603, `Could not reach ${API}: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!name.startsWith("opc_")) {
        fail(id, -32602, `No such tool: ${name}`);
        return;
      }
      try {
        reply(id, await call(name, args));
      } catch (err) {
        fail(id, -32603, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${msg.method}`);
  }
}

/* ------------------------------------------------------------------ stdio */

/**
 * Newline-delimited JSON on stdin, one message per line, handled in the order
 * they arrive but not serialised: a `tools/call` that takes a second must not
 * hold up a `ping`, and JSON-RPC ids are what pairs an answer with its
 * question.
 *
 * The buffer is kept because a chunk boundary lands mid-message often enough to
 * matter — reading `data` as a whole message works right up until the document
 * is large, and then it fails as a parse error nobody can reproduce.
 */
let buffer = "";
/*
  IN-FLIGHT REQUESTS, COUNTED, SO THE LAST ANSWER GETS OUT.

  Stdin closing normally means the client has gone and there is nothing to
  answer — but a caller that pipes a fixed script at this process (which is how
  it is tested, and how anybody will first try it) closes stdin the instant the
  last line is written, while a `tools/call` is still waiting on a fetch.
  Exiting on `end` alone therefore swallows every answer that had not already
  been written, and the symptom is a test that shows two replies and then
  silence. So `end` records the intention and the exit happens when the last
  handler has finished.
*/
let inflight = 0;
let ended = false;
const maybeExit = () => {
  if (ended && inflight === 0) process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const cut = buffer.indexOf("\n");
    if (cut < 0) break;
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      fail(null, -32700, "Parse error");
      continue;
    }
    inflight += 1;
    void handle(msg).finally(() => {
      inflight -= 1;
      maybeExit();
    });
  }
});

/* stdin closing is the client going away, which is the ordinary end of this
   process's life and not a failure — once whatever it last asked for has been
   answered. */
process.stdin.on("end", () => {
  ended = true;
  maybeExit();
});
