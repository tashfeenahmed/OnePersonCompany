/**
 * One Replicate prediction, without Replicate.
 *
 * `fetch` is stubbed, which is the only way to test the thing the two copies
 * actually disagreed about: what happens to a prediction that is still queued
 * when the synchronous door closes. One copy gave up and told the owner to
 * press the button again — on work that had already been paid for. The other
 * polled. This checks that the polling one is what the shared helper does by
 * default, and that the giving-up one still says the money is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { download, firstUrl, predict } from "./replicate-run.ts";

type Reply = { status?: number; body: unknown };

/** Answer the POST with the first reply and each poll with the next. */
function stubFetch(replies: Reply[]): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const GET = "https://api.replicate.com/v1/predictions/p1";

/* ------------------------------------------------------------- validation */

test("a model that is not owner/name is refused before anything is spent", async () => {
  const got = await predict({ token: "r8_x", model: "flux", input: {} });
  assert.equal(got.ok, false);
  assert.equal(got.ok === false && got.spent, false, "nothing was created, so nothing was charged");
  assert.match(got.ok === false ? got.error : "", /owner\/name/);
});

test("a rejected POST created no prediction, so it did not cost anything", async () => {
  const stub = stubFetch([{ status: 422, body: { detail: "input.prompt is required" } }]);
  try {
    const got = await predict({ token: "r8_x", model: "black-forest-labs/flux-schnell", input: {} });
    assert.equal(got.ok, false);
    assert.equal(got.ok === false && got.spent, false);
    assert.match(got.ok === false ? got.error : "", /HTTP 422 — input\.prompt is required/);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------- the polling */

test("a still-queued prediction is polled through to succeeded — the money is already spent", async () => {
  const stub = stubFetch([
    { body: { id: "p1", status: "starting", urls: { get: GET } } },
    { body: { id: "p1", status: "processing", urls: { get: GET } } },
    { body: { id: "p1", status: "succeeded", output: ["https://example.test/a.png"] } },
  ]);
  try {
    const got = await predict({
      token: "r8_x",
      model: "owner/name",
      input: { prompt: "a cat" },
      poll: { everyMs: 1 },
    });
    assert.equal(got.ok, true);
    assert.equal(got.ok && firstUrl(got.output), "https://example.test/a.png");
    assert.equal(stub.calls.length, 3, "one POST and two polls");
    assert.equal(stub.calls[1], GET, "the prediction's own urls.get, not a URL composed here");
  } finally {
    stub.restore();
  }
});

test("poll: false is the old behaviour, and it still says the prediction was paid for", async () => {
  const stub = stubFetch([{ body: { id: "p1", status: "starting", urls: { get: GET } } }]);
  try {
    const got = await predict({ token: "r8_x", model: "owner/name", input: {}, poll: false });
    assert.equal(got.ok, false);
    assert.equal(got.ok === false && got.spent, true);
    assert.equal(got.ok === false && got.status, "starting");
    assert.match(got.ok === false ? got.error : "", /paid for/);
    assert.equal(stub.calls.length, 1, "asked once and gave up");
  } finally {
    stub.restore();
  }
});

test("a failed poll is counted, not fatal, until the budget runs out", async () => {
  const stub = stubFetch([
    { body: { id: "p1", status: "starting", urls: { get: GET } } },
    { status: 502, body: { detail: "bad gateway" } },
    { body: { id: "p1", status: "succeeded", output: "https://example.test/b.mp4" } },
  ]);
  try {
    const got = await predict({
      token: "r8_x",
      model: "owner/name",
      input: {},
      poll: { everyMs: 1, failuresAllowed: 3 },
    });
    assert.equal(got.ok, true, "one 502 must not throw away a prediction that has been paid for");
  } finally {
    stub.restore();
  }
});

test("enough consecutive failures ends it, pointing at Replicate's own dashboard", async () => {
  const stub = stubFetch([
    { body: { id: "p1", status: "starting", urls: { get: GET } } },
    { status: 502, body: {} },
  ]);
  try {
    const got = await predict({
      token: "r8_x",
      model: "owner/name",
      input: {},
      poll: { everyMs: 1, failuresAllowed: 2 },
    });
    assert.equal(got.ok, false);
    assert.equal(got.ok === false && got.spent, true);
    assert.match(got.ok === false ? got.error : "", /may still have finished/);
  } finally {
    stub.restore();
  }
});

test("a prediction that failed is its own sentence, carrying the model's complaint", async () => {
  const stub = stubFetch([
    { body: { id: "p1", status: "failed", error: "NSFW content detected" } },
  ]);
  try {
    const got = await predict({ token: "r8_x", model: "owner/name", input: {} });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.error : "", /NSFW content detected/);
  } finally {
    stub.restore();
  }
});

/* -------------------------------------------------------------- firstUrl */

test("firstUrl walks a string, a list, and an object — the case one copy missed", () => {
  assert.equal(firstUrl("https://example.test/a.png"), "https://example.test/a.png");
  assert.equal(firstUrl(["https://example.test/a.png", "b"]), "https://example.test/a.png");
  /* An image-to-video model answers with an object. The copy that did not look
     inside one reported "the prediction succeeded and produced no video URL"
     for a prediction that had produced exactly that. */
  assert.equal(firstUrl({ video: "https://example.test/c.mp4" }), "https://example.test/c.mp4");
  assert.equal(firstUrl({ other: { nested: ["https://example.test/d.png"] } }), "https://example.test/d.png");
});

test("firstUrl refuses anything that is not an http URL", () => {
  assert.equal(firstUrl("data:image/png;base64,AAAA"), null);
  assert.equal(firstUrl({ caption: "a photograph of a cat" }), null);
  assert.equal(firstUrl(null), null);
  assert.equal(firstUrl([]), null);
});

/* -------------------------------------------------------------- download */

test("a finished artefact over the cap is refused with what it actually was", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(4096))) as typeof fetch;
  try {
    const got = await download({ url: "https://example.test/a.png", cap: 1024, what: "image" });
    assert.equal(got.ok, false);
    assert.match(got.error ?? "", /4 KB/);
    const fits = await download({ url: "https://example.test/a.png", cap: 8192, what: "image" });
    assert.equal(fits.ok, true);
    assert.equal(fits.ok && fits.bytes.length, 4096);
  } finally {
    globalThis.fetch = real;
  }
});
