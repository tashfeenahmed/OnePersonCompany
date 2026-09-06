/**
 * The mapper, the validator and the rollback.
 *
 * THREE THINGS ARE TESTED AND THEY ARE THE THREE THAT COULD BE WRONG QUIETLY.
 * The MAPPER, because every decision in it is arguable and only a fixture can
 * hold it to one — a card in a column that does not exist, a chat whose
 * messages carry no timestamps, a rolling total that must not become a daily
 * one. The VALIDATOR, because it is the only thing standing between a mistyped
 * adapter and a page of nothing, and because `contactPermitted` is a field
 * where a lenient parse would turn a type error into permission to write to
 * somebody. And ROLLBACK, because it is the promise that makes the import safe
 * to run at all: if it leaves rows behind, or takes a row it did not create,
 * nobody finds out until it matters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cardFrom, chatFrom, goalsMarkdown, historyRows, iso, memoryFrom, outboxFrom,
  outcomeFrom, studioFrom, urgencyOf, ventureFrom, SERIES,
} from "./mapper.ts";
import { validateSample } from "./adapters.ts";
import { validate } from "../activity/users.ts";
import { GOAL_KEY, closeBatch, goalTarget, mapRows, newBatchId, openBatch, remember, rollback } from "./store.ts";
import { parseKinds, parseVentureMap } from "./importer.ts";
import { denied } from "./workdash.ts";
import { db, now } from "../../db.ts";

/* ------------------------------------------------------------------ time */

test("WorkDash's two clocks are both read, and neither is guessed wrong", () => {
  /* goals.json and actions.json are SECONDS; kanban.json and agent-memory.json
     are MILLISECONDS. The same instant has to come out of both. */
  assert.equal(iso(1752000000), "2025-07-08T18:40:00.000Z");
  assert.equal(iso(1752000000000), "2025-07-08T18:40:00.000Z");
  assert.equal(iso("2026-08-01"), "2026-08-01T00:00:00.000Z");
  assert.equal(iso(0), null);
  assert.equal(iso(null), null);
  assert.equal(iso("yesterday"), null);
});

/* -------------------------------------------------------------- ventures */

test("a WorkDash project keyed by a domain becomes a venture with a host and a website", () => {
  const v = ventureFrom("example-app-1.example.test", { name: "Example App 1", oneLiner: "Planning, searchable." });
  assert.equal(v.slug, "example-app-1", "the dots must not survive into a URL segment");
  assert.equal(v.host, "example-app-1.example.test");
  assert.equal(v.website, "https://example-app-1.example.test");
  assert.equal(v.description, "Planning, searchable.");
  assert.equal(v.problems.length, 0);
});

test("a project whose slug is a name, not a domain, gets no site — which is not a gap", () => {
  const v = ventureFrom("sideproject", { name: "Side Project" });
  assert.equal(v.host, null);
  assert.equal(v.website, null);
  assert.equal(v.slug, "sideproject");
  assert.equal(v.description, "");
  assert.match(v.problems[0]!, /neither a one-liner nor a summary/);
});

test("the one-liner wins over the summary, because a person wrote it", () => {
  const v = ventureFrom("x.co", { oneLiner: "Short.", summary: "A much longer model-written expansion." });
  assert.equal(v.description, "Short.");
});

/* ----------------------------------------------------------------- board */

test("a card in a column with no counterpart lands in Backlog and says so", () => {
  const c = cardFrom({ id: "k2b", title: "Fix invite emails", column: "waiting", order: 2000, createdAt: 1751000000000 })!;
  assert.equal(c.columnKey, "backlog");
  assert.match(c.problems[0]!, /a WorkDash column called “waiting”/);
});

test("the three obvious column pairs map without complaint", () => {
  for (const [from, to] of [["backlog", "backlog"], ["todo", "next"], ["inprogress", "doing"], ["done", "done"]] as const) {
    const c = cardFrom({ id: `k-${from}`, title: "t", column: from, createdAt: 1751000000000 })!;
    assert.equal(c.columnKey, to);
    assert.equal(c.problems.length, 0);
  }
});

test("urgency is an ORDER, and an unknown word is normal rather than urgent", () => {
  assert.equal(urgencyOf("low"), 0);
  assert.equal(urgencyOf("normal"), 1);
  assert.equal(urgencyOf("high"), 2);
  assert.equal(urgencyOf("urgent"), 3);
  assert.equal(urgencyOf("critical"), 1, "a word this does not know must not be promoted");
  assert.equal(urgencyOf(undefined), 1);
});

