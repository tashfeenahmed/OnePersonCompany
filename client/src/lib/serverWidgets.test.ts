import test from "node:test";
import assert from "node:assert/strict";
import { meanServerLoad, serverCard, serverFleet, serverAddress, SERVER_BUILDERS } from "./serverWidgets.ts";
import { WIDGETS } from "../data/widgets.ts";
import { measuredWidget } from "./widgetView.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";
import { migrateWorkspace } from "./workspaceMigrations.ts";
import type { StoreState } from "./store.tsx";
import type { FleetBox, FleetReport } from "./api/reports.ts";
import type { LiveInputs } from "./liveWidgets.ts";

const now=Date.now();
const iso=(hours:number)=>new Date(now-hours*3_600_000).toISOString();
const reading=(percent:number)=>({used:percent,free:100-percent,percent,level:"ok" as const});
function box(patch:Partial<FleetBox>={}):FleetBox {
  return {accountId:1,label:"Test box",target:"user@192.0.2.10",hostname:"machine",kernel:"Linux",seenAt:iso(0),okAt:iso(0),error:null,
    sample:{ts:iso(0),uptimeSeconds:3600,cpus:2,cpuPercent:20,load:{one:0.2,five:0.2,fifteen:0.2},loadPerCpu:0.1,memory:reading(50),memoryTotal:100,swap:null},
    disks:[{mount:"/",size:100,used:20,avail:80,meter:reading(20)}],docker:{installed:true,running:2},containers:[],counters:[],
    samples:[{ts:iso(2),load1:0.1,cpuPercent:10,cpus:2,memUsed:40,memTotal:100,swapUsed:null,swapTotal:null},{ts:iso(0),load1:0.2,cpuPercent:20,cpus:2,memUsed:50,memTotal:100,swapUsed:null,swapTotal:null}],...patch};
}
function input(boxes:FleetBox[]):LiveInputs {
  return {points:[],boxes:{boxes,window:{hours:720,unit:"bytes"},thresholds:{warn:80,critical:90},cadenceMinutes:30} as FleetReport};
}

