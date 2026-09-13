import test from "node:test";
import assert from "node:assert/strict";
import { migrateWorkspace } from "./workspaceMigrations.ts";
import type { Dashboard, StoreState } from "./store";

function saved(dashboards: Dashboard[], seedVersion = 26): StoreState {
  return { seedVersion, workspace: { name:"My company", owner:"Owner",defaultVentureId:null }, dashboards, sessions:[], ventures:[], plugins:{} } as StoreState;
}
const servers: Dashboard = {
  id:"d-servers", name:"My servers", slug:"servers", ventureId:null,
  widgets:[
    {id:"custom-cpu",type:"fleet.cpu",w:4,span:8,param:"my-server"},
    {id:"custom-disk",type:"fleet.disk",w:2,span:4},
  ],
};
const usage: Dashboard = {id:"d-custom",name:"LLM Usage",slug:"llm-usage",ventureId:null,widgets:[{id:"mine",type:"runtime.tokens",w:4}]};

test("a template version upgrade preserves customized dashboards and deliberate deletions", () => {
  // Revenue, Costs and all the other starter boards were deliberately removed.
  const before = saved([usage, servers]);
  const original = structuredClone(before);
  const after = migrateWorkspace(before, 27);
  assert.deepEqual(after.dashboards, original.dashboards);
  assert.equal(after.dashboards, before.dashboards);
  assert.equal(after.seedVersion, 27);
  assert.deepEqual(before, original, "migration must not mutate the saved source");
  assert.deepEqual(migrateWorkspace(after, 28).dashboards, original.dashboards, "later releases cannot resurrect defaults either");
});

test("an intentionally empty dashboard list stays empty", () => {
  assert.deepEqual(migrateWorkspace(saved([]),27).dashboards,[]);
});

test("an older Overview keeps its selected widgets, order and resized widths", () => {
  const overview: Dashboard = {id:"d-overview",name:"My overview",slug:"overview",widgets:[
    {id:"b",type:"stripe.net30",w:4},
    {id:"a",type:"revenue.combined",w:2},
  ]};
  assert.deepEqual(migrateWorkspace(saved([overview],23),27).dashboards,[overview]);
});

test("legacy address repair preserves every dashboard and widget", () => {
  const legacy = {...servers,id:"legacy",name:"Servers",slug:""};
  const before = saved([servers,legacy]);
  const after = migrateWorkspace(before,27);
  assert.equal(after.dashboards[0],servers);
  assert.equal(after.dashboards[1]!.slug,"servers-2");
  assert.equal(after.dashboards[1]!.widgets,legacy.widgets);
  assert.equal(before.dashboards[1]!.slug,"");
});

test("current and newer documents retain their identity and version", () => {
  for (const version of [27,28]) {
    const state=saved([servers,usage],version);
    assert.equal(migrateWorkspace(state,27),state);
  }
});
