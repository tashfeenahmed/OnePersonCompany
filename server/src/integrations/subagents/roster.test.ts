import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, now } from "../../db.ts";
import { boundResponse, DEFAULT_RESPONSE_BYTES } from "../agentcore/bound.ts";
import { entry, view } from "../../skills/registry.ts";
import { subagentRoutes } from "./routes.ts";
import { ensureTeam, subagentId, workerRoster } from "./store.ts";

beforeEach(() => {
  db.exec("DELETE FROM agent_runs; DELETE FROM subagents; DELETE FROM ventures;");
  const insert = db.prepare("INSERT INTO ventures(id,slug,name,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 30; i++) insert.run(`v-opaque-${i}`, `business-${i}`, `Business ${i}`, "launched", "#334455", "owner", now(), now(), i,
    JSON.stringify({ favicon: `data:image/png;base64,${"a".repeat(8_000)}` }));
  ensureTeam();
  db.prepare("UPDATE subagents SET instructions = ?").run("Owner's standing instructions. ".repeat(200));
});

test("a late venture's worker remains discoverable inside the tool response budget", async () => {
  const id = subagentId("v-opaque-29", "seo");
  db.prepare("UPDATE subagents SET enabled=0, name=? WHERE id=?").run("Search specialist", id);
  const response = await subagentRoutes.request("/roster?venture=business-29&role=seo");
  assert.equal(response.status, 200);
  const text = await response.text();
  const bounded = boundResponse(text, { budget: DEFAULT_RESPONSE_BYTES, pretty: true });
  assert.equal(bounded.bounded, false, "branding and standing instructions must not crowd out the worker");
  const doc = JSON.parse(bounded.text);
  assert.equal(doc.total, 1);
  assert.equal(doc.nextOffset, null);
  assert.equal(doc.workers.length, 1);
  assert.equal(doc.workers[0].id, id);
  assert.equal(doc.workers[0].name, "Search specialist");
  assert.equal(doc.workers[0].enabled, false);
  assert.equal(doc.workers[0].venture.id, "v-opaque-29");
  assert.deepEqual(doc.roles.map((role: { role: string }) => role.role), ["seo"]);
  assert.ok(bounded.bytes < 2_000, "an exact worker lookup fits even a small terminal result");
  assert.ok(!text.includes("data:image") && !text.includes("standing instructions"));
  const byId = await (await subagentRoutes.request("/roster?venture=v-opaque-29&role=seo")).json();
  assert.deepEqual(byId, doc);
});

test("all workers are reachable through stable pages and portfolio lookup needs no venture", async () => {
  const found: string[] = [];
  let offset: number | null = 0, total = 0;
  while (offset !== null) {
    const page = workerRoster({ limit: 20, offset });
    total = page.total;
    const bounded = boundResponse(JSON.stringify(page), { budget: DEFAULT_RESPONSE_BYTES, pretty: true });
    assert.equal(bounded.bounded, false);
    found.push(...page.workers.map(w => w.id));
    offset = page.nextOffset;
  }
  assert.equal(found.length, total);
  assert.equal(new Set(found).size, total);
  const response = await subagentRoutes.request("/roster?role=people");
  const doc = await response.json() as ReturnType<typeof workerRoster>;
  assert.equal(doc.total, 1);
  assert.equal(doc.workers[0]!.portfolio, true);
  assert.equal(doc.workers[0]!.venture, null);
});

test("unknown targets and invalid paging fail explicitly, and the agent catalog exposes the compact view", async () => {
  for (const [query, status] of [
    ["venture=missing", 404], ["role=missing", 400], ["venture=business-1&role=people", 400],
    ["limit=51", 400], ["limit=0", 400], ["limit=NaN", 400], ["offset=-1", 400], ["offset=1.2", 400],
  ] as const) assert.equal((await subagentRoutes.request(`/roster?${query}`)).status, status, query);
  const skill = entry("subagents")!;
  assert.equal(view(skill, null)?.path, "/api/subagents/roster");
  assert.equal(view(skill, "roster")?.path, "/api/subagents/roster");
  assert.equal(view(skill, "default")?.path, "/api/subagents", "full org remains available");
  assert.deepEqual(view(skill, "roster")?.params.map(p => p.name), ["venture", "role", "limit", "offset"]);
});

