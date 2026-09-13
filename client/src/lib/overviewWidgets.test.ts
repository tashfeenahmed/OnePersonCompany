import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_BUILDERS, type LiveInputs } from "./liveWidgets.ts";
import { WIDGETS } from "../data/widgets.ts";
import { measuredWidget } from "./widgetView.ts";
import { cycleWidgetWidth, widgetSpan } from "./widgetLayout.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";
const build = (key: string, data: Record<string, unknown>) => LIVE_BUILDERS[key]!({points:[], ...data} as LiveInputs);

test("overview cards stay empty without measurements, including their inherited catalog samples", () => {
  for (const [key, base] of Object.entries(WIDGETS).filter(([k])=>k.startsWith("brief."))) {
    const patch = build(key, {});
    assert.equal(patch, null, key);
    const result = measuredWidget(base, patch);
    assert.equal(result.value, undefined, key);
    assert.equal(result.series, undefined, key);
    assert.equal(result.presentation, base.presentation, key);
  }
});
test("net card accounts for exactly its ledger gross and keeps sterling", () => {
  const p=build("brief.net",{window:7,stripe:{revenue:[{currency:"GBP",gross:1000,net:800,series:[]} ]}})!;
  assert.match(p.name!,/7d/);
  assert.match(p.value!,/£800/);
  assert.deepEqual(p.parts?.map(p=>p.value),[200,800]);
  assert.match(p.caption!,/Stripe ledger only/);
  const loss=build("brief.net",{stripe:{revenue:[{currency:"GBP",gross:100,net:-20,series:[]}]}})!;
  assert.deepEqual(loss.parts,[],"negative net is not a positive share");
});
test("traffic widgets respect Umami's fixed window and preserve total views in the split", () => {
  const websites=Array.from({length:5},(_,i)=>({name:`site${i}`,domain:`site${i}.com`,window:{pageviews:(i+1)*100,visitors:20}}));
  const umami={portfolio:{answering:5,window:{days:30,pageviews:1500},days:[]},websites};
  const p=build("brief.views",{window:7,umami})!;
  assert.equal(p.name,"Views · 30d");
  assert.equal(p.parts?.reduce((n,p)=>n+p.value,0),1500);
  assert.equal(p.parts?.length,4);
  assert.equal(p.parts?.at(-1)?.label,"Other sites");
  const traffic=build("brief.traffic",{umami})!;
  assert.equal(traffic.dumbbell?.length,5);
  assert.deepEqual(traffic.names,["Visitors","Pageviews"]);
});
test("unlike Play payout currencies never share a ranked bar scale",()=>{
  const p=build("brief.play",{mobile:{play:{connected:true,packages:[{package:"com.one.app",payout:[{amount:20,currency:"USD"},{amount:30,currency:"EUR"}]}]}}})!;
  assert.deepEqual(p.ranked,[]);
  assert.equal(p.rows?.length,2);
  assert.match(p.caption!,/original currencies/);
});
test("a resized third-width card persists through the shared workspace contract",()=>{
  const def=WIDGETS["brief.arr"]!;
  const initial={id:"w",type:"brief.arr",w:2 as const};
  assert.equal(widgetSpan(initial,def),4);
  const resized={...initial,...cycleWidgetWidth(initial,def)};
  assert.equal(widgetSpan(resized,def),5);
  assert.equal(widgetSpan({w:1}),3,"existing quarter widths are preserved");
  const prefs={workspace:{name:"Test",owner:"Owner"},sessions:[],dashboards:[{id:"d",name:"Test",slug:"test",widgets:[resized]}]};
  assert.equal(isWorkspacePreferences(prefs),true);
  assert.equal(isWorkspacePreferences({...prefs,dashboards:[{...prefs.dashboards[0],widgets:[{...resized,span:13}]}]}),false);
});
test("missing traffic measurements are omitted, not plotted as zero",()=>{
  const missing={name:"Missing",domain:"missing.test",window:{visitors:null,pageviews:100}};
  const known={name:"Known",domain:"known.test",window:{visitors:20,pageviews:100}};
  const p=build("brief.traffic",{umami:{portfolio:{window:{days:30}},websites:[missing,known]}})!;
  assert.equal(p.dumbbell?.length,1);
  assert.equal(p.dumbbell?.[0]?.a,20);
});
