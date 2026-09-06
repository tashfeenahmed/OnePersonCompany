/**
 * READING A BRAND OFF ITS OWN WEBSITE.
 *
 * The owner types a name, a sentence and a URL; everything else on a venture —
 * the icon, the colours, the fonts, what the site says it is — is already
 * published at that URL and typing it a second time is data entry. So this
 * file fetches the page and MEASURES it.
 *
 * IT IS A PORT OF WORKDASH'S `agent/branddna.js`, WITHOUT THE BROWSER, AND THE
 * MISSING BROWSER IS THE WHOLE DIFFERENCE. WorkDash drives a Chromium, walks
 * the rendered DOM and asks for COMPUTED styles: it knows the body's actual
 * background, which colour is painted on how many elements, and what font the
 * headings really resolved to. That is better evidence than anything here and
 * it costs a hundred and fifty megabytes of runtime plus a page load per site.
 * This app has zero runtime dependencies beyond Hono and runs on a Pi, so the
 * evidence available to it is the TEXT: the HTML, the `<style>` blocks, the
 * `style=""` attributes, a few linked stylesheets and the favicon's own pixels.
 *
 * WHAT THAT COSTS, NAMED HONESTLY, because a measurement whose limits are not
 * written down gets quoted as if it had none:
 *   - A colour declared in CSS is counted whether or not anything on the page
 *     is painted with it. A stylesheet's unused half votes.
 *   - A site whose colours arrive from a bundled JS framework at runtime, or
 *     from a cross-origin stylesheet, is invisible here. The palette comes
 *     back thin or empty, and the notes say why.
 *   - `:root { --brand: … }` scoping is not evaluated. Any CUSTOM PROPERTY
 *     declaration counts as a declaration of intent (weight 3), wherever it
 *     was written, because a parser that could tell `:root` from `.card:hover`
 *     is a CSS parser and this is a regex.
 * The colour arithmetic below — `luminance`, `hsl`, `hueGap`, `isBrandable`,
 * `assignRoles` — is ported line for line, thresholds and all, because those
 * numbers were tuned against real sites and re-deriving them here would be
 * inventing new ones. Their comments come with them.
 *
 * EVERY STEP FAILS SOFTLY AND SAYS SO. A site that is down leaves `error` set
 * and everything else null. A site that is up but has no icon link leaves a
 * `notes` line and a palette. A favicon that is a 5 MB PNG leaves a note and
 * no icon. What must never happen is a venture that cannot be created because
 * a web server was slow, which is why `enrich()` catches everything and why
 * the route treats its answer as data rather than as a result.
 *
 * ONE DEADLINE FOR THE WHOLE RUN. Each fetch has its own timeout, but the
 * budget is what actually bounds this: a page that takes five seconds leaves
 * five for the icon and the stylesheets, and whatever is unfinished when the
 * clock runs out becomes a note rather than a wait. A create that hangs for a
 * minute is a create the owner will assume has failed.
 */
import { inflateSync } from "node:zlib";
import { ventureRowById, writeVentureBrand, type VentureRow } from "../db.ts";
import { startKnowledgeRead } from "../integrations/knowledge/first-read.ts";

/* ------------------------------------------------------------------ shapes */

/**
 * Where a colour was found, which is the only thing that makes one vote worth
 * more than another.
 *
 * `var` — a custom property declaration. A DECLARATION of a brand colour
 *         rather than one more painted pixel. Weight 3.
 * `icon` — a pixel in the site's own favicon. Weight 2: an icon is a brand's
 *         most deliberate square centimetre, and it is small, so a colour that
 *         survives being drawn at 32 pixels is a colour the brand meant.
 * `css`  — any other literal in a stylesheet, a style block or a style
 *         attribute. Weight 1, and there are thousands of them.
 */
export type ColourKind = "var" | "css" | "icon";
export type ColourCount = { hex: string; n: number; kind: ColourKind };

export type Palette = {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  background: string | null;
  ink: string | null;
  /** The top eight brandable colours the roles were assigned FROM. A role with
   *  no ranking behind it is a role to distrust, so the evidence ships. */
  ranked: { hex: string; weight: number }[];
};

export type Brand = {
  /** A `data:` URL, so the page needs no second request and no proxy for an
   *  icon that lives on somebody else's origin. Capped at 64 KB. */
  favicon: string | null;
  /** Where it came from, absolute. Kept because "we drew this from your site"
   *  is a claim, and a claim should say where. */
  faviconSource: string | null;
  title: string | null;
  description: string | null;
  /** NOT downloaded. It is a social preview, it is often a megabyte, and a URL
   *  is enough for a page that wants to show one. */
  ogImage: string | null;
  themeColor: string | null;
  lang: string | null;
  palette: Palette;
  fonts: string[];
  /** ISO, or null for a site that has never been read. */
  enrichedAt: string | null;
  /** Why the read failed OUTRIGHT — the site was unreachable. Null when the
   *  page was fetched, even if nothing useful was in it; that case is notes. */
  error: string | null;
  /** What could not be measured, and why. One sentence each, in the order they
   *  happened. This is the difference between "this site has no icon" and "we
   *  did not find one", and the two must never read the same. */
  notes: string[];
};

