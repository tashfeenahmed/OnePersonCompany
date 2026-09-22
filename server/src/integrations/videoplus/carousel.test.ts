import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { resolve } from "node:path";
import type { VisionTurn } from "../../models/provider.ts";
import { imageDimensions } from "../../tools/chrome.ts";
import {
  makeSlide,
  measureSlideHtml,
  parsePlan,
  parseVerdict,
  pickHtml,
  readGeometry,
  renderSlideHtml,
  type SlideDeps,
  type SlidePlan,
  type VerifyOutcome,
} from "./carousel.ts";
import { storedZip } from "./carousel-routes.ts";
import { findBrowser } from "./chrome.ts";
import { carouselSize } from "../../../../shared/carousel.ts";

const slides = (n: number) => Array.from({ length: n }, (_, i) => ({ headline: `Headline ${i + 1}`, body: `Body ${i + 1}`, visual: "a line" }));

test("a plan is six slides whose roles come from their position, not the model's labels", () => {
  const got = parsePlan(`Thinking about it first {not json}\n${JSON.stringify({ title: "Six things", caption: "Read on.", slides: slides(6).map((s) => ({ ...s, role: "cta" })) })}`);
  assert.ok("plan" in got);
  assert.equal(got.plan.slides.length, 6);
  assert.deepEqual(got.plan.slides.map((s) => s.role), ["hook", "body", "body", "body", "body", "cta"]);
  assert.deepEqual(got.plan.slides.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(got.plan.title, "Six things");
  assert.equal(got.plan.caption, "Read on.");
});

test("a seven-slide plan keeps its last slide, because that is where the ask is", () => {
  const got = parsePlan(JSON.stringify({ title: "t", slides: slides(7) }));
  assert.ok("plan" in got);
  assert.deepEqual(got.plan.slides.map((s) => s.headline), ["Headline 1", "Headline 2", "Headline 3", "Headline 4", "Headline 5", "Headline 7"]);
});

test("fewer than six usable slides, or no slides at all, is a reason and never a plan", () => {
  const five = parsePlan(JSON.stringify({ title: "t", slides: [...slides(5), { headline: "  ", body: "no headline" }] }));
  assert.ok("error" in five);
  assert.match(five.error, /planned 5 slides/);
  assert.ok("error" in parsePlan("I could not do that."));
  assert.ok("error" in parsePlan(JSON.stringify({ slides: "six" })));
});

test("the verdict must say pass or fail; a fail must point at something", () => {
  assert.deepEqual(parseVerdict('{"pass":true,"issues":[]}'), { pass: true, issues: [] });
  assert.deepEqual(
    parseVerdict('```json\n{"pass":false,"issues":["The headline is cut off at the right edge.",{"where":"footer","problem":"overlaps the logo"}]}\n```'),
    { pass: false, issues: ["The headline is cut off at the right edge.", "footer: overlaps the logo"] },
  );
  assert.deepEqual(parseVerdict('{"pass":"false","issues":["x is faint"]}'), { pass: false, issues: ["x is faint"] });
  assert.equal(parseVerdict('{"pass":false,"issues":[]}'), null);
  assert.equal(parseVerdict('{"pass":"mostly","issues":[]}'), null);
  assert.equal(parseVerdict("Looks fine to me."), null);
  assert.equal(parseVerdict(JSON.stringify({ pass: false, issues: Array.from({ length: 12 }, (_, i) => `issue ${i}`) }))!.issues.length, 6);
});

test("the document is cut out of a fenced reply and its scripts are removed", () => {
  const doc = pickHtml("Here it is:\n```html\n<!doctype html><html><body><h1>Hi</h1><script>fetch('x')</script></body></html>\n```\nHope that helps.");
  assert.equal(doc, "<!doctype html><html><body><h1>Hi</h1></body></html>");
  assert.equal(pickHtml("<html><body>ok</body></html> trailing words"), "<html><body>ok</body></html>");
  assert.equal(pickHtml("No markup here."), null);
});

test("the geometry the measuring script leaves in the DOM is read back, entities and all", () => {
  assert.deepEqual(readGeometry('<head><meta name="opc-geometry" content="[&quot;The text \\&quot;Hi\\&quot; runs outside&quot;]"></head>'), ['The text "Hi" runs outside']);
  assert.deepEqual(readGeometry('<meta name="opc-geometry" content="[]">'), []);
  assert.equal(readGeometry("<html></html>"), null);
});

test("a carousel size is one of the four names, portrait when it is anything else", () => {
  assert.equal(carouselSize("Square"), "square");
  assert.equal(carouselSize("landscape"), "landscape");
  assert.equal(carouselSize("4:5"), "portrait");
  assert.equal(carouselSize(undefined), "portrait");
});

/* ------------------------------------------------------------ the loop */

const slide: SlidePlan = { n: 2, role: "body", headline: "One idea", body: "Said plainly.", visual: "" };

function scripted(opts: { verdicts: VerifyOutcome[]; geometry?: string[][]; codeFails?: number[] }) {
  const seen: VisionTurn[][] = [];
  let coded = 0;
  let measured = 0;
  let verified = 0;
  const deps: SlideDeps = {
    async code(turns) {
      seen.push(turns);
      const i = coded++;
      if (opts.codeFails?.includes(i)) throw new Error("the model timed out");
      return { text: `<!doctype html><html><body>attempt ${i}</body></html>`, model: "test-model" };
    },
    async render(_html, attempt) {
      return { ok: true, path: `/tmp/slide-2.try${attempt}.png` };
    },
    async measure() {
      return opts.geometry?.[measured++] ?? [];
    },
    async verify() {
      return opts.verdicts[verified++] ?? { kind: "verdict", pass: true, issues: [] };
    },
  };
  const turns = (feedback: { html: string; issues: string[] } | null): VisionTurn[] => [
    { role: "user", content: feedback ? `FIX: ${feedback.issues.join(" | ")} IN ${feedback.html}` : "first" },
  ];
  return { deps, turns, seen, count: () => ({ coded, measured, verified }) };
}

test("a failed slide goes back to the coder with the issues and its own HTML, and stops when it passes", async () => {
  const s = scripted({ verdicts: [{ kind: "verdict", pass: false, issues: ["The headline overlaps the logo."] }, { kind: "verdict", pass: true, issues: [] }] });
  const got = await makeSlide({ slide, deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "pass");
  assert.equal(got.attempts, 2);
  assert.equal(got.file, "slide-2.try1.png");
  assert.equal(got.html, "<!doctype html><html><body>attempt 1</body></html>");
  assert.equal(got.model, "test-model");
  assert.deepEqual(got.history.map((h) => h.verdict), ["fail", "pass"]);
  assert.match(String(s.seen[1]![0]!.content), /FIX: The headline overlaps the logo\. IN <!doctype html><html><body>attempt 0/);
});

test("the geometry check fails a slide even when the vision model passed it", async () => {
  const s = scripted({
    geometry: [['The text "One idea" runs outside the 1080x1350 frame.'], []],
    verdicts: [{ kind: "verdict", pass: true, issues: [] }, { kind: "verdict", pass: true, issues: [] }],
  });
  const got = await makeSlide({ slide, deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "pass");
  assert.equal(got.attempts, 2);
  assert.match(String(s.seen[1]![0]!.content), /runs outside the 1080x1350 frame/);
});

test("retries stop at two, and the last render is kept with its verdict and issues", async () => {
  const fail: VerifyOutcome = { kind: "verdict", pass: false, issues: ["The body text is too faint on the background."] };
  const s = scripted({ verdicts: [fail, fail, fail, fail] });
  const got = await makeSlide({ slide, deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "fail");
  assert.equal(got.attempts, 3);
  assert.equal(s.count().coded, 3);
  assert.equal(got.file, "slide-2.try2.png");
  assert.deepEqual(got.issues, ["The body text is too faint on the background."]);
});

test("with no vision model a clean slide is unverified — never a pass — and is not retried", async () => {
  const s = scripted({ verdicts: [{ kind: "unverified", note: "the model cannot take a picture" }] });
  const got = await makeSlide({ slide, deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "unverified");
  assert.equal(got.attempts, 1);
  assert.equal(got.note, "the model cannot take a picture");
});

test("a model failure on the first attempt throws; on a retry it keeps the render it has", async () => {
  await assert.rejects(makeSlide({ slide, deps: scripted({ verdicts: [], codeFails: [0] }).deps, turns: () => [] }), /timed out/);
  const s = scripted({ verdicts: [{ kind: "verdict", pass: false, issues: ["Overlap in the footer."] }], codeFails: [1] });
  const got = await makeSlide({ slide, deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "fail");
  assert.equal(got.file, "slide-2.try0.png");
  assert.match(got.note ?? "", /Retry 1 could not be coded/);
});

test("a reply with no document is a failed attempt that is sent back, not a crash", async () => {
  let n = 0;
  const deps: SlideDeps = {
    async code() { return { text: n++ === 0 ? "Sorry, here is my plan instead." : "<html><body>ok</body></html>", model: null }; },
    async render(_h, attempt) { return { ok: true, path: `/x/slide-1.try${attempt}.png` }; },
    async measure() { return []; },
    async verify() { return { kind: "verdict", pass: true, issues: [] }; },
  };
  const got = await makeSlide({ slide: { ...slide, n: 1 }, deps, turns: () => [] });
  assert.equal(got.verdict, "pass");
  assert.equal(got.attempts, 2);
  assert.deepEqual(got.history[0]!.issues, ["The reply contained no HTML document."]);
});

/* ----------------------------------------------------------- the zip */

test("the zip is a valid stored archive: one local header per file, a central directory, the right CRC", () => {
  const a = Buffer.from("first file");
  const b = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const zip = storedZip([{ name: "slide-1.png", bytes: a }, { name: "slide-2.png", bytes: b }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  const dirStart = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(dirStart), 0x02014b50);
  /* The CRC every unzip checks, and "123456789"'s is the standard check value. */
  assert.equal(zip.readUInt32LE(14), crc32(a) >>> 0);
  assert.equal(storedZip([{ name: "c", bytes: Buffer.from("123456789") }]).readUInt32LE(14), 0xcbf43926);
  assert.equal(zip.subarray(30, 41).toString(), "slide-1.png");
  assert.deepEqual(zip.subarray(41, 41 + a.length), a);
});

/* ------------------------------------------------- the real browser */

test("in a real browser, a slide renders at exactly its size and overflowing text is measured", async (t) => {
  const browser = findBrowser();
  if (!browser.path) return t.skip("no Chrome or Chromium on this machine");
  const dir = mkdtempSync(resolve(tmpdir(), "opc-carousel-"));
  try {
    const good = `<!doctype html><html><head><style>html,body{margin:0;width:540px;height:675px;overflow:hidden;background:#123}h1{color:#fff;font:700 40px sans-serif;margin:60px}</style></head><body><h1>Fits well</h1></body></html>`;
    const shot = await renderSlideHtml({ browser: browser.path, html: good, dir, name: "good", width: 540, height: 675 });
    assert.ok(shot.ok, shot.ok ? "" : shot.error);
    assert.deepEqual(imageDimensions(readFileSync(shot.path)), { width: 540, height: 675 });
    assert.deepEqual(await measureSlideHtml({ browser: browser.path, html: good, dir, name: "good", width: 540, height: 675 }), []);

    const bad = `<!doctype html><html><head><style>html,body{margin:0;width:540px;height:675px;overflow:hidden}h1{position:absolute;left:400px;top:40px;white-space:nowrap;font:700 60px sans-serif}.box{position:absolute;top:300px;left:40px;width:200px;height:40px;overflow:hidden;font:20px sans-serif}</style></head><body><h1>Runs off the edge</h1><div class="box">A long paragraph that cannot possibly fit inside a box this small and gets cut off.</div></body></html>`;
    const issues = await measureSlideHtml({ browser: browser.path, html: bad, dir, name: "bad", width: 540, height: 675 });
    assert.ok(issues.some((i) => /Runs off the edge.*outside the 540x675 frame/.test(i)), issues.join("\n"));
    assert.ok(issues.some((i) => /A long paragraph.*cut off by its box/.test(i)), issues.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