test("every card carries an origin, which is both its provenance and its idempotency", () => {
  const c = cardFrom({ id: "k1a", title: "t", createdAt: 1750000000000 })!;
  assert.equal(c.origin, "workdash:card:k1a");
});

test("a card with no title is not a card", () => {
  assert.equal(cardFrom({ id: "k4d", title: "", createdAt: 1749000000000 }), null);
  assert.equal(cardFrom({ title: "no id", createdAt: 1749000000000 }), null);
});

/* ----------------------------------------------------------------- chats */

test("a chat's parts are flattened to text, thinking is dropped, and every message carries the chat's own time", () => {
  const chat = chatFrom({
    id: "cabc12",
    title: "Planning search performance",
    createdAt: 1754000000000,
    updatedAt: 1754003600000,
    model: "gpt-5.6-luna",
    messages: [
      { role: "user", content: "Why is the county filter slow?" },
      { role: "assistant", content: "", parts: [{ kind: "thinking", text: "internal" }, { kind: "text", text: "No index." }] },
      { role: "system", content: "ignored" },
    ],
  })!;
  assert.equal(chat.sessionId, "wd-cabc12");
  assert.equal(chat.messages.length, 2, "the system row is not one of the two roles this stores from a WorkDash chat");
  assert.equal(chat.messages[1]!.content, "No index.", "thinking must not reach the transcript");
  /* THE TIMES ARE ALL THE SAME ON PURPOSE. See chatFrom's header: spreading
     them would draw a conversation that never happened. */
  assert.equal(chat.messages[0]!.ts, chat.messages[1]!.ts);
  assert.equal(chat.messages[0]!.ts, "2025-07-31T22:13:20.000Z");
  assert.equal(chat.messages[0]!.model, null, "a model is not attributed to what the owner typed");
  assert.equal(chat.messages[1]!.model, "gpt-5.6-luna");
});

test("a chat with nothing readable in it is not imported as an empty session", () => {
  assert.equal(chatFrom({ id: "cdef34", createdAt: 1754100000000, messages: [] }), null);
});

/* -------------------------------------------------------------- memories */

test("a note longer than this box's cap is refused by name and never truncated", () => {
  const got = memoryFrom({ id: "m3z", text: "X".repeat(700), createdAt: 1748000000000 });
  assert.ok(got && "skip" in got);
  assert.match((got as { skip: string }).skip, /700 characters/);
});

test("a note with a project is venture-scoped and one without is global", () => {
  const a = memoryFrom({ id: "m1x", text: "A fact.", project: "example-app-1.example.test", createdAt: 1750000000000, updatedAt: 1755000000000 });
  const b = memoryFrom({ id: "m2y", text: "Another.", createdAt: 1748000000000 });
  assert.ok(a && !("skip" in a) && a.scope === "venture" && a.ventureSource === "example-app-1.example.test");
  assert.ok(b && !("skip" in b) && b.scope === "global" && b.ventureSource === null);
  assert.ok(a && !("skip" in a) && a.id === "wd-m1x");
});

/* ----------------------------------------------------------------- goals */

test("WorkDash's structured goals render to markdown with every field kept", () => {
  const md = goalsMarkdown([
    { title: "Get to 500 EUR MRR", why: "Real demand.", keywords: ["mrr"], horizon: "quarter", target: { metric: "mrr", value: 500 } },
    { title: "Ship weekly", keywords: ["ship"], horizon: "year" },
  ]);
  assert.match(md, /\*\*Get to 500 EUR MRR\*\* \(this quarter\)/);
  assert.match(md, /Why: Real demand\./);
  assert.match(md, /Target: mrr = 500/);
  assert.match(md, /\*\*Ship weekly\*\* \(this year\)/);
  assert.equal(goalsMarkdown([]), "");
});

/* -------------------------------------------------------------- outcomes */

test("an outcome arrives closed, with its two readings, and says the windows were samples", () => {
  const o = outcomeFrom(
    { actionId: "a1", at: 1752000000, project: "example-app-1.example.test", metric: "traffic", before: 120.5, after: 184.25, windowDays: { before: 14, after: 14 }, verdict: "up" },
    "Added a county index",
  )!;
  assert.equal(o.id, "wd-a1-traffic");
  assert.equal(o.unit, "traffic");
  assert.deepEqual(o.readings.map((r) => r.value), [120.5, 184.25]);
  assert.match(o.note, /SAMPLES, not calendar days/);
  assert.match(o.note, /Nothing re-reads this/);
});