/** A venture whose site has never been read. `enrichedAt: null` is the flag
 *  the boot pass looks for, so it has to survive a JSON round trip. */
export const EMPTY_BRAND: Brand = {
  favicon: null,
  faviconSource: null,
  title: null,
  description: null,
  ogImage: null,
  themeColor: null,
  lang: null,
  palette: {
    primary: null,
    secondary: null,
    accent: null,
    background: null,
    ink: null,
    ranked: [],
  },
  fonts: [],
  enrichedAt: null,
  error: null,
  notes: [],
};

/** A stored `brand` column, or the empty one when it is missing or unreadable.
 *  A row hand-edited into invalid JSON costs its brand, not the venture. */
export function readBrand(raw: string | null): Brand {
  if (!raw) return EMPTY_BRAND;
  try {
    const parsed = JSON.parse(raw) as Partial<Brand> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_BRAND;
    return {
      ...EMPTY_BRAND,
      ...parsed,
      palette: { ...EMPTY_BRAND.palette, ...(parsed.palette ?? {}) },
      fonts: Array.isArray(parsed.fonts) ? parsed.fonts : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    };
  } catch {
    return EMPTY_BRAND;
  }
}

/* ------------------------------------------------------------------ limits */

/** Named so a caller reading a note knows which number it hit. */
const BUDGET_MS = 10_000;
const PAGE_MS = 6_000;
const PAGE_CAP = 1_000_000;
const ICON_MS = 5_000;
const ICON_CAP = 64 * 1024;
const CSS_MS = 5_000;
const CSS_CAP = 300 * 1024;
const CSS_MAX = 3;
/** How many of an icon's pixels are looked at. A 192×192 icon is 36,864 of
 *  them and the four thousandth adds nothing to a frequency table. */
const ICON_SAMPLE = 4096;
/** A decompressed icon this app will hold in memory. A 64 KB PNG that inflates
 *  to a gigabyte is a real file format and a real denial of service. */
const INFLATE_CAP = 16 * 1024 * 1024;

/** Who is knocking. A site owner reading their access log should be able to
 *  tell this from a scraper, and this app is the answer. */
const UA = "OnePersonCompany/0.1 (+brand reader)";

/* ------------------------------------------------------ colour arithmetic */
/* Ported from workdash agent/branddna.js. The thresholds are the only tuned
   numbers here and they were tuned against live sites; see the block comment
   on PALE for the one that was learned the hard way. */

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX6.test(hex)) return null;
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Relative luminance, sRGB, the WCAG definition — used to decide "is this
 *  near-white" rather than to compute a contrast ratio, so the gamma step
 *  matters less than the consistency. */
