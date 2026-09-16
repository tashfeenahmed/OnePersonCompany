import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { db } from "../db.ts";
import { runRoutes } from "../integrations/runs/routes.ts";
import { deleteRun, insertRun } from "../integrations/runs/store.ts";
import { STUDIO_DIR, studioRoutes } from "../integrations/ventures/studio.ts";
import { thumbnailSource } from "../integrations/video/thumbnails.ts";

const ts = new Date().toISOString();
db.prepare(`INSERT INTO ventures(id, slug, name, stage, color, color_source, position, brand, created_at, updated_at)
  VALUES('v-delete', 'deletion-test', 'Deletion test', 'idea', '#777777', 'default', 0, '{}', ?, ?)`).run(ts, ts);

function fixture(id: string, status = "done") {
  insertRun({ id, kind: "video", ventureId: null, title: "Test generation", input: {} });
  db.prepare("UPDATE agent_runs SET status = ? WHERE id = ?").run(status, id);
  const dir = join(DATA_DIR, "video", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "video.mp4");
  writeFileSync(path, "generated video");
  db.prepare("INSERT INTO video_jobs(run_id,format,ts,path) VALUES(?,?,?,?)").run(id, "shorts", ts, path);
  return { dir, path };
}

function publication(id: string, kind: string, source: string, status: string) {
  db.prepare(`INSERT INTO publish_items(id, venture_id, source_kind, source_id, status, idempotency_key, created_at, updated_at)
    VALUES(?, 'v-delete', ?, ?, ?, ?, ?, ?)`).run(id, kind, source, status, id, ts, ts);
}

function post(id: string, path: string | null) {
  db.prepare("INSERT INTO studio_posts(id, venture_id, ts, brief, format, image_path) VALUES(?, 'v-delete', ?, 'Test image', 'square', ?)")
    .run(id, ts, path);
}

test("deleting a generation removes its outputs, intermediates, previews and related records only", async () => {
  const id = "r-delete-files";
  const { dir, path } = fixture(id);
  const neighbor = fixture("r-keep-files");
  const clip = join(dir, "clip-1.mp4");
  writeFileSync(clip, "clip");
  writeFileSync(join(dir, "narration.wav"), "intermediate audio");
  db.prepare("INSERT INTO video_clips(run_id,idx,title,chosen_by,start_s,end_s,path) VALUES(?,1,'Clip','spacing',0,1,?)").run(id, clip);
  db.prepare("INSERT INTO videoplus_clip_framing(run_id,idx,mode,detector) VALUES(?,1,'cover','none')").run(id);
  db.prepare("INSERT INTO ugc_jobs(run_id,ts,image_path) VALUES(?,?,?)").run(id, ts, join(dir, "ugc.png"));
  const previews = [path, clip].map((source) => join(DATA_DIR, "video", "thumbnails", `${thumbnailSource([source])!.key}.jpg`));
  mkdirSync(join(DATA_DIR, "video", "thumbnails"), { recursive: true });
  previews.push(join(DATA_DIR, "video", "thumbnails", `${id}.old-version.jpg`));
  for (const preview of previews) writeFileSync(preview, "preview");
  publication("pub-keep", "video_job", id, "published");
  const response = await runRoutes.request(`/${id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal(existsSync(dir), false);
  for (const preview of previews) assert.equal(existsSync(preview), false);
  for (const table of ["video_jobs", "video_clips", "videoplus_clip_framing", "ugc_jobs"])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(id)!.n, 0);
  assert.equal(db.prepare("SELECT id FROM agent_runs WHERE id = ?").get(id), undefined);
  assert.equal(readFileSync(neighbor.path, "utf8"), "generated video");
  assert.ok(db.prepare("SELECT id FROM publish_items WHERE id = 'pub-keep'").get());
  assert.equal((await runRoutes.request(`/${id}`, { method: "DELETE" })).status, 404);
});

test("queued/running generations and pending publishing media cannot be deleted", async () => {
  for (const status of ["queued", "running"]) {
    const id = `r-delete-${status}`;
    const { path } = fixture(id, status);
    assert.equal((await runRoutes.request(`/${id}`, { method: "DELETE" })).status, 409);
    assert.ok(existsSync(path));
    assert.ok(db.prepare("SELECT id FROM agent_runs WHERE id = ?").get(id));
  }
  const id = "r-delete-pending";
  const { path } = fixture(id);
  publication("pub-pending", "video_job", id, "scheduled");
  const response = await runRoutes.request(`/${id}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /Publishing/);
  assert.ok(existsSync(path));
  db.prepare("UPDATE publish_items SET status='cancelled' WHERE id='pub-pending'").run();
  assert.equal((await runRoutes.request(`/${id}`, { method: "DELETE" })).status, 200);
});

