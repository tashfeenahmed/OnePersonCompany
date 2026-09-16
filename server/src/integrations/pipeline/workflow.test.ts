import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, now } from "../../db.ts";
import { nightlyTemplate, newBlock, type WorkflowBlock } from "../../../../shared/workflow.ts";
import { workflow, workflowOwns, validateWorkflow, saveWorkflow } from "./workflow-store.ts";
import { installWorkflowEngine, registerWorkflowExecutor } from "./workflow-engine.ts";
import { agentCandidates, runAgentBlock } from "./workflow-agents.ts";
import { allStages, type StageContext } from "./registry.ts";
import { closeInterrupted, pipelineActivity, runNight, stopPipeline, tickPipeline } from "./nightly.ts";
import { ensureTeam, subagentId } from "../subagents/store.ts";
import { RUNTIME_KEYS, readSetting, writeSetting } from "../../runtime/settings.ts";
import { setSkipDay, settings } from "./registry.ts";
import { rotation } from "./synthesis.ts";
import { refreshForWorkflow, registerCollectors } from "../deploy/scheduler.ts";
import { startRun, finishRun, upsertPlugin, setConfig } from "../../db.ts";
import { agentRefusal } from "../security/gate.ts";
import { insertRun, runRow } from "../runs/store.ts";
import { dispatch } from "../subagents/routes.ts";
import { cancelRun } from "../runs/executor.ts";
import { nextScheduledNight, pipelineRoutes } from "./routes.ts";

beforeEach(() => {
  db.exec("DELETE FROM pipeline_block_jobs; DELETE FROM pipeline_stage_results; DELETE FROM pipeline_runs; DELETE FROM pipeline_stage_prefs; DELETE FROM pipeline_workflow; DELETE FROM agent_runs; DELETE FROM ventures;");
  db.exec("DELETE FROM plugin_config WHERE plugin_id='pipeline'; DELETE FROM runtime_settings WHERE key='pipeline-last-due';");
  setSkipDay(null, null);
  installWorkflowEngine();
});
const venture = (id: string, type = "web") => db.prepare("INSERT INTO ventures(id,slug,name,host,stage,color,color_source,created_at,updated_at,position,business_type,business_types) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)")
  .run(id,id,`Test ${id}`,`${id}.example.test`,"launched","#334455","owner",now(),now(),type,JSON.stringify([type]));
const ctx = (signal = new AbortController().signal): StageContext => ({ runId:"test-run",stageId:"wf-agent",dry:false,signal,deadline:Date.now()+60000,budget:{ maxMinutes:1,maxUsd:null } });
const write = (blocks: WorkflowBlock[]) => saveWorkflow(workflow().revision,{ name:"Test workflow",blocks });

test("the starter is valid and remains a preview until explicitly saved", () => {
  assert.equal(workflow().saved,false);
  assert.equal(validateWorkflow(nightlyTemplate()).blocks.length,15);
  const saved = saveWorkflow(0,nightlyTemplate());
  assert.equal(saved.revision,1); assert.equal(allStages().length,15);
  assert.throws(() => saveWorkflow(0,nightlyTemplate()),/another tab/);
});

test("validation refuses broken order, cycles, unknown roles and stale venture scopes", () => {
  const a=newBlock("agent","wf-a"), b=newBlock("synthesis","wf-b");
  assert.throws(() => validateWorkflow({name:"Test",blocks:[b,a]}),/findings after/);
  a.dependsOn=[b.id]; assert.throws(() => validateWorkflow({name:"Test",blocks:[a,b]}),/dependencies must appear before/);
  a.dependsOn=[]; a.agent!.role="missing"; assert.throws(() => write([a]),/available/);
  a.agent!.role="demand"; a.agent!.ventureIds=["missing"]; assert.throws(() => write([a]),/ventures that exist/);
  assert.throws(() => write([{...b,enabled:"false" as unknown as boolean}]),/switches/);
});

test("saved blocks execute in the exact order and rehearsals execute no adapters", async () => {
  const events:string[]=[];
  for(const kind of ["collect","alerts","synthesis","briefing"] as const) registerWorkflowExecutor(kind,async () => { events.push(kind); return {outcome:"completed"}; });
  write([newBlock("collect","wf-data"),newBlock("alerts","wf-alerts"),newBlock("synthesis","wf-findings"),newBlock("briefing","wf-brief")]);
  const dry=await runNight({trigger:"manual",dry:true}); assert.equal(dry.run?.completed,4); assert.deepEqual(events,[]);
  const real=await runNight({trigger:"manual"}); assert.equal(real.run?.completed,4); assert.deepEqual(events,["collect","alerts","synthesis","briefing"]);
});