export function luminance(hex: string): number | null {
  const c = hexToRgb(hex);
  if (!c) return null;
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** HSL saturation and hue. Hue is null for a grey — there is no angle on the
 *  axis, and returning 0 would make every grey look like a red. */
export function hsl(hex: string): { h: number | null; s: number; l: number } | null {
  const c = hexToRgb(hex);
  if (!c) return null;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: null, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

/** The shortest way round the wheel. 350 and 10 are twenty degrees apart, not
 *  three hundred and forty. */
export function hueGap(a: number | null, b: number | null): number {
  if (a == null || b == null) return 360;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const NEAR_WHITE = 0.9;
const NEAR_BLACK = 0.045;
const FLAT = 0.15;
/*
  PALE, and this one was learned from a live page rather than reasoned about.

  The first run of workdash's extractor against example-app-4.example.test returned #E0E5EB
  as the brand's primary colour — a pale blue-grey used on fourteen card
  borders — and pushed the site's actual blue, #1776F2, into second place. It
  got through every other filter honestly: its relative luminance is 0.78,
  below near-white, and its saturation is 0.22, above flat. What gives it away
  is that it is both very light AND barely coloured, which is what a surface
  tint is and what a brand colour is not.

  So the cut is on HSL lightness, and it is deliberately generous to the
  saturated end: a bright emerald at lightness 0.52 and a coral at 0.69 both
  survive it, and a paper-coloured grey at 0.90 does not. The trade is named: a
  brand whose actual mark is a pale pastel loses it here and the owner types it
  in, which is one field of work once versus every generated picture — and
  every venture chip — being drawn in a border colour.
*/
const PALE = 0.85;
const MURK = 0.08;

/** A colour a brand could be identified by: not the paper, not the ink, not a
 *  border grey and not a surface tint. */
export function isBrandable(hex: string): boolean {
  const l = luminance(hex);
  const c = hsl(hex);
  if (l == null || c == null) return false;
  if (l >= NEAR_WHITE) return false;
  if (l <= NEAR_BLACK) return false;
  if (c.s < FLAT) return false;
  if (c.l >= PALE) return false;
  if (c.l <= MURK) return false;
  return true;
}

/**
 * Which measured hex plays which part.
 *
 * Primary is the most-used brandable colour. Secondary is the next one at
 * least 25 degrees away round the wheel, because two shades of the same blue
 * are one brand colour rendered twice and calling both of them colours
 * produces a palette with no second colour in it. Accent is the next one
 * again, at least 25 degrees from both.
 *
 * THE WEIGHTS ARE WHERE THIS DEPARTS FROM THE ORIGINAL, by exactly one row.
 * WorkDash weighted a custom property 3 and everything else 1 — three, chosen
 * by measurement, because below that the vars lost to a border grey used on
 * ninety rows. That stands. What is new is `icon` at 2: this port has evidence
 * WorkDash did not, the favicon's own pixels, and it sits above a stylesheet
 * literal and below a declaration for the reason given at `ColourKind`.
 *
 * Every field can come back null. A site drawn entirely in greys HAS no
 * primary, and inventing one would be inventing the brand.
 */
export function assignRoles(
  counts: ColourCount[],
  page: { background?: string | null; color?: string | null } = {},
): Palette {
  const totals = new Map<string, number>();
  for (const row of counts) {
    const hex = String(row?.hex ?? "").toUpperCase();
    if (!HEX6.test(hex)) continue;
    const weight = row.kind === "var" ? 3 : row.kind === "icon" ? 2 : 1;
    totals.set(hex, (totals.get(hex) ?? 0) + (Number(row.n) || 1) * weight);
  }

  const pageBg = String(page.background ?? "").toUpperCase();
  const pageInk = String(page.color ?? "").toUpperCase();

  const background =
    (HEX6.test(pageBg) && pageBg) ||
    [...totals]
      .filter(([hex]) => !isBrandable(hex))
      .sort((a, b) => b[1] - a[1])[0]?.[0] ||
    null;
  const ink = (HEX6.test(pageInk) && pageInk) || null;

  const ranked = [...totals]
    .filter(([hex]) => isBrandable(hex))
    .filter(([hex]) => hex !== background && hex !== ink)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([hex, n]) => ({ hex, n, h: hsl(hex)?.h ?? null }));

  const primary = ranked[0] ?? null;
  const secondary =
    ranked.slice(1).find((c) => hueGap(c.h, primary?.h ?? null) >= 25) ?? ranked[1] ?? null;
  const accent =
    ranked
      .slice(1)
      .find(
        (c) =>
          c.hex !== secondary?.hex &&
          hueGap(c.h, primary?.h ?? null) >= 25 &&
          hueGap(c.h, secondary?.h ?? null) >= 25,
      ) ?? null;

  return {
    primary: primary?.hex ?? null,
    secondary: secondary?.hex ?? null,
    accent: accent?.hex ?? null,
    background,
    ink,
    ranked: ranked.slice(0, 8).map((c) => ({ hex: c.hex, weight: c.n })),
  };
}

/* ------------------------------------------------------- colour literals */

/**
 * Any CSS colour notation this file understands, as `#RRGGBB`.
 *
 * Named colours are NOT resolved, deliberately: the list is 148 entries, most
 * of which nobody has ever typed on purpose, and `white`/`black`/`transparent`
 * — the three that are common — are all non-brandable and would be discarded
 * two functions later anyway. A colour written as `rebeccapurple` is a colour
 * this reader misses, and the note at the end of the run does not claim
 * otherwise because it cannot know.
 *
 * ALPHA IS A FILTER RATHER THAN A BLEND. Something 30% transparent is not the
 * colour it was declared as — it is that colour over whatever is behind it,
 * which nothing here knows — so anything below half opacity is dropped rather
 * than composited against a guess.
 */
function normHex(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("#")) {
    const d = v.slice(1);
    if (d.length === 3 || d.length === 4) {
      if (d.length === 4 && Number.parseInt(d[3]!, 16) * 17 < 128) return null;
      return `#${d[0]!}${d[0]!}${d[1]!}${d[1]!}${d[2]!}${d[2]!}`.toUpperCase();
    }
    if (d.length === 6 || d.length === 8) {
      if (d.length === 8 && Number.parseInt(d.slice(6), 16) < 128) return null;
      return `#${d.slice(0, 6)}`.toUpperCase();
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = (fn[2] ?? "")
    .split(/[,\s/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const alpha = parts[3];
  if (alpha !== undefined && opacity(alpha) < 0.5) return null;

  if (fn[1]!.startsWith("rgb")) {
    const rgb = parts.slice(0, 3).map((p) => {
      const n = Number.parseFloat(p);
      if (!Number.isFinite(n)) return NaN;
      return p.endsWith("%") ? Math.round((n / 100) * 255) : Math.round(n);
    });
    if (rgb.some((n) => !Number.isFinite(n))) return null;
    return toHex(rgb[0]!, rgb[1]!, rgb[2]!);
  }

  const h = Number.parseFloat(parts[0]!.replace(/deg$/, ""));
  const s = Number.parseFloat(parts[1]!) / 100;
  const l = Number.parseFloat(parts[2]!) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  return hslToHex(h, s, l);
}

function opacity(raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 1;
  return raw.trim().endsWith("%") ? n / 100 : n;
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function hslToHex(hDeg: number, s: number, l: number): string {
  const h = ((hDeg % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb =
    seg === 0
      ? [c, x, 0]
      : seg === 1
        ? [x, c, 0]
        : seg === 2
          ? [0, c, x]
          : seg === 3
            ? [0, x, c]
            : seg === 4
              ? [x, 0, c]
              : [c, 0, x];
  return toHex((rgb[0]! + m) * 255, (rgb[1]! + m) * 255, (rgb[2]! + m) * 255);
}

/**
 * Every colour literal in a lump of CSS, with the custom properties told
 * apart from everything else.
 *
 * A DECLARATION IS FOUND BY ITS NAME, NOT BY ITS SELECTOR. `--brand: #1776F2`
 * counts as `var` wherever it was written — see the file header for why a
 * regex cannot tell `:root` from `.dark .card`. The declarations are blanked
 * out of the text before the literal sweep so no colour is counted twice.
 *
 * The hex pattern refuses a trailing word character, so `#deadbeef` in a URL
 * fragment is not read as a colour and `#abcz` is not read as `#abc`. An id
 * selector that happens to be six hex digits still votes; that is the residue
 * of not having a parser, it is rare, and it is one vote.
 */
const HEX_LITERAL =
  /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const FN_LITERAL = /\b(?:rgba?|hsla?)\([^)]{0,120}\)/g;
const CUSTOM_PROP = /(--[\w-]+)\s*:\s*([^;{}]{0,300})/g;

function scanColours(css: string, kind: "css" | "icon", out: ColourCount[]): void {
  let rest = css;
  for (const m of css.matchAll(CUSTOM_PROP)) {
    const value = m[2] ?? "";
    for (const hex of literals(value)) out.push({ hex, n: 1, kind: "var" });
    /* Blanked rather than removed so nothing else shifts under it. */
    rest = rest.replace(m[0], " ".repeat(m[0].length));
  }
  for (const hex of literals(rest)) out.push({ hex, n: 1, kind });
}

function literals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HEX_LITERAL)) {
    const hex = normHex(m[0]);
    if (hex) out.push(hex);
  }
  for (const m of text.matchAll(FN_LITERAL)) {
    const hex = normHex(m[0]);
    if (hex) out.push(hex);
  }
  return out;
}

/* --------------------------------------------------------------- the fonts */

/**
 * The families a browser falls back to, which are nobody's brand.
 *
 * Dropped rather than reported, because "the heading font is sans-serif" is
 * the same sentence as "we did not find out", and anything reading this record
 * would dutifully pass it on.
 */
const GENERIC = new Set(
  [
    "sans-serif",
    "serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "ui-rounded",
    "-apple-system",
    "blinkmacsystemfont",
    "segoe ui",
    "roboto",
    "helvetica",
    "helvetica neue",
    "arial",
    "apple color emoji",
    "segoe ui emoji",
    "segoe ui symbol",
    "noto color emoji",
    "emoji",
    "math",
    "inherit",
    "initial",
    "unset",
  ].map((s) => s.toLowerCase()),
);

const MAX_FONTS = 4;

/** The first NAMED family of every `font-family` stack in a lump of CSS, in
 *  the order they appear. A stack that is all fallbacks contributes nothing,
 *  which is the honest answer for it. */
function scanFonts(css: string, out: string[]): void {
  for (const m of css.matchAll(/font-family\s*:\s*([^;{}]{0,300})/gi)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().replace(/^["']|["']$/g, "").trim().slice(0, 60);
      if (!name || name.startsWith("var(")) continue;
      /* A family name is a name. Anything still carrying markup after the
         decode is a stack this reader mangled, and reporting it would put a
         string nobody could set in a font field. */
      if (/[&;<>{}]/.test(name)) continue;
      if (GENERIC.has(name.toLowerCase())) continue;
      if (!out.includes(name)) out.push(name);
      break;
    }
  }
}

/* ------------------------------------------------------------------ HTML */

/** The five entities that actually turn up in a title. A full table would be
 *  a dependency; a title with a stray `&hellip;` in it is a cosmetic loss. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const ATTR = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR))
    out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}

function tags(html: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi")))
    out.push(attrs(m[0]));
  return out;
}

function tidy(s: string | undefined, max = 400): string | null {
  if (!s) return null;
  const v = decodeEntities(s).replace(/\s+/g, " ").trim().slice(0, max);
  return v || null;
}

/* ------------------------------------------------------------------ fetch */

type Fetched = {
  url: string;
  status: number;
  type: string | null;
  bytes: Uint8Array;
  /** The cap was hit. A truncated stylesheet is still evidence; a truncated
   *  favicon is not an image, so the two callers treat this differently. */
  truncated: boolean;
};

/**
 * GET something, and stop reading at the cap.
 *
 * THE CAP IS ENFORCED ON THE STREAM, NOT ON `content-length`. A header is a
 * claim by the server: it can be absent (chunked encoding), it can be wrong,
 * and it can be a small number in front of a large body. Reading until the
 * counter says stop is the only version of this that actually bounds memory.
 *
 * The timeout is the SMALLER of this call's own and whatever is left of the
 * run's budget, so no single step can spend time a later one was promised.
 */
async function get(
  url: string,
  o: { ms: number; cap: number; deadline: number },
): Promise<Fetched> {
  const left = o.deadline - Date.now();
  if (left <= 0) throw new Error("out of time");

  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(Math.min(o.ms, left)),
  });

  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  const body = res.body;
  if (body) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (n + value.length > o.cap) {
          chunks.push(value.subarray(0, o.cap - n));
          n = o.cap;
          truncated = true;
          break;
        }
        chunks.push(value);
        n += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return {
    url: res.url || url,
    status: res.status,
    type: res.headers.get("content-type"),
    bytes: Buffer.concat(chunks),
    truncated,
  };
}

/** What a failed fetch is called in a note. `fetch` throws a TypeError with a
 *  cause for DNS and TLS, and an AbortError for the timeout; neither of those
 *  names means anything to a person reading the Ventures page. */
function why(err: unknown, ms: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError")
      return `it did not answer within ${Math.round(ms / 1000)}s`;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "ENOTFOUND") return "the hostname does not resolve";
    if (cause?.code === "ECONNREFUSED") return "nothing is listening on it";
    if (cause?.message) return cause.message;
    return err.message;
  }
  return "it failed for a reason it did not give";
}

/* --------------------------------------------------------------- the icon */

/** The content type a byte string actually is, when the server did not say or
 *  said `application/octet-stream`. Three magic numbers, because those are the
 *  three formats a favicon is. */
function sniff(bytes: Uint8Array, href: string): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01)
    return "image/x-icon";
  const path = href.split("?")[0]!.toLowerCase();
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/x-icon";
}

