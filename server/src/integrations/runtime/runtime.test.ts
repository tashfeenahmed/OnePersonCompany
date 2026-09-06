/**
 * THE FOUR THINGS THIS AREA GETS WRONG SILENTLY IF THEY ARE WRONG.
 *
 *   TOOL-CALL PARSING — a shape this does not recognise is not a crash. It is
 *   a turn where the model asked for a tool, was ignored, and the answer came
 *   back saying it had no data. Three dialects arrive on one wire (a routing
 *   gateway picks the upstream), so all three are read from fixtures.
 *
 *   THE LOOP'S BOUNDS — a ceiling that does not hold is a model calling tools
 *   until a timeout, with the owner watching a spinner. Tested against a real
 *   HTTP endpoint that always asks for another tool, which is the only way to
 *   know the ceiling holds rather than that it was written down.
 *
 *   THE RESULT CURSOR — a relay that re-sends is a relay that gets muted, and
 *   a relay that sends its whole backlog on first run is worse. Tested against
 *   real files in a real directory, because the dedupe key is a filename.
 *
 *   THE HERMES ENVELOPE — the silence sentinel. A watchdog that correctly
 *   found nothing writes a file saying so, and a relay that did not know the
 *   word would push "[SILENT]" to a phone every hour.
 *
 * The loop test stands up a tiny OpenAI-shaped server on loopback and
 * registers it as the `local` provider, so the whole path under test is the
 * real one: the limiter, the budget reservation, the tool array on the wire,
 * the parser, the ceiling and the final tool-free round.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { db, setConfig, upsertPlugin } from "../../db.ts";
import { DEFAULT_BUDGETS, saveBudgets } from "../../runtime/budgets.ts";
import { registerProvider, setProviderChoiceReader } from "../../models/provider.ts";
import {
  assistantCallTurn,
  messageText,
  parseToolCalls,
  renderTools,
  resultTurn,
  routeName,
  toolName,
  readSchema,
  actionGate,
  allowedActions,
  indexTools,
  toolsFor,
} from "./tools.ts";
import { isSilence, parseHermesRun } from "./jobs.ts";
import { RUNTIME_PLUGIN, writeCapability } from "./store.ts";
import type { Skill } from "../../skills/registry.ts";

/* ------------------------------------------------------------- tool parsing */

test("openai tool calls are read, with their arguments parsed", () => {
  const { calls, shape } = parseToolCalls({
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "opc_stripe", arguments: '{"days":30}' } },
      { id: "c2", type: "function", function: { name: "opc_board", arguments: "{}" } },
    ],
  });
  assert.equal(shape, "openai");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { id: "c1", name: "opc_stripe", args: { days: 30 }, badJson: null });
  assert.deepEqual(calls[1]!.args, {});
});

test("an openai call with no id still gets a stable one", () => {
  const { calls } = parseToolCalls({
    tool_calls: [{ function: { name: "opc_uptime", arguments: "{}" } }],
  });
  assert.equal(calls[0]!.id, "call_0");
});

test("arguments that are not JSON are reported rather than thrown", () => {
  const { calls } = parseToolCalls({
    tool_calls: [{ id: "x", function: { name: "opc_stripe", arguments: '{"days": ' } }],
  });
  assert.deepEqual(calls[0]!.args, {});
  assert.equal(calls[0]!.badJson, '{"days":');
});

test("anthropic tool_use blocks inside content are read", () => {
  const { calls, shape } = parseToolCalls({
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "opc_stripe", input: { days: 7 } },
    ],
  });
  assert.equal(shape, "anthropic");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, { days: 7 });
  /* And the prose beside the call is still the prose. */
  assert.equal(
    messageText({ content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t", name: "n", input: {} }] }),
    "Let me check.",
  );
});

test("gemini functionCall parts are read", () => {
  const { calls, shape } = parseToolCalls({
    parts: [{ text: "ok" }, { functionCall: { name: "opc_umami", args: { days: 1 } } }],
  });
  assert.equal(shape, "gemini");
  assert.equal(calls[0]!.name, "opc_umami");
  assert.deepEqual(calls[0]!.args, { days: 1 });
});

test("a plain answer has no tool calls and is not an error", () => {
  const { calls, shape } = parseToolCalls({ content: "Revenue was $412 last week." });
  assert.equal(calls.length, 0);
  assert.equal(shape, null);
});