test("a null before stays null and is not read as zero", () => {
  const o = outcomeFrom({ actionId: "a2", at: 1753000000, metric: "signups", before: null, after: 3, windowDays: {}, verdict: "unmeasurable" }, null)!;
  assert.equal(o.readings[0]!.value, null);
  assert.match(o.note, /no before figure/);
});

/* --------------------------------------------------------------- studio */

test("a studio draft keeps its own timestamp-derived id under a wd- prefix", () => {
  const s = studioFrom({ id: "example-app-1.example.test-1754000000", slug: "example-app-1.example.test", at: 1754000000, format: "single", caption: "c", prompt: "p", image: "x.webp" })!;
  assert.equal(s.id, "wd-example-app-1.example.test-1754000000");
  assert.equal(s.ventureSource, "example-app-1.example.test");
  assert.equal(s.imageFile, "x.webp");
});

test("brief falls back through topic to the format label, because the column is NOT NULL", () => {
  const s = studioFrom({ id: "a-1", slug: "x.co", at: 1754000000, topic: "New filter", formatLabel: "Single image" })!;
  assert.equal(s.brief, "New filter");
  const t = studioFrom({ id: "a-2", slug: "x.co", at: 1754000000, formatLabel: "Single image" })!;
  assert.equal(t.brief, "Single image");
});

/* --------------------------------------------------------------- outbox */

test("a WorkDash “stopped” draft becomes dismissed, and it is said out loud", () => {
  const o = outboxFrom({ id: "o2", to: "joe@example.com", subject: "Following up", body: "Hi.", status: "stopped", createdAt: 1754000000000 })!;
  assert.equal(o.status, "dismissed");
  assert.ok(o.problems.some((p) => /halted sequence/.test(p)));
});

test("a draft with no address is not a draft", () => {
  assert.equal(outboxFrom({ id: "o3", to: "not-an-address", subject: "s", body: "b" }), null);
  assert.equal(outboxFrom({ id: "o4", to: "a@b.com", subject: "s", body: "   " }), null);
});

/* -------------------------------------------------------------- history */

test("every declared series says which table it would go to and why it does not", () => {
  for (const rule of SERIES) {
    assert.ok(rule.reason.length > 40, `${rule.series} needs a real reason, not a label`);
    assert.ok(rule.target.length > 0, `${rule.series} must name the table it would have gone to`);
    assert.ok(["day", "rolling", "level", "cumulative"].includes(rule.window));
  }
});

test("a rolling series is tagged rolling, so nothing downstream can sum two rows", () => {
  const search = SERIES.find((s) => s.series === "search")!;
  assert.equal(search.window, "rolling");
  assert.match(search.reason, /28-DAY/);
  const play = SERIES.find((s) => s.series === "playstore")!;
  assert.equal(play.window, "day", "installs IS a daily count; the reason it cannot move is the account key, not the window");
  assert.match(play.reason, /keyed by the Play account/);
});

test("a NULL figure is dropped rather than stored as zero", () => {
  const traffic = SERIES.find((s) => s.series === "traffic")!;
  const got = historyRows(traffic, [["2026-08-01", "example-app-1.example.test", 1200, null], ["2026-08-02", "example-app-1.example.test", 1210, 14]]);
  assert.equal(got.examined, 4, "two rows of two figures each");
  assert.equal(got.dropped, 1, "the null bots24");
  assert.equal(got.rows.length, 3);
  assert.ok(!got.rows.some((r) => r.metric === "bots24" && r.period === "2026-08-01"));
  assert.equal(got.rows[0]!.subject, "example-app-1.example.test");
  assert.equal(got.rows[0]!.window, "rolling");
});

/* ------------------------------------------------------------ arguments */

test("--only refuses a kind it does not have rather than silently importing everything", () => {
  assert.deepEqual(parseKinds("board,chats").kinds, ["board", "chats"]);
  const bad = parseKinds("board,everything");
  assert.deepEqual(bad.kinds, ["board"]);
  assert.match(bad.problems[0]!, /“everything” is not a kind/);
  assert.equal(parseKinds(null).kinds.length, 7);
});

test("the venture map reads mappings and skips, and names a line it cannot read", () => {
  const got = parseVentureMap("# comment\nexample-app-1.example.test = example-app-1\nexample-app-13.example.test = skip\n\nnonsense\n");
  assert.equal(got.map.get("example-app-1.example.test"), "example-app-1");
  assert.equal(got.map.get("example-app-13.example.test"), "skip");
  assert.match(got.problems[0]!, /is not a mapping/);
});

