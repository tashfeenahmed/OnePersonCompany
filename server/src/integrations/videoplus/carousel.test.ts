import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { resolve } from "node:path";
import type { VisionTurn } from "../../models/provider.ts";
import { imageDimensions } from "../../tools/chrome.ts";
import { decodePixels } from "../../tools/png.ts";
import {
  coderSystem,
  feedbackText,
  makeStrip,
  measureStrip,
  parsePlan,
  parseStripVerdict,
  pickHtml,
  readGeometry,
  renderStrip,
  sortGeometry,
  type StripDeps,
  type VerifyOutcome,
} from "./carousel.ts";
import { FONTS_HREF, hasIcon, iconSamples, inlineIcons, prepareHtml } from "./carousel-kit.ts";
import { storedZip } from "./carousel-routes.ts";
import { findBrowser } from "./chrome.ts";
import { carouselSize } from "../../../../shared/carousel.ts";

const slides = (n: number) => Array.from({ length: n }, (_, i) => ({ headline: `Headline ${i + 1}`, body: `Body ${i + 1}`, visual: "a line" }));

/* ------------------------------------------------------------ the plan */

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

/* --------------------------------------------------------- the verdict */

test("the verdict is read per slide, by number or by order, with strip issues kept apart", () => {
  const got = parseStripVerdict(JSON.stringify({
    pass: false,
    strip: ["Slide 4 uses a serif headline; the others use a sans."],
    slides: [{ n: 3, pass: false, issues: ["The headline is cut off at the right edge.", { where: "footer", problem: "overlaps the logo" }] }, { n: 1, pass: true, issues: [] }],
  }), 6);
  assert.ok(got);
  assert.deepEqual(got.strip, ["Slide 4 uses a serif headline; the others use a sans."]);
  assert.deepEqual(got.slides[2], { pass: false, issues: ["The headline is cut off at the right edge.", "footer: overlaps the logo"] });
  assert.equal(got.slides.filter((s) => s.pass).length, 5, "slides it did not mention passed");

  const ordered = parseStripVerdict('```json\n{"pass":"false","slides":[{"pass":true},{"pass":"false","issues":["x is faint"]}]}\n```', 6);
  assert.deepEqual(ordered?.slides[1], { pass: false, issues: ["x is faint"] });
});

test("a fail that points at nothing is not a verdict; a slide failed with no issue is a pass", () => {
  assert.equal(parseStripVerdict('{"pass":false,"strip":[],"slides":[{"n":2,"pass":false,"issues":[]}]}', 6), null);
  assert.equal(parseStripVerdict("Looks fine to me."), null);
  assert.equal(parseStripVerdict('{"verdict":"mostly"}'), null);
  const clean = parseStripVerdict('{"pass":true,"strip":[],"slides":[]}', 6);
  assert.ok(clean && clean.slides.every((s) => s.pass) && clean.strip.length === 0);
  const capped = parseStripVerdict(JSON.stringify({ pass: false, strip: Array.from({ length: 12 }, (_, i) => `issue ${i}`) }), 6);
  assert.equal(capped?.strip.length, 6);
});

