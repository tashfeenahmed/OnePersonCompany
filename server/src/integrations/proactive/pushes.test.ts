import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, now, setConfig, upsertPlugin } from "../../db.ts";
import { clearIncidents, insertEvent, insertRule } from "./store.ts";
import { ALERTS_KEY, MAX_ATTEMPTS, RUNS_KEY, armPushes, armedAt, pushAlerts, pushRuns, pushSettings, runMessage } from "./pushes.ts";

const LONG_AGO = "2000-01-01T00:00:00.000Z";
const sent: string[] = [];
const ok = async (text: string) => { sent.push(text); return { sent: true }; };

const state = (subject: string, ref: string | number) =>
  db.prepare("SELECT state, attempts, note FROM telegram_pushes WHERE subject = ? AND ref = ?").get(subject, String(ref)) as
    | { state: string; attempts: number; note: string | null }
    | undefined;

function rule(name = "Disk full") {
  return insertRule({ name, skill: "fleet", view: "default", params: {}, path: "disk", op: ">", threshold: 85,
    windowMinutes: null, enabled: true, ventureId: null, cooldownMinutes: 0 });
}
const trip = (ruleId: number, name = "Disk full") =>
  insertEvent({ ruleId, kind: "trip", observed: 91, previous: 85, message: `${name}: disk is 91 — the rule trips when it is > 85, and it is.` });

let runSeq = 0;
function run(p: { kind?: string; status: string; error?: string | null; ms?: number }) {
  const id = `r-t${String(++runSeq).padStart(4, "0")}`;
  db.prepare(`INSERT INTO agent_runs (id, kind, venture_id, title, input, status, queued_at, finished_at, ms, error)
              VALUES (?, ?, NULL, ?, '{}', ?, ?, ?, ?, ?)`)
    .run(id, p.kind ?? "research", `Title of ${id}`, p.status, now(), now(), p.ms ?? 125_000, p.error ?? null);
  return id;
}
const facts = { isRunning: () => false, facts: () => ({ kindName: "Research", cards: 2, link: "/team/research/runs/x" }) };

beforeEach(() => {
  sent.length = 0;
  upsertPlugin("briefing", true, null);
  setConfig("briefing", ALERTS_KEY, "");
  setConfig("briefing", RUNS_KEY, "");
  armPushes(pushSettings());
  db.prepare("DELETE FROM telegram_pushes").run();
  db.prepare("DELETE FROM alert_events").run();
  db.prepare("DELETE FROM agent_runs").run();
});

test("both pushes are off by default and write down why, so switching on is not a backlog", async () => {
  const r = rule();
  const e = trip(r.id);
  const id = run({ status: "done" });
  assert.deepEqual(pushSettings(), { alerts: false, runs: false });
  assert.equal((await pushAlerts({ send: ok })).suppressed, 1);
  assert.equal((await pushRuns({ send: ok, ...facts })).suppressed, 1);
  assert.equal(sent.length, 0);
  assert.equal(state("alert-trip", e.id)?.note, "pushing alerts to Telegram is off");
  assert.equal(state("run", id)?.note, "pushing runs to Telegram is off");

  setConfig("briefing", ALERTS_KEY, "on");
  setConfig("briefing", RUNS_KEY, "on");
  armPushes(pushSettings());
  assert.ok(armedAt("alerts") && armedAt("runs"));
  assert.equal((await pushAlerts({ send: ok })).sent, 0);
  assert.equal((await pushRuns({ send: ok, ...facts })).sent, 0);
  assert.equal(sent.length, 0);
});

test("anything that happened before the switch was armed is suppressed, not sent", async () => {
  const e = trip(rule().id);
  const id = run({ status: "failed", error: "boom" });
  setConfig("briefing", ALERTS_KEY, "on");
  setConfig("briefing", RUNS_KEY, "on");
  armPushes(pushSettings(), "2999-01-01T00:00:00.000Z");
  await pushAlerts({ send: ok });
  await pushRuns({ send: ok, ...facts });
  assert.equal(sent.length, 0);
  assert.equal(state("alert-trip", e.id)?.note, "before pushing was switched on");
  assert.equal(state("run", id)?.note, "before pushing was switched on");
});

