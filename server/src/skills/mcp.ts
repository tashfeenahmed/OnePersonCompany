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
 * MOST TOOLS ARE A GET AND A FEW ARE NOT, and the ones that are not say so in
 * the field a client reads to decide. `opc_<id>` is the read: a query string
 * and a fetch, as it always was. `opc_<id>_<action>` is a write, and it is a
 * POST to `/api/skills/<id>/<action>` — never to the route behind it, because
 * this process has no opinion about which verb that route wants and no way to
 * reach one the registry has not named. The set of writes reachable from here
 * is therefore exactly the set `/api/skills` publishes, which is a list a
 * person can read, and the annotations on each one — `readOnlyHint: false`,
 * `destructiveHint` where there is no undo — are how a client is told to ask
 * first. There is no method parameter and no raw body anywhere in this file.
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
  /** Where the proxy puts it. Read here only to know that a `path` parameter is
   *  still SENT like any other — see `call`. */
  in: "query" | "path" | "body";
  about: string;
};
type CatalogView = { key: string; route: string; about: string; params: CatalogParam[] };
type CatalogAction = {
  key: string;
  method: string;
  route: string;
  call: string;
  about: string;
  destructive: boolean;
  params: CatalogParam[];
};
type CatalogSkill = {
  id: string;
  title: string;
  about: string;
  rules: string[];
  views: CatalogView[];
  /** Always present, empty on the skills that only read. An older server that
   *  did not publish it is handled by the `?? []` at every use. */
  actions?: CatalogAction[];
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

  /* Parameters are unioned across views — MCP has one schema per tool and no
     way to express a per-view one — so a NAME that appears in two views keeps
     BOTH sentences, joined, rather than whichever view was rendered last.
     `page` on the mailbox is a Gmail cursor in one view and a Resend cursor in
     another, and a model handed only the second description while paging
     threads has been told something untrue about the parameter it is sending. */
  const said = new Map<string, string[]>();
  for (const v of s.views)
    for (const p of v.params) {
      const scope =
        s.views.length > 1 ? ` (${p.required ? "required for view" : "view"}: ${v.key})` : "";
      const line = `${p.about}${scope}${p.default !== null ? ` Default ${p.default}.` : ""}`;
      const already = said.get(p.name);
      if (already) {
        if (!already.includes(line)) already.push(line);
      } else {
        said.set(p.name, [line]);
        properties[p.name] = { type: p.type };
      }
      /*
        REQUIRED ONLY WHERE IT IS REQUIRED OF EVERY VIEW, and this is the half
        of the union that cannot be done the obvious way. `mailbox` needs an
        `id` to open one thread and needs nothing at all to list them; a schema
        that unioned the requirement would tell a model listing threads that it
        must send a thread id, and a model that must send one will make one up.
        So the schema requires what is required no matter which view is chosen,
        and the per-view requirement is said in the description above — which is
        where MCP leaves anything conditional.
      */
      const always = s.views.every((x) => x.params.some((y) => y.name === p.name && y.required));
      if (always && !required.includes(p.name)) required.push(p.name);
    }
  for (const [name, lines] of said)
    (properties[name] as { description?: string }).description = lines.join(" — or — ");

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
 * One tool per ACTION, named `opc_<skill>_<action>`.
 *
 * A SEPARATE TOOL RATHER THAN A `mode` PARAMETER ON THE READ. The annotations
 * are per tool, and they are the whole point: a client that is told
 * `readOnlyHint: true` may call a tool without asking anybody, so a single tool
 * that both read the board and deleted from it could carry only the more
 * alarming of the two claims — and then every read of the board would be a
 * prompt somebody has to answer, which is the failure the annotations were
 * added to fix. Split, each one tells the truth about itself and the client
 * decides once per action rather than once per skill.
 *
 * THE SKILL'S RULES ARE IN EVERY ACTION'S DESCRIPTION TOO, in full, for the
 * reason they are in the read tool's: the description is the only text the
 * client is guaranteed to show the model, and an agent about to write on the
 * owner's board is the one that most needs to have just read "never create a
 * card the owner did not ask for".
 */
function actionTool(s: CatalogSkill, a: CatalogAction) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of a.params) {
    properties[p.name] = {
      type: p.type,
      description: `${p.about}${p.default !== null ? ` Default ${p.default}.` : ""}`,
    };
    if (p.required) required.push(p.name);
  }

  const rules = s.rules.map((r) => `- ${r}`).join("\n");
  return {
    name: `opc_${s.id}_${a.key}`,
    title: `${s.title} — ${a.key.replace(/_/g, " ")}`,
    /*
      THE ANNOTATIONS AGAIN, AND HERE THEY ARE A WARNING RATHER THAN A
      REASSURANCE. `readOnlyHint: false` because this changes something the
      owner will find changed; `destructiveHint` from the registry, which means
      "there is no undo" and is true of exactly one of these today;
      `idempotentHint: false` because calling create twice makes two cards and a
      client must not retry one of these on its own; `openWorldHint: false`
      because every action reaches a route on this machine.
    */
    annotations: {
      readOnlyHint: false,
      destructiveHint: a.destructive === true,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      `${a.about}\n\nThis CHANGES the owner's own data — ` +
      `${a.method} ${a.route}${a.destructive ? ", and there is no undo" : ""}.\n\n` +
      `RULES FOR USING THIS — they are not optional:\n${rules}`,
    inputSchema: { type: "object", properties, required },
  };
}

