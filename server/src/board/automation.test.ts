import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { db, insertAccount, upsertPlugin } from "../db.ts";
import { boardRoutes, fileCard } from "../routes/board.ts";
import { actionInboxRoutes } from "../routes/actionInbox.ts";
import { ackEvent, insertEvent, insertRule } from "../integrations/proactive/store.ts";
import { boardAutomationStatus, configureBoardAutomation, registerBoardSource, syncBoardCards, type BoardCandidate } from "./automation.ts";
import { boardAutomationRoutes } from "./routes.ts";
import { growthCandidates, healthCandidates, inboxCandidates } from "./sources.ts";

const candidate = (n: number): BoardCandidate => ({ origin: `test:${n}`, title: `Review issue ${n}`, detail: "A measured issue", href: "/alerts", observedAt: new Date().toISOString() });
beforeEach(() => {
  db.exec("DELETE FROM board_automation_filings; DELETE FROM board_cards; DELETE FROM action_inbox_state; DELETE FROM alert_events; DELETE FROM alert_rules; DELETE FROM people_commitments; DELETE FROM mailflow_triage; DELETE FROM mailflow_triage_threads; DELETE FROM gsc_queries; DELETE FROM gsc_sites; DELETE FROM venture_links; DELETE FROM synthesis_venture_prefs; DELETE FROM ventures;");
  registerBoardSource({ id: "test", label: "Test feed", read: () => [] });
  configureBoardAutomation({ enabled: true, sources: Object.fromEntries(boardAutomationStatus().sources.map(s => [s.id, s.id === "test"])) });
});
const count = () => (db.prepare("SELECT count(*) AS n FROM board_cards").get() as { n: number }).n;

test("automatic filing uses Backlog, retains snapshots, and deduplicates polls and restarts", async () => {
  db.prepare("UPDATE board_columns SET title='Later' WHERE key='backlog'").run();
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1)] });
  const results = await Promise.all([syncBoardCards(), syncBoardCards()]);
  assert.equal(results[0], results[1]); assert.equal(results[0].filed, 1);
  assert.equal((await syncBoardCards()).filed, 0); assert.equal(count(), 1);
  const row = db.prepare("SELECT b.*,c.key FROM board_cards b JOIN board_columns c ON c.id=b.column_id").get() as { id: number; body: string; key: string };
  assert.equal(row.key, "backlog"); assert.match(row.body, /View source/); assert.match(row.body, /Snapshot observed/);
  db.prepare("UPDATE board_cards SET title='My edited title',body='My notes',archived_at=? WHERE id=?").run(new Date().toISOString(),row.id);
  assert.equal((await syncBoardCards()).filed, 0);
  assert.equal((db.prepare("SELECT body FROM board_cards WHERE id=?").get(row.id) as { body: string }).body,"My notes");
  await boardRoutes.request(`/cards/${row.id}`, { method: "DELETE" });
  assert.equal((await syncBoardCards()).filed, 0); assert.equal(count(), 0);
});

test("manual and completed cards block automatic duplicates, including explicit origin aliases", async () => {
  await boardRoutes.request("/cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: candidate(1).title }) });
  fileCard({ origin: "inbox:alert:42", title: "A manually filed event title" });
  db.exec("UPDATE board_cards SET column_id=(SELECT id FROM board_columns WHERE key='done')");
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1), { ...candidate(2), aliases: ["inbox:alert:42"] }] });
  assert.equal((await syncBoardCards()).filed,0); assert.equal(count(),2);
  db.exec("DELETE FROM board_cards");
  assert.equal((await syncBoardCards()).filed,0);
});

test("distinct source items are not merged solely because they share a headline", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1), { ...candidate(2), title: candidate(1).title }] });
  assert.equal((await syncBoardCards()).filed,2); assert.equal(count(),2);
});

test("distinct issues sharing a portfolio alert alias do not suppress one another", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1), candidate(2)].map(c=>({...c,aliases:["inbox:alert:999"]})) });
  assert.equal((await syncBoardCards()).filed, 2);
  assert.equal((await syncBoardCards()).filed, 0);
  assert.equal(count(), 2);
});