test("geometry lines go to the slide they name, anything else to the strip", () => {
  assert.deepEqual(sortGeometry(["Slide 2: the text runs outside.", "Slide 9: out of range", "a strip-wide note"], 6), {
    strip: ["Slide 9: out of range", "a strip-wide note"],
    slides: [[], ["the text runs outside."], [], [], [], []],
  });
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

/* ------------------------------------------------------------ the kit */

test("icons are inlined from the vendored sets; an unknown name renders as nothing and is reported", () => {
  const got = inlineIcons(`<div><i data-lucide="rocket" class="big" style="color:red"></i><span data-tabler="bolt"/> <i data-lucide="not-an-icon"></i></div>`);
  assert.match(got.html, /<svg [^>]*viewBox="0 0 24 24"[^>]*class="big" style="color:red" data-icon="lucide:rocket"><path /);
  assert.match(got.html, /data-icon="tabler:bolt"/);
  assert.doesNotMatch(got.html, /not-an-icon|<i /);
  assert.deepEqual(got.missing, ["lucide:not-an-icon"]);
});

test("every icon name the prompt offers exists, and the prompt lists the fonts and the cuts", () => {
  const s = iconSamples();
  assert.ok(s.lucide.length > 40 && s.tabler.length > 30);
  assert.ok([...s.lucide.map((n) => hasIcon("lucide", n)), ...s.tabler.map((n) => hasIcon("tabler", n))].every(Boolean));
  const system = coderSystem({ width: 1080, height: 1350 });
  assert.match(system, /6480px wide and 1350px tall/);
  assert.match(system, /1080px, 2160px, 3240px, 4320px, 5400px/);
  assert.match(system, /Bricolage Grotesque \(display\)/);
  assert.match(system, /data-lucide="rocket"/);
});

test("the prepared page links the curated fonts and the venture's own font, and inlines icons", () => {
  const got = prepareHtml(`<!doctype html><html><head><title>x</title></head><body><i data-lucide="check"></i></body></html>`, "Poppins");
  assert.ok(got.html.includes(FONTS_HREF.replace(/&/g, "&amp;")));
  assert.match(got.html, /family=Poppins&amp;display=block/);
  assert.match(got.html, /data-icon="lucide:check"/);
  assert.equal(prepareHtml("<html><body></body></html>", "Inter").html.match(/<link /g)?.length, 1, "a font already in the list is not linked twice");
});

/* ------------------------------------------------------------ the loop */

function scripted(opts: { verdicts: VerifyOutcome[]; geometry?: string[][]; codeFails?: number[]; missing?: string[] }) {
  const seen: VisionTurn[][] = [];
  let coded = 0;
  let measured = 0;
  let verified = 0;
  const deps: StripDeps = {
    async code(turns) {
      seen.push(turns);
      const i = coded++;
      if (opts.codeFails?.includes(i)) throw new Error("the model timed out");
      return { text: `<!doctype html><html><body>attempt ${i}</body></html>`, model: "test-model" };
    },
    prepare: (doc) => ({ html: doc, missingIcons: opts.missing ?? [] }),
    async render(_html, attempt) {
      return { ok: true, strip: `/tmp/carousel.try${attempt}.png`, slides: [1, 2, 3, 4, 5, 6].map((n) => `/tmp/slide-${n}.try${attempt}.png`) };
    },
    async measure() {
      return opts.geometry?.[measured++] ?? [];
    },
    async verify() {
      return opts.verdicts[verified++] ?? allPass();
    },
  };
  const turns = (feedback: { html: string; issues: string } | null): VisionTurn[] => [
    { role: "user", content: feedback ? `FIX:\n${feedback.issues}\nIN ${feedback.html}` : "first" },
  ];
  return { deps, turns, seen, count: () => ({ coded, measured, verified }) };
}

function allPass(): VerifyOutcome {
  return { kind: "verdict", strip: [], slides: Array.from({ length: 6 }, () => ({ pass: true, issues: [] })) };
}
function failSlide(n: number, issue: string, strip: string[] = []): VerifyOutcome {
  return {
    kind: "verdict",
    strip,
    slides: Array.from({ length: 6 }, (_, i) => (i === n - 1 ? { pass: false, issues: [issue] } : { pass: true, issues: [] })),
  };
}

test("a failed strip goes back to the coder as the SAME document with issues listed per slide, and stops when it passes", async () => {
  const s = scripted({ verdicts: [failSlide(3, "The headline overlaps the logo.", ["Slide 5 uses a different footer."]), allPass()] });
  const got = await makeStrip({ deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "pass");
  assert.equal(got.attempts, 2);
  assert.equal(got.kept?.attempt, 1);
  assert.equal(got.kept?.slides[5], "/tmp/slide-6.try1.png");
  assert.equal(got.html, "<!doctype html><html><body>attempt 1</body></html>");
  assert.deepEqual(got.history.map((h) => h.verdict), ["fail", "pass"]);
  assert.deepEqual(got.history[0]!.slides.map((x) => x.verdict), ["pass", "pass", "fail", "pass", "pass", "pass"]);
  const retry = String(s.seen[1]![0]!.content);
  assert.match(retry, /THE CAROUSEL AS A WHOLE:\n- Slide 5 uses a different footer\./);
  assert.match(retry, /SLIDE 3:\n- The headline overlaps the logo\./);
  assert.match(retry, /IN <!doctype html><html><body>attempt 0/);
});

test("the geometry check fails a slide even when the vision model passed it, and names the slide", async () => {
  const s = scripted({
    geometry: [['Slide 2: the text "One idea" crosses the cut between slide 2 and slide 3 (…).'], []],
    verdicts: [allPass(), allPass()],
  });
  const got = await makeStrip({ deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "pass");
  assert.equal(got.attempts, 2);
  assert.deepEqual(got.history[0]!.slides[1], { verdict: "fail", issues: ['the text "One idea" crosses the cut between slide 2 and slide 3 (…).'] });
  assert.match(String(s.seen[1]![0]!.content), /SLIDE 2:\n- the text "One idea" crosses the cut/);
});

test("revisions stop at two, and the last render is kept with each slide's verdict", async () => {
  const bad = failSlide(4, "The body text is too faint on the background.");
  const s = scripted({ verdicts: [bad, bad, bad, bad] });
  const got = await makeStrip({ deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "fail");
  assert.equal(got.attempts, 3);
  assert.equal(s.count().coded, 3);
  assert.equal(got.kept?.attempt, 2);
  assert.deepEqual(got.slides[3], { verdict: "fail", issues: ["The body text is too faint on the background."] });
  assert.equal(got.slides[0]!.verdict, "pass");
});

test("with no vision model a clean strip is unverified — never a pass — and is not revised", async () => {
  const s = scripted({ verdicts: [{ kind: "unverified", note: "the model cannot take a picture" }] });
  const got = await makeStrip({ deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "unverified");
  assert.ok(got.slides.every((x) => x.verdict === "unverified"));
  assert.equal(got.attempts, 1);
  assert.equal(got.note, "the model cannot take a picture");
});

test("unknown icons do not fail a strip, but a revision is told about them", async () => {
  const s = scripted({ verdicts: [failSlide(1, "The hook is clipped."), allPass()], missing: ["lucide:rockett"] });
  const got = await makeStrip({ deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "pass");
  assert.match(String(s.seen[1]![0]!.content), /ICONS THAT DO NOT EXIST[^\n]*lucide:rockett/);
  assert.equal(feedbackText({ verdict: "pass", strip: [], slides: [], note: null, missingIcons: [] }), "");
});

test("a model failure on the first attempt throws; on a revision it keeps the render it has", async () => {
  await assert.rejects(makeStrip({ deps: scripted({ verdicts: [], codeFails: [0] }).deps, turns: () => [] }), /timed out/);
  const s = scripted({ verdicts: [failSlide(2, "Overlap in the footer.")], codeFails: [1] });
  const got = await makeStrip({ deps: s.deps, turns: s.turns });
  assert.equal(got.verdict, "fail");
  assert.equal(got.kept?.attempt, 0);
  assert.match(got.note ?? "", /Revision 1 could not be coded/);
});

test("a reply with no document is a failed attempt that is sent back, not a crash", async () => {
  let n = 0;
  const deps: StripDeps = {
    async code() { return { text: n++ === 0 ? "Sorry, here is my plan instead." : "<html><body>ok</body></html>", model: null }; },
    prepare: (doc) => ({ html: doc, missingIcons: [] }),
    async render(_h, attempt) { return { ok: true, strip: `/x/c.try${attempt}.png`, slides: [] }; },
    async measure() { return []; },
    async verify() { return allPass(); },
  };
  const got = await makeStrip({ deps, turns: () => [] });
  assert.equal(got.verdict, "pass");
  assert.equal(got.attempts, 2);
  assert.deepEqual(got.history[0]!.strip, ["The reply contained no HTML document."]);
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

test("in a real browser, one strip renders six slides wide, is cut at the right offsets, and is measured", async (t) => {
  const browser = findBrowser();
  if (!browser.path) return t.skip("no Chrome or Chromium on this machine");
  const dir = mkdtempSync(resolve(tmpdir(), "opc-carousel-"));
  const W = 200, H = 250;
  const colours = ["#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2"];
  const sections = colours.map((c, i) => `<section style="position:absolute;left:${i * W}px;top:0;width:${W}px;height:${H}px;background:${c}"><p style="margin:40px 20px;font:700 20px sans-serif;color:#fff">Slide ${i + 1}</p></section>`).join("");
  const good = `<!doctype html><html><head><style>html,body{margin:0;width:${W * 6}px;height:${H}px;overflow:hidden;position:relative}</style></head><body>${sections}</body></html>`;
  try {
    const shot = await renderStrip({ browser: browser.path, html: good, dir, name: "strip", slideName: (n) => `s${n}`, width: W, height: H });
    assert.ok(shot.ok, shot.ok ? "" : shot.error);
    assert.deepEqual(imageDimensions(readFileSync(shot.strip)), { width: W * 6, height: H });
    for (let n = 1; n <= 6; n++) {
      const px = decodePixels(readFileSync(shot.slides[n - 1]!));
      assert.ok(!("error" in px));
      assert.deepEqual([px.width, px.height], [W, H]);
      /* The top-left pixel is that slide's own colour: the cut is on the boundary. */
      const want = colours[n - 1]!.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
      assert.deepEqual([...px.data.subarray(0, 3)], want, `slide ${n}'s first pixel`);
      /* And the bottom row is still the slide — the Linux height quirk was trimmed. */
      const last = (px.height - 1) * px.width * px.channels;
      assert.deepEqual([...px.data.subarray(last, last + 3)], want, `slide ${n}'s bottom row`);
    }
    assert.deepEqual(await measureStrip({ browser: browser.path, html: good, dir, name: "good", width: W, height: H }), []);

    const bad = good.replace("</body>", `<h1 style="position:absolute;left:${W * 2 - 60}px;top:120px;margin:0;white-space:nowrap;font:700 30px sans-serif">Across the cut</h1><h2 style="position:absolute;left:${W * 6 - 50}px;top:180px;margin:0;white-space:nowrap;font:700 24px sans-serif">Off the end</h2><div style="position:absolute;left:${W * 4 + 20}px;top:60px;width:120px;height:30px;overflow:hidden;font:16px sans-serif">A long paragraph that cannot possibly fit inside a box this small.</div></body>`);
    const issues = await measureStrip({ browser: browser.path, html: bad, dir, name: "bad", width: W, height: H });
    assert.ok(issues.some((i) => /^Slide [23]: the text "Across the cut" crosses the cut between slide 2 and slide 3/.test(i)), issues.join("\n"));
    assert.ok(issues.some((i) => /^Slide 6: the text "Off the end" runs outside the 200x250 frame \(\d+px past the right edge\)/.test(i)), issues.join("\n"));
    assert.ok(issues.some((i) => /^Slide 5: the text "A long paragraph.*cut off by the box around it/.test(i)), issues.join("\n"));

    /* The first Pi run's false alarm: a box a few pixels taller than its
       content (an inline SVG's descender gap), every letter plainly inside. */
    const snug = good.replace("</body>", `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden"><div style="position:absolute;inset:0"><svg width="${W}" height="${H}"><circle cx="100" cy="100" r="40" fill="teal"/></svg></div><div style="position:absolute;left:20px;bottom:20px;font:14px sans-serif">Footer 1 / 6</div></div></body>`);
    assert.deepEqual(await measureStrip({ browser: browser.path, html: snug, dir, name: "snug", width: W, height: H }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