test("editing during a run cannot change its saved block snapshot or remaining steps", async () => {
  let release!:()=>void; const events:string[]=[];
  registerWorkflowExecutor("collect",async () => { await new Promise<void>(r => {release=r;}); events.push("collect"); return {outcome:"completed"}; });
  registerWorkflowExecutor("alerts",async () => {events.push("alerts");return {outcome:"completed"};});
  write([newBlock("collect","wf-data"),newBlock("alerts","wf-alerts")]);
  const running=runNight({trigger:"manual"});
  assert.equal(pipelineActivity().running,true);
  write([newBlock("collect","wf-new")]); release();
  const result=await running;
  assert.deepEqual(events,["collect","alerts"]);
  const row=db.prepare("SELECT workflow_snapshot FROM pipeline_runs WHERE id=?").get(result.run!.id) as {workflow_snapshot:string};
  assert.equal(JSON.parse(row.workflow_snapshot)[1].definition.id,"wf-alerts");
});

test("failure can continue to a summary, while required-success dependencies stop", async () => {
  registerWorkflowExecutor("collect",async () => ({outcome:"failed",error:"Test source offline"}));
  registerWorkflowExecutor("alerts",async () => ({outcome:"completed"}));
  registerWorkflowExecutor("briefing",async () => ({outcome:"completed"}));
  const a=newBlock("collect","wf-data"), b=newBlock("alerts","wf-alerts"), c=newBlock("briefing","wf-brief");
  b.dependsOn=[a.id]; b.requireSuccess=true; c.dependsOn=[b.id];
  write([a,b,c]); const out=await runNight({trigger:"manual"});
  assert.deepEqual(out.stages.map(s=>s.outcome),["failed","skipped","completed"]);
});

test("agent scope uses business types, fair rotation, cadence and explicit venture selection", () => {
  venture("one","web"); venture("two","mobile"); venture("three","mobile");
  const b=newBlock("agent","wf-agent"); b.agent!.businessTypes=["mobile"];
  assert.deepEqual(agentCandidates(b).map(v=>v.id),["three","two"]);
  b.agent!.ventureIds=["two"]; assert.deepEqual(agentCandidates(b).map(v=>v.id),["two"]);
  insertRun({id:"done-test",kind:"demand",ventureId:"two",title:"Test",input:{}});
  db.prepare("UPDATE agent_runs SET status='done',finished_at=? WHERE id='done-test'").run(now());
  db.prepare("INSERT INTO pipeline_block_jobs VALUES('earlier',?,'two','done-test',?)").run(b.id,now());
  assert.equal(agentCandidates(b).length,0);
});

test("an agent block waits for completion; synthesis sees the finished report", async () => {
  venture("one"); let release!:()=>void; let asked=0;
  const fakeDispatch = ((row: Parameters<typeof dispatch>[0]) => {
    asked++; insertRun({id:"fake-agent",kind:"demand",ventureId:row.venture_id,title:"Test report",input:{}});
    release=()=>db.prepare("UPDATE agent_runs SET status='done',output='Test measured finding',finished_at=? WHERE id='fake-agent'").run(now());
    return {status:201,json:{run:{id:"fake-agent"}}};
  });
  registerWorkflowExecutor("agent",(b,c)=>runAgentBlock(b,c,{dispatch:fakeDispatch,read:runRow,cancel:cancelRun,delayMs:5}));
  let synthesised=false;
  registerWorkflowExecutor("synthesis",async () => { assert.equal(runRow("fake-agent")?.status,"done"); synthesised=true; return {outcome:"completed"}; });
  write([newBlock("agent","wf-agent"),newBlock("synthesis","wf-findings")]);
  const out=runNight({trigger:"manual"}); assert.equal(asked,1); assert.equal(synthesised,false);
  release(); const result=await out; assert.equal(result.run?.completed,2); assert.equal(synthesised,true);
  const detail=await (await pipelineRoutes.request(`/runs/${result.run!.id}`)).json() as { jobs: { venture_name: string }[] };
  assert.equal(detail.jobs[0]?.venture_name,"Test one");
});

test("unavailable specialists do not starve later ventures behind a one-venture cap", () => {
  for (const id of ["a-disabled", "b-busy", "c-ready"]) venture(id);
  ensureTeam("a-disabled");
  db.prepare("UPDATE subagents SET enabled=0 WHERE id=?").run(subagentId("a-disabled", "demand"));
  insertRun({id:"busy", kind:"demand", ventureId:"b-busy", title:"Existing work", input:{}});
  const block = newBlock("agent", "wf-agent"); block.agent!.limit = 1;
  assert.deepEqual(agentCandidates(block).map(v => v.id), ["c-ready"]);
  assert.equal(db.prepare("SELECT id FROM subagents WHERE venture_id='c-ready'").get(), undefined);
});