/** `sizes="32x32 16x16"` → 32. `sizes="any"` on an SVG is not a pixel count
 *  and is handled by the caller, which knows it is looking at an SVG. */
function largestSize(sizes: string | undefined): number {
  let best = 0;
  for (const m of (sizes ?? "").matchAll(/(\d+)\s*[x×]\s*(\d+)/gi))
    best = Math.max(best, Number(m[1]), Number(m[2]));
  return best;
}

const ICON_REL = /(^|\s)(shortcut\s+icon|icon|apple-touch-icon(-precomposed)?)(\s|$)/i;

/**
 * Which icon to fetch, in the order a person would pick one.
 *
 * A PNG or an SVG between 32 and 192 pixels first, largest of those — big
 * enough to have colours in it, small enough not to be a download. An SVG is
 * ranked as if it were 192 because it has no pixel size and is the best
 * possible answer at any of them. Then any declared icon at all, whatever
 * format. Then `/favicon.ico`, which is not a link at all but a convention
 * every browser still tries and most sites still honour.
 */
function pickIcons(links: Record<string, string>[], base: URL): string[] {
  const icons = links
    .filter((l) => ICON_REL.test(l.rel ?? "") && (l.href ?? "").trim())
    .map((l) => {
      const href = l.href!.trim();
      const type = (l.type ?? "").toLowerCase();
      const path = href.split("?")[0]!.toLowerCase();
      const svg = type.includes("svg") || path.endsWith(".svg");
      const png = type.includes("png") || path.endsWith(".png");
      return { href, svg, png, size: svg ? 192 : largestSize(l.sizes) };
    });

  const preferred = icons
    .filter((i) => (i.png || i.svg) && i.size >= 32 && i.size <= 192)
    .sort((a, b) => b.size - a.size);

  const ordered = [...preferred, ...icons.filter((i) => !preferred.includes(i))];
  const urls: string[] = [];
  for (const i of ordered) {
    const abs = absolute(i.href, base);
    if (abs && !urls.includes(abs)) urls.push(abs);
  }
  const ico = absolute("/favicon.ico", base);
  if (ico && !urls.includes(ico)) urls.push(ico);
  return urls;
}

