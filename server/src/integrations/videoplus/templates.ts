/**
 * THE MOTION TEMPLATES — five scene kinds as one self-contained HTML page.
 *
 * NO REMOTION AND NO RENDER TOOLCHAIN. The system this replaces renders these
 * with Remotion, which is React plus a bundler plus a headless Chrome plus a
 * node_modules tree, and it is a good answer on a box that already has one.
 * This server has no build step, no React on the server side and no npm
 * dependency beyond hono, and adding a React renderer to draw six words on
 * a coloured background would be a hundred megabytes of toolchain for a
 * typeface and a fade. What is
 * here instead is a page of hand-written CSS that the SAME headless Chrome
 * this box already uses for venture screenshots renders directly.
 *
 * THE ANIMATION IS A PAUSED CSS ANIMATION WITH A NEGATIVE DELAY, and that one
 * trick is what makes the render deterministic. Every animated element carries
 * `animation-play-state: paused` and `animation-delay: calc(-1s * var(--t))`.
 * A paused animation at delay −t renders EXACTLY the state it would have had t
 * seconds in — no clock is read, no frame is waited for, and the same t always
 * produces the same pixels. Nothing here depends on when Chrome got round to
 * painting, which is the failure every "screenshot an animation" approach has.
 *
 * A SHEET IS MANY TILES SIDE BY SIDE, and that is the whole reason a render on
 * a laptop finishes. One headless Chrome launch costs about two and a half
 * seconds on this machine, most of it profile setup; a frame costs almost
 * nothing once the page is up. So a sheet is one page containing N copies of
 * the scene, each with its own `--t`, laid out in a row and screenshotted in
 * ONE launch — then ffmpeg's `untile` filter cuts them back into N frames.
 * Eight frames per launch turns a five-second scene from two minutes of
 * process startup into fifteen seconds.
 *
 * THE COLOURS AND THE TYPEFACE ARE THE VENTURE'S, MEASURED. `readBrand` on the
 * venture row is what ventures/enrich.ts wrote when it read the site: a ranked
 * palette and the font families the stylesheet actually asked for. A venture
 * whose site has never been read falls through to its own colour and to system
 * fonts, and the run's report says which of the two happened — a video that
 * looks generic because nothing was measured and a video that looks generic
 * because the site is generic are different facts.
 *
 * EVERY STRING IS ESCAPED. The text in a scene spec was written by a model or
 * typed by the owner and it goes into a document Chrome will parse; a `<` that
 * reached the page as markup would at best break the layout.
 */
import type { VentureRow } from "../../db.ts";
import { readBrand } from "../../ventures/enrich.ts";
import type { Scene } from "./scenespec.ts";

/** What a scene is drawn in. Derived, never stored — see the migration. */
export type Look = {
  /** The two ends of the background gradient. */
  bg: string;
  bg2: string;
  /** Body text. */
  ink: string;
  /** Secondary text — a note, a subtitle. */
  soft: string;
  /** The one colour that is the venture's. Numbers, rules, the CTA pill. */
  accent: string;
  /** A panel behind a compare side. */
  panel: string;
  /** A hairline. */
  line: string;
  /** The venture's own measured family, or null. */
  font: string | null;
  /** Where the palette came from, for the report. */
  source: string;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v: string | null | undefined, fallback: string) => (v && HEX.test(v.trim()) ? v.trim().toLowerCase() : fallback);

/** sRGB relative luminance, the WCAG one. Used for exactly one decision: is
 *  this background dark enough to put white text on. */
function luminance(c: string): number {
  const n = parseInt(c.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** A colour nudged towards black or white by `amount`, for the second stop of
 *  the gradient. A gradient between a colour and a slightly different version
 *  of itself is what stops a flat fill from banding on an H.264 encode. */
function shift(c: string, amount: number): string {
  const n = parseInt(c.slice(1), 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v + amount * 255))),
  );
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The look for one venture.
 *
 * THE BACKGROUND IS THE MEASURED BACKGROUND WHERE THERE IS ONE, because that
 * is the single colour that makes a video feel like it came from a site. When
 * there is not, the venture's own colour is DARKENED into a background rather
 * than used flat: a brand colour is chosen to be seen against a page, and a
 * full-frame fill of it with white text on top is unreadable.
 */
