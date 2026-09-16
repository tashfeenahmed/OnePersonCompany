import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadWithRefresh, isYoutubeUrl, youtubeRuntimeArgs, ytdlpFailure } from "./ytdlp.ts";
import type { Ran, run } from "./tools.ts";

const success: Ran = { ok: true, code: 0, stdout: "", stderr: "", error: null };
const forbidden: Ran = { ...success, ok: false, code: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" };
const args = ["--no-playlist", "-o", "/tmp/source.%(ext)s", "https://www.youtube.com/watch?v=example"];

test("YouTube runtime options apply only to YouTube hosts and preserve executable paths", () => {
  for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]) {
    assert.equal(isYoutubeUrl(`https://${host}/watch?v=test`), true);
  }
  for (const url of ["https://youtube.com.example.org/test", "https://example.com/youtube.com", "invalid"]) {
    assert.equal(isYoutubeUrl(url), false);
    assert.deepEqual(youtubeRuntimeArgs(url), []);
  }
  assert.deepEqual(youtubeRuntimeArgs(args.at(-1)!, "/a path/node"), ["--js-runtimes", "node:/a path/node", "--remote-components", "ejs:github"]);
});

test("download failures surface the actual error without unrelated Python warnings", () => {
  const noisy = { ...forbidden, stderr: "/usr/lib/python3/requests/__init__.py:109: RequestsDependencyWarning: mismatch\n  warnings.warn(\n" + forbidden.stderr };
  assert.equal(ytdlpFailure(noisy, "fallback"), forbidden.stderr);
  assert.equal(ytdlpFailure({ ...noisy, error: "Timed out" }, "fallback"), "Timed out");
  assert.equal(ytdlpFailure(success, "No file was written"), "No file was written");
});

test("a YouTube 403 gets exactly one fresh extraction with partial downloads restarted", async () => {
  const calls: Parameters<typeof run>[] = [];
  let refreshes = 0;
  const controller = new AbortController();
  const result = await downloadWithRefresh("yt-dlp", args, {
    timeoutMs: 60_000, signal: controller.signal, onRefresh: () => { refreshes++; },
  }, async (...call) => { calls.push(call); return calls.length === 1 ? forbidden : success; });
  assert.deepEqual(result, { result: success, refreshed: true });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]![1], args);
  assert.deepEqual(calls[1]![1], [...args.slice(0, -1), "--force-overwrites", "--no-continue", args.at(-1)!]);
  assert.ok(calls[1]![2]!.timeoutMs! > 0 && calls[1]![2]!.timeoutMs! <= 60_000);
  assert.equal(calls[1]![2]!.signal, controller.signal);
});

test("a repeated 403 stops after the one retry", async () => {
  let calls = 0;
  const result = await downloadWithRefresh("yt-dlp", args, { timeoutMs: 60_000 }, async () => { calls++; return forbidden; });
  assert.deepEqual(result, { result: forbidden, refreshed: true });
  assert.equal(calls, 2);
});

test("success, unrelated failures, cancellation and expired budgets are not retried", async () => {
  const canceled = new AbortController();
  canceled.abort();
  for (const scenario of [
    { first: success },
    { first: { ...forbidden, stderr: "ERROR: HTTP Error 404: Not found" } },
    { first: { ...forbidden, stderr: "ERROR: Sign in to confirm your age" } },
    { first: { ...forbidden, error: "Timed out" } },
    { first: forbidden, url: "https://example.org/video.mp4" },
    { first: forbidden, signal: canceled.signal },
    { first: forbidden, timeoutMs: 0 },
  ]) {
    let calls = 0;
    const result = await downloadWithRefresh("yt-dlp", [...args.slice(0, -1), scenario.url ?? args.at(-1)!], {
      timeoutMs: scenario.timeoutMs ?? 60_000, signal: scenario.signal,
      onRefresh: () => assert.fail("Unexpected retry"),
    }, async () => { calls++; return scenario.first; });
    assert.equal(result.refreshed, false);
    assert.equal(calls, 1);
  }
});
