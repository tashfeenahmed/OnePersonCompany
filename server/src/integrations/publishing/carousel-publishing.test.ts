/**
 * A CAROUSEL IN PUBLISHING: one draft holding all six slides, in order, and
 * never a post of slide one.
 *
 * Everything here runs against the per-worker temporary database and data
 * directory (test/setup.mjs) and a transport that records requests instead of
 * sending them. Nothing is published anywhere.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { DATA_DIR } from "../../config.ts";
import { db, now, upsertPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { CAROUSEL_SLIDES } from "../../../../shared/carousel.ts";
import { checkLimits, LIMITS } from "./limits.ts";
import { approve, cancel, CAROUSEL_SLIDE_COUNT, createItem, itemRow, mediaPaths, shapeItem } from "./items.ts";
import { publishItem } from "./publish.ts";
import { sourceDeletionProblem } from "./sourceDeletion.ts";
import { captionFromPlan, ensureCarouselCaption } from "./carouselCaption.ts";
import { publishingRoutes } from "./routes.ts";
import { postInstagramCarousel, postPageCarousel } from "../../providers/meta.ts";
import { postImages } from "../../providers/linkedin.ts";
import { dryTransport, type Transport } from "../../providers/social.ts";

const PNG = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);

function venture(id: string) {
  const ts = now();
  db.prepare(
    `INSERT OR IGNORE INTO ventures (id, slug, name, description, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,?,'x','launched','#123456','default',0,'{}',?,?)`,
  ).run(id, id, `Venture ${id}`, ts, ts);
  return id;
}

/** A finished carousel: the row and six PNGs where the run directory keeps them. */
function carousel(runId: string, ventureId: string, opts: { caption?: string | null; slides?: number } = {}) {
  const dir = resolve(DATA_DIR, "video", runId);
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= (opts.slides ?? 6); n++) writeFileSync(resolve(dir, `slide-${n}.png`), PNG(n));
  const plan = Array.from({ length: 6 }, (_, i) => ({
    n: i + 1,
    role: i === 0 ? "hook" : i === 5 ? "cta" : "body",
    headline: i === 0 ? "Stop paying for tokens" : i === 5 ? "Which provider do you use?" : `Point ${i}`,
    body: "",
  }));
  db.prepare(
    `INSERT INTO studio_carousels (run_id, venture_id, ts, size, width, height, prompt, title, caption, slides)
     VALUES (?,?,?,'portrait',1080,1350,'',?,?,?)`,
  ).run(runId, ventureId, now(), "Free LLM APIs", opts.caption ?? null, JSON.stringify(plan));
}

function destination(id: string, ventureId: string, plugin: string, kind: string) {
  const ts = now();
  db.prepare(
    `INSERT INTO publish_destinations
       (id, venture_id, plugin_id, account_id, account_label, kind, external_id, handle,
        enabled, capabilities, probe_ts, probe_ok, probe_error, created_at, updated_at)
     VALUES (?,?,?,1,'Account 1',?,?,?,1,?,?,1,NULL,?,?)`,
  ).run(
    id, ventureId, plugin, kind, `EXT-${id}`, `Handle ${id}`,
    JSON.stringify({ text: true, photo: true, video: true, missing: [], facts: {}, note: "" }),
    ts, ts, ts,
  );
  return id;
}

/** A transport that records every request body as sent, and answers like the
 *  dry one. Nothing leaves the process. */
function capturing(): Transport & { bodies: { url: string; body: unknown }[] } {
  const inner = dryTransport();
  const bodies: { url: string; body: unknown }[] = [];
  return {
    calls: inner.calls,
    dry: true,
    bodies,
    async fetch(url, init) {
      bodies.push({ url, body: init?.body });
      return inner.fetch(url, init);
    },
  };
}

/* ------------------------------------------------------------------ limits */

test("the server's carousel slide count is the Studio's", () => {
  assert.equal(CAROUSEL_SLIDE_COUNT, CAROUSEL_SLIDES);
});

