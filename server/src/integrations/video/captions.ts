/**
 * BURNING WORDS ONTO A FRAME, ON A BOX THAT MAY NOT BE ABLE TO.
 *
 * A faceless video without captions is a slideshow: most of the people it is
 * made for are watching with the sound off, and the caption is the content.
 * So this is not a nicety, and it is also not something ffmpeg can always do.
 *
 * THREE RENDERERS, PICKED BY WHAT IS ON THE MACHINE, in this order:
 *
 *   typst     The typesetter this box already uses for papers, asked for a
 *             1080x1920 page with a transparent background and the caption set
 *             on it. It comes back as an RGBA PNG that ffmpeg overlays in one
 *             filter. It wraps text properly, it takes a font by NAME rather
 *             than by path, and it costs one fork per caption — about forty
 *             milliseconds. This is the preferred path.
 *   drawtext  ffmpeg's own text filter, where the build has it. It does not
 *             wrap, so the wrapping is done here and the lines are joined with
 *             escaped newlines, and every one of `:`, `'`, `\` and `%` has to
 *             be escaped into the filter string. It needs a font FILE, which
 *             is probed for.
 *   none      Neither. The video is made without captions and the run's report
 *             says so in one sentence naming what was missing. It is not
 *             pretended that there were no captions to draw.
 *
 * THE ORDER IS NOT "BEST FIRST" BY ACCIDENT. This box's own ffmpeg — Homebrew's
 * 9.0.1, configured without libfreetype and without libass — has NO drawtext,
 * no subtitles and no ass filter. That is the ordinary case on macOS and it is
 * why the probe exists at all: the obvious implementation, drawtext, is the one
 * that does not work here.
 *
 * THE COLOUR IS THE VENTURE'S AND THE SCRIM IS NOT NEGOTIABLE. Brand colour on
 * the accent rule, white text on a dark translucent block behind it. White on
 * bare footage is unreadable over a bright frame, which is most stock footage;
 * a scrim costs a little of the picture and buys the words being legible over
 * all of it.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configValue } from "../../db.ts";
import { VIDEO_PLUGIN, findFfmpeg, ffmpegFilters, run } from "./tools.ts";
/* ONE typesetter, named once. It is the papers area's binary and this borrows
   it; discovering it again here under a second settings key is what used to
   leave every video captionless on a box that had typst installed. */
import { findTypst } from "../runs/typst.ts";

/* ------------------------------------------------------------------ fonts */

/**
 * Font files a drawtext build can be pointed at.
 *
 * PROBED RATHER THAN CONSTANT, and the list spans both systems, because a
 * hard-coded /System/Library path is a feature that works on this laptop and
 * breaks on the Linux box somebody installs this on next. A bold face is
 * preferred at every position: white text over moving footage needs the
 * weight.
 */
const FONT_FILES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/HelveticaNeue.ttc",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
];

/**
 * Font NAMES typst can be asked for, in preference order.
 *
 * Typst resolves a family name against the system's own fonts and falls
 * through a list, so this is handed over whole rather than probed one at a
 * time — the fallback is the typesetter's job and it does it better than a
 * loop over `typst fonts` would. The venture's OWN measured font goes in
 * front of this list when the site had one, which is the whole reason a
 * caption looks like it came from that business.
 */
const FONT_NAMES = ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans", "Liberation Sans", "Noto Sans"];

/* ------------------------------------------------------------ the interface */

export type CaptionStyle = {
  width: number;
  height: number;
  /** The venture's colour, `#rrggbb`. The accent rule and nothing else — the
   *  text stays white, because a brand colour dark enough to be a brand is not
   *  readable over footage. */
  color: string;
  /** The venture's own measured font family, or null. Tried first. */
  font: string | null;
};