test("each dialect renders the tool array in its own shape", () => {
  const skill: Skill = {
    id: "demo",
    title: "Demo",
    plugins: [],
    about: "about",
    rules: ["a rule"],
    asks: ["a question?"],
    views: [{ key: "default", path: "/api/demo", about: "the default view", params: [] }],
  };
  const defs = toolsFor([skill], { actions: false });
  const openai = renderTools(defs, "openai")[0] as { type: string; function: { name: string } };
  assert.equal(openai.type, "function");
  assert.equal(openai.function.name, "opc_demo");
  const anthropic = renderTools(defs, "anthropic")[0] as { name: string; input_schema: unknown };
  assert.equal(anthropic.name, "opc_demo");
  assert.ok(anthropic.input_schema);
  const gemini = renderTools(defs, "gemini")[0] as { functionDeclarations: { name: string }[] };
  assert.equal(gemini.functionDeclarations[0]!.name, "opc_demo");
});

test("a result turn goes back in the same dialect it came from", () => {
  const call = { id: "c1", name: "opc_demo", args: {}, badJson: null };
  assert.deepEqual(resultTurn(call, "{}", "openai"), { role: "tool", tool_call_id: "c1", content: "{}" });
  const anth = resultTurn(call, "{}", "anthropic") as { role: string; content: { type: string }[] };
  assert.equal(anth.content[0]!.type, "tool_result");
  const gem = resultTurn(call, "{}", "gemini") as { parts: { functionResponse: { name: string } }[] };
  assert.equal(gem.parts[0]!.functionResponse.name, "opc_demo");
  const replay = assistantCallTurn("", [call], "openai") as { tool_calls: { id: string }[] };
  assert.equal(replay.tool_calls[0]!.id, "c1");
});

test("names round-trip, and an action keeps everything after the first underscore", () => {
  assert.equal(toolName("board"), "opc_board");
  assert.equal(toolName("board", "create_card"), "opc_board_create_card");
  assert.deepEqual(routeName("opc_board"), { id: "board", action: null });
  assert.deepEqual(routeName("opc_board_create_card"), { id: "board", action: "create_card" });
});

test("a parameter is required only where every view requires it", () => {
  const skill: Skill = {
    id: "mail",
    title: "Mail",
    plugins: [],
    about: "about",
    rules: [],
    asks: [],
    views: [
      { key: "threads", path: "/a", about: "list", params: [] },
      {
        key: "one",
        path: "/a/:id",
        about: "open one",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "the thread" }],
      },
    ],
  };
  const schema = readSchema(skill);
  /* `id` is required of ONE view, so requiring it in the schema would tell a
     model listing threads that it must send a thread id — and a model that
     must send one will make one up. */
  assert.deepEqual(schema.required, []);
  assert.ok("id" in schema.properties);
  /* The view selector exists only where there is a choice. */
  assert.ok("view" in schema.properties);
  assert.ok("fields" in schema.properties);
});

/* --------------------------------------------------------- hermes envelopes */

test("the silence sentinel is recognised in every shape the runtime writes it", () => {
  assert.equal(isSilence("[SILENT]"), true);
  assert.equal(isSilence("[SILENT] No changes detected"), true);
  assert.equal(isSilence("NO_REPLY"), true);
  assert.equal(isSilence("(No response generated)"), true);
  assert.equal(isSilence(""), true);
  assert.equal(isSilence("All clear.\n[SILENT]"), true);
  /* A marker buried mid-sentence in a real report is real content. */
  assert.equal(isSilence("The watchdog was not [SILENT] about the disk."), false);
});

test("a successful hermes run yields its response and a failed one its error", () => {
  const ok = parseHermesRun(
    "# Cron Job: Morning check\n\n**Job ID:** j1\n\n## Prompt\n\nsay hello\n\n## Response\n\nEverything is fine.\n",
  );
  assert.equal(ok.name, "Morning check");
  assert.equal(ok.failed, false);
  assert.equal(ok.body, "Everything is fine.");

  const bad = parseHermesRun(
    "# Cron Job: Morning check (FAILED)\n\n**Job ID:** j1\n\n## Prompt\n\nsay hello\n\n## Error\n\n```\nProxy exhausted\n```\n",
  );
  assert.equal(bad.name, "Morning check");
  assert.equal(bad.failed, true);
  assert.equal(bad.body, "Proxy exhausted");

  const quiet = parseHermesRun("# Cron Job: Watchdog\n\n**Status:** silent (empty output)\n");
  assert.equal(quiet.body, null);

  /* An unrecognised shape is silence rather than a header block pasted into
     somebody's chat. */
  assert.equal(parseHermesRun("something else entirely").body, null);
});

