/**
 * THE ONE WRITE THIS AREA MAKES TO THE OWNER'S OWN DATA, tested end to end.
 *
 * `POST /reviews/triage` files a board card carrying review ids and records
 * which reviews went on it, and both halves of that have a way to go quietly
 * wrong that no typecheck catches:
 *
 *   * `mobile_review_cards` is keyed on the REVIEW, so filing an already-filed
 *     id again REPOINTS it at the new card and erases the record that it is on
 *     the old one — the review then sits on two cards with only one of them
 *     known. A guard that fires only when EVERY id is a duplicate lets exactly
 *     that happen for a partial overlap, which is the common case: an agent
 *     re-reads the inbox, picks the same one-star review plus a new one, and
 *     sends both.
 *   * The board answers with the WHOLE board, flattened column by column and
 *     then by position, so "the last card with this title" is whichever such
 *     card sits furthest right — an older card in a later column, on a
 *     repeated default title. The new card is the one with the highest id.
 *
 * The board is driven in process through its own router rather than over the
 * loopback port, the way regression/mobileRevenue.test.ts drives the skills
 * proxy: the route under test composes a real URL and this stubs `fetch` to
 * hand it to the real board.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db } from "../../db.ts";
import { boardRoutes } from "../../routes/board.ts";
import { nextPassDue } from "./collect.ts";
import { mobileHealthRoutes, readReviewIds } from "./routes.ts";
import { writeReviews } from "./store.ts";

const app = new Hono().route("/api/board", boardRoutes);

/** Every loopback call the route makes, answered by the real board. */
function stubBoard(t: { mock: { method: typeof import("node:test").mock.method } }) {
  t.mock.method(globalThis, "fetch", (input: string, init?: RequestInit) =>
    app.request(input, init),
  );
}

function seed(ids: string[]) {
  writeReviews(
    ids.map((id, i) => ({
      store: "appstore",
      accountId: 1,
      app: "1000000000",
      id,
      rating: 1 + (i % 5),
      title: `Title ${id}`,
      body: `Body ${id}`,
      author: null,
      language: null,
      territory: "GB",
      appVersion: null,
      device: null,
      created: "2026-09-04T00:00:00.000Z",
      updated: "2026-09-04T00:00:00.000Z",
      reply: null,
      repliedAt: null,
    })),
  );
}