test("switching a block's specialist does not reuse the previous role's review cadence", () => {
  venture("one"); const block = newBlock("agent", "wf-agent");
  insertRun({id:"prior-role", kind:"demand", ventureId:"one", title:"Old role", input:{}});
  db.prepare("UPDATE agent_runs SET status='done',finished_at=? WHERE id='prior-role'").run(now());
  db.prepare("INSERT INTO pipeline_block_jobs VALUES('prior',?,'one','prior-role',?)").run(block.id,now());
  assert.equal(agentCandidates(block).length, 0);
  block.agent!.role = "seo";
  assert.deepEqual(agentCandidates(block).map(v => v.id), ["one"]);
});

test("a manual walk cannot consume the scheduled claim; a later tick runs it once", async () => {
  upsertPlugin("pipeline",true); setConfig("pipeline","enabled","on"); setConfig("pipeline","hour","2"); setConfig("pipeline","timezone","UTC");
  writeSetting(RUNTIME_KEYS.pipelineLastDue,"2026-09-15");
  let release!: () => void;
  registerWorkflowExecutor("alerts", async () => { await new Promise<void>(resolve => { release=resolve; }); return {outcome:"completed"}; });
  write([newBlock("alerts","wf-alerts")]);
  const manual = runNight({trigger:"manual"});
  try {
    assert.equal(await tickPipeline(new Date("2026-09-16T03:00:00Z")), null);
    assert.equal(readSetting(RUNTIME_KEYS.pipelineLastDue),"2026-09-15");
  } finally { release(); await manual; }
  registerWorkflowExecutor("alerts", async () => ({outcome:"completed"}));
  const scheduled = await tickPipeline(new Date("2026-09-16T03:10:00Z"));
  assert.equal(scheduled?.ran,true);
  assert.equal(scheduled?.run?.currentStage,null);
  assert.equal(readSetting(RUNTIME_KEYS.pipelineLastDue),"2026-09-16");
  assert.equal(await tickPipeline(new Date("2026-09-16T03:20:00Z")),null);
});

test("skipping a scheduled night consumes its claim without executing any block", async () => {
  upsertPlugin("pipeline",true); setConfig("pipeline","enabled","1"); setConfig("pipeline","hour","2"); setConfig("pipeline","timezone","UTC");
  write([newBlock("memory","wf-memory")]); assert.equal(workflowOwns("memory"),true);
  setSkipDay("2026-09-16","Fixture skip");
  registerWorkflowExecutor("memory",async () => { assert.fail("Skipped work must not run"); });
  assert.equal(await tickPipeline(new Date("2026-09-16T03:00:00Z")),null);
  assert.equal(readSetting(RUNTIME_KEYS.pipelineLastDue),"2026-09-16");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs").get() as {n:number}).n,0);
});

test("the skip control targets a pending catch-up, then the next night after it is claimed", () => {
  upsertPlugin("pipeline",true); setConfig("pipeline","enabled","on"); setConfig("pipeline","hour","2"); setConfig("pipeline","timezone","UTC");
  writeSetting(RUNTIME_KEYS.pipelineLastDue,"2026-09-14");
  const at = new Date("2026-09-16T01:00:00Z");
  assert.deepEqual(nextScheduledNight(settings(),at),{day:"2026-09-15",catchUp:true});
  writeSetting(RUNTIME_KEYS.pipelineLastDue,"2026-09-15");
  assert.deepEqual(nextScheduledNight(settings(),at),{day:"2026-09-16",catchUp:false});
  assert.deepEqual(nextScheduledNight(settings(),new Date("2026-09-16T03:00:00Z")),{day:"2026-09-16",catchUp:true});
  writeSetting(RUNTIME_KEYS.pipelineLastDue,"2026-09-16");
  assert.deepEqual(nextScheduledNight(settings(),new Date("2026-09-16T03:00:00Z")),{day:"2026-09-17",catchUp:false});
});

test("latest real run survives more than a page of previews", async () => {
  write([newBlock("alerts","wf-alerts")]);
  registerWorkflowExecutor("alerts",async () => ({outcome:"completed"}));
  const real = await runNight({trigger:"manual"});
  for (let i=0;i<21;i++) await runNight({trigger:"manual",dry:true});
  const doc = await (await pipelineRoutes.request("/")).json() as {last:{id:string};runs:{dry:boolean}[]};
  assert.equal(doc.last.id,real.run!.id);
  assert.equal(doc.runs.length,20); assert.ok(doc.runs.every(r=>r.dry));
});

