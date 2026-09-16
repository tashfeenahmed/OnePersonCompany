import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { db } from "../../db.ts";
import { clipPathsByRun } from "./store.ts";
import { videoRoutes } from "./routes.ts";
import { thumbnailSource, thumbnailUrl, videoThumbnail } from "./thumbnails.ts";
import { findFfmpeg, run } from "./tools.ts";

test("missing and empty outputs have no thumbnail; surviving clips can supply one", () => {
  const missing = join(DATA_DIR, "missing.mp4");
  const empty = join(DATA_DIR, "empty.mp4");
  const clip = join(DATA_DIR, "source.mp4");
  writeFileSync(empty, "");
  writeFileSync(clip, "test source");
  assert.equal(thumbnailSource([null, missing, empty, DATA_DIR]), null);
  const source = thumbnailSource([missing, clip]);
  assert.equal(source?.path, clip);
  assert.equal(thumbnailUrl("r-test", null), null);
  assert.match(thumbnailUrl("r-test", source)!, /^\/api\/video\/r-test\/thumbnail\?v=[a-f0-9]{64}$/);
  const oldTime = statSync(clip).mtime;
  utimesSync(clip, oldTime, new Date(oldTime.getTime() + 5000));
  assert.notEqual(thumbnailSource([clip])?.key, source?.key, "replaced media invalidates the cached URL");
});

test("thumbnails render short videos and still images, deduplicate requests and reuse cached JPEGs", async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg.path) return t.skip("FFmpeg is not installed.");
  for (const extension of ["mp4", "png"]) {
    const path = join(DATA_DIR, `preview-test.${extension}`);
    const made = await run(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "color=c=blue:s=64x128:d=0.4", ...(extension === "mp4" ? ["-c:v", "mpeg4"] : ["-frames:v", "1"]), path]);
    assert.ok(made.ok, made.stderr);
    const source = thumbnailSource([path])!;
    const first = videoThumbnail(source, "r-preview-test");
    const second = videoThumbnail(source, "r-preview-test");
    assert.equal(first, second, "concurrent requests share one render");
    const bytes = await first;
    assert.deepEqual(bytes?.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    assert.ok(bytes!.length < 20_000);
    const cachedFile = join(DATA_DIR, "video", "thumbnails", `r-preview-test.${source.key}.jpg`);
    const before = statSync(cachedFile).mtimeMs;
    assert.deepEqual(await videoThumbnail(source, "r-preview-test"), bytes);
    assert.equal(statSync(cachedFile).mtimeMs, before, "cache hits don't re-encode");
    assert.ok(readdirSync(join(DATA_DIR, "video", "thumbnails")).every((f) => /^r-preview-test\.[a-f0-9]{64}\.jpg$/.test(f)));
  }
});

test("thumbnail routes use stored outputs and return no image for missing or unreadable files", async (t) => {
  assert.equal((await videoRoutes.request('/unknown/thumbnail?path=/etc/passwd')).status, 404);
  const ffmpeg = findFfmpeg();
  if (!ffmpeg.path) return t.skip("FFmpeg is not installed.");
  const path = join(DATA_DIR, "route-test.mp4");
  const made = await run(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "color=c=red:s=64x128:d=0.4", "-c:v", "mpeg4", path]);
  assert.ok(made.ok, made.stderr);
  assert.ok(thumbnailSource([path]));
  db.prepare("INSERT INTO video_jobs(run_id,format,ts) VALUES(?,?,?)").run("r-preview", "shorts", new Date().toISOString());
  const addClip = db.prepare("INSERT INTO video_clips(run_id,idx,title,chosen_by,start_s,end_s,path) VALUES(?,?,?,?,?,?,?)");
  addClip.run("r-preview", 1, "Missing", "spacing", 0, 1, join(DATA_DIR, "absent.mp4"));
  addClip.run("r-preview", 2, "Available", "spacing", 1, 2, path);
  const paths = clipPathsByRun(["r-preview"]);
  assert.equal(thumbnailSource(paths.get("r-preview")!)?.path, path);
  const detail = await (await videoRoutes.request('/r-preview')).json() as { thumbnailUrl: string | null; onDisk: boolean };
  assert.equal(detail.onDisk, true, "Shorts remain available when an individual clip survives");
  assert.match(detail.thumbnailUrl!, /^\/api\/video\/r-preview\/thumbnail\?v=/);
  const response = await videoRoutes.request('/r-preview/thumbnail');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.match(response.headers.get('Cache-Control')!, /private/);
  rmSync(path);
  assert.equal((await videoRoutes.request('/r-preview/thumbnail')).status, 404, "a stale cached preview cannot mask deleted media");
  const gone = await (await videoRoutes.request('/r-preview')).json() as { onDisk: boolean; thumbnailUrl: string | null };
  assert.equal(gone.onDisk, false);
  assert.equal(gone.thumbnailUrl, null);
  writeFileSync(path, "not a video");
  assert.equal((await videoRoutes.request('/r-preview/thumbnail')).status, 404);
});