test("fleet load weights each reporting host equally and never fills missing data with zero",()=>{
  const a="2026-09-13T08:00:00Z",b="2026-09-13T08:30:00Z";
  const points=meanServerLoad([{id:"one",load:[{ts:a,value:10},{ts:"2026-09-13T08:01:00Z",value:30},{ts:b,value:60}]},{id:"two",load:[{ts:a,value:80}]}],30);
  assert.deepEqual(points.map(p=>p.value),[50,60]);
  assert.deepEqual(meanServerLoad([{id:"none",load:[{ts:a,value:NaN},{ts:"bad",value:10}]}],30),[]);
});
test("server cards distinguish unavailable measurements from zero and distinguish high resource use from outages",()=>{
  const missing=box({sample:null,disks:[],samples:[],docker:null});
  const view=serverCard(missing,input([missing]),now);
  assert.equal(view.status,"unknown");
  assert.deepEqual(view.meters.map(m=>m.value),[null,null,null]);
  assert.equal(view.load.length,0);
  const stale=box({seenAt:iso(2)});
  assert.equal(serverCard(stale,input([stale]),now).status,"down");
  const busy=box();busy.sample!.cpuPercent=95;
  assert.equal(serverCard(busy,input([busy]),now).status,"degraded");
  const failed=box({error:"SSH refused"});
  assert.equal(serverCard(failed,input([failed]),now).status,"down");
});
test("attached filesystems and source-provided thresholds participate in worst-reading comparisons",()=>{
  const b=box();b.disks.push({mount:"/database",size:100,used:93,avail:7,meter:reading(93)});
  const d=input([b]);d.boxes!.thresholds.disk={warn:70,critical:85};
  const card=serverCard(b,d,now);
  assert.equal(card.meters[3]!.label,"/database");assert.equal(card.meters[3]!.critical,85);
  assert.equal(card.status,"degraded");
  const worst=SERVER_BUILDERS["servers.worst"]!(d)!;
  assert.equal(worst.value,"93%");assert.match(worst.sub!,/database, act at 85%/);
});
test("running-container totals exclude stale boxes and never claim knowledge of stopped containers",()=>{
  const fresh=box(),stale=box({accountId:2,seenAt:iso(3)});
  stale.docker={installed:true,running:100};
  const result=SERVER_BUILDERS["servers.containers"]!(input([fresh,stale]))!;
  assert.equal(result.value,"2");assert.match(result.caption!,/Stopped containers/);
});
test("fleet cost honors ledger corrections, separates currencies and names unpriced entries",()=>{
  const d={points:[],finance:{expenses:[
    {label:"Euros",category:"server",monthly:10,currency:"EUR",archived:false},
    {label:"Dollars",category:"server",monthly:15,currency:"USD",archived:false},
    {label:"Unknown",category:"server",monthly:null,currency:"EUR",archived:false},
    {label:"Old",category:"server",monthly:900,currency:"EUR",archived:true},
    {label:"Domain",category:"domain",monthly:30,currency:"EUR",archived:false},
  ]}} as unknown as LiveInputs;
  const cost=SERVER_BUILDERS["servers.cost"]!(d)!;
  assert.match(cost.value!,/10/);assert.match(cost.value!,/15/);assert.doesNotMatch(cost.value!,/25|900/);
  assert.equal(cost.rows?.length,3);assert.match(cost.sub!,/1 unpriced/);
});
test("CPU history names the actual recorded span and ignores invalid percentage samples",()=>{
  const b=box();b.samples.push({...b.samples[0]!,ts:iso(1),cpuPercent:null});
  const fleet=serverFleet(input([b]),now)!;
  assert.equal(fleet.cards[0]!.load.length,2);assert.equal(fleet.cards[0]!.loadSpan,"2h recorded");
  assert.equal(fleet.cards[0]!.meters[0]!.change,10);assert.equal(fleet.cards[0]!.meters[2]!.change,null);
  assert.equal(serverAddress({target:"user@[2001:db8::1]:2222"}),"2001:db8::1");
});
test("new server widgets cannot render catalog sample data without their sources",()=>{
  for(const [key,build] of Object.entries(SERVER_BUILDERS)) {
    assert.equal(build({points:[]}),null,key);
    const cleared=measuredWidget({...WIDGETS[key]!,value:"123",serverFleet:{cards:[]} as never},null);
    assert.equal(cleared.value,undefined,key);assert.equal(cleared.serverFleet,undefined,key);
  }
});
test("hypervisor fallback stays on its own card and never enters a guest fleet mean",()=>{
  const b=box({samples:[]});b.sample!.cpuPercent=null;
  const d=input([b]);
  d.fleet=[{id:10,ipv4:"192.0.2.10",name:"vendor-name",monthlyEur:12,ipv4MonthlyEur:.5} as never];
  const emptyStat={now:null,mean:null,peak:null};
  d.load={hours:24,servers:[{id:10,cpuScaled:true,cpu:{now:40,mean:30,peak:40,points:[{ts:iso(1),value:20},{ts:iso(0),value:40}]},netIn:emptyStat,netOut:emptyStat,diskRead:emptyStat,diskWrite:emptyStat}]} as never;
  const card=serverCard(b,d,now);
  assert.equal(card.meters[0]!.value,40);assert.equal(card.loadSource,"Hetzner hypervisor CPU");
  assert.match(card.cost,/12.50/);assert.equal(serverFleet(d,now)!.mean,null);
  d.load!.servers[0]!.cpuScaled=false;
  assert.equal(serverCard(b,d,now).meters[0]!.value,null,"raw summed core utilization is not a whole-machine percentage");
});
test("a saved detail section retains pinned widget identities and survives workspace validation",()=>{
  const prefs={workspace:{name:"One",owner:"Owner"},sessions:[],seedVersion:27,dashboards:[{id:"d",name:"Servers",slug:"servers",widgets:[
    {id:"primary",type:"servers.cards",w:4 as const},
    {id:"custom",type:"server.cpu",w:2 as const,param:"52",detail:true},
  ]}]};
  assert.equal(isWorkspacePreferences(prefs),true);
  const saved={...prefs,plugins:{},ventures:[]} as unknown as StoreState;
  assert.deepEqual(migrateWorkspace(saved,28).dashboards,prefs.dashboards);
  assert.equal(isWorkspacePreferences({...prefs,dashboards:[{...prefs.dashboards[0],widgets:[{...prefs.dashboards[0]!.widgets[1],detail:"yes"}]}]}),false);
});
