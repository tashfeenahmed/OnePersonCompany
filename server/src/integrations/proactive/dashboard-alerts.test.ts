import test from "node:test";
import assert from "node:assert/strict";
import { insertRule, insertEvent, openRuleEvents, ackEvent, deleteRule, updateRule } from "./store.ts";
import { dashboardAlerts } from "./dashboard-alerts.ts";
import { alertRoutes } from "./alerts-routes.ts";

const make=(skill="fleet",seeded=false)=>insertRule({name:"Dashboard regression",skill,view:"default",params:{},path:"totals.fullestDisk.percent",op:">",threshold:85,windowMinutes:null,ventureId:null,enabled:true,cooldownMinutes:0,seeded});
const emit=(ruleId:number,kind:"trip"|"unreadable"|"test"="trip")=>insertEvent({ruleId,kind,observed:90,previous:80,message:"Threshold crossed"});

test("navigation returns one issue per rule without losing old open rules after 500 events",()=>{
  const older=make(),noisy=make();
  try {
    const old=emit(older.id);
    for(let i=0;i<505;i++)emit(noisy.id);
    emit(noisy.id,"test");const unreadable=emit(noisy.id,"unreadable");
    const found=openRuleEvents().filter(e=>[older.id,noisy.id].includes(e.rule_id));
    assert.equal(found.length,2);assert.ok(found.some(e=>e.id===old.id));
    ackEvent(unreadable.id);
    assert.equal(openRuleEvents().filter(e=>e.rule_id===noisy.id).length,1);
  } finally {deleteRule(older.id);deleteRule(noisy.id);}
});
test("seeded portfolio summaries do not double-count health issues, but edited thresholds are preserved",async()=>{
  const r=make("fleet",true);
  try {
    emit(r.id);
    assert.ok(!(await dashboardAlerts()).alerts.some(a=>a.id===`rule:${r.id}`));
    updateRule(r.id,{threshold:70});
    assert.ok((await dashboardAlerts()).alerts.some(a=>a.id===`rule:${r.id}`));
  } finally {deleteRule(r.id);}
});
test("rule acknowledgement and deletion immediately remove dashboard badges; test events never create one",async()=>{
  const r=make("stripe");
  try {
    const e=emit(r.id);emit(r.id,"test");
    const before=await alertRoutes.request("/navigation");
    assert.equal(before.status,200);
    assert.ok((await before.json() as {alerts:{id:string}[]}).alerts.some(a=>a.id===`rule:${r.id}`));
    ackEvent(e.id);
    assert.ok(!(await dashboardAlerts()).alerts.some(a=>a.id===`rule:${r.id}`));
    emit(r.id);deleteRule(r.id);
    assert.ok(!(await dashboardAlerts()).alerts.some(a=>a.id===`rule:${r.id}`));
  } finally {deleteRule(r.id);}
});