function absolute(href: string, base: URL): string | null {
  try {
    if (href.startsWith("data:")) return href;
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- the PNG decoder */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes per pixel by colour type, at bit depth 8: greyscale, truecolour,
 *  indexed, greyscale+alpha, truecolour+alpha. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function u32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * A PNG's own pixels, quantised, as `#RRGGBB`.
 *
 * WHY THIS EXISTS AT ALL, given that it is ninety lines of format handling in
 * a file that otherwise runs on regexes: the favicon is the ONE place a brand
 * colour is guaranteed to be, on every site, in every framework, whether or
 * not the CSS was readable. A site that renders its colours from JavaScript
 * gives this reader nothing else. Decoding one 32×32 image is a much smaller
 * thing than the browser the alternative would need.
 *
 * WHAT IT HANDLES AND WHAT IT REFUSES. Bit depth 8, non-interlaced, colour
 * types 0, 2, 3, 4 and 6 — which is what an icon exporter produces. Depth 1/2/
 * 4/16 and Adam7 interlacing are REFUSED WITH A NOTE rather than half-decoded:
 * a wrong unfilter produces plausible garbage, and plausible garbage in a
 * frequency table is worse than an admitted gap.
 *
 * QUANTISED TO FOUR BITS A CHANNEL before counting. An anti-aliased edge is
 * two hundred nearly identical blues, and counting them separately would let
 * the flat background beat the mark. Rounding them together is what makes the
 * icon's actual colour the icon's most common colour.
 *
 * Alpha below 128 is skipped: a transparent pixel has no colour, and the
 * usual value under one is white, which would win.
 */
function pngColours(bytes: Uint8Array, notes: string[]): string[] {
  for (let i = 0; i < PNG_SIG.length; i++)
    if (bytes[i] !== PNG_SIG[i]) {
      notes.push("The favicon is not a PNG, so no colours were read from it.");
      return [];
    }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let alphas: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p);
    const type = String.fromCharCode(
      bytes[p + 4]!,
      bytes[p + 5]!,
      bytes[p + 6]!,
      bytes[p + 7]!,
    );
    const start = p + 8;
    const end = start + len;
    if (end > bytes.length) break;
    if (type === "IHDR") {
      width = u32(bytes, start);
      height = u32(bytes, start + 4);
      depth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      interlace = bytes[start + 12]!;
    } else if (type === "PLTE") palette = bytes.subarray(start, end);
    else if (type === "tRNS") alphas = bytes.subarray(start, end);
    else if (type === "IDAT") idat.push(bytes.subarray(start, end));
    else if (type === "IEND") break;
    p = end + 4;
  }

  if (depth !== 8 || interlace !== 0 || CHANNELS[colorType] === undefined) {
    notes.push(
      `The favicon is a PNG this reader cannot decode (bit depth ${depth}, ` +
        `colour type ${colorType}${interlace ? ", interlaced" : ""}), so no ` +
        `colours were taken from it.`,
    );
    return [];
  }
  if (!width || !height || !idat.length) {
    notes.push("The favicon PNG has no image data in it.");
    return [];
  }
  if (width * height > 4_000_000) {
    notes.push(`The favicon is ${width}×${height}, which is a picture rather than an icon.`);
    return [];
  }

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: INFLATE_CAP });
  } catch {
    notes.push("The favicon PNG's image data would not decompress.");
    return [];
  }

  const bpp = CHANNELS[colorType]!;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) {
    notes.push("The favicon PNG is truncated.");
    return [];
  }

  /* Unfiltered in place into one flat buffer, row by row, because every filter
     but None reads the row above — so the previous row must already be the
     decoded one rather than the filtered one. */
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? out[dst + x - bpp]! : 0;
      const b = y > 0 ? out[up + x]! : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp]! : 0;
      out[dst + x] =
        filter === 0
          ? v
          : filter === 1
            ? (v + a) & 255
            : filter === 2
              ? (v + b) & 255
              : filter === 3
                ? (v + ((a + b) >> 1)) & 255
                : (v + paeth(a, b, c)) & 255;
    }
  }

  const total = width * height;
  const step = Math.max(1, Math.floor(total / ICON_SAMPLE));
  const q = (v: number) => (v >> 4) * 17;
  const hexes: string[] = [];
  for (let i = 0; i < total; i += step) {
    const y = Math.floor(i / width);
    const x = i % width;
    const o = y * stride + x * bpp;
    let r: number;
    let g: number;
    let b: number;
    let alpha = 255;
    if (colorType === 0) {
      r = g = b = out[o]!;
    } else if (colorType === 4) {
      r = g = b = out[o]!;
      alpha = out[o + 1]!;
    } else if (colorType === 2) {
      r = out[o]!;
      g = out[o + 1]!;
      b = out[o + 2]!;
    } else if (colorType === 6) {
      r = out[o]!;
      g = out[o + 1]!;
      b = out[o + 2]!;
      alpha = out[o + 3]!;
    } else {
      const idx = out[o]!;
      if (!palette || idx * 3 + 2 >= palette.length) continue;
      r = palette[idx * 3]!;
      g = palette[idx * 3 + 1]!;
      b = palette[idx * 3 + 2]!;
      alpha = alphas && idx < alphas.length ? alphas[idx]! : 255;
    }
    if (alpha < 128) continue;
    hexes.push(toHex(q(r), q(g), q(b)));
  }
  return hexes;
}

