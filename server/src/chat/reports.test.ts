import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { appendChatMessage, chatMessages, db, now } from "../db.ts";
import { ensureTeam, subagentId } from "../integrations/subagents/store.ts";
import { chatReport } from "./reports.ts";
import { runPage, subagentPage } from "../../../shared/runRoutes.ts";

const sessionId = "report-card-test";
beforeEach(() => {
  db.exec("DELETE FROM chat_messages; DELETE FROM agent_runs; DELETE FROM subagents; DELETE FROM ventures;");
  ensureTeam();
  db.prepare("UPDATE subagents SET name = ? WHERE id = ?").run("My people researcher", subagentId("", "people"));
  db.prepare(`INSERT INTO agent_runs(id,kind,title,input,status,queued_at,parent_session_id,subagent_id)
    VALUES(?,?,?,?,?,?,?,?)`).run("r-report", "dossier", "Market founder profile", "{}", "done", now(), sessionId, subagentId("", "people"));
});

const message = (overrides: Partial<Parameters<typeof appendChatMessage>[0]> = {}) => appendChatMessage({
  sessionId, role: "assistant", channel: "run",
  content: `**Profile finished** · [open the run](${runPage("dossier", "r-report")})\n\nA saved excerpt.`,
  ...overrides,
});

test("new reports resolve persisted run IDs and custom worker identity independently of message prose", () => {
  message({ reportRunId: "r-report", content: "The copy can change.", ms: 42_000 });
  const stored = chatMessages(sessionId)[0]!;
  assert.equal(stored.report_run_id, "r-report");
  assert.equal(stored.ms, 42_000, "hidden metadata remains available");
  assert.deepEqual(chatReport(stored), {
    runId: "r-report", title: "Market founder profile", agentName: "My people researcher",
    role: "people", status: "done", to: subagentPage("people", null, "r-report"), error: null,
  });
});

test("existing notifications become cards without rewriting their saved content", () => {
  const stored = message();
  assert.equal(stored.report_run_id, null);
  assert.equal(chatReport(stored)?.runId, "r-report");
  assert.equal(chatMessages(sessionId)[0]?.content, stored.content);
  assert.equal(chatReport(message({ content: `Report · [open the run](${subagentPage("people", null, "r-report")})` }))?.runId, "r-report");
});

test("ordinary links, partial messages, and runs from another conversation never become cards", () => {
  for (const overrides of [
    { channel: "web" }, { role: "user" as const }, { partial: true },
    { sessionId: "another-chat" }, { sessionId: "another-chat", reportRunId: "r-report" },
    { content: "[open the run](https://other.example.test/report)" },
    { content: "[open the run](/outputs/seo/r-report)" },
    { content: "An answer\n[open the run](/outputs/dossier/r-report)" },
  ]) assert.equal(chatReport(message(overrides)), null);
});

test("failures and cancellations retain their state; deleted workers use the registry's role", () => {
  const stored = message({ reportRunId: "r-report" });
  db.prepare("UPDATE agent_runs SET status = 'failed', error = 'Source unavailable' WHERE id = ?").run("r-report");
  assert.equal(chatReport(stored)?.status, "failed");
  assert.equal(chatReport(stored)?.error, "Source unavailable");
  db.prepare("UPDATE agent_runs SET status = 'cancelled' WHERE id = ?").run("r-report");
  assert.equal(chatReport(stored)?.status, "cancelled");
  assert.equal(chatReport(stored)?.error, null);
  db.exec("DELETE FROM subagents");
  assert.equal(chatReport(stored)?.role, "people");
  assert.equal(chatReport(stored)?.agentName, "People analyst");
});

test("deleting a run preserves its chat notification and allows the text fallback", () => {
  message({ reportRunId: "r-report" });
  db.exec("DELETE FROM agent_runs");
  const stored = chatMessages(sessionId)[0]!;
  assert.ok(stored.content.includes("A saved excerpt."));
  assert.equal(stored.report_run_id, null);
  assert.equal(chatReport(stored), null);
});
