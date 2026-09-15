import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { appendChatMessage, db, now } from "../../db.ts";
import { chatReport } from "../../chat/reports.ts";
import { childrenBySession, ROLES, PORTFOLIO_ROLES, runChild, runThreadPage } from "./store.ts";
import { runPage, subagentPage } from "../../../../shared/runRoutes.ts";

beforeEach(() => {
  db.exec("DELETE FROM chat_messages; DELETE FROM agent_runs; DELETE FROM subagents; DELETE FROM ventures;");
  db.prepare(`INSERT INTO ventures(id,slug,name,stage,color,color_source,created_at,updated_at,position)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("v-routing", "cedar", "Cedar", "launched", "#334455", "owner", now(), now(), 0);
});

function insert(kind: string, venture: string | null, id = `r-${kind}`) {
  db.prepare(`INSERT INTO agent_runs(id,kind,venture_id,title,input,status,queued_at,parent_session_id)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, kind, venture, "Review", "{}", "done", now(), "chat-routing");
  return { id, kind, title: "Review", status: "done" };
}

test("every registered role routes cards, sidebar children and live events to the same exact thread", () => {
  for (const [roles, venture, slug] of [[ROLES, "v-routing", "cedar"], [PORTFOLIO_ROLES, null, null]] as const) {
    for (const role of roles) {
      const row = insert(role.kind, venture);
      const expected = subagentPage(role.role, slug, row.id);
      assert.equal(runChild(row).to, expected, role.role);
      const message = appendChatMessage({ sessionId: "chat-routing", role: "assistant", channel: "run", content: "Report", reportRunId: row.id });
      assert.equal(chatReport(message)?.to, expected);
      assert.equal(childrenBySession().get("chat-routing")?.find(child => child.runId === row.id)?.to, expected);
    }
  }
});

test("older runs keep distinct addresses, and unavailable workers fall back to the original report", () => {
  const older = insert("seo", "v-routing", "r-older");
  const newer = insert("seo", "v-routing", "r-newer");
  assert.notEqual(runThreadPage(older), runThreadPage(newer));
  const other = insert("shotsqa", null);
  assert.equal(runThreadPage(other), runPage(other.kind, other.id));
  const orphan = insert("seo", null, "r-orphan");
  assert.equal(runThreadPage(orphan), runPage(orphan.kind, orphan.id));
});
