/**
 * The pure halves of mailflow, pinned.
 *
 * THREE THINGS ARE TESTED AND THEY ARE THE THREE THAT CAN BE WRONG SILENTLY.
 * The model's answer is written by a free endpoint on the other side of the
 * internet and arrives inside code fences, with commentary, with invented
 * categories; a batch it mangles must leave its threads UNSCORED rather than
 * defaulted to one, because "noise" is the category that hides mail. The
 * venture match decides which business a thread is filed under and a substring
 * match there would file a stranger's domain as the owner's. And the address
 * check is what stands between a queue row and a header injection.
 *
 * AND ONE THAT IS NOT PURE AND BELONGS HERE ANYWAY: the suppression check at
 * the send door, against the real table, because the failure it prevents is a
 * message reaching somebody who asked not to be written to.
 *
 * Nothing here touches the network.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { db, now, upsertPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import {
  cachedFor,
  cachedPage,
  decide,
  domainsOf,
  markThread,
  parseBatch,
  planPass,
  storedFor,
  unscoredCount,
  ventureByDomains,
  ventureByHost,
} from "./triage.ts";
import type { CachedThread } from "./triage.ts";
import type { ThreadStub } from "../../providers/gmail.ts";
import { validAddress } from "./gmail-send.ts";
import { approveDraft, prepareDraft, row as outboxRow, SendRefused, sendApproved } from "./outbox.ts";
import { optOut } from "../nurture/sequences.ts";
import type { ThreadRow } from "../../providers/gmail.ts";

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t1",
  subject: "s",
  from: "someone@elsewhere.com",
  fromName: "Someone",
  to: "",
  at: 1,
  snippet: "",
  unread: false,
  labels: [],
  messages: 1,
  recipients: [],
  ...over,
});

const KEYS = [
  { id: "v-acme", name: "Acme", slug: "acme", host: "acme.ie" },
  { id: "v-acme2", name: "Acme Two", slug: "acme2", host: "acme.so" },
  { id: "v-nohost", name: "Idea", slug: "idea", host: null },
];

test("a venture matches on its own host, in the recipients or the sender", () => {
  assert.equal(
    ventureByHost(thread({ recipients: ["hello@acme.ie"] }), KEYS),
    "v-acme",
  );
  assert.equal(ventureByHost(thread({ from: "a@acme.so" }), KEYS), "v-acme2");
});

test("a subdomain matches and a lookalike domain does not", () => {
  assert.equal(
    ventureByHost(thread({ recipients: ["x@mail.acme.ie"] }), KEYS),
    "v-acme",
  );
  /* The failure this prevents: `notacme.ie` is somebody else's business
     and a substring match would file their mail under this owner's. */
  assert.equal(ventureByHost(thread({ recipients: ["x@notacme.ie"] }), KEYS), null);
  assert.equal(ventureByHost(thread({ recipients: ["x@acme.ie.evil.com"] }), KEYS), null);
});

test("a venture with no host matches nothing, and no match is null", () => {
  assert.equal(ventureByHost(thread({ recipients: ["x@idea.com"] }), KEYS), null);
  assert.equal(ventureByHost(thread(), KEYS), null);
});

test("a fenced, chatty answer still parses", () => {
  const out = parseBatch(
    '```json\n[{"id":1,"score":"needs_reply","urgency":"high","reason":"A customer asked.","venture":"acme"}]\n```',
    2,
  );
  assert.equal(out.size, 1);
  assert.equal(out.get(1)!.score, "needs_reply");
  assert.equal(out.get(1)!.venture, "acme");
});

test("an invented category is dropped rather than kept", () => {
  const out = parseBatch('[{"id":1,"score":"urgent","reason":"x"}]', 2);
  assert.equal(out.size, 0);
});

test("an id outside the batch is dropped", () => {
  const out = parseBatch('[{"id":9,"score":"noise","reason":"x"}]', 2);
  assert.equal(out.size, 0);
});