/* ---------------------------------------------------------- credentials */

test("every credential file WorkDash can hold is refused, including the ones its own backup misses", () => {
  for (const name of [
    "stripe-key", "cf-token", "meta-token", "gsc-key.json", "play-key.json",
    "asc-key.p8", "gmail-token.json", "gmail-client.json", "resend-keys.json",
    "vault.key", "vault.json", "service-key", "auth.json", "telegram-allowed",
    /* These four are the gaps in WorkDash's OWN deny list — see workdash.ts. */
    "adsense-token.json", "reddit-app.json", "dynadot-secret", "spaceship-secret",
  ])
    assert.ok(denied(name), `${name} must never be opened`);
});

test("a state file is not mistaken for a credential", () => {
  for (const name of ["kanban.json", "chats.json", "agent-memory.json", "goals.json", "outcomes.json", "studio.json", "outbox.json", "projects-info.json", "actions.json"])
    assert.equal(denied(name), false, `${name} is state and must be readable`);
});

/* ----------------------------------------------------------- validation */

test("the validator accepts a document with no population and counts every row a customer", () => {
  const r = validateSample({ users: [{ id: "1", createdAt: "2026-01-01" }, { id: "2", createdAt: "2026-01-02" }] });
  assert.equal(r.ok, true);
  assert.equal(r.shape, "users");
  assert.deepEqual(r.populations, { customer: 2, participant: 0, admin: 0, trial: 0, internal: 0, unstated: 0 });
  assert.equal(r.contactable, 0);
  assert.match(r.note, /DEFAULT for a document that never mentions population/);
});

test("the five populations are counted separately, which is the whole point of the field", () => {
  const r = validateSample({
    users: [
      { id: "1", createdAt: "2026-01-01", population: "customer" },
      { id: "2", createdAt: "2026-01-01", population: "participant" },
      { id: "3", createdAt: "2026-01-01", population: "admin" },
      { id: "4", createdAt: "2026-01-01", population: "trial" },
      { id: "5", createdAt: "2026-01-01", population: "internal" },
    ],
  });
  assert.deepEqual(r.populations, { customer: 1, participant: 1, admin: 1, trial: 1, internal: 1, unstated: 0 });
});

test("a population this does not know is a refused ROW, not a silent fallback to customer", () => {
  const r = validate({ users: [{ id: "1", createdAt: "2026-01-01", population: "subscriber" }] });
  assert.equal(r.ok, false);
  assert.match(r.problems[0]!, /population is "subscriber"/);
});

test("consent is only ever a literal true — a string is refused rather than read generously", () => {
  const yes = validate({ users: [{ id: "1", createdAt: "2026-01-01", contactPermitted: true }] });
  assert.equal(yes.ok, true);
  assert.equal(yes.ok && yes.parsed.shape === "users" && yes.parsed.users[0]!.contactPermitted, true);

  const no = validate({ users: [{ id: "1", createdAt: "2026-01-01", contactPermitted: "true" }] });
  assert.equal(no.ok, false);
  assert.match(no.problems[0]!, /is not consent/);
});

test("consent is false by default, on a document that never mentions it", () => {
  const r = validate({ users: [{ id: "1", createdAt: "2026-01-01" }] });
  assert.ok(r.ok && r.parsed.shape === "users");
  assert.equal(r.ok && r.parsed.shape === "users" && r.parsed.users[0]!.contactPermitted, false);
  assert.equal(r.ok && r.parsed.shape === "users" && r.parsed.users[0]!.population, "customer");
});

test("a refusal says the collector would keep what it last had, because that is what happens", () => {
  const r = validateSample({ nothing: true });
  assert.equal(r.ok, false);
  assert.match(r.note, /keeps whatever the endpoint last published/);
});

test("the counts-only form is accepted and is not reported as zero users", () => {
  const r = validateSample({ counts: { total: 158, new: { days: 7, n: 12 } } });
  assert.equal(r.ok, true);
  assert.equal(r.shape, "counts");
  assert.equal(r.total, 158);
  assert.equal(r.populations, null);
  assert.match(r.note, /different fact from an empty list/);
});

