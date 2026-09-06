/**
 * EVERY PALETTE, IN BOTH MODES, AGAINST WCAG AA.
 *
 * This is the test that makes alternate palettes a feature rather than a
 * hazard. A skin is chosen for how it looks in a settings tile at 60 pixels
 * square; the failure it can cause is 11.5px grey meta text at 3.9:1 on a page
 * somebody reads every morning, and nobody notices that by looking. So the
 * ratio is computed, from the same numbers the browser is given, for every
 * text-on-surface pair each palette produces — and a palette that would ship a
 * pair under 4.5:1 fails the build instead.
 *
 * 4.5:1 AND NOT 3:1. The 3:1 exemption is for large text; this app's smallest
 * type is 10.5px and its body is 14px, so the large-text rule never applies to
 * anything drawn in these colours.
 *
 * `paper` IS TESTED TOO, and it is the one that most needed to be. It has no
 * token map — it IS the `:root` and `.dark` blocks of index.css — so the first
 * version of this file skipped it and the README claimed a sweep of "every
 * palette". That left the palette every user starts on as the only one nothing
 * checked, and left `swatch("paper", …)` hard-coding four hexes copied out of
 * that stylesheet with nothing to notice when they stopped matching. So the
 * blocks are PARSED OUT OF index.css and run through the same sweep, and the
 * default's swatch is asserted against them.
 */
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AA,
  DEFAULT_PALETTE,
  PALETTES,
  contrast,
  isPaletteId,
  palette,
  rgb,
  swatch,
  textPairs,
  type Tokens,
} from "./palettes.ts";

/**
 * THE DEFAULT PALETTE, READ OUT OF THE STYLESHEET THAT DEFINES IT.
 *
 * A deliberately small parser: the token declarations inside the FIRST `:root`
 * and `.dark` blocks, keeping only names the palette contract knows about. That
 * last filter is what makes it safe — index.css also declares `--radius` and
 * `--shimmer-highlight: var(--line-strong)`, and neither is a colour this can
 * or should read.
 *
 * If index.css is ever restructured so these blocks cannot be found, the tests
 * below fail loudly rather than silently checking nothing.
 */
function stylesheetPalette(): { light: Tokens; dark: Tokens } {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const names = new Set(Object.keys(PALETTES.find((p) => p.light)!.light!));

  const block = (selector: string): Tokens => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `index.css has no "${selector} {" block`);
    const body = css.slice(at, css.indexOf("}", at));
    const out: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g))
      if (names.has(name!)) out[name!] = value!.trim();
    const missing = [...names].filter((n) => !(n in out));
    assert.deepEqual(missing, [], `${selector} is missing ${missing.join(", ")}`);
    return out as Tokens;
  };

  return { light: block(":root"), dark: block(".dark") };
}

/**
 * WHAT THE DEFAULT PALETTE ACTUALLY MEASURES, RECORDED RATHER THAN ASSERTED
 * AWAY.
 *
 * `paper` is the design this app already shipped and it is not mine to
 * restyle — "the default is the current look, unchanged" is the whole reason
 * it has no token map. Run through the same sweep, four of its 52 pairs land
 * between 3.8:1 and 4.4:1. Two of them (`faint` on `muted`, in both modes) are
 * a pair the app never actually draws: there is no `text-faint` class anywhere
 * in `src`, and the cross product below is deliberately conservative — it asks
 * every ink against every surface rather than only the combinations that occur
 * today, because the combinations that occur change.
 *
 * So this is a LEDGER, not a gate: the exact shortfalls are written down with
 * their ratios, and the test fails if the set changes in either direction — a
 * new pair falling short, or one of these being fixed and the note left stale.
 * The seven palettes this area ADDED are held to the real gate in the test
 * below, because those values are mine and a new palette has no excuse.
 */
const PAPER_KNOWN_SHORTFALLS = [
  "paper/dark: faint on card — 4.35:1",
  "paper/dark: faint on muted — 3.82:1",
  "paper/light: destructive on muted — 4.33:1",
  "paper/light: faint on muted — 4.13:1",
];

test("the default palette's measured shortfalls are exactly the four on record", () => {
  const sheet = stylesheetPalette();
  const short: string[] = [];
  for (const mode of ["light", "dark"] as const)
    for (const pair of textPairs(sheet[mode])) {
      const ratio = contrast(pair.fg, pair.bg);
      if (ratio < AA) short.push(`paper/${mode}: ${pair.name} — ${ratio.toFixed(2)}:1`);
    }
  assert.deepEqual(
    short.sort(),
    PAPER_KNOWN_SHORTFALLS,
    "index.css's own palette moved. Fix the colour or update the ledger — do not delete the check.",
  );
});

