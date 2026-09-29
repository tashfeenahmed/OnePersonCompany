import test from "node:test";
import assert from "node:assert/strict";
import {
  addressDomain,
  decodeEntities,
  humanizeStamps,
  bareAddress,
  deliveryLabel,
  dueLabel,
  initials,
  mailTime,
  parseStamp,
  senderName,
  triageKey,
  weekLabel,
} from "./mailText.ts";

test("parseStamp reads Resend's Postgres-shaped stamp", () => {
  assert.equal(parseStamp("2026-09-29T11:47:55.208000+00"), Date.parse("2026-09-29T11:47:55.208Z"));
  assert.equal(parseStamp("2026-09-29 11:47:55.208+00"), Date.parse("2026-09-29T11:47:55.208Z"));
  assert.equal(parseStamp("2026-09-29T11:47:55Z"), Date.parse("2026-09-29T11:47:55Z"));
  assert.equal(parseStamp(1790682475208), 1790682475208);
  assert.equal(parseStamp(null), null);
  assert.equal(parseStamp(""), null);
  assert.equal(parseStamp("not a date"), null);
  assert.equal(parseStamp(0), null);
});

test("mailTime says it the way people do", () => {
  const now = new Date(2026, 8, 29, 15, 0, 0).getTime();
  assert.equal(mailTime(now - 20_000, now), "just now");
  assert.equal(mailTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(mailTime(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(mailTime(new Date(2026, 8, 28, 9, 0).getTime(), now), "Yesterday");
  assert.match(mailTime(new Date(2026, 8, 25, 9, 0).getTime(), now), /\w/);
  assert.match(mailTime(new Date(2024, 2, 3, 9, 0).getTime(), now), /2024/);
  assert.equal(mailTime(null, now), "");
});

test("sender names and addresses", () => {
  assert.equal(senderName("LiveTutor", "hello@livetutor.io"), "LiveTutor");
  assert.equal(senderName("", "hello@livetutor.io"), "hello@livetutor.io");
  assert.equal(senderName(null, null), "Unknown sender");
  assert.equal(bareAddress("LiveTutor <hello@livetutor.io>"), "hello@livetutor.io");
  assert.equal(addressDomain("LiveTutor <hello@LiveTutor.io>"), "livetutor.io");
  assert.equal(addressDomain(""), "");
});

test("initials", () => {
  assert.equal(initials("Paula Cavero"), "PC");
  assert.equal(initials("LiveTutor"), "L");
  assert.equal(initials("jalil.rizvi@sinnott.ie"), "JR");
  assert.equal(initials(""), "?");
});

test("triage and delivery words", () => {
  assert.equal(triageKey("needs_reply"), "needs_reply");
  assert.equal(triageKey(null), "unscored");
  assert.equal(triageKey("bogus"), "unscored");
  assert.equal(deliveryLabel("delivered").label, "Delivered");
  assert.equal(deliveryLabel("bounced").tone, "bad");
  assert.equal(deliveryLabel(null).label, "No update yet");
  assert.equal(deliveryLabel("delivery_delayed").label, "Delayed");
  assert.equal(deliveryLabel("something_new").label, "Something new");
});

test("week and due labels never print raw ISO", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(weekLabel("2026-W39", now), "Week 39");
  assert.equal(weekLabel("2025-W02", now), "Week 2, 2025");
  assert.equal(dueLabel(null, null, true, now).label, "No date given");
  assert.equal(dueLabel(null, "monthly", true, now).label, "“monthly”");
  assert.equal(dueLabel("2026-09-29", null, true, now).label, "Due today");
  const late = dueLabel("2026-09-03", "by Friday", true, now);
  assert.equal(late.overdue, true);
  assert.doesNotMatch(late.label, /\d{4}-\d{2}/);
  assert.equal(dueLabel("2026-09-03", null, false, now).overdue, false);
});

test("decodeEntities", () => {
  assert.equal(decodeEntities("can&#39;t &amp; won&#x27;t &quot;x&quot; &lt;b&gt;"), `can't & won't "x" <b>`);
  assert.equal(decodeEntities(null), "");
});

test("humanizeStamps rewrites raw stamps in server sentences", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const out = humanizeStamps("reached back only to 2025-10-01T09:40:18.000Z, so", now);
  assert.doesNotMatch(out, /T09:40/);
  assert.match(out, /2025/);
  assert.equal(humanizeStamps("Relations — 2026-W39", now), "Relations — Week 39");
  assert.equal(humanizeStamps(null, now), "");
});
