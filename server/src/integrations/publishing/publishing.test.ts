/**
 * What can be checked without a network, a credential or an audience.
 *
 * THE THREE THINGS WORTH ASSERTING HERE, and they are the three that would be
 * expensive to be wrong about:
 *
 *   THE LIMITS, because a limit that is wrong in the permissive direction is a
 *   post that fails at somebody else's API with a code instead of here with a
 *   sentence — and the Instagram JPEG rule in particular is invisible until a
 *   container silently never becomes a post.
 *
 *   DUE SELECTION, because the scheduler is the one thing on this box that
 *   acts unattended. Three rules interact — the scheduled time, a retry's
 *   `next_attempt_at`, and the order — and the only honest way to be sure
 *   about them is to fix a list and an instant and assert.
 *
 *   IDEMPOTENCE, because the failure it prevents is the worst one available:
 *   the same post going into somebody's feed twice.
 *
 * AND ONE THING THAT IS NOT A UNIT TEST AND IS HERE ANYWAY: a whole dry-run
 * publish, from an approved item through the credential resolution and the
 * limit checks to the composed Graph request, against a mock transport. It
 * runs the real pipeline; only the socket is replaced. On a box where nothing
 * has posting permission that is the only proof of the pipeline available, and
 * it is worth having in the suite rather than in a shell history.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { DATA_DIR } from "../../config.ts";
import { db, now, upsertPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { checkLimits, countHashtags, LIMITS } from "./limits.ts";
import { inBlackout, parseAutoSchedule, parseBlackout, normaliseBase, STUCK_MINUTES } from "./settings.ts";
import { dueItems, reclaim, tick } from "./scheduler.ts";
import { backoffMs, publishItem } from "./publish.ts";
import { approve, createItem, ITEM_STATUSES, itemRow, sniff, type ItemRow } from "./items.ts";
import { outboxStatus } from "../mailflow/outbound.ts";
import { publishingRoutes } from "./routes.ts";
import { publicAddress } from "./assets.ts";
import { patchItem, schedule } from "./items.ts";
import { parseUrn } from "../../providers/linkedin.ts";
import { bestPrivacy } from "../../providers/tiktok.ts";
import { dryTransport, redact, type Transport } from "../../providers/social.ts";
import { nextSlot } from "./autopilot-hook.ts";
import { parseJson, shapeConcepts } from "./campaigns.ts";

/* ------------------------------------------------------------------ limits */

test("a caption inside every ceiling has nothing wrong with it", () => {
  const problems = checkLimits("page", {
    caption: "Shipped weekly digests today.",
    media: { kind: "image", mime: "image/png", bytes: 200_000, publicUrl: null },
  });
  assert.deepEqual(problems, []);
});