/* ---------------------------------------------------------- the cursor pass */

function hermesFixture(jobId: string, file: string, body: string) {
  const cron = join(DATA_DIR, "hermes", "home", ".hermes", "cron");
  mkdirSync(join(cron, "output", jobId), { recursive: true });
  writeFileSync(
    join(cron, "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          id: jobId,
          name: "Nightly check",
          schedule_display: "every 1d",
          enabled: true,
          state: "scheduled",
          last_status: "completed",
        },
      ],
    }),
  );
  writeFileSync(
    join(cron, "output", jobId, file),
    `# Cron Job: Nightly check\n\n**Job ID:** ${jobId}\n\n## Prompt\n\ncheck\n\n## Response\n\n${body}\n`,
  );
}

test("the first pass is silent, the second relays, and a third re-relays nothing", async () => {
  const { ingest } = await import("./relay.ts");
  const { results } = await import("./store.ts");

  hermesFixture("job-a", "2026-09-06_09-00-00.md", "The disk is fine.");

  /* RULE ONE. A box that has been ticking for a week has a backlog on disk;
     the first pass marks it seen and sends nothing. */
  const first = ingest();
  assert.equal(first.found, 0);
  assert.deepEqual(first.firstPass, ["hermes"]);
  const afterFirst = results({ runtime: "hermes" });
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0]!.suppressed_by, "first pass");

  /* A NEW run is new, and the delivery state starts empty rather than
     suppressed — the relay setting is off in this fixture, so it is held with
     a reason rather than sent. */
  hermesFixture("job-a", "2026-09-06_10-00-00.md", "The disk filled up.");
  const second = ingest();
  const rows = results({ runtime: "hermes" });
  assert.equal(rows.length, 2);
  assert.equal(second.found, 0, "with the relay off a new result is recorded and held, not queued");
  assert.equal(rows[0]!.suppressed_by, "relay off");

  /* THE DEDUPE. Re-reading the same directory inserts nothing. */
  const third = ingest();
  assert.equal(third.found, 0);
  assert.equal(results({ runtime: "hermes" }).length, 2);
});

test("with the relay on, a new result is queued exactly once", async () => {
  const { ingest } = await import("./relay.ts");
  const { results } = await import("./store.ts");
  upsertPlugin(RUNTIME_PLUGIN, true, null);
  setConfig(RUNTIME_PLUGIN, "relay", "on");

  hermesFixture("job-b", "2026-09-06_11-00-00.md", "first");
  ingest(); // primes job-b's runtime cursor is already primed by the test above
  hermesFixture("job-b", "2026-09-06_12-00-00.md", "second");
  const pass = ingest();
  assert.equal(pass.found, 1);
  const rows = results({ runtime: "hermes", jobId: "job-b" });
  assert.equal(rows[0]!.suppressed_by, null);
  assert.equal(rows[0]!.delivered_at, null);
  /* And again: nothing new. */
  assert.equal(ingest().found, 0);
  setConfig(RUNTIME_PLUGIN, "relay", "off");
});

/* ------------------------------------------------------------- loop bounds */

/** An OpenAI-shaped endpoint that ALWAYS asks for one more tool while it is
 *  given tools, and answers in prose the moment they are taken away. That is
 *  the worst case the ceiling exists for. */
function greedyModel(): Promise<{ server: Server; url: string; rounds: () => number }> {
  let rounds = 0;
  let withTools = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      rounds += 1;
      const sent = JSON.parse(body || "{}") as { tools?: unknown[] };
      const hasTools = Array.isArray(sent.tools) && sent.tools.length > 0;
      if (hasTools) withTools += 1;
      const message = hasTools
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: `c${rounds}`, type: "function", function: { name: "opc_nothing", arguments: "{}" } },
            ],
          }
        : { role: "assistant", content: "I ran out of tool calls before I could check everything." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message, finish_reason: hasTools ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, rounds: () => withTools });
    });
  });
}

