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
 * Nothing here opens the database or the network.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseBatch, ventureByHost } from "./triage.ts";
import { validAddress } from "./gmail-send.ts";
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