test("every row claiming consent is flagged, because a lenient mapping produces exactly that", () => {
  const r = validateSample({
    users: [
      { id: "1", createdAt: "2026-01-01", contactPermitted: true },
      { id: "2", createdAt: "2026-01-01", contactPermitted: true },
    ],
  });
  assert.equal(r.contactable, 2);
  assert.match(r.note, /EVERY row claims consent/);
});

/* ------------------------------------------------------------- rollback */

test("rollback deletes exactly what a batch created and never what it only matched", () => {
  const kept = "v-keptbyowner";
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,'','',NULL,'idea','#635bff','default',900,'{}',?,?)`,
  ).run(kept, "kept-by-owner", "Kept", now(), now());
  const made = "v-madebyimport";
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,'','',NULL,'idea','#635bff','default',901,'{}',?,?)`,
  ).run(made, "made-by-import", "Made", now(), now());
  db.prepare("INSERT INTO chief_goals (scope, venture_id, text, updated_at) VALUES ('global','','from the import',?)").run(now());

  const id = newBatchId();
  openBatch({ id, source: "/tmp/wd", dryRun: false, kinds: ["projects", "workflow"] });
  remember({ sourceKind: "project", sourceId: "kept.co", targetKind: "venture", targetId: kept, batch: id, created: false });
  remember({ sourceKind: "project", sourceId: "made.co", targetKind: "venture", targetId: made, batch: id, created: true });
  remember({ sourceKind: "goals", sourceId: "global", targetKind: "goal", targetId: goalTarget("global", ""), batch: id, created: true });
  closeBatch(id, { ok: true, counts: {}, problems: [] });

  assert.equal(mapRows(id).length, 3);

  const result = rollback(id, () => ({ ok: true }));
  assert.equal(result.ok, true);
  assert.equal(result.deleted.venture, 1, "one created, one only matched");
  assert.equal(result.deleted.goal, 1, "the composite key has to survive the round trip");

  assert.ok(db.prepare("SELECT 1 FROM ventures WHERE id = ?").get(kept), "a venture the owner typed must survive an undo");
  assert.equal(db.prepare("SELECT 1 FROM ventures WHERE id = ?").get(made), undefined);
  assert.equal(db.prepare("SELECT 1 FROM chief_goals WHERE scope = 'global' AND venture_id = ''").get(), undefined);
  assert.equal(mapRows(id).length, 0, "the map is cleared, so a second rollback has nothing to take");
});

test("a batch cannot be rolled back twice, and a dry run cannot be rolled back at all", () => {
  const dry = newBatchId();
  openBatch({ id: dry, source: "/tmp/wd", dryRun: true, kinds: ["board"] });
  const a = rollback(dry, () => ({ ok: true }));
  assert.equal(a.ok, false);
  assert.match(a.error!, /was a dry run/);

  const real = newBatchId();
  openBatch({ id: real, source: "/tmp/wd", dryRun: false, kinds: ["board"] });
  assert.equal(rollback(real, () => ({ ok: true })).ok, true);
  const twice = rollback(real, () => ({ ok: true }));
  assert.equal(twice.ok, false);
  assert.match(twice.error!, /already rolled back/);
});

test("a file that changed since it was copied is kept and named rather than deleted", () => {
  const id = newBatchId();
  openBatch({ id, source: "/tmp/wd", dryRun: false, kinds: ["assets"] });
  db.prepare(
    "INSERT INTO migrate_files (batch, path, source_path, bytes, target_kind, target_id, imported_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, "/tmp/opc-test-asset.webp", "/tmp/wd/studio/a.webp", 15, "studio_post", "wd-a", now());
  const result = rollback(id, (path) => ({ ok: false, why: `${path} is a different size now.` }));
  assert.equal(result.ok, true);
  assert.equal(result.filesRemoved, 0);
  assert.equal(result.filesKept.length, 1);
  assert.match(result.filesKept[0]!.why, /different size/);
});

test("an unknown target kind is refused at the point it would be recorded, not at rollback", () => {
  const id = newBatchId();
  openBatch({ id, source: "/tmp/wd", dryRun: false, kinds: ["board"] });
  assert.throws(
    () => remember({ sourceKind: "thing", sourceId: "1", targetKind: "invoice", targetId: "9", batch: id, created: true }),
    /not a target kind this can undo/,
  );
});

test("the goal key separator cannot appear in either half of the key it joins", () => {
  assert.equal(GOAL_KEY, "|");
  assert.equal(goalTarget("venture", "v-abc123"), "venture|v-abc123");
  assert.deepEqual("venture|v-abc123".split(GOAL_KEY), ["venture", "v-abc123"]);
});