export function lookOf(v: VentureRow | null, accentOverride: string | null): Look {
  const brand = v ? readBrand(v.brand) : null;
  const p = brand?.palette;
  const accent = hex(accentOverride ?? p?.accent ?? p?.primary ?? v?.color ?? null, "#5ee7ff");
  const measured = hex(p?.background ?? null, "");
  const base = measured || shift(hex(p?.primary ?? v?.color ?? null, "#101b33"), -0.62);
  const dark = luminance(base) < 0.35;
  const ink = dark ? "#ffffff" : hex(p?.ink ?? null, "#12151c");
  const source = accentOverride
    ? "the accent set on this spec, over the venture's own"
    : measured
      ? "the palette measured off the venture's own site"
      : brand?.enrichedAt
        ? "the venture's colour, darkened — its site was read but no background colour came out of it"
        : "the venture's colour, darkened — its site has never been read, so nothing was measured";

  return {
    bg: base,
    bg2: shift(base, dark ? 0.05 : -0.05),
    ink,
    soft: dark ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.55)",
    accent,
    panel: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.045)",
    line: dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)",
    font: brand?.fonts[0] ?? null,
    source,
  };
}

/* --------------------------------------------------------------- escaping */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A CSS string literal for a font family name. A family with a quote in it is
 *  not a family this box will pass through. */