test("an unparseable answer scores nothing at all — never a default category", () => {
  assert.equal(parseBatch("I could not do that.", 3).size, 0);
  assert.equal(parseBatch("", 3).size, 0);
  assert.equal(parseBatch("[not json]", 3).size, 0);
});

test("an unknown urgency falls back to normal but the category still stands", () => {
  const out = parseBatch('[{"id":1,"score":"fyi","urgency":"CRITICAL","reason":"x"}]', 1);
  assert.equal(out.get(1)!.urgency, "normal");
  assert.equal(out.get(1)!.score, "fyi");
});

test("an address with a newline in it is not an address", () => {
  assert.equal(validAddress("a@b.com"), true);
  assert.equal(validAddress("a@b.com\r\nBcc: victim@x.com"), false);
  assert.equal(validAddress("a@b.com, c@d.com"), false);
  assert.equal(validAddress("<a@b.com>"), false);
  assert.equal(validAddress("nodomain@localhost"), false);
  assert.equal(validAddress(""), false);
});

/* ============================================================ P0 regression

   DO NOT WRITE TO THIS ADDRESS.

   `nurture_optouts` was consulted when a draft was PLANNED and never again.
   `sendApproved` is the single send door — it re-reads the row, re-checks the
   per-address floor and re-checks the daily cap, all because time passes
   between "was it fair to write this" and "may this leave" — and it did not
   consult the opt-out table at all. So somebody who unsubscribed after a draft
   had been written still got the mail, while the Nurture page beside it
   reported them as opted out.

   The window is small and it is real: `optOut()` dismisses every live draft it
   can see, so the only rows that reach this are the ones approved in the same
   breath as the opt-out landing. That is exactly the case where a person has
   just typed "stop" and the queue is about to answer them.
   ========================================================================= */

/** A connected Gmail account with a collected address, which is the least
 *  `routeFor` needs to produce an honest From line. Without it the send
 *  refuses for the wrong reason and the test would pass while testing
 *  nothing. */
function seedMailbox(): number {
  upsertPlugin("gmail", true, null);
  const account = accounts.create("gmail", "Test mailbox");
  db.prepare(
    "INSERT OR REPLACE INTO gmail_mailboxes (account_id, account_label, address, seen_at) VALUES (?,?,?,?)",
  ).run(account.id, account.label, "owner@example.com", now());
  return account.id;
}

test("P0: an address that opted out AFTER approval is refused at the send door", async () => {
  const accountId = seedMailbox();
  const to = "someone@example.com";
  const made = prepareDraft({
    accountId,
    to,
    subject: "A subject",
    body: "A body.",
    generatedBody: null,
    inReplyTo: null,
    venture: null,
    identityId: null,
    createdBy: "test",
    plan: undefined,
    facts: undefined,
    validation: undefined,
    sequenceId: null,
    sequenceStep: null,
  });
  assert.ok("item" in made, "item" in made ? "" : made.refused);
  const id = (made as { item: { id: number } }).item.id;

  /* Approved first — this is the state the hole needed. */
  approveDraft(id);
  assert.equal(outboxRow(id)!.status, "approved");

  /* Then they unsubscribe. `optOut` dismisses live drafts, so this one is put
     back to `approved` by hand: that is the race the door has to cover, and
     without it this test would be testing the cascade rather than the door. */
  optOut(to, "asked to be left alone");
  db.prepare("UPDATE mailflow_outbox SET status = 'approved', error = NULL WHERE id = ?").run(id);

  await assert.rejects(
    () => sendApproved(id),
    (err: unknown) => {
      assert.ok(err instanceof SendRefused);
      assert.match((err as Error).message, /asked not to be written to again/);
      return true;
    },
  );

  /* AND IT IS NOT LEFT CLAIMED. A refusal inside the claim rolls the whole
     transaction back, so the row is exactly where it was — not stuck in
     `sending`, which is the state nothing retries out of. */
  const after = outboxRow(id)!;
  assert.equal(after.status, "approved");
  assert.equal(after.sent_at, null);
  assert.equal(after.sending_at, null);
});

/* -------------------------------------------------------------- the verbs */