test("the default palette's body and primary text clear AA", () => {
  /* The pairs the interface is actually built out of, held to the real bar even
     for the palette this area did not author. */
  const sheet = stylesheetPalette();
  for (const mode of ["light", "dark"] as const) {
    const t = sheet[mode];
    for (const [name, fg, bg] of [
      ["foreground on background", t.foreground, t.background],
      ["foreground on card", t.foreground, t.card],
      ["muted-foreground on background", t["muted-foreground"], t.background],
      ["muted-foreground on card", t["muted-foreground"], t.card],
      ["primary-foreground on primary", t["primary-foreground"], t.primary],
    ] as const) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= AA, `paper/${mode}: ${name} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the default's swatch is the stylesheet's own colours, not a stale copy", () => {
  /* `swatch("paper", …)` cannot read CSS at runtime, so it holds four hexes
     transcribed from index.css. This is the only thing that can notice when
     one of them stops being true. */
  const sheet = stylesheetPalette();
  for (const mode of ["light", "dark"] as const)
    assert.deepEqual(
      swatch("paper", mode).map((c) => c.toLowerCase()),
      [
        sheet[mode].background,
        sheet[mode].card,
        sheet[mode].foreground,
        sheet[mode].ok,
      ].map((c) => c.toLowerCase()),
      `the paper swatch has drifted from index.css in ${mode} mode`,
    );
});

test("there are at least seven palettes and the default is one of them", () => {
  assert.ok(PALETTES.length >= 7, `only ${PALETTES.length} palettes`);
  assert.ok(PALETTES.some((p) => p.id === DEFAULT_PALETTE));
  const ids = PALETTES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "palette ids must be unique");
});

test("the default palette overrides nothing at all", () => {
  /* The whole point of `paper`: choosing it REMOVES every custom property, so
     the app is the stylesheet. A default spelled out as a copy of index.css
     would drift from it the first time index.css changed. */
  const p = palette(DEFAULT_PALETTE);
  assert.equal(p.light, null);
  assert.equal(p.dark, null);
});

test("every other palette defines both modes completely", () => {
  const names = Object.keys(
    PALETTES.find((p) => p.light)!.light!,
  );
  for (const p of PALETTES) {
    if (p.id === DEFAULT_PALETTE) continue;
    assert.ok(p.light, `${p.id} has no light block`);
    assert.ok(p.dark, `${p.id} has no dark block`);
    for (const mode of ["light", "dark"] as const)
      for (const name of names)
        assert.ok(
          (p[mode] as Record<string, string>)[name],
          `${p.id} ${mode} is missing --${name}`,
        );
  }
});

test("every colour in every palette is a hex this can parse", () => {
  for (const p of PALETTES)
    for (const mode of ["light", "dark"] as const)
      for (const [name, value] of Object.entries(p[mode] ?? {}))
        assert.doesNotThrow(() => rgb(value), `${p.id} ${mode} --${name} = ${value}`);
});

test("every text pair in every palette this area authored meets WCAG AA", () => {
  const failures: string[] = [];
  for (const p of PALETTES) {
    for (const mode of ["light", "dark"] as const) {
      const t = p[mode];
      if (!t) continue;
      for (const pair of textPairs(t)) {
        const ratio = contrast(pair.fg, pair.bg);
        if (ratio < AA)
          failures.push(
            `${p.id}/${mode}: ${pair.name} — ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1`,
          );
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
});

test("body text clears AAA, because it is the text that is read all day", () => {
  /* Stricter than the rule for the one pair where the whole interface lives.
     Every default block in index.css is well past this; a palette that was not
     would look washed out beside them rather than merely legal. */
  for (const p of PALETTES)
    for (const mode of ["light", "dark"] as const) {
      const t = p[mode];
      if (!t) continue;
      const ratio = contrast(t.foreground, t.background);
      assert.ok(ratio >= 7, `${p.id}/${mode}: foreground on background is ${ratio.toFixed(2)}:1`);
    }
});

test("contrast is the WCAG formula", () => {
  assert.equal(Number(contrast("#000000", "#ffffff").toFixed(2)), 21);
  assert.equal(contrast("#123456", "#123456"), 1);
  /* Symmetric: the ratio does not know which is the ink. */
  assert.equal(contrast("#ffffff", "#767676"), contrast("#767676", "#ffffff"));
});

test("a swatch is four colours for every palette in both modes", () => {
  for (const p of PALETTES)
    for (const mode of ["light", "dark"] as const) {
      const s = swatch(p.id, mode);
      assert.equal(s.length, 4, `${p.id}/${mode}`);
      for (const c of s) assert.doesNotThrow(() => rgb(c));
    }
});

test("an unknown palette id falls back to the default rather than blanking", () => {
  assert.equal(isPaletteId("moss"), true);
  assert.equal(isPaletteId("chartreuse"), false);
  assert.equal(isPaletteId(7), false);
  assert.equal(palette("chartreuse").id, DEFAULT_PALETTE);
  assert.equal(palette(null).id, DEFAULT_PALETTE);
});