test("the tool-call ceiling holds, and the turn still answers", async () => {
  const { server, url, rounds } = await greedyModel();
  try {
    registerProvider("local", () => ({
      id: "local",
      label: "Test endpoint",
      endpoints: [{ baseUrl: url, key: null, label: "test" }],
      defaultModel: "test-model",
      policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 },
    }));
    setProviderChoiceReader(() => "local");
    upsertPlugin(RUNTIME_PLUGIN, true, null);
    setConfig(RUNTIME_PLUGIN, "tools", "on");
    setConfig(RUNTIME_PLUGIN, "max_tool_calls", "3");
    /* The loop reads the MEASURED capability and never probes mid-turn, so the
       measurement is written directly — which is also the cheapest way to say
       "this model can call tools" in a test. */
    writeCapability("local", "test-model", "tools", "fixture");

    const { directTurn } = await import("./loop.ts");
    const events: string[] = [];
    let answer = "";
    let toolEvents = 0;
    for await (const e of directTurn([{ role: "user", content: "what is my revenue?" }], {
      signal: AbortSignal.timeout(20_000),
    })) {
      events.push(e.type);
      if (e.type === "tool" && e.status === "running") toolEvents += 1;
      if (e.type === "done") answer = e.text;
    }

    /* THREE CALLS AND NOT ONE MORE, even though the model asked every round. */
    assert.equal(toolEvents, 3);
    /* THE FINAL ROUND CARRIED NO TOOLS AT ALL — the round that exists to
       guarantee an answer must not be able to ask for another call. */
    assert.equal(rounds(), 3);
    /* AND THE TURN ANSWERED rather than stopping mid-investigation. */
    assert.ok(answer.includes("ran out of tool calls"), answer);
    assert.equal(events[events.length - 1], "done");
  } finally {
    server.close();
    setConfig(RUNTIME_PLUGIN, "max_tool_calls", "");
    setConfig(RUNTIME_PLUGIN, "tools", "");
    setProviderChoiceReader(() => null);
  }
});

test("the per-turn dollar ceiling stops the loop and the turn still answers", async () => {
  const { server, url, rounds } = await greedyModel();
  try {
    registerProvider("local", () => ({
      id: "local",
      label: "Test endpoint",
      endpoints: [{ baseUrl: url, key: null, label: "test" }],
      defaultModel: "test-model",
      policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 },
    }));
    setProviderChoiceReader(() => "local");
    upsertPlugin(RUNTIME_PLUGIN, true, null);
    setConfig(RUNTIME_PLUGIN, "tools", "on");
    setConfig(RUNTIME_PLUGIN, "max_tool_calls", "20");
    /* A price, because a turn costed at zero can never exceed a dollar
       ceiling — which is itself worth saying out loud in the settings hint. */
    assert.equal(saveBudgets({ ...DEFAULT_BUDGETS, usdPerMillion: 1_000_000 }), null);
    setConfig(RUNTIME_PLUGIN, "turn_usd", "1");
    writeCapability("local", "test-model", "tools", "fixture");

    const { directTurn } = await import("./loop.ts");
    let answer = "";
    let toolEvents = 0;
    for await (const e of directTurn([{ role: "user", content: "spend money" }], {
      signal: AbortSignal.timeout(20_000),
    })) {
      if (e.type === "tool" && e.status === "running") toolEvents += 1;
      if (e.type === "done") answer = e.text;
    }
    /* It stopped well short of the 20-call ceiling, so it was the dollars that
       stopped it, and it still produced an answer. */
    assert.ok(toolEvents < 20, `stopped at ${toolEvents} calls`);
    assert.ok(rounds() < 20);
    assert.ok(answer.length > 0);
  } finally {
    server.close();
    setConfig(RUNTIME_PLUGIN, "turn_usd", "");
    setConfig(RUNTIME_PLUGIN, "max_tool_calls", "");
    setConfig(RUNTIME_PLUGIN, "tools", "");
    assert.equal(saveBudgets(DEFAULT_BUDGETS), null);
    db.exec("DELETE FROM budget_usage");
    setProviderChoiceReader(() => null);
  }
});

test("a model measured as text-only gets the plain completion and no tools", async () => {
  const { server, url, rounds } = await greedyModel();
  try {
    registerProvider("local", () => ({
      id: "local",
      label: "Test endpoint",
      endpoints: [{ baseUrl: url, key: null, label: "test" }],
      defaultModel: "text-only-model",
      policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 },
    }));
    setProviderChoiceReader(() => "local");
    writeCapability("local", "text-only-model", "text", "fixture");
    setConfig(RUNTIME_PLUGIN, "tools", "on");

    const { directTurn } = await import("./loop.ts");
    let answer = "";
    let toolEvents = 0;
    for await (const e of directTurn([{ role: "user", content: "hello" }], {
      signal: AbortSignal.timeout(10_000),
    })) {
      if (e.type === "tool") toolEvents += 1;
      if (e.type === "done") answer = e.text;
    }
    assert.equal(toolEvents, 0);
    assert.equal(rounds(), 0, "no request carried a tools array");
    assert.ok(answer.length > 0);
  } finally {
    server.close();
    setConfig(RUNTIME_PLUGIN, "tools", "");
    setProviderChoiceReader(() => null);
  }
});