/** An SVG icon's declared colours. No rasteriser, so this is the literals
 *  themselves — every `fill`, `stroke` and `stop-color`, whether written as an
 *  attribute or as a property. Each counts once, because an SVG has no pixels
 *  to weigh them by. */
function svgColours(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)]{0,120}\))/gi,
  )) {
    const hex = normHex(m[1] ?? "");
    if (hex) out.push(hex);
  }
  return out;
}

/* ---------------------------------------------------------------- the run */

/**
 * A URL as this app stores one, from whatever the owner typed.
 *
 * A bare `support.example.test` is what a person types and it is not a URL, so https
 * is assumed — https rather than http because a site that only speaks http
 * will redirect and the final URL is what gets recorded either way, whereas
 * assuming http on an https-only site costs a redirect on every read. Only
 * http(s) is accepted: `mailto:` and `javascript:` parse perfectly well and
 * are not websites.
 */
export function normaliseWebsite(raw: string): { website: string; host: string } | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;
  return { website: url.toString(), host: hostOf(url) };
}

/** The hostname without a leading `www.`, which is what everything else on
 *  this dashboard joins on: a Cloudflare zone, a Search Console property and a
 *  sending domain are all written without it. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^www\./i, "").toLowerCase();
}

/**
 * Read a website and say what its brand looks like.
 *
 * PURE ENOUGH TO TEST: a URL in, a document out, no row touched and nothing
 * thrown. Every failure is somewhere in the answer — `error` when the site
 * could not be fetched at all, a `notes` line for everything else — because a
 * caller that has to catch is a caller that will eventually catch and discard.
 */