/* The property that let three surfaces drop their read-before-write. */
test("a verb keeps the column it did not name, and invents no score", () => {
  const account = 4242;
  const thread = "verbs";

  markThread(account, thread, { doneAt: "2026-09-06T10:00:00.000Z" });
  const first = storedFor(account).get(thread)!;
  assert.equal(first.done_at, "2026-09-06T10:00:00.000Z");
  assert.equal(first.snoozed_until, null);
  /* A thread acted on before any pass read it carries a verb and NO opinion. */
  assert.equal(first.score, null);

  markThread(account, thread, { snoozedUntil: "2026-09-13T10:00:00.000Z" });
  const second = storedFor(account).get(thread)!;
  assert.equal(second.snoozed_until, "2026-09-13T10:00:00.000Z");
  assert.equal(second.done_at, "2026-09-06T10:00:00.000Z");

  /* An explicit null is the undo and it clears — which is a different thing
     from omitting the field. */
  markThread(account, thread, { doneAt: null });
  const third = storedFor(account).get(thread)!;
  assert.equal(third.done_at, null);
  assert.equal(third.snoozed_until, "2026-09-13T10:00:00.000Z");
});

/* ------------------------------------------------- the incremental decision

   THE PROPERTY: a pass must buy a `threads.get` for exactly the threads that
   are new or have moved, and for nothing else. Getting this wrong is silent
   in both directions and expensive in both — too eager and every half hour
   costs two thousand quota units to re-read mail nobody touched; too lazy and
   the page shows yesterday's subject line under today's reply.
   ========================================================================= */

const stub = (over: Partial<ThreadStub> = {}): ThreadStub => ({
  id: "t1",
  snippet: "hello there",
  historyId: "100",
  ...over,
});

const cachedRow = (over: Partial<CachedThread> = {}): CachedThread => ({
  account_id: 7,
  thread_id: "t1",
  subject: "A subject",
  from_address: "someone@elsewhere.com",
  from_name: "Someone",
  snippet: "hello there",
  at_ms: 1_000,
  messages: 1,
  unread: 0,
  domains: JSON.stringify(["elsewhere.com"]),
  history_id: "100",
  seen_at: "2026-09-09T09:00:00.000Z",
  gone_at: null,
  ...over,
});

test("a thread with no cached row is new", () => {
  assert.equal(decide(stub(), undefined), "new");
});

test("the history id decides, and it decides alone", () => {
  assert.equal(decide(stub({ historyId: "100" }), cachedRow({ history_id: "100" })), "unchanged");
  assert.equal(decide(stub({ historyId: "101" }), cachedRow({ history_id: "100" })), "changed");
  /* Gmail moves the history id for anything that happens to a thread, so a
     snippet that looks the same is not evidence against it. */
  assert.equal(
    decide(stub({ historyId: "101", snippet: "hello there" }), cachedRow({ history_id: "100" })),
    "changed",
  );
});

test("without a history id the snippet stands in", () => {
  assert.equal(
    decide(stub({ historyId: null, snippet: "hello there" }), cachedRow({ history_id: null })),
    "unchanged",
  );
  assert.equal(
    decide(stub({ historyId: null, snippet: "a reply" }), cachedRow({ history_id: null })),
    "changed",
  );
});

test("a thread that had left the window and came back is always re-read", () => {
  assert.equal(
    decide(stub({ historyId: "100" }), cachedRow({ history_id: "100", gone_at: "2026-09-08T09:00:00.000Z" })),
    "changed",
  );
});

test("a pass buys the new and the moved, keeps the unchanged, and marks the absent gone", () => {
  const cache = new Map<string, CachedThread>([
    ["same", cachedRow({ thread_id: "same", history_id: "1" })],
    ["moved", cachedRow({ thread_id: "moved", history_id: "1" })],
    ["absent", cachedRow({ thread_id: "absent", history_id: "1" })],
  ]);
  const plan = planPass(
    [
      stub({ id: "same", historyId: "1" }),
      stub({ id: "moved", historyId: "2" }),
      stub({ id: "fresh", historyId: "9" }),
    ],
    cache,
  );
  assert.deepEqual(plan.fetch.map((s) => s.id), ["moved", "fresh"]);
  assert.deepEqual(plan.unchanged, ["same"]);
  assert.deepEqual(plan.gone, ["absent"]);
});

