import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { DATA_DIR } from "../../config.ts";
import { db, now, setConfig, upsertPlugin, ventureRowById } from "../../db.ts";
import { captureError } from "./capture-validation.ts";
import { captureDue, captureRoutes, captureVenture, lastShot } from "./capture.ts";

// Enough pixel data to distinguish a rendered page from a blank rectangle.
function png(blank = false): Buffer {
  const width = 640, height = 400;
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    pixels.fill(blank ? 255 : (x + y) % 2 ? 0 : 255, i, i + 3);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const goodHtml = '<html><head><title>Our company</title></head><body><h1>Welcome</h1></body></html>';
const offlineHtml = '<html><body class="neterror"><div id="main-frame-error">ERR_INTERNET_DISCONNECTED</div></body></html>';

test("offline, security and host error screens cannot become website previews", () => {
  assert.match(captureError(offlineHtml, png())!, /ERR_INTERNET_DISCONNECTED/);
  assert.match(captureError('<html><body id="interstitial-wrapper">Unsafe</body></html>', png())!, /security/);
  for (const title of ["502 Bad Gateway", "404: Not Found", "Just a moment...", "Privacy error"])
    assert.match(captureError(`<html><title>${title}</title></html>`, png())!, /error or verification/);
  assert.equal(captureError(goodHtml.replace("Welcome", "We help fix ERR_INTERNET_DISCONNECTED and 404 errors"), png()), null);
});

test("blank, corrupt and unfinished captures are rejected", () => {
  assert.match(captureError(goodHtml, png(true))!, /blank image/);
  assert.match(captureError(goodHtml, Buffer.from("not an image"))!, /readable image/);
  assert.match(captureError("<html><body>Loading", png())!, /finish loading/);
  assert.equal(captureError(goodHtml, png()), null);
});

test("capture preserves a good image after failure, retries it, and versions refreshed URLs", async () => {
  const id = "v-capture-test";
  const ts = now();
  db.prepare(`INSERT INTO ventures (id, slug, name, website, stage, color, color_source, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'launched', '#123456', 'default', 0, ?, ?)`)
    .run(id, "capture-test", "Capture test", "https://example.com", ts, ts);
  const venture = ventureRowById(id)!;
  mkdirSync(DATA_DIR, { recursive: true });
  const fixture = resolve(DATA_DIR, "fixture.png");
  const htmlFile = resolve(DATA_DIR, "fixture.html");
  const bin = resolve(DATA_DIR, "fake-chrome.mjs");
  writeFileSync(fixture, png());
  writeFileSync(htmlFile, goodHtml);
  writeFileSync(bin, `#!${process.execPath}\nimport {copyFileSync,readFileSync} from 'node:fs';\nconst out=process.argv.find(a=>a.startsWith('--screenshot=')).slice(13);\ncopyFileSync(${JSON.stringify(fixture)},out);\n// The image settles before the DOM arrives: the launcher must wait for both.\nsetTimeout(()=>{process.stdout.write(readFileSync(${JSON.stringify(htmlFile)}));},1200);\nsetInterval(()=>{},1000);\n`);
  chmodSync(bin, 0o755);
  upsertPlugin("capture", true, null);
  setConfig("capture", "chromium", bin);
  assert.equal(captureDue(venture), true);
  const run = captureVenture(venture);
  assert.equal(captureVenture(venture), run, "manual and scheduled work share the same run");
  const first = await run;
  assert.equal(first.ok, true, first.error ?? "");
  assert.equal(captureDue(venture), false);
  const firstReport = await (await captureRoutes.request("/")).json() as {ventures: {id:string; picture:{url:string}}[]};
  const firstUrl = firstReport.ventures.find((v: {id:string})=>v.id===id)!.picture.url;
  assert.ok(firstUrl.includes(encodeURIComponent(first.ts)));

  writeFileSync(htmlFile, offlineHtml);
  const failed = await captureVenture(venture);
  assert.equal(failed.ok, false);
  assert.match(lastShot(id)?.error ?? "", /ERR_INTERNET_DISCONNECTED/);
  assert.equal(lastShot(id, true)?.path, first.path);
  assert.deepEqual(readFileSync(first.path!), png());
  assert.equal(captureDue(venture), true, "retry failure even with a fresh older picture");
  const failedPath = resolve(DATA_DIR, "shots", `${id}-${failed.ts.replace(/[:.]/g, "")}.png`);
  assert.equal(existsSync(failedPath), false, "discard the offline screenshot");

  writeFileSync(htmlFile, goodHtml);
  const refreshed = await captureVenture(venture);
  assert.equal(refreshed.ok, true);
  assert.equal(captureDue(venture), false);
  const report = await (await captureRoutes.request("/")).json() as {ventures: {id:string; picture:{url:string}}[]; schedule:unknown};
  const newUrl = report.ventures.find((v: {id:string})=>v.id===id)!.picture.url;
  assert.notEqual(newUrl, firstUrl, "browser cache must not keep the old image");
  unlinkSync(refreshed.path!);
  assert.equal(captureDue(venture), true, "a missing recent image is due now");
  assert.equal(captureDue({...venture, website:null}), false);
  assert.deepEqual(report.schedule, {checkEveryMinutes:60,refreshEveryDays:7,retryFailed:true,running:false});
  setConfig("capture", "chromium", "");
});
