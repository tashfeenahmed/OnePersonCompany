import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { keyNamesVenture, venturesSection } from "./costs.ts";
import { CHIEF_VENTURE, PORTFOLIO_VENTURE } from "../runtime/budgets.ts";

const key = (name: string, usd: number) => ({
  account_id: 1, account_label: "acct", name, usd, usd_month: usd / 2, usd_week: usd / 4, usd_day: usd / 8,
  disabled: 0, created_at: null, spend_limit: null, limit_remaining: null, seen_at: "2026-09-22T00:00:00.000Z",
});

test("an OpenRouter key names a venture by name, slug or host and by nothing looser", () => {
  const v = { name: "Viral Video Maker", slug: "viral-video-maker", host: "viralvideomaker.co", website: "https://viralvideomaker.co" };
  assert.equal(keyNamesVenture("ViralVideoMaker", v), true);
  assert.equal(keyNamesVenture("viral video maker", v), true);
  assert.equal(keyNamesVenture("viralvideomaker.co", v), true);
  assert.equal(keyNamesVenture("VVM", v), false);
  assert.equal(keyNamesVenture("Viral", v), false);
  assert.equal(keyNamesVenture("", v), false);
  const ue = { name: "User Evaluation", slug: "user-evaluation", host: null, website: "https://www.userevaluation.com" };
  assert.equal(keyNamesVenture("UserEvaluation.com", ue), true);
  assert.equal(keyNamesVenture("GetPreg", { name: "GetPregnant", slug: "getpregnant", host: null, website: null }), false);
});

test("the ventures section lists every venture, the pseudo-ventures and the legacy null rows, and joins keys by name only", () => {
  db.exec("DELETE FROM budget_usage; DELETE FROM ventures; DELETE FROM agent_runs; DELETE FROM chat_messages");
  const at0 = "2026-09-01T00:00:00.000Z";
  const ins = db.prepare("INSERT INTO ventures (id, slug, name, website, host, stage, color, color_source, created_at, updated_at, position) VALUES (?,?,?,?,?,?,'#000','owner',?,?,?)");
  ins.run("v-bet", "betaware-ai", "Betaware AI", "https://betaware.ai", "betaware.ai", "launched", at0, at0, 1);
  ins.run("v-vvm", "viral-video-maker", "Viral Video Maker", "https://viralvideomaker.co", "viralvideomaker.co", "launched", at0, at0, 2);
  ins.run("v-mva", "my-voice-agents", "My Voice Agents", null, null, "pre-launch", at0, at0, 3);
  const use = db.prepare("INSERT INTO budget_usage (run_id, venture_id, automation, at, tokens, usd, status) VALUES (?,?,?,?,?,?,?)");
  const at = new Date().toISOString();
  use.run("r-1", "v-bet", 0, at, 600, 0, "reported");
  use.run("r-2", "v-vvm", 0, at, 200, 0, "estimated");
  use.run("direct:old", null, 1, at, 100, 0, "reported");
  use.run("chat:x", CHIEF_VENTURE, 0, at, 50, 0, "reported");
  use.run("pipeline:p:wf-triage", PORTFOLIO_VENTURE, 1, at, 50, 0, "unmetered-agent");
  use.run("r-3", "v-gone", 0, at, 0, 0, "reported");
  use.run("r-old", "v-bet", 0, "2020-01-01T00:00:00.000Z", 9999, 0, "reported");

  const from = new Date(Date.now() - 86_400_000).toISOString();
  const s = venturesSection(from, [key("ViralVideoMaker", 8), key("FLA", 30)], [{ id: "p", name: "Default project", usd: 94.06 }]);

  assert.equal(s.metered.tokens, 1000);
  assert.equal(s.metered.calls, 6);
  const by = new Map(s.list.map((r) => [r.name, r]));
  assert.equal(by.get("Betaware AI")?.metered.tokens, 600);
  assert.equal(by.get("Betaware AI")?.metered.share, 0.6);
  assert.equal(by.get("Betaware AI")?.openrouterKeys, null);
  assert.equal(by.get("My Voice Agents")?.metered.tokens, 0);
  assert.equal(by.get("Viral Video Maker")?.openrouterKeys?.usd, 8);
  assert.deepEqual(by.get("Viral Video Maker")?.openrouterKeys?.names, ["ViralVideoMaker"]);
  assert.equal(by.get("Chief of staff")?.kind, "pseudo");
  assert.equal(by.get("Chief of staff")?.metered.tokens, 50);
  assert.equal(by.get("Portfolio")?.metered.agentCalls, 1);
  assert.equal(by.get("Unattributed")?.metered.tokens, 100);
  assert.equal(by.get("v-gone")?.kind, "unattributed");
  /* The column adds up to the total: nothing metered is dropped. */
  assert.equal(s.list.reduce((n, r) => n + r.metered.tokens, 0), s.metered.tokens);
  /* The unmatched key is named, never guessed onto a venture. */
  assert.deepEqual(s.unattributed.openrouter.keys, ["FLA"]);
  assert.equal(s.unattributed.openrouter.usd, 30);
  assert.equal(s.unattributed.openai.usd, 94.06);
  assert.match(s.unattributed.openai.why, /products' own spend/);
  assert.match(s.note, /None of this box's own calls/);
});

test("the OpenAI note changes when this box's own calls went to OpenAI in the window", () => {
  db.exec("DELETE FROM budget_usage; DELETE FROM ventures; DELETE FROM agent_runs; DELETE FROM chat_messages");
  const at = new Date().toISOString();
  db.prepare("INSERT INTO chat_messages (session_id, ts, role, content, backend, channel) VALUES (?,?,?,?,?,'web')").run("s", at, "assistant", "hi", "provider:openai");
  const s = venturesSection(new Date(Date.now() - 86_400_000).toISOString(), [], [{ id: "p", name: "Default project", usd: 1 }]);
  assert.deepEqual(s.metered.backends, ["provider:openai"]);
  assert.match(s.unattributed.openai.why, /also went to it/);
  assert.match(s.note, /went to provider:openai/);
});
