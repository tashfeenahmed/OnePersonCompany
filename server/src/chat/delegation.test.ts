import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, now, setConfig, upsertPlugin } from "../db.ts";
import type { ChatBackend } from "./backend.ts";
import { ensureTeam, roleInfos, subagentId } from "../integrations/subagents/store.ts";
import { setQueuePaused } from "../runtime/budgets.ts";
import { entry } from "../skills/registry.ts";
import { TASK_AUTHORIZATION_RULE } from "../skills/assignment.ts";
import { kindDef, systemBrief } from "../integrations/runs/kinds.ts";
import { managedCliPath } from "../agents/instance.ts";
import { delegationLines } from "../integrations/subagents/delegation.ts";

const { composeTurns, chat } = await import("../routes/chat.ts");
const { subagentRoutes } = await import("../integrations/subagents/routes.ts");
const { registerBackend, setChoiceReader } = await import("./backend.ts");
const ventureId = "v-delegation-test", sessionId = "delegation-test-chat";
const request = "Do a competitor analysis for Cedar Studio.";
const fakeBackend = (id: "hermes" | "openclaw"): ChatBackend => ({
  id, label: id, ask: async () => { throw new Error("No external model in these tests"); },
});
const composed = (id: "hermes" | "openclaw", selected: string | null = null, sid = sessionId) =>
  composeTurns([{role:"user",content:request}],sid,selected,fakeBackend(id));
const instructions = (turns: ReturnType<typeof composed>) => turns.filter(t=>t.role === "system").map(t=>t.content).join("\n");

beforeEach(() => {
  db.exec("DELETE FROM agent_runs; DELETE FROM subagents; DELETE FROM ventures; DELETE FROM chat_messages;");
  db.prepare("INSERT INTO ventures(id,slug,name,host,stage,color,color_source,created_at,updated_at,position) VALUES(?,?,?,?,?,?,?,?,?,0)")
    .run(ventureId,"cedar-studio","Cedar Studio","cedar.example.test","launched","#334455","owner",now(),now());
  for (const id of ["hermes","openclaw"]) { upsertPlugin(id,true,null); setConfig(id,"mode","managed"); }
  setChoiceReader(()=>null);
  setQueuePaused(true);
});

test("an unscoped chat names every specialist and can use the venture named in the request", () => {
  for (const id of ["hermes","openclaw"] as const) {
    const turns = composed(id), system = instructions(turns);
    assert.match(system,/Cedar Studio \(cedar-studio\)/);
    for (const role of roleInfos()) assert.ok(system.includes(`role \`${role.role}\``),role.role);
    assert.match(system,/DELEGATE SPECIALIST TASKS/);
    assert.match(system,/BEFORE CHOOSING HOW/);
    assert.match(system,/New analysis of existing data is still specialist work/);
    assert.ok(system.includes(TASK_AUTHORIZATION_RULE));
    const assignment = turns.filter(t => t.role === "system").at(-1)!.content;
    assert.match(assignment, /SAVED OPC SUB-AGENTS, NOT TEMPORARY MODEL HELPERS/);
    assert.match(assignment, /delegate_task/);
    assert.match(assignment, /actual run id and link/);
    assert.ok(assignment.includes(managedCliPath(id)), "managed prompts must not rely on a tool shell's PATH");
    assert.match(system,/No venture selected in the header does not prevent delegation/);
    assert.ok(system.includes(`Use "${sessionId}" as parentSessionId`));
    assert.equal(turns.at(-1)?.content,request);
  }
});

test("dispatch guidance quotes the configured wrapper path and leaves the worker decision to the agent", () => {
  const lines = delegationLines(sessionId, true, "/tmp/owner's workspace/bin/opc").join("\n");
  assert.ok(lines.includes("'/tmp/owner'\\''s workspace/bin/opc' subagents dispatch --role <role>"));
  assert.match(lines, /choose the worker from the flat `workers` array/);
});

test("the assigned specialist's prompt owns execution rather than another handoff", () => {
  const system = systemBrief({def:kindDef("seo")!,ventureName:"Cedar Studio",hasTools:true,data:"Existing audit findings"});
  assert.match(system,/assigned specialist executing this run/);
  assert.match(system,/do not dispatch your assignment to another sub-agent/);
  assert.match(system,/YOUR REPLY IS THE DOCUMENT/);
});

test("selected teams include the owner's disabled state and delegation failure is not silent fallback", () => {
  ensureTeam(ventureId);
  db.prepare("UPDATE subagents SET enabled=0 WHERE id=?").run(subagentId(ventureId,"competitors"));
  const system = instructions(composed("hermes",ventureId));
  assert.match(system,/Competitor Analyst.*SWITCHED OFF/);
  assert.match(system,/do not silently do its job yourself or enable it/);
  assert.match(system,/Reuse an existing matching run/);
});

test("remote agents get the HTTP dispatch contract, while text-only fallback and workers do not get dispatcher orders", () => {
  setConfig("openclaw","mode","remote");
  assert.match(instructions(composed("openclaw")),/POST \/api\/skills\/subagents\/dispatch/);
  const fallback = composeTurns([{role:"user",content:request}],sessionId,null,null);
  assert.doesNotMatch(instructions(fallback),/DELEGATE SPECIALIST TASKS|opc subagents dispatch/);
  assert.doesNotMatch(instructions(composed("hermes",ventureId,"run:worker")),/DELEGATE SPECIALIST TASKS/);
});

test("the sub-agent skill preserves the same policy and distinguishes existing findings from new work", () => {
  const rules = entry("subagents")!.rules.join("\n");
  assert.match(rules,/DELEGATE SPECIALIST TASKS/);
  assert.match(rules,/summarize existing findings/);
  assert.match(rules,/already executing its assigned run must do that work itself/);
  assert.match(rules,/Never claim a dispatch without a returned run id/);
});

test("chat dispatch files a real queued specialist run under the requesting conversation", async () => {
  // The test double is a remote adapter; no managed process should boot.
  setConfig("hermes","mode","remote");
  registerBackend("hermes",()=>({ ...fakeBackend("hermes"), ask:async(turns,options)=>{
    assert.match(instructions(turns),/DELEGATE SPECIALIST TASKS/);
    assert.match(instructions(turns),/Cedar Studio \(cedar-studio\)/);
    const dispatched = await subagentRoutes.request("/dispatch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({venture:"cedar-studio",role:"competitors",brief:request,parentSessionId:options?.sessionId})});
    assert.equal(dispatched.status,201);
    const payload = await dispatched.json() as {run:{id:string;status:string}};
    assert.equal(payload.run.status,"queued");
    return {text:`Competitor Analyst queued: ${payload.run.id}`,backend:"hermes",model:"test",ms:1,usage:null};
  }}));
  setChoiceReader(()=>"hermes");
  try {
    const response = await chat.request("/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId,message:request})});
    assert.equal(response.status,200);
    const rows = db.prepare("SELECT kind,venture_id,parent_session_id,subagent_id,brief,status FROM agent_runs").all();
    assert.equal(rows.length,1);
    assert.deepEqual({...rows[0]}, {kind:"competitors",venture_id:ventureId,parent_session_id:sessionId,subagent_id:subagentId(ventureId,"competitors"),brief:request,status:"queued"});
    const sessions = await (await chat.request("/sessions")).json() as {sessions:{sessionId:string;children:unknown[]}[]};
    assert.equal(sessions.sessions.find(s=>s.sessionId===sessionId)?.children.length,1);
  } finally { setChoiceReader(()=>null); }
});