test("a new server process respects the saved receipt after card deletion", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1)] });
  await syncBoardCards();
  db.exec("DELETE FROM board_cards");
  const script = `
    import {registerBoardSource,syncBoardCards} from ${JSON.stringify(new URL("./automation.ts", import.meta.url).href)};
    registerBoardSource({id:"test",label:"Test feed",read:()=>[${JSON.stringify(candidate(1))}]});
    const result = await syncBoardCards();
    if (result.filed !== 0 || result.errors.length) throw new Error("A restart refiled deleted work");
  `;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: process.env, stdio: "pipe" });
  assert.equal(count(), 0);
});

test("alternate source IDs honour durable receipts after the original card is deleted", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1)] });
  assert.equal((await syncBoardCards()).filed, 1);
  db.exec("DELETE FROM board_cards");
  registerBoardSource({ id: "test", label: "Test feed", read: () => [{ ...candidate(2), aliases: [candidate(1).origin] }] });
  assert.equal((await syncBoardCards()).filed, 0);
  assert.equal(count(), 0);
  assert.equal((db.prepare("SELECT card_id FROM board_automation_filings WHERE origin=?").get(candidate(2).origin) as { card_id: number | null }).card_id, null);
  // The alternate identity also remains held after a restart/source stops
  // supplying the old alias, and cannot be bypassed by a different filer.
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(2)] });
  assert.equal((await syncBoardCards()).filed, 0);
  assert.equal(fileCard({ origin: candidate(2).origin, title: "Try another filing path" }).filed, false);
  assert.equal(fileCard({ origin: "test:3", aliases: [candidate(1).origin], title: "Another alias" }).filed, false);
  assert.equal(count(), 0);
});

test("edits and completed or archived cards survive changes to snapshots and alternate IDs", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1)] });
  await syncBoardCards();
  db.exec("UPDATE board_cards SET title='Owner title',body='Owner notes',done_at='2026-09-01',archived_at='2026-09-02',column_id=(SELECT id FROM board_columns WHERE key='done')");
  const before = db.prepare("SELECT * FROM board_cards").get();
  registerBoardSource({ id: "test", label: "Test feed", read: () => [{ ...candidate(2), title: "Fresh measurements", detail: "Changed figures", aliases: [candidate(1).origin] }] });
  assert.equal((await syncBoardCards()).filed, 0);
  assert.deepEqual(db.prepare("SELECT * FROM board_cards").get(), before);
});

test("inbox filing cannot duplicate automatic health cards, including deleted cards", async () => {
  const rule=insertRule({name:"Test app errors",skill:"stability",view:"default",params:{},path:"errors",op:">",threshold:5,windowMinutes:null,enabled:true,ventureId:null,cooldownMinutes:0});
  const event=insertEvent({ruleId:rule.id,kind:"trip",observed:10,previous:0,message:"Test app has 10 errors"});
  configureBoardAutomation({ sources: { test: false, health: true } });
  assert.equal((await syncBoardCards()).filed, 1);
  const response=await actionInboxRoutes.request(`/alert:${event.id}/board`,{method:"POST"});
  assert.equal(response.status, 200); assert.equal(((await response.json()) as { filed: boolean }).filed, false); assert.equal(count(), 1);
  db.exec("DELETE FROM board_cards");
  const retry=await actionInboxRoutes.request(`/alert:${event.id}/board`,{method:"POST"});
  assert.equal(retry.status, 200); assert.equal(((await retry.json()) as { filed: boolean }).filed, false); assert.equal(count(), 0);
});

test("a later alert event still recognises work filed from an earlier event of the rule", async () => {
  const rule=insertRule({name:"Test app errors",skill:"stability",view:"default",params:{},path:"errors",op:">",threshold:5,windowMinutes:null,enabled:true,ventureId:null,cooldownMinutes:0});
  const first=insertEvent({ruleId:rule.id,kind:"trip",observed:10,previous:0,message:"Test app has 10 errors"});
  fileCard({origin:`inbox:alert:${first.id}`,title:"An earlier health issue"});
  const second=insertEvent({ruleId:rule.id,kind:"trip",observed:20,previous:10,message:"Test app now has 20 errors"});
  const candidate=(await healthCandidates()).find(c=>c.origin===`health:rule:${rule.id}`)!;
  assert.ok(candidate.aliases?.includes(`inbox:alert:${first.id}`));
  assert.ok(candidate.aliases?.includes(`inbox:alert:${second.id}`));
  configureBoardAutomation({ sources: { test: false, health: true } });
  assert.equal((await syncBoardCards()).filed, 0); assert.equal(count(), 1);
});