/* --------------------------------------------------------- the write gates */

test("actions are not published as tools at all until writes are switched on", () => {
  const skill: Skill = {
    id: "demo",
    title: "Demo",
    plugins: [],
    about: "about",
    rules: [],
    asks: [],
    views: [{ key: "default", path: "/api/demo", about: "the view", params: [] }],
    actions: [
      { key: "add", method: "POST", path: "/api/demo", about: "add one", params: [] },
      {
        key: "wipe",
        method: "DELETE",
        path: "/api/demo/:id",
        about: "remove it",
        params: [],
        destructive: true,
      },
    ],
  };
  /* A tool that is in the list and always refuses is a tool the model keeps
     trying; one that is not in the list does not exist, and the model plans
     around what it has. */
  assert.deepEqual(
    toolsFor([skill], { actions: false }).map((d) => d.name),
    ["opc_demo"],
  );
  const withWrites = toolsFor([skill], { actions: true });
  /* AND EVEN WITH WRITES ON, `wipe` IS NOT PUBLISHED — the gate is an
     allow-list, so a marked action never appears in the tool array at all. It
     is still refused if the model names it anyway; see the index-surface test
     below. */
  assert.deepEqual(
    withWrites.map((d) => d.name),
    ["opc_demo", "opc_demo_add"],
  );
  assert.equal(withWrites.find((d) => d.name === "opc_demo_add")!.destructive, false);

  /* And the index surface carries the write door only when writes are on. */
  assert.deepEqual(
    indexTools([skill], { actions: false }).map((d) => d.name),
    ["opc_skills", "opc_read"],
  );
  assert.deepEqual(
    indexTools([skill], { actions: true }).map((d) => d.name),
    ["opc_skills", "opc_read", "opc_act"],
  );
});

/** A model that asks to delete a board card once, then answers. The fake
 *  server keeps every message it is sent, so the tool RESULT the loop fed back
 *  is inspectable — which is the only place a refusal can be seen from
 *  outside. */
function deleterModel(): Promise<{ server: Server; url: string; seen: () => unknown[] }> {
  let asked = false;
  let last: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body || "{}") as { messages: unknown[]; tools?: unknown[] };
      last = sent.messages;
      const first = !asked && Array.isArray(sent.tools) && sent.tools.length > 0;
      if (first) asked = true;
      const message = first
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "d1",
                type: "function",
                function: { name: "opc_board_delete_card", arguments: '{"id":1}' },
              },
            ],
          }
        : { role: "assistant", content: "I did not delete it." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, seen: () => last });
    });
  });
}

test("an irreversible action is refused with a sentence the owner can act on", async () => {
  const { server, url, seen } = await deleterModel();
  try {
    registerProvider("local", () => ({
      id: "local",
      label: "Test endpoint",
      endpoints: [{ baseUrl: url, key: null, label: "test" }],
      defaultModel: "test-model",
      policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 },
    }));
    setProviderChoiceReader(() => "local");
    upsertPlugin(RUNTIME_PLUGIN, true, null);
    setConfig(RUNTIME_PLUGIN, "tools", "on");
    /* Writes ON, which is the harder case: the refusal must come from the
       `destructive` claim on the action rather than from the write gate. */
    setConfig(RUNTIME_PLUGIN, "actions", "on");
    /* A big enough budget that the per-skill surface is used. The tool is NOT
       in that list — the allow-list removed it — which is the point: a model
       that names a real action anyway gets the gate's sentence rather than
       "there is no tool called that", which would be false. */
    setConfig(RUNTIME_PLUGIN, "tool_catalog_bytes", "4194304");
    writeCapability("local", "test-model", "tools", "fixture");

    const { directTurn } = await import("./loop.ts");
    for await (const e of directTurn([{ role: "user", content: "delete card 1" }], {
      signal: AbortSignal.timeout(20_000),
    })) {
      void e;
    }

    const result = (seen() as { role?: string; content?: string }[]).find((m) => m.role === "tool");
    assert.ok(result, "the loop fed a tool result back");
    const doc = JSON.parse(result!.content!) as { error: string; refused: string; reason: string };
    assert.equal(doc.refused, "board.delete_card");
    assert.match(doc.error, /cannot be undone/);
    assert.match(doc.error, /no confirmation step/);
    assert.match(doc.reason, /allow-list/);
    /* AND NOTHING WAS DELETED — the refusal happens before any request leaves
       this process, so there is no board route to have been called. */
  } finally {
    server.close();
    setConfig(RUNTIME_PLUGIN, "actions", "");
    setConfig(RUNTIME_PLUGIN, "tools", "");
    setConfig(RUNTIME_PLUGIN, "tool_catalog_bytes", "");
    setProviderChoiceReader(() => null);
  }
});