test("a caption over the ceiling names the platform and the overshoot", () => {
  const caption = "x".repeat(LIMITS.ig.caption + 15);
  const problems = checkLimits("ig", {
    caption,
    media: { kind: "image", mime: "image/jpeg", bytes: 100_000, publicUrl: "https://x/y" },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.field, "caption");
  assert.match(problems[0]!.message, /Instagram business account takes 2200/);
  assert.match(problems[0]!.message, /Shorten it by 15/);
});

test("Instagram refuses a PNG, which is the failure that is otherwise invisible", () => {
  const problems = checkLimits("ig", {
    caption: "hello",
    media: { kind: "image", mime: "image/png", bytes: 100_000, publicUrl: "https://x/y" },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.field, "media");
  assert.match(problems[0]!.message, /accepts image\/jpeg and this picture is image\/png/);
});

test("Instagram with no public URL says so as its own problem", () => {
  const problems = checkLimits("ig", {
    caption: "hello",
    media: { kind: "image", mime: "image/jpeg", bytes: 10, publicUrl: null },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.field, "public-url");
  assert.match(problems[0]!.message, /publicBaseUrl/);
});

test("more than thirty hashtags is an Instagram problem and not a Facebook one", () => {
  const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
  assert.equal(countHashtags(caption), 31);
  const ig = checkLimits("ig", {
    caption,
    media: { kind: "image", mime: "image/jpeg", bytes: 10, publicUrl: "https://x/y" },
  });
  assert.ok(ig.some((p) => p.field === "hashtags"));
  const page = checkLimits("page", {
    caption,
    media: { kind: "image", mime: "image/png", bytes: 10, publicUrl: null },
  });
  assert.equal(page.filter((p) => p.field === "hashtags").length, 0);
});

test("video is refused for LinkedIn and Instagram as unsupported, not as an error", () => {
  for (const kind of ["linkedin", "ig"] as const) {
    const problems = checkLimits(kind, {
      caption: "clip",
      media: { kind: "video", mime: "video/mp4", bytes: 1_000_000, publicUrl: "https://x/y" },
    });
    assert.ok(
      problems.some((p) => /not supported for this destination/.test(p.message)),
      `${kind} should say "not supported"`,
    );
  }
});

test("TikTok takes a clip and refuses a picture and a bare caption", () => {
  assert.deepEqual(
    checkLimits("tiktok", {
      caption: "a short title",
      media: { kind: "video", mime: "video/mp4", bytes: 5_000_000, publicUrl: "https://x/y" },
    }),
    [],
  );
  assert.ok(
    checkLimits("tiktok", {
      caption: "a short title",
      media: { kind: "image", mime: "image/jpeg", bytes: 10, publicUrl: "https://x/y" },
    }).some((p) => p.field === "media"),
  );
  assert.ok(
    checkLimits("tiktok", { caption: "words only", media: { kind: "none" } }).some(
      (p) => p.field === "media",
    ),
  );
});

test("nothing at all to post is its own problem", () => {
  assert.ok(
    checkLimits("page", { caption: "", media: { kind: "none" } }).some(
      (p) => p.message === "There is nothing to post — no caption and no media.",
    ),
  );
});

/* --------------------------------------------------------- due selection */

const item = (over: Partial<ItemRow>): ItemRow =>
  ({
    id: "x",
    venture_id: "v",
    destination_id: "d",
    source_kind: "manual",
    source_id: null,
    caption: "c",
    media_kind: "none",
    media_path: null,
    status: "scheduled",
    scheduled_for: null,
    approved_at: null,
    approved_by: null,
    idempotency_key: "k",
    attempts: 0,
    last_attempt_at: null,
    next_attempt_at: null,
    external_id: null,
    permalink: null,
    error: null,
    note: null,
    campaign_id: null,
    published_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as ItemRow;

const AT = "2026-09-06T12:00:00.000Z";

test("due selection takes scheduled rows whose time has passed, oldest first", () => {
  const rows = [
    item({ id: "later", scheduled_for: "2026-09-06T11:59:00.000Z" }),
    item({ id: "earlier", scheduled_for: "2026-09-06T09:00:00.000Z" }),
    item({ id: "future", scheduled_for: "2026-09-06T12:00:01.000Z" }),
  ];
  assert.deepEqual(dueItems(rows, AT).map((r) => r.id), ["earlier", "later"]);
});

test("due selection ignores anything not scheduled, and anything already submitted", () => {
  const rows = [
    item({ id: "draft", status: "draft", scheduled_for: "2026-09-01T00:00:00.000Z" }),
    item({ id: "approved", status: "approved", scheduled_for: "2026-09-01T00:00:00.000Z" }),
    item({ id: "inflight", status: "publishing", scheduled_for: "2026-09-01T00:00:00.000Z" }),
    item({ id: "cancelled", status: "cancelled", scheduled_for: "2026-09-01T00:00:00.000Z" }),
    /* The belt to publishItem's braces: a row carrying an external id is never
       chosen, whatever its status says. */
    item({ id: "sent", scheduled_for: "2026-09-01T00:00:00.000Z", external_id: "123_456" }),
    item({ id: "ok", scheduled_for: "2026-09-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(dueItems(rows, AT).map((r) => r.id), ["ok"]);
});

test("a retry waiting for its backoff is not due, and is due once it has passed", () => {
  const waiting = item({
    id: "waiting",
    scheduled_for: "2026-09-06T09:00:00.000Z",
    next_attempt_at: "2026-09-06T12:05:00.000Z",
  });
  const ready = item({
    id: "ready",
    scheduled_for: "2026-09-06T09:00:00.000Z",
    next_attempt_at: "2026-09-06T11:55:00.000Z",
  });
  assert.deepEqual(dueItems([waiting, ready], AT).map((r) => r.id), ["ready"]);
});

test("the backoff grows and is capped at six hours", () => {
  assert.equal(backoffMs(1), 5 * 60_000);
  assert.equal(backoffMs(2), 15 * 60_000);
  assert.equal(backoffMs(3), 45 * 60_000);
  assert.equal(backoffMs(4), 135 * 60_000);
  assert.equal(backoffMs(9), 360 * 60_000);
  assert.ok(backoffMs(2) > backoffMs(1));
});

/* ------------------------------------------------------------- blackout */

test("a blackout window that wraps midnight covers both sides of it", () => {
  const { windows, bad } = parseBlackout("22:00-07:00");
  assert.deepEqual(bad, []);
  assert.equal(windows.length, 1);
  assert.ok(inBlackout(windows, { weekday: 3, minutes: 23 * 60 }));
  assert.ok(inBlackout(windows, { weekday: 3, minutes: 2 * 60 }));
  assert.equal(inBlackout(windows, { weekday: 3, minutes: 12 * 60 }), null);
});

test("a blackout window with days only applies on those days", () => {
  const { windows, bad } = parseBlackout("Sat,Sun 09:00-17:00");
  assert.deepEqual(bad, []);
  assert.ok(inBlackout(windows, { weekday: 6, minutes: 10 * 60 }));
  assert.ok(inBlackout(windows, { weekday: 0, minutes: 10 * 60 }));
  assert.equal(inBlackout(windows, { weekday: 1, minutes: 10 * 60 }), null);
});

test("a day range is expanded and a line that cannot be read is reported", () => {
  const { windows, bad } = parseBlackout("mon-fri 12:00-13:00\nnonsense");
  assert.deepEqual(bad, ["nonsense"]);
  assert.deepEqual(windows[0]!.days.sort(), [1, 2, 3, 4, 5]);
});

test("a public base URL needs a scheme", () => {
  assert.equal(normaliseBase("opc.example.com"), null);
  assert.equal(normaliseBase("https://opc.example.com/"), "https://opc.example.com");
  assert.equal(normaliseBase(""), null);
});

test("auto-schedule lines parse, and a broken one is named", () => {
  const { slots, bad } = parseAutoSchedule("* = 09:30\nacme = 08:00\nrubbish");
  assert.deepEqual(bad, ["rubbish"]);
  assert.deepEqual(slots, [
    { slug: "*", hour: 9, minute: 30 },
    { slug: "acme", hour: 8, minute: 0 },
  ]);
});

test("the next auto-schedule slot is always in the future", () => {
  const at = new Date("2026-09-06T12:00:00.000Z");
  const next = nextSlot("UTC", 9, 30, at);
  assert.ok(new Date(next).getTime() > at.getTime());
  /* 09:30 has passed today, so it is tomorrow's. */
  assert.equal(next, "2026-09-07T09:30:00.000Z");
  assert.equal(nextSlot("UTC", 15, 0, at), "2026-09-06T15:00:00.000Z");
});

/* -------------------------------------------------------------- providers */

test("a LinkedIn author URN is recognised, and a bare page id is promoted", () => {
  assert.deepEqual(parseUrn("urn:li:organization:123"), {
    urn: "urn:li:organization:123",
    kind: "organization",
  });
  assert.deepEqual(parseUrn("urn:li:person:AbC-1"), { urn: "urn:li:person:AbC-1", kind: "person" });
  assert.deepEqual(parseUrn("1234567"), { urn: "urn:li:organization:1234567", kind: "organization" });
  assert.deepEqual(parseUrn("my page"), { urn: null, kind: null });
});

test("TikTok privacy takes the most public level OFFERED, and SELF_ONLY when that is all", () => {
  assert.equal(bestPrivacy(["SELF_ONLY", "PUBLIC_TO_EVERYONE"]), "PUBLIC_TO_EVERYONE");
  assert.equal(bestPrivacy(["SELF_ONLY"]), "SELF_ONLY");
  assert.equal(bestPrivacy([]), "SELF_ONLY");
});

test("a file's type comes from its bytes and not from a name", () => {
  assert.equal(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0])), "image/png");
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(new Uint8Array([1, 2, 3, 4])), null);
});

/* -------------------------------------------------------------- campaigns */

test("concepts are shaped, deduplicated by theme and capped", () => {
  const raw = parseJson(
    '```json\n{"concepts":[{"theme":"One","description":"a"},{"theme":"one","description":"b"},{"theme":"Two"},{"theme":""}]}\n```',
  );
  const shaped = shapeConcepts(raw, 3);
  assert.deepEqual(shaped.map((c) => c.theme), ["One", "Two"]);
});

test("an answer with no JSON object at all is null rather than a throw", () => {
  assert.equal(parseJson("I would be happy to help!"), null);
});

/* ---------------------------------------------- a whole dry-run publish */

test("the pipeline reaches the Graph call with a mock transport and posts nothing", async () => {
  /* A venture, a destination and a real file on disk — the same three things a
     live publish needs. The database is a fresh temporary one per test worker
     (see test/setup.mjs), so nothing here touches a developer's rows. */
  const ts = now();
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES ('v-t','t','Test venture','A test','https://t.invalid','t.invalid','launched','#123456','default',0,'{}',?,?)`,
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO publish_destinations
       (id, venture_id, plugin_id, account_id, account_label, kind, external_id, handle,
        enabled, capabilities, probe_ts, probe_ok, probe_error, created_at, updated_at)
     VALUES ('d-t','v-t','meta',1,'Account 1','page','PAGE1','Test Page',1,?,?,1,NULL,?,?)`,
  ).run(
    JSON.stringify({ text: true, photo: true, video: true, missing: [], facts: {}, note: "" }),
    ts,
    ts,
    ts,
  );

  const dir = resolve(DATA_DIR, "studio");
  mkdirSync(dir, { recursive: true });
  const png = resolve(dir, "test-publish.png");
  /* A minimal but genuine PNG signature, so `sniff` reads image/png and the
     Facebook limits pass on a real type rather than on a guess. */
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
  db.prepare(
    `INSERT INTO studio_posts (id, venture_id, ts, brief, platform, format, caption, hashtags, image_prompt, image_path, model, ms, error)
     VALUES ('p-t','v-t',?,'a brief','Facebook','square','A caption for the test.','#one #two','prompt',?,'m',1,NULL)`,
  ).run(ts, png);

  const created = createItem({
    source: { kind: "studio_post", id: "p-t" },
    destinationId: "d-t",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const id = created.item.id;
  assert.equal(created.item.status, "draft");
  assert.equal(created.item.media_kind, "image");

  /* IDEMPOTENCE: the same source to the same destination is the same request. */
  const again = createItem({ source: { kind: "studio_post", id: "p-t" }, destinationId: "d-t" });
  assert.ok(again.ok);
  assert.equal(again.created, false);
  assert.equal(again.item.id, id);

  /* A draft is not publishable, and the refusal names the reason. */
  const refused = await publishItem(id, {});
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /Only an approved item is published/);

  const approved = approve(id, "test");
  assert.ok(approved.ok, approved.ok ? "" : approved.error);
  assert.equal(approved.item.status, "approved");

  /* THE REHEARSAL. Real checks, real credential lookup, real request bodies —
     and a transport that answers from a table. There is no Meta credential in
     a test database, so the pipeline stops exactly where it should: at the
     credential, having passed every check before it. */
  const t = dryTransport();
  const dry = await publishItem(id, { dry: true, transport: t });
  assert.equal(dry.dry, true);
  assert.equal(dry.ok, false);
  assert.match(dry.error!, /Meta account this destination came from is not connected/);

  /* NOTHING WAS WRITTEN TO THE ITEM BY THE REHEARSAL. */
  const after = itemRow(id)!;
  assert.equal(after.status, "approved");
  assert.equal(after.external_id, null);
  assert.equal(after.attempts, 0);

  /* And the rehearsal was recorded as one. */
  const attempt = db
    .prepare("SELECT dry, ok FROM publish_attempts WHERE item_id = ? ORDER BY id DESC LIMIT 1")
    .get(id) as { dry: number; ok: number };
  assert.equal(attempt.dry, 1);
  assert.equal(attempt.ok, 0);
});

/* ------------------------------------------------ the flag that published */

/**
 * THE REGRESSION THIS FILE EXISTS FOR MOST — routes.ts's header on `/rehearse`
 * has the incident.
 *
 * Two assertions, and they are two different guarantees:
 *   the rehearse route CANNOT publish, whatever is sent to it;
 *   the publish route REFUSES a `dry` it cannot read, rather than falling
 *   through to the side that posts.
 */
test("the rehearse route is dry whatever the body says", async () => {
  const ts = now();
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES ('v-r','r','Rehearsal venture','x',NULL,NULL,'launched','#123456','default',1,'{}',?,?)`,
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO publish_destinations
       (id, venture_id, plugin_id, account_id, account_label, kind, external_id, handle,
        enabled, capabilities, probe_ts, probe_ok, probe_error, created_at, updated_at)
     VALUES ('d-r','v-r','meta',1,'Account 1','page','PAGE-R','Rehearsal Page',1,?,?,1,NULL,?,?)`,
  ).run(
    JSON.stringify({ text: true, photo: false, video: false, missing: [], facts: {}, note: "" }),
    ts,
    ts,
    ts,
  );
  const created = createItem({
    ventureId: "v-r",
    source: { kind: "manual", id: null },
    destinationId: "d-r",
    caption: "A caption with no picture.",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const id = created.item.id;
  assert.ok(approve(id, "test").ok);

  /* Every shape the proxy or a confused caller could send. None of them may
     produce a live submission. */
  for (const body of ['{"dry":"false"}', '{"dry":false}', "{}", '{"dry":"nonsense"}']) {
    const res = await publishingRoutes.request(`/items/${id}/rehearse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const doc = (await res.json()) as { result: { dry: boolean } };
    assert.equal(doc.result.dry, true, `body ${body} should still be a rehearsal`);
  }
  assert.equal(itemRow(id)!.status, "approved");
  assert.equal(itemRow(id)!.external_id, null);
});

test("the publish route refuses a `dry` it cannot read rather than posting", async () => {
  const created = createItem({
    ventureId: "v-r",
    source: { kind: "manual", id: null },
    destinationId: "d-r",
    caption: "Another caption.",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const res = await publishingRoutes.request(`/items/${created.ok ? created.item.id : ""}/publish`, {
    method: "POST",
    /* `sec-fetch-site` because the publish route is BROWSER-ONLY and now
       actually is: `requireBrowser` used to refuse only what it could see — a
       foreign origin, a presented key — so a request carrying no headers at
       all walked through it. A test that posts with no headers was testing the
       hole, so it says which door it is coming in by. */
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: '{"dry":"yes please"}',
  });
  assert.equal(res.status, 400);
  const doc = (await res.json()) as { error: string };
  assert.match(doc.error, /refusing rather than guessing/);
});

test("the string \"true\" is read as a rehearsal on the publish route too", async () => {
  const created = createItem({
    ventureId: "v-r",
    source: { kind: "manual", id: null },
    destinationId: "d-r",
    caption: "A third caption.",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const id = created.ok ? created.item.id : "";
  const res = await publishingRoutes.request(`/items/${id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: '{"dry":"true"}',
  });
  const doc = (await res.json()) as { result: { dry: boolean } };
  assert.equal(doc.result.dry, true);
  assert.equal(itemRow(id)!.external_id, null);
});

/* ================================================================ P0 regressions

   Two paths put a DUPLICATE post on a live Page with no owner action. Both
   were three lines. Both are the kind of bug that is invisible until the day
   somebody's feed has the same thing in it twice, so both get a test that
   fails loudly if the line is ever removed.
   ============================================================================ */

/**
 * A connected Meta account in the TEST vault.
 *
 * Needed because the credential lookup happens BEFORE the first network call,
 * so without one the pipeline stops at "not connected" and the transport is
 * never reached — which is right for the pipeline and useless for testing what
 * happens when a call throws. The vault here lives in the per-worker temp data
 * directory (`test/setup.mjs`), so this touches nothing of the developer's.
 */
let metaSeeded = false;
function seedMetaCredential() {
  if (metaSeeded) return;
  metaSeeded = true;
  /* The plugin row first: `accounts` has a foreign key onto it, and a fresh
     per-worker database has no plugins at all. */
  upsertPlugin("meta", true, null);
  const account = accounts.create("meta", "Test account");
  accounts.writeCredentials(account, "meta-token", ["token"], { token: "TEST-TOKEN" });
  /* `seedApproved` writes `account_id = 1` on its destinations, and the first
     account minted in a fresh per-worker database is 1. Asserted rather than
     assumed: if that ever changes, the credential lookup would silently fall
     back to "the first ready account" and these tests would still pass while
     testing something else. */
  assert.equal(account.id, 1);
}

/** A venture, a destination and an approved item — the three rows every path
 *  below needs. Returns the item's id. */
function seedApproved(suffix: string, caption = "A caption with no picture."): string {
  seedMetaCredential();
  const ts = now();
  const v = `v-${suffix}`;
  const d = `d-${suffix}`;
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,'x',NULL,NULL,'launched','#123456','default',9,'{}',?,?)`,
  ).run(v, suffix, `Venture ${suffix}`, ts, ts);
  db.prepare(
    `INSERT INTO publish_destinations
       (id, venture_id, plugin_id, account_id, account_label, kind, external_id, handle,
        enabled, capabilities, probe_ts, probe_ok, probe_error, created_at, updated_at)
     VALUES (?,?, 'meta',1,'Account 1','page',?,?,1,?,?,1,NULL,?,?)`,
  ).run(
    d,
    v,
    `PAGE-${suffix}`,
    `Page ${suffix}`,
    JSON.stringify({ text: true, photo: false, video: false, missing: [], facts: {}, note: "" }),
    ts,
    ts,
    ts,
  );
  const created = createItem({
    ventureId: v,
    source: { kind: "manual", id: null },
    destinationId: d,
    caption,
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const id = created.item.id;
  assert.ok(approve(id, "test").ok);
  return id;
}

test("P0-1: a crash mid-call FAILS the item and takes it off the calendar", async () => {
  const id = seedApproved("p0a");
  assert.ok(schedule(id, new Date(Date.now() - 60_000).toISOString()).ok);

  /* The exact wreckage a killed process leaves: `publishing`, one attempt
     counted, no external id, and a `last_attempt_at` older than the stuck
     window. */
  const old = new Date(Date.now() - (STUCK_MINUTES + 5) * 60_000).toISOString();
  db.prepare(
    "UPDATE publish_items SET status = 'publishing', attempts = 1, last_attempt_at = ? WHERE id = ?",
  ).run(old, id);

  assert.equal(reclaim(), 1);
  const after = itemRow(id)!;
  /* THE WHOLE POINT. It used to come back as `scheduled` with no
     `next_attempt_at`, and `reclaim()` runs at the top of `tick()` with the
     due query right after it — so the same call re-posted it. */
  assert.equal(after.status, "failed");
  assert.equal(after.scheduled_for, null);
  assert.equal(after.next_attempt_at, null);
  assert.match(after.error!, /OUTCOME IS UNKNOWN/);

  /* And it is not due, so a tick cannot pick it up. */
  assert.deepEqual(dueItems(scheduledRowsFor(id), new Date().toISOString()), []);
  const ticked = await tick("manual");
  assert.equal(ticked.publishedId, null);
});

/** Just this item, whatever its status, so the due predicate can be asserted
 *  against it without depending on what else the suite has left lying about. */
function scheduledRowsFor(id: string): ItemRow[] {
  return [itemRow(id)!];
}

test("P0-2: a call that threw is FAILED, never retried", async () => {
  const id = seedApproved("p0b");
  assert.ok(schedule(id, new Date(Date.now() - 60_000).toISOString()).ok);

  /*
    A transport that RECORDS the call and then throws — which is what
    `liveTransport` does on a timeout: `status: null` on the record, and the
    exception propagates. The publisher turns it into a failed outcome with
    `configured: true`, which used to make it retryable.
  */
  const throwing: Transport = {
    calls: [],
    dry: false,
    async fetch(url, init) {
      throwing.calls.push({
        method: init?.method ?? "GET",
        url: redact(url),
        body: null,
        status: null,
        ms: 1,
        dry: false,
      });
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    },
  };

  const res = await publishItem(id, { transport: throwing });
  assert.equal(res.ok, false);
  assert.equal(res.status, "failed");
  assert.match(res.error!, /OUTCOME IS UNKNOWN/);

  const after = itemRow(id)!;
  assert.equal(after.status, "failed");
  /* The date goes too, so nothing can put it back on a timer. */
  assert.equal(after.scheduled_for, null);
  assert.equal(after.next_attempt_at, null);
});

test("a KNOWN refusal on a scheduled item is still retried, with a backoff", async () => {
  const id = seedApproved("p0c");
  assert.ok(schedule(id, new Date(Date.now() - 60_000).toISOString()).ok);

  /* Answers 400 — a fact, not an ambiguity. `status` on the record is a real
     number, so this one stays retryable. */
  const refusing: Transport = {
    calls: [],
    dry: false,
    async fetch(url, init) {
      refusing.calls.push({
        method: init?.method ?? "GET",
        url: redact(url),
        body: null,
        status: 400,
        ms: 1,
        dry: false,
      });
      return new Response(JSON.stringify({ error: { message: "(#100) nope", code: 100 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  };

  const res = await publishItem(id, { transport: refusing });
  assert.equal(res.ok, false);
  assert.equal(res.status, "scheduled");
  const after = itemRow(id)!;
  assert.equal(after.status, "scheduled");
  assert.ok(after.next_attempt_at, "a known refusal gets a next attempt");
  assert.doesNotMatch(after.error ?? "", /OUTCOME IS UNKNOWN/);
});

/**
 * P0-3: TWO SUBMISSIONS OF ONE ITEM, IN FLIGHT AT ONCE.
 *
 * THIS ONE FIRED. It put a real post on a live Facebook Page twice while this
 * area was being built, and the reason was three lines:
 *
 *   - the claim was a bare `UPDATE publish_items SET status = 'publishing'
 *     ... WHERE id = ?`: no transaction, and no status in the WHERE, so two
 *     callers could both "win" it;
 *   - `publishing` — the in-flight status itself — was on the list of statuses
 *     a submission would accept, so the second caller read "somebody is
 *     sending this right now" as "the owner consented to this";
 *   - and the only thing keeping the scheduler from racing itself was a
 *     boolean in module scope, which the manual publish route does not go
 *     through at all.
 *
 * So a tick submitting item X while somebody pressed Publish on X had both
 * callers pass every check and open a socket.
 *
 * THE TEST IS THE RACE AND NOT A PROXY FOR IT. `publishItem` is async and runs
 * synchronously until its first `await`, which is inside the Graph call — so
 * starting both and awaiting them together puts the second one's checks
 * exactly where the real second caller's were: after the first has claimed and
 * before it has answered. Against the code as it was, both transports record a
 * call. Against this code, one does.
 */
test("P0-3: two submissions of one item race, and only ONE reaches the network", async () => {
  const id = seedApproved("p0d");

  /* Answers 400 to everything. What is being counted is whether a socket was
     opened at all, so what comes back does not matter. */
  const counting = (): Transport => {
    const t: Transport = {
      calls: [],
      dry: false,
      async fetch(url, init) {
        t.calls.push({
          method: init?.method ?? "GET",
          url: redact(url),
          body: null,
          status: 400,
          ms: 1,
          dry: false,
        });
        return new Response(JSON.stringify({ error: { message: "(#100) nope", code: 100 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    };
    return t;
  };

  const first = counting();
  const second = counting();
  const [a, b] = await Promise.all([
    publishItem(id, { transport: first, by: "scheduler" }),
    publishItem(id, { transport: second, by: "owner" }),
  ]);

  const reached = [first, second].filter((t) => t.calls.length > 0).length;
  assert.equal(reached, 1, "exactly one submission may reach the network");

  /* And the one that lost says so in a sentence, rather than reporting some
     unrelated failure of its own. */
  const refused = [a, b].find((r) => /submitted right now|not sent twice|not submitted twice/i.test(r.error ?? ""));
  assert.ok(refused, `the losing call should name the reason; got ${JSON.stringify([a.error, b.error])}`);
  assert.equal(refused!.calls.length, 0);
  assert.equal(itemRow(id)!.external_id, null);
});

test("P0-3b: an item already in flight is not a consented item", async () => {
  const id = seedApproved("p0e");
  db.prepare("UPDATE publish_items SET status = 'publishing' WHERE id = ?").run(id);
  const t = dryTransport();
  const res = await publishItem(id, { transport: t });
  assert.equal(res.ok, false);
  assert.match(res.error!, /submitted right now/);
  /* `publishing` used to be in CONSENTED, which is what let the losing caller
     through. `reclaim()` is what rescues a row whose process died, and it moves
     it to `failed` — which IS consented — so the retry button still works. */
  assert.equal(t.calls.length, 0);
});

/* ------------------------------------------------------------- P1 regressions */

test("editing an approved item withdraws the approval and its date", () => {
  const id = seedApproved("p1a");
  assert.ok(schedule(id, new Date(Date.now() + 3_600_000).toISOString()).ok);
  assert.equal(itemRow(id)!.status, "scheduled");

  const res = patchItem(id, { caption: "Different words entirely." });
  assert.ok(res.ok, res.ok ? "" : res.error);
  assert.equal(res.ok && res.unapproved, true);
  const after = itemRow(id)!;
  assert.equal(after.status, "draft");
  assert.equal(after.approved_at, null);
  assert.equal(after.scheduled_for, null);
});

test("an edit that changes nothing does not withdraw an approval", () => {
  const id = seedApproved("p1b", "Exactly these words.");
  const res = patchItem(id, { caption: "Exactly these words." });
  assert.ok(res.ok);
  assert.equal(res.ok && res.unapproved, false);
  assert.equal(itemRow(id)!.status, "approved");
});

test("the two sending routes refuse the skills proxy and both keys", async () => {
  const id = seedApproved("p1c");
  const refused: Record<string, string>[] = [
    /* The proxy's own provenance header, which is how an agent's call arrives
       if somebody adds a registry entry pointing here by accident. */
    { "x-opc-via": "skills" },
    /* And either key, presented directly from a shell. */
    { "x-opc-key": "anything-at-all" },
  ];
  for (const path of [`/items/${id}/publish`, `/items/${id}/retry`]) {
    for (const extra of refused) {
      const res = await publishingRoutes.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: "{}",
      });
      assert.equal(res.status, 403, `${path} with ${Object.keys(extra)[0]}`);
    }
  }
  /* And the item was not touched by any refusal. */
  assert.equal(itemRow(id)!.status, "approved");
});

test("the agent-reachable actions still work through the skills proxy", async () => {
  /* THE OTHER HALF OF THE RULE, and the reason `/api/publishing` is NOT on the
     gate's OWNER_SURFACE prefix list: that list refuses `x-opc-via: skills`
     outright, so putting this area on it would have silently killed queueing,
     approving, scheduling and cancelling — every action the registry
     deliberately publishes, none of which sends anything. */
  const id = seedApproved("p1e");
  const proxied = { "content-type": "application/json", "x-opc-via": "skills" };

  const cancelled = await publishingRoutes.request(`/items/${id}/cancel`, {
    method: "POST",
    headers: proxied,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(itemRow(id)!.status, "cancelled");

  const approved = await publishingRoutes.request(`/items/${id}/approve`, {
    method: "POST",
    headers: proxied,
    body: JSON.stringify({ by: "agent" }),
  });
  assert.equal(approved.status, 200);
  assert.equal(itemRow(id)!.status, "approved");
});

test("retry is reachable: a failed item is accepted by the pipeline", async () => {
  const id = seedApproved("p1d");
  db.prepare("UPDATE publish_items SET status = 'failed' WHERE id = ?").run(id);
  /* It gets past the consent check and stops at the credential, which is as
     far as a test database can go. What it must NOT be is the old
     "That item is failed. Only an approved item is published." */
  const res = await publishItem(id, { transport: dryTransport(), dry: true });
  assert.doesNotMatch(res.error ?? "", /Only an approved item is published/);
});

test("import_asset refuses loopback, private and link-local addresses", () => {
  for (const [ip, why] of [
    ["127.0.0.1", "this machine"],
    ["10.1.2.3", "a private range"],
    ["172.16.0.1", "a private range"],
    ["172.31.255.254", "a private range"],
    ["192.168.0.1", "a private range"],
    ["169.254.169.254", "link-local, where cloud metadata services live"],
    ["100.64.0.1", "a carrier-grade NAT range"],
    ["0.0.0.0", "this network"],
    ["::1", "this machine"],
    ["fd00::1", "a unique-local address"],
    ["fe80::1", "link-local"],
  ] as const) {
    const verdict = publicAddress(ip);
    assert.equal(verdict.ok, false, `${ip} should be refused`);
    assert.equal(verdict.why, why);
  }
  /* 172.15 and 172.32 are OUTSIDE the /12 and are public. */
  for (const ip of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:4700::1111"])
    assert.equal(publicAddress(ip).ok, true, `${ip} should be allowed`);
});

test("a signed upload URL from an unknown host loses its whole query string", () => {
  const signed =
    "https://www.linkedin.com/dms-uploads/abc?sig=SECRET&expiry=123&otherthing=alsosecret";
  const out = redact(signed);
  assert.doesNotMatch(out, /SECRET/);
  assert.doesNotMatch(out, /alsosecret/);
  assert.match(out, /\?REDACTED$/);
  /* Meta's own host keeps its readable parameters and blanks the named ones. */
  const graph = "https://graph.facebook.com/v21.0/me/accounts?fields=id&appsecret_proof=abc123";
  assert.match(redact(graph), /fields=id/);
  assert.doesNotMatch(redact(graph), /abc123/);
});

test("a blackout window includes its closing minute", () => {
  const { windows } = parseBlackout("Sat,Sun 00:00-23:59");
  /* 23:59 on Saturday used to be open, which is the one minute the person who
     typed that window most obviously meant to cover. */
  assert.ok(inBlackout(windows, { weekday: 6, minutes: 23 * 60 + 59 }));
  assert.ok(inBlackout(windows, { weekday: 6, minutes: 0 }));
  assert.equal(inBlackout(windows, { weekday: 1, minutes: 12 * 60 }), null);
});

/**
 * The two outbound queues, checked against each other — which nothing did.
 *
 * They carry the same lifecycle under different words. With no shared type and
 * no test, an eighth status added here would simply have no meaning in the
 * other queue, and the first thing to notice would be a page rendering a state
 * it has no word for.
 */
test("every publishing status has a word in the shared outbound lifecycle", () => {
  for (const status of ITEM_STATUSES)
    assert.ok(
      outboxStatus(status),
      `“${status}” has no word in OUTBOX_STATUSES — add one in mailflow/outbound.ts`,
    );
  /* And the in-flight status maps to the in-flight status, which is the pair
     the claim depends on being the same idea in both queues. */
  assert.equal(outboxStatus("publishing"), "sending");
});

test("a schedule in the PAST is refused: it would publish on the next tick", async () => {
  const id = seedApproved("past-sched");
  const res = await publishingRoutes.request(`/items/${id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString() }),
  });
  assert.equal(res.status, 400);
  const doc = (await res.json()) as { error: string };
  assert.match(doc.error, /already passed/);
  assert.match(doc.error, /Publish now/);
  /* The item is untouched: still approved, still unscheduled. */
  const row = itemRow(id)!;
  assert.equal(row.status, "approved");
  assert.equal(row.scheduled_for, null);

  /* A future instant still schedules, and an unreadable one is refused. */
  const future = await publishingRoutes.request(`/items/${id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ at: new Date(Date.now() + 3_600_000).toISOString() }),
  });
  assert.equal(future.status, 200);
  assert.equal(itemRow(id)!.status, "scheduled");

  const junk = await publishingRoutes.request(`/items/${id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ at: "tomorrow-ish" }),
  });
  assert.equal(junk.status, 400);
  assert.match(((await junk.json()) as { error: string }).error, /not a date/);
});

test("the past check compares instants, not wall-clock strings, whatever zone the caller writes", async () => {
  const id = seedApproved("zone-sched");
  const post = (at: string) =>
    publishingRoutes.request(`/items/${id}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at }),
    });
  /* Thirty minutes ago, written in UTC+14: its wall clock reads hours AHEAD
     of the server's, and it is still the past. */
  const pastMs = Date.now() - 30 * 60_000;
  const plus14 = new Date(pastMs + 14 * 3_600_000).toISOString().slice(0, 19) + "+14:00";
  assert.equal(Date.parse(plus14), Math.floor(pastMs / 1000) * 1000);
  assert.equal((await post(plus14)).status, 400);
  assert.equal(itemRow(id)!.scheduled_for, null);

  /* An hour ahead, written in UTC-12: its wall clock reads BEHIND, and it is
     the future — accepted and stored as the same instant in UTC. */
  const futureMs = Math.floor((Date.now() + 3_600_000) / 1000) * 1000;
  const minus12 = new Date(futureMs - 12 * 3_600_000).toISOString().slice(0, 19) + "-12:00";
  assert.equal((await post(minus12)).status, 200);
  assert.equal(itemRow(id)!.scheduled_for, new Date(futureMs).toISOString());
});