export async function enrich(
  website: string,
  budgetMs = BUDGET_MS,
): Promise<{ brand: Brand; host: string | null; finalUrl: string | null }> {
  const deadline = Date.now() + budgetMs;
  const stamped = (b: Partial<Brand>): Brand => ({
    ...EMPTY_BRAND,
    ...b,
    enrichedAt: new Date().toISOString(),
  });

  const norm = normaliseWebsite(website);
  if (!norm)
    return {
      brand: stamped({ error: `“${website}” is not a website address.` }),
      host: null,
      finalUrl: null,
    };

  const notes: string[] = [];
  let page: Fetched;
  try {
    page = await get(norm.website, { ms: PAGE_MS, cap: PAGE_CAP, deadline });
  } catch (err) {
    return {
      brand: stamped({ error: `${norm.host} could not be read — ${why(err, PAGE_MS)}.` }),
      host: norm.host,
      finalUrl: null,
    };
  }

  /* THE FINAL URL IS THE BASE FOR EVERYTHING BELOW. A site that redirects
     apex to www, or http to https, or `/` to `/en/`, publishes its icon and
     its stylesheets relative to where it LANDED — resolving them against what
     was typed is how a reader ends up fetching a hundred 404s. */
  let base: URL;
  try {
    base = new URL(page.url);
  } catch {
    base = new URL(norm.website);
  }
  const host = hostOf(base);

  if (page.status >= 400)
    notes.push(
      `${host} answered ${page.status}, so what was read may be an error page rather than the site.`,
    );
  if (page.truncated)
    notes.push(`Only the first ${PAGE_CAP / 1000} KB of the page was read.`);

  const html = new TextDecoder("utf-8").decode(page.bytes);
  const metas = tags(html, "meta");
  const links = tags(html, "link");

  const meta = (key: string): string | undefined => {
    const k = key.toLowerCase();
    for (const m of metas) {
      const name = (m.name ?? m.property ?? "").toLowerCase();
      if (name === k) return m.content;
    }
    return undefined;
  };

  const counts: ColourCount[] = [];
  const fonts: string[] = [];

  /* The colours the site DECLARES about itself, counted as declarations —
     `theme-color` is a brand colour written down on purpose, which is exactly
     what a custom property is, so it is weighed the same. */
  const themeColor = normHex(meta("theme-color") ?? "");
  if (themeColor) counts.push({ hex: themeColor, n: 1, kind: "var" });

  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]{0,200000}?)<\/style>/gi)) {
    /*
      DECODED, EVEN THOUGH `<style>` IS A RAW-TEXT ELEMENT AND SHOULD NOT NEED
      IT. By the spec its contents are CSS exactly as written and a browser
      decodes nothing in here — but server-rendered pages emit escaped quotes
      into it anyway (Gatsby's inlined styles on support.example.test are one), and
      the cost of the two readings differs wildly: decoding a stylesheet that
      did not need it changes nothing, because `&amp;` and `&#x27;` are not
      valid CSS to begin with, while NOT decoding one that did records a font
      family called "&#x27".
    */
    const css = decodeEntities(m[1] ?? "");
    scanColours(css, "css", counts);
    scanFonts(css, fonts);
  }
  for (const m of html.matchAll(/\sstyle\s*=\s*("([^"]{0,600})"|'([^']{0,600})')/gi)) {
    /* DECODED, unlike a `<style>` block, and the difference is the HTML spec
       rather than a preference: `<style>` is a raw-text element and its
       contents are CSS exactly as written, while an ATTRIBUTE value is
       entity-encoded — so a stack written `font-family:&#x27;Inter&#x27;` is
       really `font-family:'Inter'`, and scanning it raw records a font called
       "&#x27". */
    const css = decodeEntities(m[2] ?? m[3] ?? "");
    scanColours(css, "css", counts);
    scanFonts(css, fonts);
  }

  /* SAME-ORIGIN STYLESHEETS ONLY, AND AT MOST THREE. Not a security rule — a
     public stylesheet is public — but an honesty one: a Google Fonts or
     Bootstrap CDN sheet is somebody else's palette, and counting a framework's
     four hundred utility colours would drown the site's own. Three is what a
     hand-built site has; a bundler emits one. */
  const sheets = links
    .filter((l) => /(^|\s)stylesheet(\s|$)/i.test(l.rel ?? "") && (l.href ?? "").trim())
    .map((l) => absolute(l.href!.trim(), base))
    .filter((u): u is string => u !== null && !u.startsWith("data:"))
    .filter((u) => {
      try {
        return new URL(u).host === base.host;
      } catch {
        return false;
      }
    })
    .slice(0, CSS_MAX);

  for (const url of sheets) {
    if (Date.now() >= deadline) {
      notes.push("The run ran out of time before every stylesheet was read.");
      break;
    }
    try {
      const css = await get(url, { ms: CSS_MS, cap: CSS_CAP, deadline });
      const text = new TextDecoder("utf-8").decode(css.bytes);
      scanColours(text, "css", counts);
      scanFonts(text, fonts);
      if (css.truncated)
        notes.push(`Only the first ${CSS_CAP / 1024} KB of ${url} was read.`);
    } catch (err) {
      notes.push(`A stylesheet could not be read — ${why(err, CSS_MS)}.`);
    }
  }
  if (!sheets.length && !html.includes("<style"))
    notes.push(
      "No same-origin stylesheet and no style block, so the colours below come from the page's own markup and its icon.",
    );

  /* --- the icon ------------------------------------------------------- */

  let favicon: string | null = null;
  let faviconSource: string | null = null;
  const candidates = pickIcons(links, base);
  const declared = candidates.length > 1;

  for (const url of candidates) {
    if (Date.now() >= deadline) {
      notes.push("The run ran out of time before an icon was fetched.");
      break;
    }
    try {
      if (url.startsWith("data:")) {
        if (url.length > ICON_CAP * 2) {
          notes.push("The icon is an inline data URL larger than 64 KB.");
          continue;
        }
        favicon = url;
        faviconSource = url.slice(0, 64) + "…";
        break;
      }
      const icon = await get(url, { ms: ICON_MS, cap: ICON_CAP + 1, deadline });
      if (icon.status >= 400) continue;
      if (!icon.bytes.length) continue;
      if (icon.bytes.length > ICON_CAP || icon.truncated) {
        notes.push(
          `${url} is larger than ${ICON_CAP / 1024} KB, which is a picture rather than an icon, so it was skipped.`,
        );
        continue;
      }
      const type = (icon.type ?? "").split(";")[0]!.trim().toLowerCase();
      const mime =
        type && type.startsWith("image/") ? type : sniff(icon.bytes, url);
      favicon = `data:${mime};base64,${Buffer.from(icon.bytes).toString("base64")}`;
      faviconSource = icon.url;

      if (mime === "image/png")
        for (const hex of pngColours(icon.bytes, notes))
          counts.push({ hex, n: 1, kind: "icon" });
      else if (mime === "image/svg+xml") {
        /* The declared colours only, and NOT the general literal sweep the
           stylesheets get. An SVG's every hex is not evidence in the same way:
           a `#clip-path-3` reference or an id is not a colour, and a custom
           property inside an icon is not a site-wide declaration worth weight
           three. What paints the mark is `fill`, `stroke` and `stop-color`. */
        for (const hex of svgColours(new TextDecoder("utf-8").decode(icon.bytes)))
          counts.push({ hex, n: 1, kind: "icon" });
      } else
        notes.push(
          `The favicon is ${mime}, which this reader can store but not look inside, so no colours were taken from it.`,
        );
      break;
    } catch (err) {
      notes.push(`An icon could not be fetched — ${why(err, ICON_MS)}.`);
    }
  }
  if (!favicon)
    notes.push(
      declared
        ? "None of the icons the page links to could be fetched, and /favicon.ico did not answer either."
        : "The page links to no icon and /favicon.ico did not answer.",
    );

  /* --- the answer ----------------------------------------------------- */

  const palette = assignRoles(counts);
  if (!palette.primary)
    notes.push(
      counts.length
        ? "No colour on the site is brandable — everything measured is paper, ink or a border grey."
        : "No colour could be measured at all: the page carries none in its markup and its stylesheets were unreadable from here.",
    );

  return {
    brand: stamped({
      favicon,
      faviconSource,
      title: tidy(
        /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(html)?.[1] ?? meta("og:title"),
        200,
      ),
      description: tidy(meta("description") ?? meta("og:description"), 400),
      ogImage: meta("og:image") ? absolute(meta("og:image")!.trim(), base) : null,
      themeColor,
      lang: tidy(attrs(/<html\b[^>]*>/i.exec(html)?.[0] ?? "").lang, 16),
      palette,
      fonts: fonts.slice(0, MAX_FONTS),
      notes,
    }),
    host,
    finalUrl: page.url,
  };
}

