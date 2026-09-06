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
import { markThread, parseBatch, storedFor, ventureByHost } from "./triage.ts";
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
  { id: "v-example-app-1", name: "Example App 1", slug: "example-app-1", host: "example-app-1.example.test" },
  { id: "v-example-content", name: "example.ie", slug: "neu", host: "example.ie" },
  { id: "v-nohost", name: "Idea", slug: "idea", host: null },
];

test("a venture matches on its own host, in the recipients or the sender", () => {
  assert.equal(
    ventureByHost(thread({ recipients: ["hello@example-app-1.example.test"] }), KEYS),
    "v-example-app-1",
  );
  assert.equal(ventureByHost(thread({ from: "a@example.ie" }), KEYS), "v-example-content");
});

test("a subdomain matches and a lookalike domain does not", () => {
  assert.equal(
    ventureByHost(thread({ recipients: ["x@mail.example-app-1.example.test"] }), KEYS),
    "v-example-app-1",
  );
  /* The failure this prevents: `notexample-app-1.example.test` is somebody else's business
     and a substring match would file their mail under this owner's. */
  assert.equal(ventureByHost(thread({ recipients: ["x@notexample-app-1.example.test"] }), KEYS), null);
  assert.equal(ventureByHost(thread({ recipients: ["x@example-app-1.example.test.evil.com"] }), KEYS), null);
});

test("a venture with no host matches nothing, and no match is null", () => {
  assert.equal(ventureByHost(thread({ recipients: ["x@idea.com"] }), KEYS), null);
  assert.equal(ventureByHost(thread(), KEYS), null);
});

test("a fenced, chatty answer still parses", () => {
  const out = parseBatch(
    '```json\n[{"id":1,"score":"needs_reply","urgency":"high","reason":"A customer asked.","venture":"example-app-1"}]\n```',
    2,
  );
  assert.equal(out.size, 1);
  assert.equal(out.get(1)!.score, "needs_reply");
  assert.equal(out.get(1)!.venture, "example-app-1");
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