test("roster busy state includes jobs started outside chat delegation", async () => {
  db.prepare("INSERT INTO agent_runs(id,kind,venture_id,title,input,status,queued_at,started_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("run-existing", "seo", "v-opaque-29", "Existing review", "{}", "running", now(), now());
  const doc = await (await subagentRoutes.request("/roster?venture=business-29&role=seo")).json() as ReturnType<typeof workerRoster>;
  const worker = doc.workers[0]!;
  assert.equal(worker.running, true);
  assert.equal(worker.lastRun?.id, "run-existing");
  assert.equal(worker.lastRun?.status, "running");
  assert.ok(worker.lastRun?.url.includes("run-existing"));
});

test("every role tells a dispatcher what its brief is used as, and a standard job needs none", async () => {
  const { roleInfos } = await import("./store.ts");
  const { delegationLines } = await import("./delegation.ts");
  const roles = Object.fromEntries(roleInfos().map((r) => [r.role, r.brief]));
  assert.equal(roles.visibility?.field, "questions");
  assert.equal(roles.visibility?.required, false);
  assert.equal(roles.writer?.field, "topic");
  assert.equal(roles.people?.required, true);
  /* The retired roles do not come back through the roster. */
  assert.equal(roles.producer, undefined);
  assert.equal(roles.campaigns, undefined);
  const lines = delegationLines("s-1", true).join("\n");
  assert.match(lines, /role `visibility`[^\n]*BRIEF = Extra questions \(optional\)/);
  assert.match(lines, /role `people`[^\n]*\(required\)/);
  assert.doesNotMatch(lines, /role `(producer|campaigns)`/);

  /* And the route agrees: no brief is a run, not a 400, where the field is optional. */
  const res = await subagentRoutes.request("/dispatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "visibility", venture: "business-1" }),
  });
  assert.equal(res.status, 201);
  const made = await res.json() as { run: { id: string } };
  const row = db.prepare("SELECT input FROM agent_runs WHERE id=?").get(made.run.id) as { input: string };
  assert.ok(!JSON.parse(row.input).questions);
});

test("a dispatch carries the form's defaults, so a teardown asked for in chat reads the default number of pages", async () => {
  const res = await subagentRoutes.request("/dispatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "serp", venture: "business-2", brief: "free llm api" }),
  });
  assert.equal(res.status, 201);
  const made = await res.json() as { run: { id: string } };
  const input = JSON.parse((db.prepare("SELECT input FROM agent_runs WHERE id=?").get(made.run.id) as { input: string }).input);
  assert.equal(input.results, "5");
  /* `queries` is literal — the brief lands as typed, with no preface. */
  assert.equal(input.queries, "free llm api");
});

test("a dispatch reads its other inputs from a JSON string, which is all the CLI can carry", async () => {
  const res = await subagentRoutes.request("/dispatch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "serp", venture: "business-3", input: '{"results":"8"}' }),
  });
  assert.equal(res.status, 201);
  const made = await res.json() as { run: { id: string } };
  const input = JSON.parse((db.prepare("SELECT input FROM agent_runs WHERE id=?").get(made.run.id) as { input: string }).input);
  assert.equal(input.results, "8");
});

test("a dispatch to a retired role is refused, and the migration leaves no worker behind for it", async () => {
  for (const role of ["producer", "campaigns"]) {
    const res = await subagentRoutes.request("/dispatch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, venture: "business-1", brief: "anything" }),
    });
    assert.notEqual(res.status, 201, role);
    assert.equal((await subagentRoutes.request(`/roster?role=${role}`)).status, 400, role);
  }
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM subagents WHERE role IN ('producer','campaigns')").get() as { n: number }).n,
    0,
  );
});