test("re-saving the settings does not move the watermark", () => {
  setConfig("briefing", ALERTS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  armPushes(pushSettings(), "2999-01-01T00:00:00.000Z");
  assert.equal(armedAt("alerts"), LONG_AGO);
  setConfig("briefing", ALERTS_KEY, "off");
  armPushes(pushSettings());
  assert.equal(armedAt("alerts"), null);
});

test("a trip is sent once, its recovery once, and an unreadable never", async () => {
  setConfig("briefing", ALERTS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  const r = rule();
  const e = trip(r.id);
  insertEvent({ ruleId: r.id, kind: "unreadable", observed: null, previous: null, message: "Stripe did not answer" });

  assert.equal((await pushAlerts({ send: ok })).sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "⚠️ Disk full\nIt's at 91, above your limit of 85.");
  await pushAlerts({ send: ok });
  assert.equal(sent.length, 1, "a second pass sends nothing");

  clearIncidents(r.id, "trip", now(), "disk is 60 — back under the line.");
  await pushAlerts({ send: ok });
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /^✅ Back to normal: Disk full\nIt lasted \d+ s\.$/);
  assert.equal(state("alert-clear", e.id)?.state, "sent");
  await pushAlerts({ send: ok });
  assert.equal(sent.length, 2);
});

test("a trip that recovered before it could be sent says so, and is not told twice", async () => {
  setConfig("briefing", ALERTS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  const r = rule();
  const e = trip(r.id);
  clearIncidents(r.id, "trip", now(), "fine again");
  await pushAlerts({ send: ok });
  await pushAlerts({ send: ok });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /\n✅ Already fine again at \d{1,2}:\d\d[ap]m\.$/);
  assert.equal(state("alert-clear", e.id)?.note, "told with the trip");
});

test("a refused send is retried, counted, and given up on at the ceiling; a throw is a refusal", async () => {
  setConfig("briefing", ALERTS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  const e = trip(rule().id);
  let calls = 0;
  const refuse = async () => { calls++; if (calls % 2) throw new Error("network down"); return { sent: false, reason: "No chat is paired yet" }; };
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await pushAlerts({ send: refuse });
  assert.equal(calls, MAX_ATTEMPTS);
  assert.deepEqual({ ...state("alert-trip", e.id) }, { state: "failed", attempts: MAX_ATTEMPTS, note: "network down" });
});

test("more than three trips at once are one message", async () => {
  setConfig("briefing", ALERTS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  for (const n of ["A", "B", "C", "D", "E"]) trip(rule(n).id, n);
  const r = await pushAlerts({ send: ok });
  assert.equal(r.sent, 5);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^⚠️ 5 alerts went off\n• ⚠️ A\n/);
  assert.match(sent[0]!, /Send \/alerts to see what's still open\.$/);
});

test("quiet hours hold a push rather than dropping it", async () => {
  upsertPlugin("customers", false, null);
  setConfig("customers", "timezone", "UTC");
  setConfig("customers", "quiet-hours", "22-8");
  try {
    setConfig("briefing", ALERTS_KEY, "on");
    armPushes(pushSettings(), LONG_AGO);
    const e = trip(rule().id);
    const night = new Date(); night.setUTCHours(23, 0, 0, 0);
    const day = new Date(); day.setUTCHours(12, 0, 0, 0);
    assert.equal((await pushAlerts({ send: ok, at: night })).held, 1);
    assert.equal(sent.length, 0);
    assert.equal(state("alert-trip", e.id), undefined, "held is not a decision; nothing is written");
    assert.equal((await pushAlerts({ send: ok, at: day })).sent, 1);
  } finally {
    setConfig("customers", "quiet-hours", "");
  }
});

test("runs: finished, failed and filing runs; cancelled and autopilot video are not sent", async () => {
  setConfig("briefing", RUNS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  const done = run({ status: "done", ms: 12 * 60_000 });
  const failed = run({ status: "failed", error: "Local · Dell 5820 could not be reached" });
  run({ status: "cancelled" });
  const video = run({ kind: "video", status: "done" });
  const videoFailed = run({ kind: "video", status: "failed", error: "render died" });
  for (const ref of [video, videoFailed])
    db.prepare("INSERT INTO video_autopilot_log (ts, pass_id, kind, action, ref) VALUES (?, 'p', 'video', 'queued', ?)").run(now(), ref);

  const filing = new Set([done]);
  const first = await pushRuns({ send: ok, isRunning: (id) => filing.has(id), facts: facts.facts });
  assert.equal(first.held, 1, "a run still filing its cards waits");
  assert.equal(sent.length, 2);
  assert.ok(sent.some((m) => m === `⚠️ Research failed: couldn't reach Dell 5820, it may be switched off\nTitle of ${failed}\n/team/research/runs/x`));
  assert.ok(sent.some((m) => m.includes(`Title of ${videoFailed}`)), "a failed autopilot video is not announced elsewhere");
  assert.ok(!sent.some((m) => m.includes(`Title of ${video}`)));
  assert.ok(!sent.some((m) => /\br-t\d{4}\b/.test(m.replace(/Title of r-t\d{4}/g, ""))), "no run id outside the test's own titles");

  filing.clear();
  await pushRuns({ send: ok, ...facts });
  assert.equal(sent.length, 3);
  assert.match(sent[2]!, /^✅ Research is done: 2 new cards on the board \(12 min\)\nTitle of r-t\d+\n\/team\/research\/runs\/x$/);
  await pushRuns({ send: ok, ...facts });
  assert.equal(sent.length, 3);
});

test("runs: the nightly batch is one message", async () => {
  setConfig("briefing", RUNS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  for (let i = 0; i < 10; i++) run({ status: "failed", error: "Hermes stopped mid-answer" });
  run({ status: "done" });
  const r = await pushRuns({ send: ok, ...facts });
  assert.equal(r.sent, 11);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^⚠️ 11 agent runs finished: 1 done, 10 failed\n/);
  assert.equal(sent[0]!.split("\n").filter((l) => l.startsWith("• ❌ Research: Hermes stopped mid-answer")).length, 10);
});

test("the run message says how long, in words a phone can read", () => {
  const text = runMessage(
    { id: "r-abc", kind: "seo", venture_id: null, title: "SEO audit", status: "done", finished_at: now(), ms: 3_900_000, error: null },
    { kindName: "SEO", cards: 1, link: "http://box/x" },
  );
  assert.equal(text, "✅ SEO review is done: 1 new card on the board (1 h 5 min)\nSEO audit\nhttp://box/x");
});

test("runs: the run area's own helpers load lazily and name the kind, the cards and the page", async () => {
  setConfig("briefing", RUNS_KEY, "on");
  armPushes(pushSettings(), LONG_AGO);
  const id = run({ kind: "seo", status: "done" });
  await pushRuns({ send: ok });
  assert.equal(sent.length, 1);
  assert.equal(sent[0], `✅ SEO review is done: no new cards (2 min)\nTitle of ${id}`, "a LAN-only dashboard link is left off");
});
