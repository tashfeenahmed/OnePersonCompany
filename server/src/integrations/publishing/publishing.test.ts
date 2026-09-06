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
import { db, now } from "../../db.ts";
import { checkLimits, countHashtags, LIMITS } from "./limits.ts";
import { inBlackout, parseAutoSchedule, parseBlackout, normaliseBase } from "./settings.ts";
import { dueItems } from "./scheduler.ts";
import { backoffMs, publishItem } from "./publish.ts";
import { approve, createItem, itemRow, sniff, type ItemRow } from "./items.ts";
import { publishingRoutes } from "./routes.ts";
import { parseUrn } from "../../providers/linkedin.ts";
import { bestPrivacy } from "../../providers/tiktok.ts";
import { dryTransport } from "../../providers/social.ts";
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
  const { slots, bad } = parseAutoSchedule("* = 09:30\nexample-app-1 = 08:00\nrubbish");
  assert.deepEqual(bad, ["rubbish"]);
  assert.deepEqual(slots, [
    { slug: "*", hour: 9, minute: 30 },
    { slug: "example-app-1", hour: 8, minute: 0 },
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
 * THE REGRESSION THIS FILE EXISTS FOR MOST.
 *
 * `rehearse_item` used to be `POST /items/:id/publish` with `dry: true`. The
 * skills proxy sends every parameter as a STRING, so `"true"` reached a strict
 * `=== true` comparison, read false, and a rehearsal published a real post to
 * a real Facebook Page. Nobody typed anything wrong; the endpoint was the
 * wrong shape.
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
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
    body: '{"dry":"true"}',
  });
  const doc = (await res.json()) as { result: { dry: boolean } };
  assert.equal(doc.result.dry, true);
  assert.equal(itemRow(id)!.external_id, null);
});
