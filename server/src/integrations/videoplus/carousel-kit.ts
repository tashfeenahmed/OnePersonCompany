/**
 * WHAT THE CAROUSEL CODER CAN REACH FOR WITHOUT THE NETWORK — icons, fonts,
 * emoji — and the step that turns what it wrote into what Chrome draws.
 *
 * ICONS ARE VENDORED, NOT FETCHED. Lucide (ISC) and Tabler's outline set
 * (MIT) live in ./icons as one JSON file each, rebuilt by
 * scripts/vendor-icons.mjs, licence text included. The coder writes
 * `<i data-lucide="rocket"></i>` or `<i data-tabler="rocket"></i>` and
 * `prepareHtml` swaps each for the real inline SVG before the render — so the
 * Pi's headless Chrome needs no CDN, the icon is in the PNG exactly as named,
 * and there is no script to wait for. An icon whose name is not in the set
 * FAILS SOFT: it renders as nothing and the name is reported, so the next
 * attempt can be told, instead of the whole slide failing over a guess.
 *
 * FONTS ARE GOOGLE FONTS, CURATED. Fourteen families — display, sans, serif,
 * mono — in one stylesheet link that `prepareHtml` adds itself, so the coder
 * only writes `font-family`. Chrome downloads only the faces a page uses, and
 * the render's network rules allow exactly the two Google Fonts hosts. They
 * are not vendored: fourteen variable families are several megabytes of
 * binaries in a repository, and the Pi's Chrome reaches Google Fonts (checked
 * 2026-09-22; the first Pi carousels rendered in them). The venture's own
 * site font gets its own link, because one family Google does not serve
 * would fail a combined request for all fifteen.
 *
 * EMOJI come from the system: Noto Color Emoji is installed on the Pi
 * (`fc-list`, 2026-09-22) and Apple Color Emoji on a Mac.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

type IconSet = { _license: string; _version: string; icons: Record<string, string> };

let sets: { lucide: IconSet; tabler: IconSet } | null = null;
function iconSets() {
  if (!sets) {
    const read = (name: string) => JSON.parse(readFileSync(resolve(here, "icons", `${name}.json`), "utf8")) as IconSet;
    sets = { lucide: read("lucide"), tabler: read("tabler") };
  }
  return sets;
}

export type IconLibrary = "lucide" | "tabler";

export function hasIcon(lib: IconLibrary, name: string): boolean {
  return Object.hasOwn(iconSets()[lib].icons, name);
}

/** Names the prompt offers as examples, kept only if the set really has them
 *  — a sample list with a name that does not exist teaches the model to guess. */
const LUCIDE_SAMPLE = [
  "rocket", "zap", "key-round", "shield-check", "check", "x", "circle-check", "circle-x", "arrow-right", "arrow-up-right",
  "sparkles", "star", "heart", "message-circle", "message-square-text", "bell", "search", "settings", "code", "terminal",
  "server", "database", "cloud", "cpu", "globe", "lock", "unlock", "users", "user", "clock", "calendar", "chart-line",
  "chart-bar", "trending-up", "trending-down", "dollar-sign", "wallet", "gift", "layers", "puzzle", "plug", "link",
  "refresh-cw", "repeat", "shuffle", "git-branch", "github", "download", "upload", "smartphone", "laptop", "book-open",
  "lightbulb", "target", "flag", "trophy", "thumbs-up", "hand", "eye", "wand-sparkles", "bot", "brain", "infinity",
];
const TABLER_SAMPLE = [
  "rocket", "bolt", "key", "shield-check", "check", "x", "circle-check", "arrow-right", "sparkles", "star", "heart",
  "message-circle", "brand-github", "brand-openai", "api", "server", "database", "cloud", "cpu", "world", "lock", "users",
  "clock", "chart-line", "chart-bar", "trending-up", "coin", "gift", "stack-2", "puzzle", "plug", "link", "refresh",
  "arrows-shuffle", "git-branch", "download", "device-mobile", "device-laptop", "book", "bulb", "target", "flag", "trophy",
  "thumb-up", "eye", "wand", "robot", "brain", "infinity", "route", "switch-horizontal",
];

export function iconSamples(): { lucide: string[]; tabler: string[] } {
  return {
    lucide: LUCIDE_SAMPLE.filter((n) => hasIcon("lucide", n)),
    tabler: TABLER_SAMPLE.filter((n) => hasIcon("tabler", n)),
  };
}

/** Attributes carried from the placeholder onto the SVG. */
const KEEP_ATTRS = /\s(class|style|id|width|height|stroke-width|aria-label|role)\s*=\s*("[^"]*"|'[^']*')/gi;

