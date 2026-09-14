import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { db, ventureRow } from "../../db.ts";
import { ventureRoutes } from "../../routes/ventures.ts";
import { journeyRoutes, readJourney } from "./journey.ts";
import { insightRoutes } from "../insights/routes.ts";
import { BUSINESS_TYPES, JOURNEY_STAGES, emptyJourney, journeyTasks, journeyReadiness, journeyExport, type JourneyCommand, type JourneyDocument } from "../../../../shared/ventureJourney.ts";
import { JOURNEY_TEMPLATES } from "../../../../shared/ventureJourneyTemplates.ts";
import { shiftDay } from "../../../../shared/workJournal.ts";
const init = (method: string, data?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
let serial = 0;
test("multiple venture types survive API edits and archive all selected review tracks", async () => {
  const v = await create({ stage: "launched", businessTypes: ["web", "mobile"] });
  let doc = await read(v.id);
  assert.deepEqual(doc.businessTypes, ["web", "mobile"]);
  const picked = journeyTasks(emptyJourney(), "launched", ["web", "mobile"]);
  for (const type of ["web", "mobile"])
    await saved(v.id, { kind: "task", key: picked.find(t => t.businessType === type)!.key, status: "done", evidence: "Reviewed" });
  const untouched = journeyTasks(emptyJourney(), "launched", "goods").find(t => t.businessType === "goods")!;
  await saved(v.id, { kind: "task", key: untouched.key, status: "done", evidence: "Saved from another track" });
  assert.equal((await update(v.id, { kind: "start-review", businessType: "web", businessTypes: ["web"] })).status, 409);
  doc = await saved(v.id, { kind: "start-review", businessType: "web", businessTypes: ["web", "mobile"] });
  assert.equal(doc.reviews[0]!.done, 2);
  assert.deepEqual(doc.reviews[0]!.businessTypes, ["web", "mobile"]);
  assert.equal(doc.reviews[0]!.total, picked.length);
  assert(picked.every(t => !doc.state.tasks[t.key]));
  assert.equal(doc.state.tasks[untouched.key]!.status, "done");
  const renamed = await ventureRoutes.request(`/${v.id}`, init("PATCH", { name: "Both platforms", businessType: "web" }));
  assert.deepEqual((await renamed.json() as { businessTypes: string[] }).businessTypes, ["web", "mobile"]);
  for (const value of ["web", ["web", "unknown"], null])
    assert.equal((await ventureRoutes.request(`/${v.id}`, init("PATCH", { businessTypes: value }))).status, 400);
  assert.deepEqual((await read(v.id)).businessTypes, ["web", "mobile"]);
});
async function create(body: Record<string, unknown> = {}) {
  const r = await ventureRoutes.request("/", init("POST", { name: `Journey test ${++serial}`, ...body }));
  assert.equal(r.status, 201, await r.clone().text());
  return await r.json() as { id: string; slug: string; stage: string; businessType: string | null; updatedAt: string };
}
const read = async (id: string) => await (await journeyRoutes.request(`/${id}`)).json() as JourneyDocument;
async function update(id: string, command: JourneyCommand, revision?: number) {
  return journeyRoutes.request(`/${id}`, init("PATCH", { revision: revision ?? (await read(id)).revision, command }));
}
async function saved(id: string, command: JourneyCommand) {
  const r = await update(id, command); assert.equal(r.status, 200, await r.clone().text()); return await r.json() as JourneyDocument;
}

test("all 21 business/stage combinations have distinct, unfinished and tailored plans", () => {
  assert.equal(new Set(JOURNEY_TEMPLATES.map(t => t.key)).size, JOURNEY_TEMPLATES.length);
  for (const type of BUSINESS_TYPES) for (const stage of JOURNEY_STAGES) {
    const state = emptyJourney(), tasks = journeyTasks(state, stage, type.id), result = journeyReadiness(tasks, state.tasks);
    assert.ok(tasks.length >= 7); assert.ok(tasks.some(t => t.businessType === type.id));
    assert.ok(tasks.every(t => t.stage === stage && (t.businessType === null || t.businessType === type.id)));
    assert.equal(result.done, 0); assert.equal(result.percent, 0); assert.equal(result.open.length, tasks.length);
  }
  assert.ok(journeyTasks(emptyJourney(), "idea", null).every(t => t.businessType === null));
});
test("legacy ventures stay unclassified; reads never seed dashboards or mark tasks complete", async () => {
  const v = await create(); assert.equal(v.businessType, null); assert.equal(v.stage, "idea");
  const before = db.prepare("SELECT * FROM workspace_preferences").all();
  const doc = await read(v.slug); assert.equal(doc.revision, 0); assert.deepEqual(doc.state, emptyJourney());
  assert.deepEqual(db.prepare("SELECT * FROM workspace_preferences").all(), before);
  assert.equal(db.prepare("SELECT venture_id FROM venture_journeys WHERE venture_id = ?").get(v.id), undefined);
});
test("profile, evidence and custom steps persist without leaking across ventures or tracks", async () => {
  const a = await create({ businessType: "mobile" }), b = await create({ businessType: "web" });
  await saved(a.id, { kind: "profile", values: { customer: "Local teams", problem: "Missed handoffs", launchDate: "2028-02-29" } });
  const task = journeyTasks(emptyJourney(), "idea", "mobile").find(t => t.businessType === "mobile")!;
  await saved(a.id, { kind: "task", key: task.key, status: "done", evidence: "Three interviews; a paid pilot requested." });
  let doc = await saved(a.id, { kind: "add-task", stage: "pre-launch", businessType: "mobile", title: "Pilot acceptance", detail: "A tester completes the full flow", required: true });
  const custom = doc.state.custom[0]!;
  doc = await saved(a.id, { kind: "task", key: custom.key, status: "skipped", evidence: "This release uses a closed internal pilot." });
  assert.equal((await update(b.id, { kind: "task", key: custom.key, status: "done", evidence: "" })).status, 400);
  assert.deepEqual((await read(b.id)).state, emptyJourney());
  assert.ok(!journeyTasks(doc.state, "pre-launch", "web").some(t => t.key === custom.key));
  assert.ok(journeyTasks(doc.state, "pre-launch", "mobile").some(t => t.key === custom.key));
  const path = (db.prepare("PRAGMA database_list").all() as { file: string }[])[0]!.file;
  const separate = new DatabaseSync(path, { readOnly: true });
  try { const stored = separate.prepare("SELECT state FROM venture_journeys WHERE venture_id = ?").get(a.id) as { state: string }; assert.deepEqual(JSON.parse(stored.state), doc.state); } finally { separate.close(); }
  assert.equal((journeyExport("A", doc).state.tasks[task.key])?.evidence, "Three interviews; a paid pilot requested.");
});
test("every stage and type change preserves progress, links and custom dashboard preferences", async () => {
  let v = await create({ businessType: "web" });
  db.prepare("INSERT OR REPLACE INTO workspace_preferences (id,revision,data,updated_at) VALUES (1,41,?,?)").run(JSON.stringify({ dashboards: [{ id: "my-custom-server-dashboard", widgets: ["mine"] }] }), new Date().toISOString());
  db.prepare("INSERT INTO venture_links (venture_id,plugin,entity,source,created_at) VALUES (?,?,?,'owner',?)").run(v.id, "example", "my-entity", new Date().toISOString());
  const snapshot = db.prepare("SELECT * FROM workspace_preferences").all();
  await saved(v.id, { kind: "task", key: "idea:common:customer", status: "done", evidence: "Real buyer interviews" });
  for (const type of BUSINESS_TYPES) for (const stage of JOURNEY_STAGES) {
    const response = await ventureRoutes.request(`/${v.id}`, init("PATCH", { stage, businessType: type.id, stageChangeNote: "Owner decision", expectedUpdatedAt: v.updatedAt }));
    assert.equal(response.status, 200, await response.clone().text()); v = await response.json() as typeof v;
    const doc = await read(v.id); assert.equal(doc.stage, stage); assert.equal(doc.businessType, type.id);
    assert.equal(doc.state.tasks["idea:common:customer"]?.status, "done");
  }
  const doc = await read(v.id); assert.equal(doc.history.length, 20); assert.ok(doc.history.every(h => h.note === "Owner decision"));
  assert.equal(db.prepare("SELECT entity FROM venture_links WHERE venture_id = ?").get(v.id)?.entity, "my-entity");
  assert.deepEqual(db.prepare("SELECT * FROM workspace_preferences").all(), snapshot);
});
test("stale and simultaneous edits are rejected instead of replacing another window's work", async () => {
  const v = await create();
  const command: JourneyCommand = { kind: "profile", values: { customer: "First writer" } };
  const responses = await Promise.all([update(v.id, command, 0), update(v.id, { kind: "profile", values: { customer: "Second writer" } }, 0)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal((await read(v.id)).revision, 1);
  const patch = { stage: "pre-launch", expectedUpdatedAt: v.updatedAt };
  assert.equal((await ventureRoutes.request(`/${v.id}`, init("PATCH", patch))).status, 200);
  assert.equal((await ventureRoutes.request(`/${v.id}`, init("PATCH", { ...patch, stage: "launched" }))).status, 409);
  assert.equal((await read(v.id)).history.length, 1);
});
test("invalid mutations and skip-without-evidence never alter the saved plan", async () => {
  const v = await create();
  const invalid: unknown[] = [null, [], { kind: "profile", values: { launchDate: "2027-02-29" } }, { kind: "profile", values: { customer: 3 } }, { kind: "profile", values: { ignored: "x" } }, JSON.parse('{"kind":"profile","values":{"__proto__":"bad"}}'), { kind: "task", key: "constructor", status: "done", evidence: "" }, { kind: "task", key: "idea:common:customer", status: "skipped", evidence: "  " }, { kind: "task", key: "idea:common:customer", status: "done", evidence: "x".repeat(8001) }, { kind: "delete-task", key: "idea:common:customer" }, { kind: "add-task", stage: "bogus", businessType: null, title: "A", detail: "", required: true }];
  for (const command of invalid) assert.equal((await journeyRoutes.request(`/${v.id}`, init("PATCH", { revision: 0, command }))).status, 400);
  for (const body of [{ businessType: "invented" }, { stage: "archived" }, { stageChangeNote: 42, stage: "launched" }]) assert.equal((await ventureRoutes.request(`/${v.id}`, init("PATCH", body))).status, 400);
  assert.equal((await read(v.id)).revision, 0); assert.deepEqual((await read(v.id)).state, emptyJourney());
  assert.equal((await journeyRoutes.request("/missing")).status, 404);
});
test("name decisions are explicit, keep evidence and do not rename or buy anything", async () => {
  const v = await create();
  const candidate = { kind: "name", name: "A name", domain: "example.com", status: "unchecked", evidence: "" } as const;
  let doc = await saved(v.id, candidate); assert.equal(doc.state.names[0]?.status, "unchecked");
  const id = doc.state.names[0]!.id;
  assert.equal((await update(v.id, { ...candidate, id, status: "chosen" })).status, 400);
  assert.equal((await update(v.id, { ...candidate, domain: "https://example.com/path" })).status, 400);
  doc = await saved(v.id, { ...candidate, id, status: "chosen", evidence: "Registrar check and existing brand review, dated today" });
  assert.equal(doc.state.names[0]?.status, "chosen"); assert.equal(ventureRow(v.id)?.name, `Journey test ${serial}`);
  doc = await saved(v.id, { ...candidate, name: "A second name", status: "chosen", evidence: "Checks documented" });
  assert.equal(doc.state.names.filter(n => n.status === "chosen").length, 1);
  doc = await saved(v.id, { kind: "delete-name", id }); assert.equal(doc.state.names.length, 1);
});
test("operating reviews retain evidence and reset only the selected operating track", async () => {
  const v = await create({ stage: "launched", businessType: "shop" });
  const common = "launched:common:weekly", goods = journeyTasks(emptyJourney(), "launched", "goods").find(t => t.businessType === "goods")!.key;
  await saved(v.id, { kind: "task", key: common, status: "done", evidence: "Reviewed receipts; repeat buyers increased" });
  await saved(v.id, { kind: "task", key: goods, status: "done", evidence: "Kept from previous goods track" });
  await saved(v.id, { kind: "task", key: "idea:common:customer", status: "done", evidence: "Original interviews" });
  assert.equal((await update(v.id, { kind: "start-review", businessType: "goods" })).status, 409);
  assert.equal((await read(v.id)).reviews.length, 0);
  const doc = await saved(v.id, { kind: "start-review", businessType: "shop" });
  assert.equal(doc.state.tasks[common], undefined); assert.equal(doc.state.tasks[goods]?.status, "done"); assert.equal(doc.state.tasks["idea:common:customer"]?.status, "done");
  const id = doc.reviews[0]!.id, response = await journeyRoutes.request(`/${v.id}/reviews/${id}`); assert.equal(response.status, 200);
  const archive = await response.json() as { progress: Record<string, { evidence: string }> }; assert.match(archive.progress[common]!.evidence, /repeat buyers/);
  const other = await create(); assert.equal((await journeyRoutes.request(`/${other.id}/reviews/${id}`)).status, 404);
  assert.equal((await update(v.id, { kind: "start-review", businessType: "shop" })).status, 400);
});
test("venture signals exclude portfolio and other ventures, retaining missing measurements", async () => {
  const a = await create(), b = await create(), today = new Date().toISOString().slice(0, 10), yesterday = shiftDay(today, -1);
  for (const [id, ventureId] of [["mine", a.id], ["other", b.id], ["portfolio", null]] as const) {
    const response = await insightRoutes.request("/sources", init("POST", { id, label: id, ventureId, metric: "custom", unit: "orders", observedAt: new Date().toISOString(), completeThrough: yesterday, points: [{ day: shiftDay(today, -2), value: 10 }, { day: yesterday, value: null }] }));
    assert.equal(response.status, 201);
  }
  const r = await journeyRoutes.request(`/${a.id}/signals`); assert.equal(r.status, 200);
  const doc = await r.json() as { series: { source: { id: string; ventureId: string }; pace: { projected: number | null }; anomaly: { state: string } }[] };
  assert.equal(doc.series.length, 1); assert.equal(doc.series[0]?.source.id, "import:mine"); assert.equal(doc.series[0]?.pace.projected, null); assert.equal(doc.series[0]?.anomaly.state, "unavailable");
});
test("custom task deletion and venture deletion cascade only owned journey records", async () => {
  const a = await create(), b = await create(); let doc = await saved(a.id, { kind: "add-task", title: "My step", detail: "", stage: "idea", businessType: null, required: false });
  const key = doc.state.custom[0]!.key; await saved(a.id, { kind: "task", key, status: "done", evidence: "Result" });
  doc = await saved(a.id, { kind: "delete-task", key }); assert.equal(doc.state.custom.length, 0); assert.equal(doc.state.tasks[key], undefined);
  await saved(b.id, { kind: "profile", values: { customer: "Keep me" } });
  db.prepare("DELETE FROM ventures WHERE id = ?").run(a.id);
  assert.equal(db.prepare("SELECT * FROM venture_journeys WHERE venture_id = ?").get(a.id), undefined); assert.equal(readJourney(ventureRow(b.id)!).state.profile.customer, "Keep me");
});