const family = (name: string | null) => {
  const clean = (name ?? "").replace(/["'\\;{}]/g, "").trim().slice(0, 60);
  const list = `-apple-system, "Helvetica Neue", Helvetica, Arial, "DejaVu Sans", "Liberation Sans", sans-serif`;
  return clean ? `"${clean}", ${list}` : list;
};

/* ---------------------------------------------------------------- the page */

/** One tile of a sheet: which scene, and at what second inside it. */
export type Tile = { scene: Scene; t: number; holdLastFrame?: boolean };

/**
 * A whole sheet, as one HTML document.
 *
 * The tiles are laid out in a single flex ROW with no wrapping and no gap, so
 * the screenshot is exactly `tiles.length × width` wide and ffmpeg's `untile`
 * can cut it on the grid with no arithmetic. `flex: 0 0 auto` on the tile is
 * load-bearing: without it a flex row shrinks its children to fit the viewport
 * and every frame comes out the wrong width.
 */
export function sheetHtml(tiles: Tile[], look: Look, size: { width: number; height: number }): string {
  const body = tiles
    .map(
      (tile) =>
        `<div class="tile${tile.holdLastFrame ? " hold-last-frame" : ""}" style="--t:${tile.t.toFixed(3)};--secs:${tile.scene.seconds}">` +
        `<div class="bar"></div>` +
        `<div class="stage">${sceneHtml(tile.scene)}</div>` +
        `</div>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${css(look, size)}
</style></head><body><div class="strip">${body}</div></body></html>`;
}

function css(look: Look, size: { width: number; height: number }): string {
  const pad = Math.round(size.width * 0.09);
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;width:max-content}
.strip{display:flex;flex-wrap:nowrap;align-items:flex-start}
.tile{
  flex:0 0 auto;position:relative;overflow:hidden;
  width:${size.width}px;height:${size.height}px;
  background:linear-gradient(158deg, ${look.bg} 0%, ${look.bg2} 100%);
  color:${look.ink};font-family:${family(look.font)};
  -webkit-font-smoothing:antialiased;
}
/* THE PROGRESS BAR RUNS THE WHOLE VIDEO'S SCENE, not the video: a viewer who
   can see where a scene ends watches to the end of it. Its width is pure
   arithmetic on --t, so it needs no animation at all. */
.bar{position:absolute;top:0;left:0;height:${Math.round(size.height * 0.005)}px;background:${look.accent};
  width:calc(var(--t) / var(--secs) * 100%);opacity:.85}
.stage{
  position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;
  padding:${pad}px ${pad}px ${Math.round(pad * 1.6)}px;
  /* The exit. The last 0.35s of every scene fades and lifts, so the next one
     lands on quiet rather than on a hard swap. */
  animation:exit .35s linear both;animation-play-state:paused;
  animation-delay:calc(-1s * var(--t) + (var(--secs) - .35) * 1s);
}
/* Keep the card readable when its final frame waits for speech to finish. */
.hold-last-frame .stage{animation:none}
@keyframes exit{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-18px)}}
.an{animation-name:var(--anim,rise);animation-duration:var(--dur,.65s);
  animation-timing-function:cubic-bezier(.22,1,.36,1);animation-fill-mode:both;
  animation-iteration-count:1;animation-play-state:paused;
  animation-delay:calc(-1s * var(--t) + var(--d,0s))}
@keyframes rise{from{opacity:0;transform:translateY(52px)}to{opacity:1;transform:translateY(0)}}
@keyframes fromleft{from{opacity:0;transform:translateX(-90px)}to{opacity:1;transform:translateX(0)}}
@keyframes fromright{from{opacity:0;transform:translateX(90px)}to{opacity:1;transform:translateX(0)}}
@keyframes pop{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
@keyframes wipe{from{transform:scaleX(0)}to{transform:scaleX(1)}}

.kicker{color:${look.accent};font-size:${Math.round(size.width * 0.031)}px;font-weight:600;
  letter-spacing:.22em;text-transform:uppercase;margin-bottom:${Math.round(pad * 0.32)}px}
.h1{font-size:${Math.round(size.width * 0.105)}px;font-weight:700;line-height:1.08;letter-spacing:-.02em}
.h2{font-size:${Math.round(size.width * 0.068)}px;font-weight:700;line-height:1.14;margin-bottom:${Math.round(pad * 0.5)}px}
.sub{font-size:${Math.round(size.width * 0.042)}px;font-weight:400;line-height:1.3;color:${look.soft};
  margin-top:${Math.round(pad * 0.35)}px}
.rule{height:${Math.round(size.height * 0.004)}px;background:${look.accent};transform-origin:left center;
  width:${Math.round(size.width * 0.28)}px;margin-top:${Math.round(pad * 0.4)}px}

.big{font-size:${Math.round(size.width * 0.2)}px;font-weight:700;line-height:1;letter-spacing:-.04em;
  color:${look.accent};font-variant-numeric:tabular-nums}
.unit{font-size:${Math.round(size.width * 0.085)}px;font-weight:700;letter-spacing:-.02em}
.label{font-size:${Math.round(size.width * 0.052)}px;font-weight:600;margin-top:${Math.round(pad * 0.4)}px}
.note{font-size:${Math.round(size.width * 0.034)}px;color:${look.soft};margin-top:${Math.round(pad * 0.22)}px}

.row{display:flex;align-items:baseline;gap:${Math.round(pad * 0.3)}px;
  padding:${Math.round(pad * 0.28)}px 0;border-top:2px solid ${look.line}}
.row:first-of-type{border-top:0}
.num{color:${look.accent};font-weight:700;font-size:${Math.round(size.width * 0.042)}px;
  min-width:${Math.round(size.width * 0.06)}px;font-variant-numeric:tabular-nums}
.item{font-size:${Math.round(size.width * 0.045)}px;font-weight:500;line-height:1.25}

.panel{background:${look.panel};border:2px solid ${look.line};border-radius:${Math.round(pad * 0.34)}px;
  padding:${Math.round(pad * 0.42)}px ${Math.round(pad * 0.46)}px;margin-top:${Math.round(pad * 0.3)}px}
.panel.hot{border-color:${look.accent}}
.side{font-size:${Math.round(size.width * 0.036)}px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:${look.soft}}
.panel.hot .side{color:${look.accent}}
.sideval{font-size:${Math.round(size.width * 0.075)}px;font-weight:700;line-height:1.05;
  margin-top:${Math.round(pad * 0.16)}px}
.point{font-size:${Math.round(size.width * 0.034)}px;color:${look.soft};margin-top:${Math.round(pad * 0.14)}px}

.pill{display:inline-block;background:${look.accent};color:${look.bg};font-weight:700;
  font-size:${Math.round(size.width * 0.042)}px;padding:${Math.round(pad * 0.26)}px ${Math.round(pad * 0.5)}px;
  border-radius:999px;margin-top:${Math.round(pad * 0.5)}px}
.url{font-size:${Math.round(size.width * 0.03)}px;color:${look.soft};margin-top:${Math.round(pad * 0.3)}px;
  word-break:break-all}
`;
}

/** `style` for one animated element: which keyframes, how long, and when it
 *  starts relative to the scene. */
const an = (delay: number, anim = "rise", dur = 0.65) =>
  `--d:${delay.toFixed(2)}s;--anim:${anim};--dur:${dur}s`;

const kickerHtml = (s: Scene) =>
  s.kicker ? `<div class="kicker an" style="${an(0)}">${esc(s.kicker)}</div>` : "";

/**
 * ONE SCENE'S CONTENT.
 *
 * The stagger is the whole design: an element every 90–140 ms, in the order a
 * person would read them. A scene whose parts all appear at once is a slide,
 * and slides get swiped past.
 */
export function sceneHtml(s: Scene): string {
  switch (s.kind) {
    case "title":
      return (
        kickerHtml(s) +
        `<div class="h1 an" style="${an(0.12)}">${esc(s.title)}</div>` +
        `<div class="rule an" style="${an(0.34, "wipe", 0.5)}"></div>` +
        (s.subtitle ? `<div class="sub an" style="${an(0.46)}">${esc(s.subtitle)}</div>` : "")
      );

    case "stat":
      return (
        kickerHtml(s) +
        `<div class="an" style="${an(0.1, "pop", 0.55)}"><span class="big">${esc(s.value)}</span>` +
        (s.unit ? `<span class="big unit">${esc(s.unit)}</span>` : "") +
        `</div>` +
        `<div class="label an" style="${an(0.34)}">${esc(s.label)}</div>` +
        (s.note ? `<div class="note an" style="${an(0.48)}">${esc(s.note)}</div>` : "")
      );

    case "compare":
      return (
        kickerHtml(s) +
        (s.heading ? `<div class="h2 an" style="${an(0.1)}">${esc(s.heading)}</div>` : "") +
        side(s.left, false, 0.24) +
        side(s.right, true, 0.4)
      );

    case "list":
      return (
        kickerHtml(s) +
        `<div class="h2 an" style="${an(0.1)}">${esc(s.heading)}</div>` +
        s.items
          .map(
            (item, i) =>
              `<div class="row an" style="${an(0.24 + i * 0.14, "fromleft")}">` +
              `<span class="num">${String(i + 1).padStart(2, "0")}</span>` +
              `<span class="item">${esc(item)}</span></div>`,
          )
          .join("")
      );

    default:
      return (
        kickerHtml(s) +
        `<div class="h1 an" style="${an(0.1)}">${esc(s.headline)}</div>` +
        `<div><span class="pill an" style="${an(0.36, "pop", 0.5)}">${esc(s.action)}</span></div>` +
        (s.url ? `<div class="url an" style="${an(0.52)}">${esc(s.url)}</div>` : "")
      );
  }
}

function side(v: { label: string; value: string; points: string[] }, hot: boolean, delay: number): string {
  return (
    `<div class="panel${hot ? " hot" : ""} an" style="${an(delay, hot ? "fromright" : "fromleft")}">` +
    `<div class="side">${esc(v.label)}</div>` +
    `<div class="sideval">${esc(v.value)}</div>` +
    v.points.map((p) => `<div class="point">${esc(p)}</div>`).join("") +
    `</div>`
  );
}