export type Captioner = {
  id: "typst" | "drawtext" | "none";
  /** One sentence for the run's report and for the row. Says which machine
   *  drew the words, or why nothing did. */
  note: string;
  /** A transparent frame-sized PNG with the caption on it, ready to overlay at
   *  0:0. Null for every renderer that is not `typst`. */
  strip(text: string, style: CaptionStyle, out: string, signal?: AbortSignal): Promise<string | null>;
  /** An ffmpeg filter fragment that draws the caption onto whatever precedes
   *  it. Null for every renderer that is not `drawtext`. */
  expr(text: string, style: CaptionStyle): string | null;
  /** A full opaque end-card frame — the venture's name and its address on its
   *  own colour. Null where this renderer cannot draw one. */
  endCard(lines: string[], style: CaptionStyle, out: string, signal?: AbortSignal): Promise<string | null>;
};

/* ------------------------------------------------------------- the picking */

/**
 * Which renderer this machine can actually use.
 *
 * Called once per run and the answer goes on the row, so a video made in June
 * on a box with no typesetter still says that is why it has no words on it.
 */
export async function pickCaptioner(): Promise<Captioner> {
  const configured = (configValue(VIDEO_PLUGIN, "captions") ?? "").trim().toLowerCase();
  const typst = findTypst();
  const ffmpeg = findFfmpeg();
  const filters = ffmpeg.path ? await ffmpegFilters(ffmpeg.path) : new Set<string>();
  const fontFile = FONT_FILES.find((f) => existsSync(f)) ?? null;
  const hasDrawtext = filters.has("drawtext") && !!fontFile;

  /* The setting is an OVERRIDE and it can only ever narrow. Asking for
     drawtext on a build that has none gets `none` with a sentence, not a
     silent promotion to typst — the owner asked for a specific machine and
     is entitled to be told it is not there. */
  if (configured === "off") return noneCaptioner("captions are switched off under the Video settings");
  if (configured === "drawtext" && !hasDrawtext)
    return noneCaptioner(
      filters.has("drawtext")
        ? "drawtext was asked for and this ffmpeg has it, but no font file was found on this machine to give it"
        : "drawtext was asked for and this ffmpeg was built without it",
    );
  if (configured === "typst" && !typst.path)
    return noneCaptioner("typst was asked for and none was found — " + (typst.error ?? "no path"));

  if (configured !== "drawtext" && typst.path) return typstCaptioner(typst.path);
  if (hasDrawtext) return drawtextCaptioner(fontFile!);
  return noneCaptioner(
    typst.error
      ? `${typst.error} And this ffmpeg was built without drawtext, so there is no other way to put words on a frame.`
      : "no typesetter, and this ffmpeg was built without drawtext",
  );
}

function noneCaptioner(why: string): Captioner {
  return {
    id: "none",
    note: `No captions were burned in: ${why}. The script is on the run page and the video is silent about it.`,
    strip: async () => null,
    expr: () => null,
    endCard: async () => null,
  };
}

/* --------------------------------------------------------------- typst --- */

/** Typst strings take a backslash and a double quote. Nothing else in a
 *  caption can reach the compiler, because everything else goes inside a
 *  string literal. */
const typstString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * A caption as CONTENT rather than as a printed string literal.
 *
 * `[#("…")]` AND NOT `["…"]`, and the difference is the whole reason this
 * helper exists. A bare string literal inside a content block is typeset as a
 * string — with its quotation marks visible, curled by the smart-quote pass —
 * which is exactly what the first video made here came out with. Interpolating
 * it inserts the characters and nothing else: no quotes drawn, no markup
 * interpreted, so a caption containing `*`, `#`, `_` or `@` is words rather
 * than formatting.
 */
const typstText = (s: string) => `#(${typstString(s)})`;

/** A hex colour typst will accept, or the fallback. A colour that came off a
 *  venture record is trusted no further than this regex. */