test("each network's carousel rule: Facebook and LinkedIn take six PNGs, Instagram wants JPEG, TikTok refuses", () => {
  const six = Array.from({ length: 6 }, () => ({ mime: "image/png", bytes: 300_000 }));
  const post = (images: typeof six) => ({ caption: "Six slides.", media: { kind: "carousel" as const, images, publicUrl: "https://x.invalid/m" } });
  assert.deepEqual(checkLimits("page", post(six)), []);
  assert.deepEqual(checkLimits("linkedin", post(six)), []);

  const ig = checkLimits("ig", post(six));
  assert.equal(ig.length, 1);
  assert.match(ig[0]!.message, /accepts image\/jpeg and every slide are image\/png/);
  assert.deepEqual(checkLimits("ig", post(six.map(() => ({ mime: "image/jpeg", bytes: 300_000 })))), []);

  const tt = checkLimits("tiktok", post(six));
  assert.equal(tt.length, 1);
  assert.match(tt[0]!.message, /does not take a carousel.*not even the first slide/);
  assert.equal(LIMITS.tiktok.carousel, null);
});

test("carousel counts are the documented ones and oversized slides are named", () => {
  const img = { mime: "image/png", bytes: 100 };
  const one = checkLimits("linkedin", { caption: "x", media: { kind: "carousel", images: [img] } });
  assert.match(one[0]!.message, /1 picture and LinkedIn .* takes 2 to 20/);
  const eleven = checkLimits("page", { caption: "x", media: { kind: "carousel", images: Array(11).fill(img) } });
  assert.match(eleven[0]!.message, /11 pictures .* takes 2 to 10/);
  const big = checkLimits("linkedin", {
    caption: "x",
    media: { kind: "carousel", images: [img, { mime: "image/png", bytes: 11 * 1024 * 1024 }, img] },
  });
  assert.match(big[0]!.message, /Slide 2 is over this app's 10 MB cap/);
});

/* ------------------------------------------------------------------- items */

test("a finished carousel becomes ONE draft holding all six slides in order", () => {
  const v = venture("v-car1");
  carousel("r-car1", v, { caption: "Six ways to stop paying for tokens." });
  const made = createItem({ source: { kind: "carousel", id: "r-car1" } });
  assert.ok(made.ok, made.ok ? "" : made.error);
  const item = made.item;
  assert.equal(item.status, "draft");
  assert.equal(item.media_kind, "carousel");
  /* The rule that keeps every single-image path from posting slide one. */
  assert.equal(item.media_path, null);
  assert.equal(item.caption, "Six ways to stop paying for tokens.");
  const paths = mediaPaths(item.id);
  assert.equal(paths.length, 6);
  paths.forEach((p, i) => assert.ok(p.endsWith(`r-car1/slide-${i + 1}.png`), p));

  const shaped = shapeItem(item);
  assert.equal(shaped.media.kind, "carousel");
  assert.equal(shaped.media.count, 6);
  assert.deepEqual(shaped.media.images.map((i) => i.n), [1, 2, 3, 4, 5, 6]);
  assert.ok(shaped.media.images.every((i) => i.onDisk && i.mime === "image/png"));

  /* Asking twice is the same request. */
  const again = createItem({ source: { kind: "carousel", id: "r-car1" } });
  assert.ok(again.ok && !again.created && again.item.id === item.id);
  assert.equal(mediaPaths(item.id).length, 6);
});

test("a carousel with a slide missing is refused, not queued as five", () => {
  const v = venture("v-car2");
  carousel("r-car2", v, { slides: 5 });
  const made = createItem({ source: { kind: "carousel", id: "r-car2" } });
  assert.equal(made.ok, false);
  assert.match(made.ok ? "" : made.error, /Slide 6 of that carousel is not on disk/);
  assert.equal(createItem({ source: { kind: "carousel", id: "r-nothing" } }).ok, false);
});

test("an existing single-image item is unchanged: one path, no carousel rows", () => {
  const v = venture("v-car3");
  const png = resolve(DATA_DIR, "studio", "car3.png");
  mkdirSync(resolve(DATA_DIR, "studio"), { recursive: true });
  writeFileSync(png, PNG(0));
  db.prepare(
    `INSERT INTO studio_posts (id, venture_id, ts, brief, platform, format, caption, hashtags, image_prompt, image_path, model, ms, error)
     VALUES ('p-car3',?,?,'b','Facebook','square','One picture.',NULL,'p',?,'m',1,NULL)`,
  ).run(v, now(), png);
  const made = createItem({ source: { kind: "studio_post", id: "p-car3" } });
  assert.ok(made.ok);
  assert.equal(made.item.media_kind, "image");
  assert.equal(made.item.media_path, png);
  assert.deepEqual(mediaPaths(made.item.id), []);
  const shaped = shapeItem(made.item);
  assert.equal(shaped.media.url, `/api/publishing/items/${made.item.id}/media`);
  assert.equal(shaped.media.count, 1);
});

test("TikTok and a PNG Instagram carousel cannot be approved; Facebook and LinkedIn can", () => {
  const v = venture("v-car4");
  carousel("r-car4", v, { caption: "c" });
  const expect = (dest: string, ok: boolean, why?: RegExp) => {
    const made = createItem({ source: { kind: "carousel", id: "r-car4" }, destinationId: dest });
    assert.ok(made.ok, made.ok ? "" : made.error);
    const res = approve(made.item.id, "test");
    assert.equal(res.ok, ok, res.ok ? "" : res.error);
    if (!res.ok && why) assert.match(res.error, why);
    if (!ok) assert.ok(shapeItem(itemRow(made.item.id)!).problems.length > 0);
  };
  expect(destination("d-car4-tt", v, "tiktok", "tiktok"), false, /TikTok account does not take a carousel/);
  expect(destination("d-car4-ig", v, "meta", "ig"), false, /accepts image\/jpeg/);
  expect(destination("d-car4-fb", v, "meta", "page"), true);
  expect(destination("d-car4-li", v, "linkedin", "linkedin"), true);
});

/* ------------------------------------------------------- the publishers */

test("Facebook: six unpublished photos, then ONE feed post attaching all six in order", async () => {
  const t = capturing();
  const media = Array.from({ length: 6 }, (_, i) => ({ bytes: new Uint8Array(PNG(i)), mime: "image/png", name: `slide-${i + 1}.png` }));
  const out = await postPageCarousel({ id: "PAGE1", token: "TOKEN" }, "Caption", media, t);
  assert.equal(out.ok, true);
  const photos = t.bodies.filter((b) => b.url.endsWith("/PAGE1/photos"));
  assert.equal(photos.length, 6);
  for (const p of photos) assert.equal((p.body as FormData).get("published"), "false");
  const feed = t.bodies.filter((b) => b.url.endsWith("/PAGE1/feed"));
  assert.equal(feed.length, 1);
  const form = new URLSearchParams(String(feed[0]!.body));
  assert.equal(form.get("message"), "Caption");
  for (let i = 0; i < 6; i++) assert.equal(form.get(`attached_media[${i}]`), JSON.stringify({ media_fbid: "DRY-MEDIA" }));
  assert.equal(form.get("attached_media[6]"), null);
  /* The token never reaches the record. */
  assert.ok(t.calls.every((c) => !JSON.stringify(c).includes("TOKEN\"") && !c.url.includes("=TOKEN")));
});

test("Instagram: a child container per slide, a CAROUSEL parent naming them, then publish", async () => {
  const t = capturing();
  const urls = Array.from({ length: 6 }, (_, i) => `https://pub.invalid/api/publishing/items/pi-x/media/${i + 1}`);
  const out = await postInstagramCarousel({ id: "IG1", token: "TOKEN" }, "Caption", urls, t);
  assert.equal(out.ok, true);
  const media = t.bodies.filter((b) => b.url.endsWith("/IG1/media")).map((b) => new URLSearchParams(String(b.body)));
  assert.equal(media.length, 7);
  media.slice(0, 6).forEach((f, i) => {
    assert.equal(f.get("is_carousel_item"), "true");
    assert.equal(f.get("image_url"), urls[i]);
    assert.equal(f.get("caption"), null);
  });
  const parent = media[6]!;
  assert.equal(parent.get("media_type"), "CAROUSEL");
  assert.equal(parent.get("children")!.split(",").length, 6);
  assert.equal(parent.get("caption"), "Caption");
  assert.equal(t.bodies.filter((b) => b.url.endsWith("/IG1/media_publish")).length, 1);
});

test("LinkedIn: six images uploaded, then ONE post with content.multiImage in order", async () => {
  const t = capturing();
  const media = Array.from({ length: 6 }, (_, i) => ({ bytes: new Uint8Array(PNG(i)), mime: "image/png" }));
  const out = await postImages({ token: "TOKEN", author: "urn:li:organization:1" }, "Caption", media, t);
  assert.equal(out.ok, true);
  assert.equal(t.bodies.filter((b) => b.url.includes("/rest/images?action=initializeUpload")).length, 6);
  const posts = t.bodies.filter((b) => b.url.endsWith("/rest/posts"));
  assert.equal(posts.length, 1);
  const body = JSON.parse(String(posts[0]!.body)) as { content: { multiImage: { images: { id: string }[] }; media?: unknown } };
  assert.equal(body.content.multiImage.images.length, 6);
  assert.equal(body.content.media, undefined);
});

test("the pipeline rehearses an approved carousel to a Page as one multi-photo post", async () => {
  upsertPlugin("meta", true, null);
  const account = accounts.create("meta", "Test account");
  accounts.writeCredentials(account, "meta-token", ["token"], { token: "TEST-TOKEN" });
  assert.equal(account.id, 1);

  const v = venture("v-car5");
  carousel("r-car5", v, { caption: "Six slides." });
  const made = createItem({ source: { kind: "carousel", id: "r-car5" }, destinationId: destination("d-car5", v, "meta", "page") });
  assert.ok(made.ok);
  assert.ok(approve(made.item.id, "test").ok);

  const t = dryTransport();
  const res = await publishItem(made.item.id, { dry: true, transport: t });
  assert.equal(res.ok, true, res.error ?? "");
  assert.equal(t.calls.filter((c) => /\/photos$/.test(c.url)).length, 6);
  const feed = t.calls.filter((c) => /\/feed$/.test(c.url));
  assert.equal(feed.length, 1);
  assert.match(feed[0]!.body!, /attached_media\[5\]/);
  /* A rehearsal leaves the item as it was. */
  assert.equal(itemRow(made.item.id)!.status, "approved");
  assert.equal(itemRow(made.item.id)!.external_id, null);
});

test("a slide deleted after approval stops the publish before anything is sent", async () => {
  const v = venture("v-car6");
  carousel("r-car6", v, { caption: "c" });
  const made = createItem({ source: { kind: "carousel", id: "r-car6" }, destinationId: destination("d-car6", v, "linkedin", "linkedin") });
  assert.ok(made.ok && approve(made.item.id, "test").ok);
  rmSync(resolve(DATA_DIR, "video", "r-car6", "slide-4.png"));
  const t = dryTransport();
  const res = await publishItem(made.item.id, { dry: true, transport: t });
  assert.equal(res.ok, false);
  assert.match(res.error!, /Slide 4 of this carousel is no longer on disk/);
  assert.equal(t.calls.length, 0);
});

/* ------------------------------------------------- deletion and caption */

test("a pending carousel item holds back deleting the carousel run, like an image post", () => {
  const v = venture("v-car7");
  carousel("r-car7", v, { caption: "c" });
  assert.equal(sourceDeletionProblem("video_job", "r-car7"), null);
  const made = createItem({ source: { kind: "carousel", id: "r-car7" } });
  assert.ok(made.ok);
  assert.match(sourceDeletionProblem("video_job", "r-car7") ?? "", /used in Publishing/);
  assert.ok(cancel(made.item.id).ok);
  assert.equal(sourceDeletionProblem("video_job", "r-car7"), null);
});

test("a carousel with no caption gets one from its plan when no model answers", async () => {
  assert.equal(
    captionFromPlan("t", [{ headline: "Hook" }, { headline: "A" }, { headline: "B" }, { headline: "Ask?" }]),
    "Hook\n\n- A\n- B\n\nAsk?",
  );
  const v = venture("v-car8");
  carousel("r-car8", v, { caption: null });
  const got = await ensureCarouselCaption("r-car8");
  assert.equal(got.source, "plan");
  assert.match(got.caption ?? "", /^Stop paying for tokens\n\n- Point 1/);
  /* Saved back, so the Studio and the queue say the same words. */
  const row = db.prepare("SELECT caption FROM studio_carousels WHERE run_id = 'r-car8'").get() as { caption: string };
  assert.equal(row.caption, got.caption);
});

test("the queue route files a carousel as a draft and serves each slide by position", async () => {
  const v = venture("v-car9");
  carousel("r-car9", v, { caption: null });
  const res = await publishingRoutes.request("/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: { kind: "carousel", id: "r-car9" } }),
  });
  assert.equal(res.status, 201);
  const doc = (await res.json()) as { item: { id: string; status: string; caption: string; media: { kind: string; count: number } } };
  assert.equal(doc.item.status, "draft");
  assert.equal(doc.item.media.kind, "carousel");
  assert.equal(doc.item.media.count, 6);
  assert.ok(doc.item.caption.length > 0);

  const third = await publishingRoutes.request(`/items/${doc.item.id}/media/3`);
  assert.equal(third.status, 200);
  assert.deepEqual(Buffer.from(await third.arrayBuffer()), PNG(3));
  assert.equal((await publishingRoutes.request(`/items/${doc.item.id}/media/7`)).status, 404);
  /* The single-file route has nothing for a carousel, by design. */
  assert.equal((await publishingRoutes.request(`/items/${doc.item.id}/media`)).status, 404);
});