test("a disabled source and pausing while a source loads cannot file cards", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1)] });
  configureBoardAutomation({ sources: { test: false } });
  assert.equal((await syncBoardCards()).filed,0);
  let finish!: (rows: BoardCandidate[]) => void;
  registerBoardSource({ id: "test", label: "Test feed", read: () => new Promise(resolve => { finish=resolve; }) });
  configureBoardAutomation({ sources: { test: true } });
  const pending=syncBoardCards();
  configureBoardAutomation({ enabled: false }); finish([candidate(1)]);
  assert.equal((await pending).filed,0); assert.equal(count(),0);
});

test("one failed adapter does not block other feeds, and the per-pass cap drains without duplicates", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => { throw new Error("unavailable"); } });
  registerBoardSource({ id: "healthy", label: "Healthy feed", read: () => Array.from({ length: 27 },(_,i)=>candidate(i)) });
  configureBoardAutomation({ sources: { healthy: true } });
  const first=await syncBoardCards(); assert.equal(first.filed,25); assert.equal(first.errors.length,1);
  assert.equal((await syncBoardCards()).filed,2); assert.equal(count(),27);
});

test("automation routes validate settings and a read never files a card", async () => {
  registerBoardSource({ id: "test", label: "Test feed", read: () => [candidate(1)] });
  assert.equal((await boardAutomationRoutes.request("/")).status,200); assert.equal(count(),0);
  for(const body of [{enabled:"false"},{sources:{test:"on"}},{sources:{unknown:true}}]) {
    assert.equal((await boardAutomationRoutes.request("/", {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).status,400);
  }
  assert.equal((await boardAutomationRoutes.request("/sync", {method:"POST"})).status,200); assert.equal(count(),1);
});

test("pending work honours source decisions before filing", () => {
  for(const id of ["open","done","snoozed"]) db.prepare("INSERT INTO people_commitments(id,mailbox,thread_id,message_id,what,sentence,found_at,status) VALUES(?,?,?,?,?,?,?,?)")
    .run(id,"test",id,id,`Review ${id}`,"I will review it",new Date().toISOString(),id==="done"?"done":"open");
  db.prepare("INSERT INTO action_inbox_state(id,snoozed_until) VALUES(?,?)").run("commitment:snoozed",new Date(Date.now()+86400000).toISOString());
  assert.deepEqual(inboxCandidates().map(c=>c.origin),["inbox:commitment:open"]);
});

test("health cards exclude unreadable checks, acknowledged events and snoozes", async () => {
  const rule=insertRule({name:"Test app errors",skill:"stability",view:"default",params:{},path:"errors",op:">",threshold:5,windowMinutes:null,enabled:true,ventureId:null,cooldownMinutes:0});
  const event=insertEvent({ruleId:rule.id,kind:"trip",observed:10,previous:0,message:"Test app has 10 errors"});
  assert.ok((await healthCandidates()).some(c=>c.origin===`health:rule:${rule.id}`));
  db.prepare("INSERT INTO action_inbox_state(id,snoozed_until) VALUES(?,?)").run(`alert:${event.id}`,new Date(Date.now()+86400000).toISOString());
  assert.equal((await healthCandidates()).length,0);
  db.exec("DELETE FROM action_inbox_state"); ackEvent(event.id);
  assert.equal((await healthCandidates()).length,0);
  insertEvent({ruleId:rule.id,kind:"unreadable",observed:null,previous:null,message:"Could not read test app"});
  assert.equal((await healthCandidates()).length,0);
});

test("email cards identify the sender and subject, including colon-containing thread IDs", () => {
  const time = new Date().toISOString();
  for (const thread of ["thread:part:2", "uncached"]) {
    db.prepare("INSERT INTO mailflow_triage(account_id,thread_id,score,reason,scored_at) VALUES(991,?,'needs_reply',?,?)")
      .run(thread, "Confirm the delivery date", time);
  }
  db.prepare("INSERT INTO mailflow_triage_threads(account_id,thread_id,subject,from_address,from_name,snippet,messages,unread,domains,seen_at) VALUES(991,?,?,?,?,?,1,1,'[]',?)")
    .run("thread:part:2", "Launch delivery", "sender@example.test", "Test Sender", "Please confirm", time);
  const cards = inboxCandidates();
  assert.equal(cards.find(c => c.origin === "inbox:triage:991:thread:part:2")?.title, "Reply to Test Sender: Launch delivery");
  assert.equal(cards.find(c => c.origin === "inbox:triage:991:uncached")?.title, "Reply needed: Confirm the delivery date");
});

test("search growth cards require fresh measured data and a matching opted-in venture", () => {
  const time=new Date().toISOString(), today=time.slice(0,10), yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  db.prepare("INSERT INTO ventures(id,slug,name,host,stage,color,color_source,created_at,updated_at,position) VALUES(?,?,?,?,?,?,?,?,?,0)")
    .run("test-v","test-venture","Test Venture","example.test","launched","#334455","owner",time,time);
  upsertPlugin("gsc",true,null); const account=insertAccount("gsc","Test Search");
  db.prepare("INSERT INTO gsc_sites(property,account_id,account_label,window_start,window_end,seen_at) VALUES(?,?,?,?,?,?)")
    .run("sc-domain:example.test",account,"Test Search",yesterday,today,time);
  db.prepare("INSERT INTO gsc_queries(property,query,clicks,impressions,position,seen_at) VALUES(?,?,?,?,?,?)")
    .run("sc-domain:example.test","test query",10,500,9,time);
  const cards=growthCandidates(); assert.equal(cards.length,1); assert.equal(cards[0]!.ventureId,"test-v"); assert.match(cards[0]!.detail,/500 impressions/);
  db.prepare("UPDATE gsc_queries SET impressions=2").run(); assert.equal(growthCandidates().length,0);
  db.prepare("UPDATE gsc_queries SET impressions=500,seen_at='2000-01-01T00:00:00.000Z'").run(); assert.equal(growthCandidates().length,0);
  db.prepare("UPDATE gsc_queries SET seen_at=?").run(time);
  db.prepare("INSERT INTO synthesis_venture_prefs(venture_id,proposals,updated_at) VALUES(?,0,?)").run("test-v",time);
  assert.equal(growthCandidates().length,0);
});

test("search growth cards skip brand queries, including another venture's brand on our own property", () => {
  const time=new Date().toISOString(), today=time.slice(0,10), yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const venture=db.prepare("INSERT INTO ventures(id,slug,name,host,stage,color,color_source,created_at,updated_at,position) VALUES(?,?,?,?,'launched','#334455','owner',?,?,0)");
  venture.run("free-v","freellmapi","FreeLLMAPI","freellmapi.co",time,time);
  venture.run("neu-v","neu","Neu","neu.ie",time,time);
  upsertPlugin("gsc",true,null); const account=insertAccount("gsc","Brand Search");
  const site=db.prepare("INSERT INTO gsc_sites(property,account_id,account_label,window_start,window_end,seen_at) VALUES(?,?,'Brand Search',?,?,?)");
  site.run("sc-domain:freellmapi.co",account,yesterday,today,time);
  site.run("sc-domain:neu.ie",account,yesterday,today,time);
  const query=db.prepare("INSERT INTO gsc_queries(property,query,clicks,impressions,position,seen_at) VALUES(?,?,1,?,9,?)");
  query.run("sc-domain:freellmapi.co","freellmapi github",900,time);
  query.run("sc-domain:freellmapi.co","freelmapi",800,time);
  query.run("sc-domain:freellmapi.co","free llm api",300,time);
  query.run("sc-domain:neu.ie","freellmapi",500,time);
  const cards=growthCandidates();
  assert.equal(cards.length,1);
  assert.equal(cards[0]!.ventureId,"free-v");
  assert.match(cards[0]!.title,/free llm api/);
  db.prepare("DELETE FROM gsc_queries WHERE query='free llm api'").run();
  assert.equal(growthCandidates().length,0);
});