test("file removal failures retain the generation for retry; missing media can be deleted", async () => {
  const id = "r-delete-retry";
  const { path, dir } = fixture(id);
  const preview = join(DATA_DIR, "video", "thumbnails", `${thumbnailSource([path])!.key}.jpg`);
  mkdirSync(preview, { recursive: true }); // A directory cannot be removed as a thumbnail file.
  const response = await runRoutes.request(`/${id}`, { method: "DELETE" });
  assert.equal(response.status, 500);
  assert.ok(db.prepare("SELECT run_id FROM video_jobs WHERE run_id = ?").get(id));
  assert.ok(db.prepare("SELECT id FROM agent_runs WHERE id = ?").get(id));
  assert.ok(existsSync(path));
  rmSync(preview, { recursive: true });
  rmSync(dir, { recursive: true });
  assert.equal((await runRoutes.request(`/${id}`, { method: "DELETE" })).status, 200);
  assert.throws(() => deleteRun("../studio"), /Invalid run id/);
});

test("image deletion removes only the owned file and preserves records on errors", async () => {
  mkdirSync(STUDIO_DIR, { recursive: true });
  const path = join(STUDIO_DIR, "p-delete-image.png");
  writeFileSync(path, "image");
  post("p-delete-image", path);
  publication("pub-image", "studio_post", "p-delete-image", "draft");
  assert.equal((await studioRoutes.request('/posts/p-delete-image', { method: "DELETE" })).status, 409);
  assert.ok(existsSync(path));
  db.prepare("UPDATE publish_items SET status='cancelled' WHERE id='pub-image'").run();
  assert.equal((await studioRoutes.request('/posts/p-delete-image', { method: "DELETE" })).status, 200);
  assert.equal(existsSync(path), false);
  assert.equal(db.prepare("SELECT id FROM studio_posts WHERE id='p-delete-image'").get(), undefined);
  post("p-delete-missing", join(STUDIO_DIR, "p-delete-missing.png"));
  assert.equal((await studioRoutes.request('/posts/p-delete-missing', { method: "DELETE" })).status, 200);
  post("p-delete-caption", null);
  assert.equal((await studioRoutes.request('/posts/p-delete-caption', { method: "DELETE" })).status, 200);
  const outside = join(DATA_DIR, "keep.png");
  writeFileSync(outside, "keep");
  post("p-delete-outside", outside);
  assert.equal((await studioRoutes.request('/posts/p-delete-outside', { method: "DELETE" })).status, 500);
  assert.equal(readFileSync(outside, "utf8"), "keep");
  const blocked = join(STUDIO_DIR, "p-delete-blocked.png");
  mkdirSync(blocked);
  post("p-delete-blocked", blocked);
  assert.equal((await studioRoutes.request('/posts/p-delete-blocked', { method: "DELETE" })).status, 500);
  assert.ok(db.prepare("SELECT id FROM studio_posts WHERE id='p-delete-blocked'").get());
});

test("an in-flight image regeneration blocks deletion until it finishes", async () => {
  post("p-delete-regenerating", null);
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const request = new Request("http://localhost/posts/p-delete-regenerating/regenerate", {
    method: "POST", body: stream, duplex: "half",
  } as RequestInit);
  const regeneration = studioRoutes.fetch(request);
  await setImmediate();
  assert.equal((await studioRoutes.request('/posts/p-delete-regenerating', { method: "DELETE" })).status, 409);
  // Complete the request with invalid input: no model or image service runs.
  body.enqueue(new TextEncoder().encode('{"what":"invalid"}'));
  body.close();
  assert.equal((await regeneration).status, 400);
  assert.equal((await studioRoutes.request('/posts/p-delete-regenerating', { method: "DELETE" })).status, 200);
});
