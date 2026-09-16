import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now, ventureRowById } from "../../db.ts";
import { competitorsRun } from "./competitors.ts";
import type { Step } from "./store.ts";

test("a tool-free competitor run cannot invent rivals, change prices or refresh verification dates", async t => {
  const id = "v-competitor-no-tools";
  db.prepare("INSERT INTO ventures(id,slug,name,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, "competitor-no-tools", "Example", "launched", "#123456", "owner", now(), now(), 0, "{}");
  db.prepare("INSERT INTO competitor_profiles(venture_id,name,domain,url,pricing,last_verified,first_seen) VALUES(?,?,?,?,?,?,?)")
    .run(id, "Existing", "existing.example", "https://existing.example", "$10", "2026-08-01", "2026-07-01");
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "No collector fixture" }, { status: 404 }));
  let output = "", calls = 0;
  const html = '<!doctype html><html><head><title>Existing market evidence</title></head><body><h1>Existing market evidence</h1><p>This is a review of the retained register only. No fresh sources were checked and the verification date remains unchanged.</p></body></html>';
  await competitorsRun({ runId: "r-competitor-no-tools", venture: ventureRowById(id)!, input: {}, tools: {
    hasTools: false, writerUsesProvider: true,
    say: text => { output += text; }, outputLength: () => output.length,
    rewind: n => { output = output.slice(0, n); },
    startStep: (tool, label): Step => ({ toolCallId: String(calls), tool, label, startedAt: now(), finishedAt: null }),
    endStep: () => {},
    turn: async (turns, opts) => {
      calls++;
      if (calls === 1) return { text: JSON.stringify({ competitors: [
        { name: "Existing", domain: "existing.example", pricing: "$99", sources: ["https://existing.example/pricing"] },
        { name: "Imagined", domain: "imagined.example", sources: ["https://imagined.example"] },
      ], focusDone: [], focusNext: [], cards: [] }) };
      assert.equal(opts.forceProvider, true);
      assert.match(turns[0]!.content, /YOU HAVE NO TOOLS/);
      output += html;
      return { text: html };
    },
  } });
  const rows = db.prepare("SELECT name,pricing,last_verified FROM competitor_profiles WHERE venture_id=?").all(id);
  assert.deepEqual(rows.map(r => ({ ...r })), [{ name: "Existing", pricing: "$10", last_verified: "2026-08-01" }]);
  assert.equal(calls, 2);
});
