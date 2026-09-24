import { test } from "node:test";
import assert from "node:assert/strict";
import { clearWords, tripWords, type TripFacts } from "./alert-words.ts";

const Z = "Europe/Dublin";
const NOW = new Date("2026-09-24T10:40:00Z");
const base = (p: Partial<TripFacts>): TripFacts => ({
  rule: "Rule", skill: "x", path: "y", op: ">", threshold: 0, window_minutes: null, observed: 1, previous: 0,
  message: "", context: null, ts: "2026-09-24T10:32:37Z", cleared_at: null, recovery_message: null, venture: null, ...p,
});
const say = (w: { emoji: string; head: string; lines: string[] }) => [`${w.emoji} ${w.head}`, ...w.lines].join("\n");

test("disk: the box by name, from the snapshot the rule read", () => {
  const t = base({ rule: "A box is filling up", skill: "fleet", path: "totals.fullestDisk.percent", threshold: 85, observed: 86.6 });
  const doc = { totals: { fullestDisk: { box: "Demo box", mount: "/", percent: 86.6 } } };
  assert.equal(say(tripWords(t, doc, Z, NOW)), "💾 Disk is 87% full on Demo box");
  const later = { totals: { fullestDisk: { box: "Sosho box", mount: "/", percent: 79.5 } } };
  assert.equal(
    say(clearWords({ ...t, cleared_at: "2026-09-24T19:02:48Z" }, later, Z, NOW, doc)),
    "✅ Disk on Demo box is back under 85%\nIt lasted 8 h 30 min.",
    "the box that filled up, not whichever is fullest now",
  );
  assert.equal(say(tripWords(t, null, Z, NOW)), "💾 Disk is 87% full on one of your boxes", "a pruned snapshot still says what happened");
});

test("sites: the names, and a DNS-wide failure blamed on this box's internet", () => {
  const t = base({ rule: "A site is not answering", skill: "uptime", path: "summary.down", observed: 24 });
  const dns = (host: string) => ({ host, current: { ok: false, status: null, error: `EAI_AGAIN — getaddrinfo EAI_AGAIN ${host}` } });
  const doc = { hosts: [dns("scallopbot.com"), dns("planintel.ie"), dns("neu.ie"), ...Array.from({ length: 21 }, (_, i) => dns(`s${i}.com`)), { host: "up.com", current: { ok: true } }] };
  assert.equal(
    say(tripWords(t, doc, Z, NOW)),
    "🔴 24 sites aren't responding: scallopbot.com, planintel.ie, neu.ie, +21 more\n" +
      "Every check failed at the address lookup, so it's probably this box's internet rather than the sites.",
  );
  const one = { hosts: [{ host: "tellswell.com", current: { ok: false, status: 502, error: null } }] };
  assert.equal(say(tripWords({ ...t, observed: 1 }, one, Z, NOW)), "🔴 tellswell.com isn't responding\nIt answered with error 502.");
});

test("MRR: which way, by how much, and what it is now — never the JSON path", () => {
  const t = base({ rule: "MRR moved for CircleChat", skill: "stripe", path: "byVenture.v-3s7ufr.mrrAbsDelta", threshold: 20, observed: 29, venture: "CircleChat" });
  const doc = { byVenture: { "v-3s7ufr": { name: "CircleChat", currency: "USD", mrr: 15, previousMrr: 44, mrrDelta: -29 } } };
  const text = say(tripWords(t, doc, Z, NOW));
  assert.equal(text, "📉 CircleChat MRR is down $29/mo\nNow $15/mo, was $44/mo.");
  assert.ok(!text.includes("v-3s7ufr"));
  assert.equal(say(tripWords(t, null, Z, NOW)), "📊 CircleChat MRR moved by $29/mo");
});

test("signups and page views out of their usual range, from the anomaly pass's sentence", () => {
  const t = base({
    rule: "Tellswell · signups changed unusually", skill: "insights", path: "daily.value", op: "changed", observed: 8,
    message: "Tellswell · signups: 8 signups on 2026-09-23; expected 0.0–5.0 from 28 prior days (2026-08-25–2026-09-21).",
    recovery_message: "Tellswell · signups returned to its baseline range: 0 signups on 2026-09-24.",
  });
  assert.equal(say(tripWords(t, null, Z, NOW)), "📈 Tellswell had 8 signups yesterday\nMore than usual: normally 0–5 a day.");
  assert.equal(clearWords(t, null, Z, NOW).head, "Tellswell signups are back to normal (0 signups today)");
  const views = base({ message: "FreeLLMAPI · pageviews: 17517 views on 2026-09-23; expected 5073.7–13800.3 from 28 prior days (x)." });
  assert.equal(tripWords(views, null, Z, NOW).head, "FreeLLMAPI had 17,517 page views yesterday");
});

test("failed payments and expiring domains", () => {
  const pay = base({ rule: "A payment failed today", skill: "stripe", path: "charges[0].failed", observed: 11 });
  assert.equal(
    say(tripWords(pay, { charges: [{ failed: 11, blocked: 5, declined: 6 }] }, Z, NOW)),
    "❌ 11 payments failed today\n5 blocked by Stripe's fraud checks, 6 declined by the bank.",
  );
  const dom = base({ rule: "A domain expires within 30 days", skill: "domains", path: "summary.expiring30", observed: 1 });
  assert.equal(
    say(tripWords(dom, { domains: [{ name: "mynextgaff.com", expiresInDays: 12, autoRenew: false }, { name: "x.co", expiresInDays: 200 }] }, Z, NOW)),
    "📅 mynextgaff.com expires in 12 days\nAuto-renew is off.",
  );
});

test("a rule with no reading of its own says its name and the figure against its line", () => {
  const t = base({ rule: "Pageviews dropped by half against last week", skill: "umami", path: "portfolio.window.pageviews", op: "dropped_by_pct", threshold: 50, window_minutes: 10_080, observed: 1200, previous: 3000 });
  assert.equal(say(tripWords(t, null, Z, NOW)), "⚠️ Pageviews dropped by half against last week\nDown 60% on last week: 3,000 → 1,200.");
  const custom = base({ rule: "Queue too long", skill: "ops", path: "queue.length", op: ">", threshold: 10, observed: 14, venture: "Sosho" });
  assert.equal(say(tripWords(custom, null, Z, NOW)), "⚠️ Queue too long (Sosho)\nIt's at 14, above your limit of 10.");
});