async function triage(body: unknown) {
  const res = await mobileHealthRoutes.request("/reviews/triage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, doc: (await res.json()) as Record<string, never> };
}

beforeEach(() => {
  db.prepare("DELETE FROM mobile_review_cards").run();
  db.prepare("DELETE FROM mobile_reviews").run();
  db.prepare("DELETE FROM board_cards").run();
});

/* ------------------------------------------------------- the ids themselves */

test("review ids arrive as an array or as the comma-separated string the CLI sends", () => {
  assert.deepEqual(readReviewIds(["a", "b"]), ["a", "b"]);
  // A skill parameter can only be `number` or `string`, so this is what the
  // agent path actually sends — declaring the param a string and accepting
  // only an array made the published action unusable from `opc`.
  assert.deepEqual(readReviewIds("a,b"), ["a", "b"]);
  assert.deepEqual(readReviewIds(" a , b ,, "), ["a", "b"]);
  // The same id twice would be counted twice on the card and in the reply.
  assert.deepEqual(readReviewIds("a,a,b"), ["a", "b"]);
  assert.deepEqual(readReviewIds(""), []);
  assert.deepEqual(readReviewIds(undefined), []);
  assert.deepEqual(readReviewIds(42), []);
});

test("the route accepts the comma-separated form end to end", async (t) => {
  stubBoard(t);
  seed(["r1", "r2"]);
  const { status, doc } = await triage({ reviewIds: "r1,r2", title: "Comma form" });
  assert.equal(status, 201);
  assert.deepEqual((doc as unknown as { filed: string[] }).filed, ["r1", "r2"]);
});

/* ------------------------------------------------ the partial-overlap guard */

test("a review already on a card is left on it, and only the rest are filed", async (t) => {
  stubBoard(t);
  seed(["r1", "r2", "r3"]);

  const first = await triage({ reviewIds: ["r1"], title: "First card" });
  assert.equal(first.status, 201);
  const firstCard = (first.doc as unknown as { cardId: number }).cardId;

  // r1 is already filed; r2 and r3 are not. The old behaviour put all three on
  // a new card and repointed r1's row at it.
  const second = await triage({ reviewIds: ["r1", "r2", "r3"], title: "Second card" });
  assert.equal(second.status, 201);
  const doc = second.doc as unknown as {
    cardId: number;
    filed: string[];
    alreadyFiled: { reviewId: string; cardId: number }[];
  };
  assert.deepEqual(doc.filed, ["r2", "r3"]);
  assert.deepEqual(doc.alreadyFiled, [{ reviewId: "r1", cardId: firstCard }]);
  // The two lists never overlap — that is the whole claim.
  assert.equal(doc.filed.includes("r1"), false);

  // And r1's record still points at the card it is actually on.
  const rows = (
    db
      .prepare("SELECT review_id, card_id FROM mobile_review_cards ORDER BY review_id")
      .all() as unknown as { review_id: string; card_id: number }[]
  ).map((r) => ({ review_id: r.review_id, card_id: r.card_id }));
  assert.deepEqual(rows, [
    { review_id: "r1", card_id: firstCard },
    { review_id: "r2", card_id: doc.cardId },
    { review_id: "r3", card_id: doc.cardId },
  ]);
});

test("nothing left to file is a 409 naming the cards, not an empty card", async (t) => {
  stubBoard(t);
  seed(["r1", "r2"]);
  const first = await triage({ reviewIds: ["r1", "r2"] });
  assert.equal(first.status, 201);

  const again = await triage({ reviewIds: ["r1", "r2"] });
  assert.equal(again.status, 409);
  assert.match(
    (again.doc as unknown as { error: string }).error,
    new RegExp(String((first.doc as unknown as { cardId: number }).cardId)),
  );
  // No second card was created for a request that filed nothing.
  const n = db.prepare("SELECT COUNT(*) AS n FROM board_cards").get() as { n: number };
  assert.equal(n.n, 1);
});

test("ids this box does not hold are reported back rather than dropped", async (t) => {
  stubBoard(t);
  seed(["r1"]);
  const { status, doc } = await triage({ reviewIds: "r1,nope" });
  assert.equal(status, 201);
  const d = doc as unknown as { filed: string[]; notFound: string[] };
  assert.deepEqual(d.filed, ["r1"]);
  assert.deepEqual(d.notFound, ["nope"]);
});

/* ------------------------------------------ which card the reply points at */

test("the new card is identified by id, not by being last in a flattened board", async (t) => {
  stubBoard(t);
  seed(["r1", "r2"]);

  // Two cards with the SAME title — which the default title produces — and the
  // older one moved into a later column, so a flattened scan finds it last.
  const first = await triage({ reviewIds: ["r1"], title: "Same title" });
  const firstCard = (first.doc as unknown as { cardId: number }).cardId;
  const moved = await app.request(`/api/board/cards/${firstCard}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ columnId: lastColumnId(), before: null }),
  });
  assert.equal(moved.status, 200);

  const second = await triage({ reviewIds: ["r2"], title: "Same title" });
  const secondCard = (second.doc as unknown as { cardId: number }).cardId;
  assert.notEqual(secondCard, firstCard);
  assert.ok(secondCard > firstCard);
  // And the record filed r2 against the card that was actually created.
  const row = db
    .prepare("SELECT card_id FROM mobile_review_cards WHERE review_id = 'r2'")
    .get() as { card_id: number };
  assert.equal(row.card_id, secondCard);
});

function lastColumnId(): number {
  const row = db
    .prepare("SELECT id FROM board_columns ORDER BY position DESC LIMIT 1")
    .get() as { id: number };
  return row.id;
}

/* ------------------------------------------------------- the six-hour clock */

test("the collection clock is read off the runs ledger, so a restart inherits it", () => {
  db.prepare("DELETE FROM runs WHERE plugin_id = 'mobilehealth'").run();

  // Nothing has ever run: due at once, and nothing to inherit.
  assert.deepEqual(nextPassDue(), { lastAt: null, dueAt: null, dueNow: true });

  // A pass an hour ago. `lastAt` used to live in a module variable that went
  // back to 0 on every restart — and this server restarts on every save to
  // server/src, so an editing session ran a full pass every fifteen minutes.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare("INSERT INTO runs (plugin_id, started_at) VALUES ('mobilehealth', ?)").run(hourAgo);
  const due = nextPassDue();
  assert.equal(due.lastAt, hourAgo);
  assert.equal(due.dueNow, false, "an hour after a pass, the next one is not due");
  assert.equal(Date.parse(due.dueAt!) - Date.parse(hourAgo), 6 * 3_600_000);

  // Seven hours ago: due again.
  db.prepare("DELETE FROM runs WHERE plugin_id = 'mobilehealth'").run();
  db.prepare("INSERT INTO runs (plugin_id, started_at) VALUES ('mobilehealth', ?)").run(
    new Date(Date.now() - 7 * 3_600_000).toISOString(),
  );
  assert.equal(nextPassDue().dueNow, true);
});