test("the tool list falls back to the index when the per-skill catalog is too big", async () => {
  const { catalogBytes } = await import("./tools.ts");
  const many: Skill[] = Array.from({ length: 40 }, (_, i) => ({
    id: `demo${i}`,
    title: `Demo ${i}`,
    plugins: [],
    about: "A long sentence about what this integration measures, in the units it measures it in, repeated enough times to be realistic. ".repeat(4),
    rules: [],
    asks: ["a question?"],
    views: [{ key: "default", path: "/api/demo", about: "the view", params: [] }],
  }));
  const perSkill = toolsFor(many, { actions: false });
  const index = indexTools(many, { actions: false });
  assert.ok(catalogBytes(perSkill) > 24 * 1024, "the fixture is over the default budget");
  assert.ok(
    catalogBytes(index) < catalogBytes(perSkill),
    "the index is smaller than one tool per skill",
  );
  /* AND IT IS NOT A DEGRADED SURFACE: every id is still named in the schema,
     so the model never has to spend a call to discover what exists. */
  const read = index.find((d) => d.name === "opc_read")!;
  const skillParam = read.schema.properties.skill as { enum: string[] };
  assert.deepEqual(skillParam.enum, many.map((s) => s.id));
});

/* ------------------------------------------------------- the write allow-list */

test("the write gate is an allow-list: a spend or send action is refused with writes ON", () => {
  const skill: Skill = {
    id: "demo",
    title: "Demo",
    plugins: [],
    about: "about",
    rules: [],
    asks: [],
    views: [{ key: "default", path: "/api/demo", about: "the view", params: [] }],
    actions: [
      { key: "create_card", method: "POST", path: "/api/demo", about: "write a row", params: [] },
      /* Marked, the way `proactive.send_now` and the rest now are. */
      { key: "send_now", method: "POST", path: "/api/demo/send", about: "send it", params: [], destructive: true },
      /* NOT marked — the case the flags alone would miss, and the whole reason
         there is a verb rule as well. */
      { key: "run_stage", method: "POST", path: "/api/demo/run", about: "run a stage", params: [] },
      { key: "dispatch", method: "POST", path: "/api/demo/dispatch", about: "dispatch a run", params: [] },
      { key: "submit", method: "POST", path: "/api/demo/submit", about: "tell a search engine", params: [] },
      { key: "refresh", method: "POST", path: "/api/demo/refresh", about: "refresh it", params: [] },
      { key: "wake", method: "POST", path: "/api/demo/wake", about: "wake a machine", params: [] },
      { key: "update_card", method: "PATCH", path: "/api/demo/:id", about: "edit a row", params: [] },
    ],
  };

  assert.deepEqual(
    allowedActions(skill).map((a) => a.key),
    ["create_card", "update_card"],
  );
  /* And every refusal says WHY, in a clause the model can pass on. */
  assert.match((actionGate(skill, skill.actions![1]!) as { why: string }).why, /irreversible/);
  assert.match((actionGate(skill, skill.actions![2]!) as { why: string }).why, /doing verb/);

  /* A skill that reaches off this machine cannot be written through at all,
     however its actions are named. */
  const open: Skill = { ...skill, id: "outward", openWorld: true };
  assert.deepEqual(allowedActions(open), []);
  assert.match((actionGate(open, open.actions![0]!) as { why: string }).why, /off this machine/);

  /* The tool list publishes only the allowed ones, on both surfaces. */
  assert.deepEqual(
    toolsFor([skill], { actions: true }).map((d) => d.name),
    ["opc_demo", "opc_demo_create_card", "opc_demo_update_card"],
  );
  assert.deepEqual(indexTools([open], { actions: true }).map((d) => d.name), ["opc_skills", "opc_read"]);
});