const hex = (c: string, fallback = "#ffffff") => (/^#[0-9a-fA-F]{6}$/.test(c.trim()) ? c.trim() : fallback);

function fontList(style: CaptionStyle): string {
  const names = style.font ? [style.font, ...FONT_NAMES] : FONT_NAMES;
  return `(${names.map(typstString).join(", ")})`;
}

function typstCaptioner(bin: string): Captioner {
  /**
   * One caption, as a transparent page the size of the frame.
   *
   * `fill: none` IS THE WHOLE TRICK and it is why this works at all: typst
   * writes an RGBA PNG with a genuinely transparent page, so ffmpeg's overlay
   * composites the words and the scrim and nothing else. A white page would
   * have to be keyed out, and keying white out of a caption removes the
   * caption.
   *
   * The caption sits in the lower third rather than centred, because the
   * middle of a portrait frame is where the subject of the footage is and the
   * bottom is where every platform's own chrome is not.
   */
  const write = async (typ: string, out: string, signal?: AbortSignal): Promise<string | null> => {
    const src = out.replace(/\.png$/, ".typ");
    writeFileSync(src, typ, "utf8");
    const r = await run(bin, ["compile", "--format", "png", "--ppi", "72", src, out], {
      timeoutMs: 30_000,
      signal,
    });
    return r.ok && existsSync(out) ? out : null;
  };

  return {
    id: "typst",
    note: "Captions were set by typst and composited onto the frames — the venture's own font where its site had one, white on a dark scrim with the brand colour as the rule above it.",

    async strip(text, style, out, signal) {
      const size = Math.round(style.width * 0.058);
      const typ = [
        `#set page(width: ${style.width}pt, height: ${style.height}pt, margin: 0pt, fill: none)`,
        `#set text(font: ${fontList(style)}, size: ${size}pt, weight: "bold", fill: white)`,
        `#set par(justify: false, leading: 0.42em)`,
        /* The scrim, the rule and the words as one block placed in the lower
           third. `place` with a bottom anchor keeps a two-line caption and a
           four-line one both sitting off the same edge, rather than growing
           downward off the frame. */
        `#place(bottom + center, dy: -${Math.round(style.height * 0.13)}pt)[`,
        `  #block(width: ${Math.round(style.width * 0.88)}pt, fill: rgb(0, 0, 0, 150), inset: (x: ${Math.round(style.width * 0.045)}pt, y: ${Math.round(style.width * 0.038)}pt), radius: ${Math.round(style.width * 0.022)}pt)[`,
        `    #align(center)[#box(width: ${Math.round(style.width * 0.16)}pt, height: ${Math.round(style.width * 0.008)}pt, fill: rgb(${typstString(hex(style.color))}))]`,
        `    #v(${Math.round(style.width * 0.018)}pt)`,
        `    #align(center)[${typstText(text)}]`,
        `  ]`,
        `]`,
      ].join("\n");
      return write(typ, out, signal);
    },

    expr: () => null,

    /**
     * The end card: the venture's own colour, its name, and the address a
     * viewer would type. OPAQUE, because it is a frame rather than an overlay
     * — this is the one still in the video that is not footage.
     */
    async endCard(lines, style, out, signal) {
      const [name, site, ...rest] = lines;
      const typ = [
        `#set page(width: ${style.width}pt, height: ${style.height}pt, margin: 0pt, fill: rgb(${typstString(hex(style.color, "#111111"))}))`,
        `#set text(font: ${fontList(style)}, fill: white)`,
        `#align(center + horizon)[`,
        `  #text(size: ${Math.round(style.width * 0.085)}pt, weight: "bold")[${typstText(name ?? "")}]`,
        site ? `  #v(${Math.round(style.width * 0.03)}pt)` : "",
        site ? `  #text(size: ${Math.round(style.width * 0.042)}pt)[${typstText(site)}]` : "",
        ...rest.flatMap((l) => [
          `  #v(${Math.round(style.width * 0.02)}pt)`,
          `  #text(size: ${Math.round(style.width * 0.032)}pt)[${typstText(l)}]`,
        ]),
        `]`,
      ]
        .filter(Boolean)
        .join("\n");
      return write(typ, out, signal);
    },
  };
}

/* ------------------------------------------------------------ drawtext --- */

/**
 * ESCAPING FOR A FILTER STRING, and it is two layers deep.
 *
 * ffmpeg parses the filtergraph, then drawtext parses its own option values.
 * A `:` ends an option, a `'` ends a quoted value, a `%` starts an expansion
 * and a `\` escapes. Every one of them has to survive both parsers, which is
 * why each is doubled here rather than escaped once. A caption is written by a
 * model and will one day contain a colon; without this that caption is a
 * filtergraph syntax error at the end of a three-minute render.
 */
const drawtextEscape = (s: string) =>
  s
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\\\\\\'")
    .replace(/:/g, "\\\\:")
    .replace(/%/g, "\\\\%")
    .replace(/[[\]]/g, "");

/**
 * WRAPPING, BECAUSE DRAWTEXT DOES NOT.
 *
 * By character count rather than by measured pixels, which is an
 * approximation and is stated as one: this file cannot measure a glyph
 * without a font library, and the alternative — one very long line running off
 * both sides of the frame — is not a better approximation. The count is
 * derived from the frame width and the point size so it is right for a
 * different aspect rather than tuned for one.
 */
export function wrap(text: string, perLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= perLine) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function drawtextCaptioner(fontFile: string): Captioner {
  return {
    id: "drawtext",
    note: `Captions were burned in by ffmpeg's drawtext filter using ${fontFile}, white with a black outline. Lines were wrapped by character count rather than by measured width — this server has no way to measure a glyph — so a very wide caption can sit closer to the edges than a typeset one would.`,

    strip: async () => null,

    expr(text, style) {
      const size = Math.round(style.width * 0.055);
      const lines = wrap(text, Math.max(14, Math.floor((style.width / size) * 1.75)));
      if (!lines.length) return null;
      const body = drawtextEscape(lines.join("\n"));
      const y = Math.round(style.height * 0.72);
      return [
        `drawtext=fontfile='${fontFile}'`,
        `text='${body}'`,
        `fontcolor=white`,
        `fontsize=${size}`,
        `borderw=${Math.max(2, Math.round(size * 0.06))}`,
        `bordercolor=black`,
        `box=1`,
        `boxcolor=black@0.45`,
        `boxborderw=${Math.round(size * 0.4)}`,
        `line_spacing=${Math.round(size * 0.22)}`,
        `x=(w-text_w)/2`,
        `y=${y}`,
      ].join(":");
    },

    /** Drawn as a filter over a colour source rather than as a file, because
     *  drawtext has no way to write a PNG. The caller feeds this to an
     *  `lavfi` colour input; the return value is the PATH it wrote, so a null
     *  here means the end card was skipped. See faceless.ts. */
    async endCard(lines, style, out, signal) {
      void style;
      const ffmpeg = findFfmpeg();
      if (!ffmpeg.path) return null;
      const [name, site] = lines;
      const big = Math.round(style.width * 0.085);
      const small = Math.round(style.width * 0.042);
      const draws = [
        `drawtext=fontfile='${fontFile}':text='${drawtextEscape(name ?? "")}':fontcolor=white:fontsize=${big}:x=(w-text_w)/2:y=(h-text_h)/2-${big}`,
        site
          ? `drawtext=fontfile='${fontFile}':text='${drawtextEscape(site)}':fontcolor=white@0.85:fontsize=${small}:x=(w-text_w)/2:y=(h-text_h)/2+${big}`
          : null,
      ].filter(Boolean) as string[];
      const r = await run(
        ffmpeg.path,
        [
          "-y",
          "-v", "error",
          "-f", "lavfi",
          "-i", `color=c=${hex(style.color, "#111111").replace("#", "0x")}:s=${style.width}x${style.height}`,
          "-vf", draws.join(","),
          "-frames:v", "1",
          out,
        ],
        { timeoutMs: 30_000, signal },
      );
      return r.ok && existsSync(out) ? out : null;
    },
  };
}

/** Where a caption PNG for one beat goes. Named by index so a directory left
 *  behind after a failure can be read in order. */
export const stripPath = (dir: string, i: number) => resolve(dir, `caption-${String(i).padStart(2, "0")}.png`);