/**
 * Which skill, and whether this is a read or a write.
 *
 * SPLIT AT THE FIRST UNDERSCORE, which works because a registry id has never
 * had one: they are single lowercase words, and the one id with any punctuation
 * in the whole app (`bing-webmaster`) is a PLUGIN id and not a skill's. Action
 * keys are snake case and keep everything after the cut, so
 * `opc_board_create_card` is the board's `create_card` and `opc_board` is the
 * board itself. The alternative — holding the catalog between `tools/list` and
 * `tools/call` to look the name up — would be this process keeping a second
 * opinion about what exists, which the header above spends a paragraph
 * refusing.
 */
function route(name: string): { id: string; action: string | null } {
  const rest = name.replace(/^opc_/, "");
  const cut = rest.indexOf("_");
  return cut < 0
    ? { id: rest, action: null }
    : { id: rest.slice(0, cut), action: rest.slice(cut + 1) };
}

/**
 * Run one tool: GET the proxy for a read, POST it for an action, hand back
 * whatever it answered.
 *
 * The JSON is returned as TEXT rather than as structured content, because the
 * documents behind these routes are deep and irregular — Stripe's carries a
 * currency-keyed list of objects — and a client that flattens structured
 * content into a table would be flattening exactly the nesting the honesty
 * rules are about. Text is what the model reads anyway. It is also why an
 * action's answer travels whole: every board mutation replies with the entire
 * board, and the id of what was just created is in there and nowhere else.
 */
async function call(name: string, args: Record<string, unknown>) {
  const { id, action } = route(name);

  const res = action
    ? await fetch(
        `${API}/api/skills/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          /*
            THE ARGUMENTS VERBATIM, NULLS INCLUDED. A null is how a field is
            CLEARED — see routes/board.ts on absent versus null — so dropping
            them the way the query string below has to would turn "remove the
            due date" into a call that changes nothing and reports success.
            `JSON.stringify` drops `undefined` on its own, which is the same
            thing as never having sent the key.
          */
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(60_000),
        },
      )
    : await (async () => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args ?? {})) {
          if (v === undefined || v === null) continue;
          qs.set(k, String(v));
        }
        /* A view's path parameter goes out as a query parameter here too: the
           proxy is what knows it belongs in a segment. */
        return fetch(`${API}/api/skills/${encodeURIComponent(id)}${qs.size ? `?${qs}` : ""}`, {
          method: "GET",
          signal: AbortSignal.timeout(60_000),
        });
      })();

  const text = await res.text();
  return {
    content: [{ type: "text", text }],
    /* A non-200 is reported as a tool ERROR rather than as content, so the model
       is told the call failed instead of being handed an error document to read
       as data. The body still travels, because these routes explain themselves:
       a 409 here names the credential that is missing, or says the board moved
       under the drag. */
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
          "Every tool here reaches this one-person company's own dashboard over " +
          "loopback. Most of them READ: each one's description carries the rules for " +
          "reporting its figures honestly — follow them exactly, and say 'not " +
          "reported' rather than inventing a number the document does not carry. A " +
          "few WRITE, and they are the ones whose annotations say readOnlyHint " +
          "false: they change the owner's own board and his list of ventures. Never " +
          "call one of those unless he asked for that exact change, prefer archiving " +
          "to deleting, and tell him afterwards what you did and the id it happened " +
          "to.",
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
        /* The read first and its actions after it, per skill, so a tool list
           read by a person groups the way the registry does. */
        reply(id, {
          tools: mine.flatMap((sk) => [
            toolFor(sk),
            ...(sk.actions ?? []).map((a) => actionTool(sk, a)),
          ]),
        });
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