test("the registry's own send/spend actions are marked", async () => {
  /* THE FLAGS THEMSELVES, not a copy of them. If an area ever un-marks one of
     these, this fails here rather than the day a model presses it. */
  const { entry } = await import("../../skills/registry.ts");
  for (const [id, key] of [
    ["briefing", "send_now"],
    ["pipeline", "run_stage"],
    ["pipeline", "run_for_venture"],
    ["security", "wake"],
    ["security", "sleep"],
    ["snapshots", "take_now"],
    ["triage", "run"],
    ["people", "scan"],
  ] as [string, string][]) {
    const s = entry(id);
    if (!s) continue; // an area that is not installed in this build
    const a = (s.actions ?? []).find((x) => x.key === key);
    if (!a) continue;
    assert.equal(a.destructive, true, `${id}.${key} must be marked destructive`);
    assert.equal(actionGate(s, a).ok, false, `${id}.${key} must be off the allow-list`);
  }
});

/** A model that calls one named action once, then answers. The fake server
 *  keeps the messages it was sent, so the tool RESULT is inspectable. */
function callerModel(name: string, args: string): Promise<{ server: Server; url: string; seen: () => unknown[] }> {
  let asked = false;
  let last: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body || "{}") as { messages: unknown[]; tools?: unknown[] };
      last = sent.messages;
      const first = !asked && Array.isArray(sent.tools) && sent.tools.length > 0;
      if (first) asked = true;
      const message = first
        ? {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "x1", type: "function", function: { name, arguments: args } }],
          }
        : { role: "assistant", content: "I handed it back to you." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, seen: () => last });
    });
  });
}

function useFake(url: string, model = "test-model") {
  registerProvider("local", () => ({
    id: "local",
    label: "Test endpoint",
    endpoints: [{ baseUrl: url, key: null, label: "test" }],
    defaultModel: model,
    policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 },
  }));
  setProviderChoiceReader(() => "local");
  upsertPlugin(RUNTIME_PLUGIN, true, null);
  writeCapability("local", model, "tools", "fixture");
}

function clearRuntimeConfig() {
  for (const k of ["tools", "actions", "max_tool_calls", "tool_catalog_bytes", "turn_usd"])
    setConfig(RUNTIME_PLUGIN, k, "");
  setProviderChoiceReader(() => null);
}

test("a spend action named through the index surface is refused at the call, not only at publication", async () => {
  /* THE CASE THE PUBLICATION FILTER CANNOT COVER. `opc_act` takes an action
     NAME, so a model that guessed one — or read the registry some other way —
     can reach for something that was never in its tool list. */
  const { server, url, seen } = await callerModel(
    "opc_act",
    JSON.stringify({ skill: "briefing", action: "send_now", params: {} }),
  );
  try {
    useFake(url);
    setConfig(RUNTIME_PLUGIN, "tools", "on");
    setConfig(RUNTIME_PLUGIN, "actions", "on");
    /* Small, so the index surface is the one in play. */
    setConfig(RUNTIME_PLUGIN, "tool_catalog_bytes", "1024");

    const { directTurn } = await import("./loop.ts");
    for await (const e of directTurn([{ role: "user", content: "send the briefing" }], {
      signal: AbortSignal.timeout(20_000),
    }))
      void e;

    const result = (seen() as { role?: string; content?: string }[]).find((m) => m.role === "tool");
    assert.ok(result, "the loop fed a tool result back");
    const doc = JSON.parse(result!.content!) as { error?: string; refused?: string };
    assert.equal(doc.refused, "briefing.send_now");
    assert.match(doc.error!, /Refused/);
    /* AND NO REQUEST LEFT THIS PROCESS — the gate runs before the fetch, so
       there is no briefing route to have been called. */
  } finally {
    server.close();
    clearRuntimeConfig();
  }
});

/* ------------------------------------------------------------- P1 regressions */

/** A server that 400s on any request carrying `tools`, and answers in prose
 *  otherwise — a gateway routing to a model whose backend has no grammar. */
function toolsRefusingModel(): Promise<{ server: Server; url: string; tooled: () => number }> {
  let tooled = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body || "{}") as { tools?: unknown[] };
      if (Array.isArray(sent.tools) && sent.tools.length) {
        tooled += 1;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "this model does not support the tools parameter" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { role: "assistant", content: "Answered from the conversation." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, tooled: () => tooled });
    });
  });
}