/**
 * Read one venture's site and keep what was read.
 *
 * THE COLOUR RULE LIVES HERE because this is the only place both halves of it
 * are known: whether the owner ever chose a colour (`color_source`) and
 * whether this reading found one (`palette.primary`). A colour the owner
 * picked is never overwritten by a measurement — not on the first read and not
 * on the fiftieth — and a reading that measured nothing leaves whatever was
 * there rather than blanking it, because a chip that turns grey when a site
 * goes down is a chip that lies about the venture.
 *
 * Returns the row as it now is, or undefined for an id that names nothing. A
 * venture with no website is left exactly as it was: there is nothing to read,
 * which is not a failure and does not deserve an `error`.
 */
export async function enrichVenture(id: string): Promise<VentureRow | undefined> {
  const row = ventureRowById(id);
  if (!row || !row.website) return row;
  /*
    THE PRODUCT'S OWN SOURCE, ONCE, BESIDE THE SITE READING.

    A site reading is the venture's MARKETING COPY measured; the repository is
    the product. They belong to different areas and this is the only place both
    are known to be wanted at the same moment, so the extractor is CALLED here
    and nothing else about it lives in this file — see
    integrations/knowledge/extract.ts.

    THREE CONSTRAINTS, and each is why this is two lines rather than an await:
      * it is FIRST TIME ONLY. `startKnowledgeRead` returns immediately unless a
        repository is mapped and has never been read, so pressing "read the
        site again" never spends a completion.
      * it is NOT AWAITED. A venture create must not wait on GitHub, and a
        GitHub outage must not stop a colour being stored.
      * it cannot throw into this function. The helper swallows its own errors
        onto the knowledge row, where the Knowledge tab draws them.
  */
  startKnowledgeRead(id);
  const { brand, host } = await enrich(row.website);
  return writeVentureBrand(id, {
    host: host ?? row.host,
    brand: JSON.stringify(brand),
    color:
      row.color_source === "owner" || !brand.palette.primary ? null : brand.palette.primary,
  });
}