test("a row already marked gone is not marked gone twice", () => {
  const cache = new Map<string, CachedThread>([
    ["old", cachedRow({ thread_id: "old", gone_at: "2026-09-01T00:00:00.000Z" })],
  ]);
  assert.deepEqual(planPass([], cache).gone, []);
});

/* The failure this prevents: a busy mailbox whose window holds more threads
   than the listing cap returns a PAGE, and every cached thread past the cut
   would look archived. A page that hides mail because a limit was reached is
   the one thing this area is built not to do. */
test("a listing that filled the cap marks nothing gone", () => {
  const cache = new Map<string, CachedThread>([
    ["a", cachedRow({ thread_id: "a", history_id: "1" })],
    ["b", cachedRow({ thread_id: "b", history_id: "1" })],
  ]);
  const plan = planPass([stub({ id: "a", historyId: "1" })], cache, { truncated: true });
  assert.deepEqual(plan.unchanged, ["a"]);
  assert.deepEqual(plan.gone, []);
});

/* ----------------------------------------------------------- the row cache */

const ACCOUNT = 9191;

function cache(row: Partial<CachedThread>): void {
  const r = cachedRow({ account_id: ACCOUNT, ...row });
  db.prepare(
    `INSERT OR REPLACE INTO mailflow_triage_threads
       (account_id, thread_id, subject, from_address, from_name, snippet, at_ms,
        messages, unread, domains, history_id, seen_at, gone_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.account_id, r.thread_id, r.subject, r.from_address, r.from_name, r.snippet,
    r.at_ms, r.messages, r.unread, r.domains, r.history_id, r.seen_at, r.gone_at,
  );
}

test("the page reads the cache: in the window, not gone, newest first", () => {
  const day = 86_400_000;
  cache({ thread_id: "now", at_ms: Date.now() - 60_000 });
  cache({ thread_id: "yesterday", at_ms: Date.now() - day });
  cache({ thread_id: "old", at_ms: Date.now() - 9 * day });
  cache({ thread_id: "archived", at_ms: Date.now() - 60_000, gone_at: "2026-09-09T09:00:00.000Z" });

  const page = cachedPage(ACCOUNT, { days: 3, max: 50 });
  assert.deepEqual(page.map((r) => r.thread_id), ["now", "yesterday"]);
  /* A wider window reaches the older row WITHOUT a Gmail call — which is the
     whole reason a row that ages out is kept rather than deleted. */
  assert.equal(cachedPage(ACCOUNT, { days: 14, max: 50 }).length, 3);
  assert.equal(cachedPage(ACCOUNT, { days: 3, max: 1 }).length, 1);
  assert.equal(cachedFor(ACCOUNT).size, 4);
});

test("unscored counts rows with no category, and a verb is not a category", () => {
  assert.equal(unscoredCount(ACCOUNT, 3), 2);
  /* Marking one done leaves a judgement row with score NULL. It is still
     unscored — the model has not read it — and that is the count that must
     not quietly become zero. */
  markThread(ACCOUNT, "now", { doneAt: "2026-09-09T10:00:00.000Z" });
  assert.equal(unscoredCount(ACCOUNT, 3), 2);
});

test("a cached row carries domains rather than addresses, and still tags a venture", () => {
  cache({ thread_id: "tagged", domains: JSON.stringify(["mail.acme.ie"]) });
  const row = cachedFor(ACCOUNT).get("tagged")!;
  assert.deepEqual(domainsOf(row), ["mail.acme.ie"]);
  assert.equal(ventureByDomains(domainsOf(row), KEYS), "v-acme");
  /* Unreadable JSON costs a venture tag and never invents one. */
  assert.deepEqual(domainsOf(cachedRow({ domains: "not json" })), []);
  assert.equal(ventureByDomains([], KEYS), null);
});