test("a gateway that refuses the tools field falls back to text instead of failing the turn", async () => {
  const { server, url, tooled } = await toolsRefusingModel();
  try {
    useFake(url, "refusing-model");
    setConfig(RUNTIME_PLUGIN, "tools", "on");

    const { directTurn } = await import("./loop.ts");
    let answer = "";
    for await (const e of directTurn([{ role: "user", content: "hello" }], {
      signal: AbortSignal.timeout(20_000),
    }))
      if (e.type === "done") answer = e.text;

    /* THE TURN ANSWERED. Before the guard this threw and every chat turn on
       that gateway failed — where the same question used to be answered as
       text. */
    assert.equal(answer, "Answered from the conversation.");
    assert.equal(tooled(), 1, "it tried once with tools and did not try again");
    /* AND THE MEASUREMENT WAS CORRECTED, so the next turn does not pay for the
       same 400 and the settings page stops claiming tools. */
    const { capability } = await import("./store.ts");
    assert.equal(capability("local", "refusing-model")!.mode, "text");
  } finally {
    server.close();
    clearRuntimeConfig();
  }
});

test("the index document is bounded like every other tool answer", async () => {
  const { skillIndexDoc } = await import("./tools.ts");
  const { boundResponse } = await import("../agentcore/bound.ts");
  const { skills } = await import("../../skills/registry.ts");
  const raw = JSON.stringify(skillIndexDoc(skills(), { actions: false }));
  const bound = boundResponse(raw, { budget: 24 * 1024, how: "x" });
  assert.ok(new TextEncoder().encode(bound.text).length <= 24 * 1024, "the bounder holds it");
  /* AND THE INDEX ITSELF IS SHORT NOW, so the bounder is a backstop rather
     than the thing doing the work: the long `about` is paid once in the tool
     schema's enum and not again in the document. */
  const long = JSON.stringify({
    skills: skills().map((s) => ({ id: s.id, about: s.about, answers: s.asks })),
  });
  assert.ok(raw.length < long.length, `${raw.length} should be under ${long.length}`);
});

test("opc_skills lists no actions when writes are off, and only allowed ones when they are on", async () => {
  const { skillEntryDoc, skillIndexDoc } = await import("./tools.ts");
  const skill: Skill = {
    id: "demo",
    title: "Demo",
    plugins: [],
    about: "about",
    rules: [],
    asks: [],
    views: [{ key: "default", path: "/api/demo", about: "the view", params: [] }],
    actions: [
      { key: "create_card", method: "POST", path: "/api/demo", about: "write a row", params: [] },
      { key: "send_now", method: "POST", path: "/api/demo/send", about: "send it", params: [], destructive: true },
    ],
  };
  const off = skillEntryDoc(skill, { actions: false }) as Record<string, unknown>;
  /* The preamble tells the model "nothing you can call changes the owner's
     data"; a list of writes underneath that is a contradiction it acts on. */
  assert.equal("actions" in off, false);
  assert.equal("refusedHere" in off, false);

  const on = skillEntryDoc(skill, { actions: true }) as {
    actions: { action: string }[];
    refusedHere: { action: string; why: string }[];
  };
  assert.deepEqual(on.actions.map((a) => a.action), ["create_card"]);
  /* NAMED, NOT HIDDEN — so the model can say "there is a send_now and you are
     the one who can press it" rather than "there is no way to do that". */
  assert.deepEqual(on.refusedHere.map((a) => a.action), ["send_now"]);

  const idxOff = skillIndexDoc([skill], { actions: false }) as { skills: Record<string, unknown>[] };
  assert.equal("actions" in idxOff.skills[0]!, false);
  const idxOn = skillIndexDoc([skill], { actions: true }) as { skills: { actions: string[] }[] };
  assert.deepEqual(idxOn.skills[0]!.actions, ["create_card"]);
});

test("usage is the whole turn's, not the last round's", async () => {
  const { server, url } = await greedyModel();
  try {
    useFake(url);
    setConfig(RUNTIME_PLUGIN, "tools", "on");
    setConfig(RUNTIME_PLUGIN, "max_tool_calls", "3");

    const { directTurn } = await import("./loop.ts");
    let usage: { prompt: number; completion: number } | null = null;
    for await (const e of directTurn([{ role: "user", content: "look at everything" }], {
      signal: AbortSignal.timeout(20_000),
    }))
      if (e.type === "done") usage = e.usage;

    /* Four rounds at 10/5 each. Assigning the last round's would store 10/5 on
       a row while budget_usage recorded four reservations — two records of one
       turn that disagree, and one of them ends up on a cost page. */
    assert.deepEqual(usage, { prompt: 40, completion: 20 });
  } finally {
    server.close();
    clearRuntimeConfig();
  }
});
