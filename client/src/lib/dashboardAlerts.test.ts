import test from "node:test";
import assert from "node:assert/strict";
import { currentDashboardAlerts, type DashboardAlert, type FleetAlertInput } from "../../../shared/dashboardAlerts.ts";
import { alertsForDashboard, dashboardAlertRollup } from "./dashboardAlerts.ts";
import type { Dashboard } from "./store.tsx";

const now=Date.now();
const server={accountId:1,label:"Box",seenAt:new Date(now).toISOString(),error:null,sample:{cpuPercent:10,memory:{percent:30},swap:{percent:0},loadPerCpu:.2},disks:[{mount:"/",meter:{percent:20}}],containers:[]};
const fleet=(boxes:FleetAlertInput["boxes"]=[server]):FleetAlertInput=>({boxes,cadenceMinutes:30,thresholds:{warn:80,critical:90}});
const board=(id:string,types:string[],ventureId?:string):Dashboard=>({id,name:id,slug:id,ventureId,widgets:types.map((type,i)=>({id:String(i),type,w:1}))});
const alert=(id:string,sources:string[],extra:Partial<DashboardAlert>={}):DashboardAlert=>({id,sources,severity:"warning",title:id,detail:"",...extra});

test("current health badges share server thresholds, include containers, and clear on recovery",()=>{
  const busy={...server,sample:{...server.sample,cpuPercent:90,swap:{percent:100}},disks:[{mount:"/",meter:{percent:85}}],containers:[{name:"api",status:"restarting"}]};
  const issues=currentDashboardAlerts({fleet:fleet([busy])},now);
  assert.equal(issues.length,4);assert.equal(issues.filter(a=>a.severity==="critical").length,1);
  assert.equal(currentDashboardAlerts({fleet:fleet()},now).length,0);
  const missing={...server,sample:null,disks:[]};
  assert.equal(currentDashboardAlerts({fleet:{...fleet(),boxes:[missing]}},now)[0]?.id,"fleet:1:reporting");
});
test("a missing server produces one reporting incident instead of replaying stale resource alarms",()=>{
  const stale={...server,seenAt:new Date(now-4*3_600_000).toISOString(),sample:{...server.sample,cpuPercent:100},disks:[{mount:"/",meter:{percent:100}}]};
  const issues=currentDashboardAlerts({fleet:fleet([stale])},now);
  assert.deepEqual(issues.map(a=>a.id),["fleet:1:reporting"]);
});
test("domain expiry and TLS warnings respect unknown values, urgency and unique domain identities",()=>{
  const d=(name:string,days:number|null)=>({name,expiresInDays:days,autoRenew:true,registrar:"Registrar"});
  const issues=currentDashboardAlerts({domains:{domains:[d("soon.test",30),d("urgent.test",7),d("expired.test",-2),d("safe.test",31),d("unknown.test",null),d("soon.test",30)],summary:{thresholds:{crit:7,warn:30}}},uptime:{hosts:[{host:"site.test",current:{ok:false,error:"Timeout",status:null},tls:{daysLeft:5}}]}});
  assert.equal(issues.length,5);assert.equal(issues.filter(a=>a.severity==="critical").length,4);
  assert.equal(currentDashboardAlerts({}).length,0);
});
test("navigation counts unique alerts, not repeated widgets or appearances on multiple boards",()=>{
  const issues=[alert("disk",["fleet","hetzner"]),alert("domain",["domains"],{severity:"critical"}),alert("payment",["stripe"])];
  const boards=[board("d-overview",[]),board("servers",["servers.cards","server.disk","fleet.alerts"]),board("domains",["registrars.expiring"]),board("revenue",["stripe.mrr"])];
  const rollup=dashboardAlertRollup(boards,issues);
  assert.equal(rollup.total.count,3);assert.equal(rollup.total.critical,1);
  assert.equal(rollup.byBoard.servers?.count,1);assert.equal(rollup.byBoard.revenue?.count,1);
  assert.equal(rollup.byBoard.domains?.count,1);
  assert.equal(alertsForDashboard(board("renamed",["servers.cards","servers.cards"]),issues).count,1);
  assert.equal(alertsForDashboard(board("empty",[]),issues).count,0);
});
test("parameterized and venture dashboards do not inherit unrelated portfolio incidents",()=>{
  const issues=[alert("one",["fleet"],{entity:{kind:"server",id:"1"}}),alert("two",["fleet"],{entity:{kind:"server",id:"2"}}),alert("a",["uptime"],{entity:{kind:"host",id:"a.test"}}),alert("b",["uptime"],{entity:{kind:"host",id:"b.test"}})];
  const specific=board("specific",["server.cpu"]);specific.widgets[0]!.param="2";
  assert.deepEqual(alertsForDashboard(specific,issues).alerts.map(a=>a.id),["two"]);
  assert.deepEqual(alertsForDashboard(board("scoped",["uptime.up"],"venture-a"),issues,[{id:"venture-a",host:"a.test"}]).alerts.map(a=>a.id),["a"]);
});
test("billing widgets do not inherit unrelated server-resource or app-crash alerts",()=>{
  const health=currentDashboardAlerts({fleet:fleet([{...server,sample:{...server.sample,swap:{percent:100}}}])},now);
  assert.equal(alertsForDashboard(board("costs",["hetzner.spend","hetzner.spendSplit"]),health).count,0);
  assert.equal(alertsForDashboard(board("payments",["play.revenue","appstore.payout"]),[alert("crash",["stability"])]).count,0);
  assert.equal(alertsForDashboard(board("apps",["mobilehealth.crashRates"]),[alert("crash",["stability"])]).count,1);
  const apps=board("custom-id",["mobile.presence"]);apps.slug="apps";apps.name="Renamed apps";
  assert.equal(alertsForDashboard(apps,[alert("crash",["stability"])]).count,1);
});