test("stopping cancels the owned queued agent and skips later blocks", async () => {
  venture("one"); const fakeDispatch=(() => { insertRun({id:"cancel-me",kind:"demand",ventureId:"one",title:"Test",input:{}}); return {status:201,json:{run:{id:"cancel-me"}}}; });
  registerWorkflowExecutor("agent",(b,c)=>runAgentBlock(b,c,{dispatch:fakeDispatch,read:runRow,cancel:cancelRun,delayMs:5}));
  write([newBlock("agent","wf-agent"),newBlock("synthesis","wf-findings")]);
  const pending=runNight({trigger:"manual"}); stopPipeline(); const out=await pending;
  assert.equal(runRow("cancel-me")?.status,"cancelled");
  assert.deepEqual(out.stages.map(s=>s.outcome),["failed","skipped"]); assert.equal(pipelineActivity().running,false);
});

test("rehearsing a specialist never creates teams or jobs", async () => {
  venture("one"); const b=newBlock("agent","wf-agent");
  const out=await runAgentBlock(b,{...ctx(),dry:true});
  assert.equal(out.counts?.eligible,1); assert.equal((db.prepare("SELECT count(*) AS n FROM agent_runs").get() as {n:number}).n,0);
});

test("workflow API validates revisions and run status is readable", async () => {
  assert.match(agentRefusal("PUT","/api/pipeline/workflow")!,/owner control/);
  assert.equal(agentRefusal("GET","/api/pipeline/workflow"),null);
  assert.equal((await pipelineRoutes.request("/workflow")).status,200);
  const send=(body:unknown)=>pipelineRoutes.request("/workflow",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await send({revision:0,definition:nightlyTemplate()})).status,200);
  assert.equal((await send({revision:0,definition:nightlyTemplate()})).status,409);
  assert.equal((await pipelineRoutes.request("/start",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"dry":true}'})).status,400);
});

test("run summaries keep the block names from the saved snapshot", async () => {
  const b = newBlock("alerts","wf-summary"); b.title = "Review server health";
  registerWorkflowExecutor("alerts",async () => ({outcome:"completed",note:"No issues."}));
  write([b]); const result = await runNight({trigger:"manual"});
  assert.match(result.run!.summary,/\*\*Review server health\*\*/);
  assert.doesNotMatch(result.run!.summary,/wf-summary/);
});

test("restart closes interrupted nights and cancels only their queued jobs", () => {
  db.prepare("INSERT INTO pipeline_runs(id,started_at,trigger,current_stage) VALUES('interrupted',?,'manual','wf-agent')").run(now());
  for (const id of ["owned","other"]) insertRun({id,kind:"demand",ventureId:null,title:"Test",input:{}});
  db.prepare("INSERT INTO pipeline_block_jobs VALUES('interrupted','wf-agent','one','owned',?)").run(now());
  assert.equal(closeInterrupted(),1);
  assert.equal(runRow("owned")?.status,"cancelled"); assert.equal(runRow("other")?.status,"queued");
  assert.equal((db.prepare("SELECT current_stage FROM pipeline_runs WHERE id='interrupted'").get() as {current_stage:null}).current_stage,null);
  assert.equal(closeInterrupted(),0);
});

test("synthesis prioritises completed specialist ventures without losing fair rotation", () => {
  venture("one"); venture("two");
  db.prepare("INSERT INTO synthesis_coverage(venture_id,last_pass_at,passes) VALUES('two',?,1) ON CONFLICT(venture_id) DO UPDATE SET last_pass_at=excluded.last_pass_at").run(now());
  assert.equal(rotation(1)[0]?.id,"one");
  assert.equal(rotation(1,["two"])[0]?.id,"two");
});

test("collector blocks share a lock and reuse successful fresh readings", async () => {
  const plugin = "workflow-test-source"; upsertPlugin(plugin,true,null);
  let release!:()=>void, calls=0;
  registerCollectors({[plugin]:async()=>{
    calls++; const id=startRun(plugin);
    await new Promise<void>(r=>{release=r;}); finishRun(id,true,"Test source refreshed");
    return {ok:true};
  }});
  const first = refreshForWorkflow(new AbortController().signal);
  await new Promise(r=>setImmediate(r));
  const second = refreshForWorkflow(new AbortController().signal);
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,1); release();
  assert.deepEqual(await first,{refreshed:1,reused:0,failed:0});
  assert.deepEqual(await second,{refreshed:0,reused:1,failed:0}); assert.equal(calls,1);
  registerCollectors({});
});