/**
 * Every `<i data-lucide="…">` / `<i data-tabler="…">` (or a `<span>`) becomes
 * inline SVG sized `1em` and coloured `currentColor`, so `font-size` and
 * `color` on it — or on its parent — size and colour it. Returns the names
 * that were not found.
 */
export function inlineIcons(html: string): { html: string; missing: string[] } {
  const missing: string[] = [];
  const out = html.replace(
    /<(i|span)\b([^>]*?)\bdata-(lucide|tabler)\s*=\s*["']([^"']+)["']([^>]*?)\/?>(?:\s*<\/\1>)?/gi,
    (_m, _tag: string, before: string, lib: string, rawName: string, after: string) => {
      const set = iconSets()[lib.toLowerCase() as IconLibrary];
      const name = rawName.trim().toLowerCase();
      const body = Object.hasOwn(set.icons, name) ? set.icons[name]! : null;
      if (!body) {
        if (!missing.includes(`${lib}:${name}`)) missing.push(`${lib}:${name}`);
        return "";
      }
      const attrs = [...`${before} ${after}`.matchAll(KEEP_ATTRS)].map((a) => ` ${a[1]!.toLowerCase()}=${a[2]}`);
      const has = (k: string) => attrs.some((a) => a.startsWith(` ${k}=`));
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
        `${has("stroke-width") ? "" : ` stroke-width="2"`} stroke-linecap="round" stroke-linejoin="round"` +
        `${has("width") ? "" : ` width="1em"`}${has("height") ? "" : ` height="1em"`}${attrs.join("")}` +
        ` data-icon="${lib.toLowerCase()}:${name}">${body}</svg>`
      );
    },
  );
  return { html: out, missing };
}

/* ------------------------------------------------------------------ fonts */

export const FONTS: { family: string; kind: "sans" | "display" | "serif" | "mono"; axis: string }[] = [
  { family: "Inter", kind: "sans", axis: "wght@400..900" },
  { family: "Manrope", kind: "sans", axis: "wght@400..800" },
  { family: "Sora", kind: "sans", axis: "wght@400..800" },
  { family: "Space Grotesk", kind: "sans", axis: "wght@400..700" },
  { family: "Bricolage Grotesque", kind: "display", axis: "wght@400..800" },
  { family: "DM Sans", kind: "sans", axis: "wght@400..900" },
  { family: "Plus Jakarta Sans", kind: "sans", axis: "wght@400..800" },
  { family: "Archivo Black", kind: "display", axis: "" },
  { family: "DM Serif Display", kind: "serif", axis: "ital@0;1" },
  { family: "Playfair Display", kind: "serif", axis: "wght@400..900" },
  { family: "Fraunces", kind: "serif", axis: "wght@400..900" },
  { family: "Instrument Serif", kind: "serif", axis: "ital@0;1" },
  { family: "JetBrains Mono", kind: "mono", axis: "wght@400..800" },
  { family: "Space Mono", kind: "mono", axis: "wght@400;700" },
];

const familyParam = (family: string, axis: string) =>
  `family=${family.trim().replace(/\s+/g, "+")}${axis ? `:${axis}` : ""}`;

export const FONTS_HREF =
  `https://fonts.googleapis.com/css2?${FONTS.map((f) => familyParam(f.family, f.axis)).join("&")}&display=block`;

/** A separate stylesheet for the venture's own font, when it is a plain family
 *  name that is not already in the list. Null otherwise. */
export function brandFontHref(font: string | null | undefined): string | null {
  const name = (font ?? "").replace(/["']/g, "").trim();
  if (!name || !/^[A-Za-z0-9 ]{2,40}$/.test(name)) return null;
  if (FONTS.some((f) => f.family.toLowerCase() === name.toLowerCase())) return null;
  if (/^(system-ui|sans-serif|serif|monospace|arial|helvetica|times new roman|georgia|verdana|-apple-system)$/i.test(name)) return null;
  return `https://fonts.googleapis.com/css2?${familyParam(name, "")}&display=block`;
}

/**
 * What the coder wrote, made ready to draw: icons inlined, the font
 * stylesheets linked in `<head>`, scripts already gone (`pickHtml`).
 */
export function prepareHtml(doc: string, brandFont: string | null): { html: string; missingIcons: string[] } {
  const icons = inlineIcons(doc);
  const links = [FONTS_HREF, brandFontHref(brandFont)]
    .filter((h): h is string => !!h)
    .map((h) => `<link rel="stylesheet" href="${h.replace(/&/g, "&amp;")}">`)
    .join("");
  const html = /<head[^>]*>/i.test(icons.html)
    ? icons.html.replace(/<head[^>]*>/i, (m) => `${m}${links}`)
    : icons.html.replace(/<html[^>]*>/i, (m) => `${m}<head>${links}</head>`);
  return { html, missingIcons: icons.missing };
}
