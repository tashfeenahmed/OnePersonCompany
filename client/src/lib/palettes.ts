/**
 * PALETTES — the second theming axis, independent of light and dark.
 *
 * MODE AND PALETTE NEVER COLLAPSE INTO ONE CHOICE. Light/dark is a fact about
 * the room somebody is sitting in and follows the OS unless it is pinned; a
 * palette is a fact about what they want the thing to look like. So every
 * palette below ships a COMPLETE light block and a COMPLETE dark block, and
 * picking one never overrides the mode: a person on Coral who moves to a dark
 * office at six still gets dark Coral. This is the arrangement seven palettes
 * of an earlier system arrived at, carried here with generic names, because a
 * dashboard skinned after somebody else's company is a dashboard that says
 * something about them rather than about the owner.
 *
 * WHY THE TOKENS LIVE IN TYPESCRIPT AND NOT IN index.css. Two reasons, and the
 * second is the one that decided it:
 *
 *   1. A swatch on the settings page has to draw the palette it is offering,
 *      and it cannot read colours out of a stylesheet block that is not
 *      applied. Data can be drawn; a CSS rule can only be switched on.
 *   2. THE CONTRAST TEST HAS TO TEST WHAT SHIPS. `palettes.test.ts` computes
 *      the WCAG ratio of every text-on-surface pair in every palette in both
 *      modes and fails the build under 4.5:1. A test that read a second copy
 *      of these values — or that could not read them at all — would be a test
 *      of the copy. There is exactly one set of numbers and both the browser
 *      and the test use it.
 *
 * They are applied as custom properties on <html> by lib/theme.tsx, layered
 * over the `:root` / `.dark` blocks in index.css that spell the default. The
 * DEFAULT PALETTE SETS NOTHING AT ALL — `paper` has no token map, so choosing
 * it removes every property and the app is byte-for-byte the stylesheet's own
 * look. That is what makes "default" a real default rather than a re-statement
 * of it that can drift.
 *
 * WHAT A PALETTE MAY OWN: the surfaces, the ink on them, the hairlines, the
 * primary fill, the status colours and the chart ink. WHAT IT MAY NOT: the
 * type scale, the radius and the fonts. Those are the design, not a skin, and
 * a palette that moved them would make eight products out of one.
 */

/** The token names a palette writes. Every one of them exists in index.css. */
export type TokenName =
  | "background" | "foreground"
  | "card" | "card-foreground"
  | "popover" | "popover-foreground"
  | "primary" | "primary-foreground"
  | "secondary" | "secondary-foreground"
  | "muted" | "muted-foreground"
  | "accent" | "accent-foreground"
  | "destructive"
  | "border" | "input" | "ring"
  | "faint" | "line-soft" | "line-strong"
  | "ok" | "ok-bg" | "warn"
  | "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5"
  | "sidebar" | "sidebar-foreground"
  | "sidebar-primary" | "sidebar-primary-foreground"
  | "sidebar-accent" | "sidebar-accent-foreground"
  | "sidebar-border" | "sidebar-ring";

export type Tokens = Record<TokenName, string>;

/**
 * A PALETTE IS SEVENTEEN COLOURS, NOT THIRTY-SEVEN.
 *
 * The token list above is what the components ask for; this is what a person
 * can hold in their head while choosing. Everything else is derived by
 * `tokens()` below in one place, so the relationships that make the design
 * coherent — a popover is a card, an accent is a muted surface, a chart's ink
 * is the primary — cannot be got wrong differently in eight palettes.
 */
type Seed = {
  /** The page. */
  bg: string;
  /** A raised surface: cards, popovers. */
  card: string;
  /** The rail. */
  sidebar: string;
  /** The recessed one: muted fills, hover, secondary buttons. */
  surface: string;
  /** Body text. */
  ink: string;
  /** Secondary text — labels, captions. Must clear AA on every surface. */
  mutedInk: string;
  /** The smallest meta text. Also must clear AA: it is text. */
  faint: string;
  /** Hairlines, inputs. */
  line: string;
  /** The quietest divider. */
  lineSoft: string;
  /** The loudest divider, and the shimmer highlight in light mode. */
  lineStrong: string;
  /** The primary fill: buttons, the focus ring. */
  brand: string;
  /** Text ON the primary fill. */
  brandInk: string;
  ok: string;
  okBg: string;
  warn: string;
  destructive: string;
  /** The primary chart series. */
  chart: string;
};

/**
 * Seeds → tokens. The only place a relationship between two tokens is written
 * down, which is why it is a function rather than eight hand-written maps.
 */
function tokens(s: Seed): Tokens {
  return {
    background: s.bg,
    foreground: s.ink,
    card: s.card,
    "card-foreground": s.ink,
    popover: s.card,
    "popover-foreground": s.ink,
    primary: s.brand,
    "primary-foreground": s.brandInk,
    secondary: s.surface,
    "secondary-foreground": s.ink,
    muted: s.surface,
    "muted-foreground": s.mutedInk,
    accent: s.surface,
    "accent-foreground": s.ink,
    destructive: s.destructive,
    border: s.line,
    input: s.line,
    ring: s.brand,
    faint: s.faint,
    "line-soft": s.lineSoft,
    "line-strong": s.lineStrong,
    ok: s.ok,
    "ok-bg": s.okBg,
    warn: s.warn,
    /* The five chart steps are a RAMP and not five hues: this app's charts draw
       one series as ink and the rest as progressively quieter greys, on the
       argument (stated in components/charts.tsx) that a brand hue climbing a
       load chart says "something is wrong" before anybody has read the axis.
       A palette moves where the ramp starts; it does not turn it into a set of
       categorical colours. */
    "chart-1": s.chart,
    "chart-2": s.mutedInk,
    "chart-3": s.faint,
    "chart-4": s.lineStrong,
    "chart-5": s.line,
    sidebar: s.sidebar,
    "sidebar-foreground": s.ink,
    "sidebar-primary": s.brand,
    "sidebar-primary-foreground": s.brandInk,
    "sidebar-accent": s.surface,
    "sidebar-accent-foreground": s.ink,
    "sidebar-border": s.line,
    "sidebar-ring": s.brand,
  };
}

export type PaletteId =
  | "paper" | "moss" | "azure" | "coral" | "linen" | "slate" | "violet" | "mono";

export type Palette = {
  id: PaletteId;
  label: string;
  /** One line, said the way the settings page will say it. */
  hint: string;
  /** null on `paper` alone: the default is the stylesheet, untouched. */
  light: Tokens | null;
  dark: Tokens | null;
};

/* --------------------------------------------------------------- the eight */

export const PALETTES: Palette[] = [
  {
    id: "paper",
    label: "Paper",
    hint: "The default: near-black ink on warm paper, colour reserved for state.",
    light: null,
    dark: null,
  },
  {
    id: "moss",
    label: "Moss",
    hint: "Deep green on a cool off-white; a forest floor in the dark.",
    light: tokens({
      bg: "#f8faf8", card: "#ffffff", sidebar: "#eff3ee", surface: "#e3eae2",
      ink: "#0f1610", mutedInk: "#3f4e3e", faint: "#5b6a58",
      line: "#d2dbcf", lineSoft: "#e3e9e1", lineStrong: "#a7b5a3",
      brand: "#1c6b41", brandInk: "#ffffff",
      ok: "#1f6b3f", okBg: "#dff0e5", warn: "#77490f", destructive: "#a93c29",
      chart: "#1c6b41",
    }),
    dark: tokens({
      bg: "#0c110d", card: "#161d17", sidebar: "#111711", surface: "#212a22",
      ink: "#eef4ee", mutedInk: "#a3b0a2", faint: "#8b988a",
      line: "#2c372d", lineSoft: "#212a22", lineStrong: "#4b584a",
      brand: "#5fd08a", brandInk: "#08160e",
      ok: "#78cc97", okBg: "#16281c", warn: "#dfa961", destructive: "#e0705a",
      chart: "#5fd08a",
    }),
  },
  {
    id: "azure",
    label: "Azure",
    hint: "A clear blue on cool white; a deep navy-grey after dark.",
    light: tokens({
      bg: "#f8fafc", card: "#ffffff", sidebar: "#eef2f8", surface: "#e3e9f2",
      ink: "#0e131c", mutedInk: "#3d4657", faint: "#5a6474",
      line: "#d1d8e4", lineSoft: "#e3e7ef", lineStrong: "#a5aec1",
      brand: "#1c58bb", brandInk: "#ffffff",
      ok: "#1b6a48", okBg: "#dcefe6", warn: "#75470f", destructive: "#ab3a2b",
      chart: "#1c58bb",
    }),
    dark: tokens({
      bg: "#0b0f16", card: "#151b25", sidebar: "#10151d", surface: "#1f2733",
      ink: "#eef2f8", mutedInk: "#a1aab9", faint: "#8891a0",
      line: "#2b3341", lineSoft: "#1f2733", lineStrong: "#4a5364",
      brand: "#7fb0ff", brandInk: "#0a1626",
      ok: "#78cca0", okBg: "#16281f", warn: "#e0a862", destructive: "#e0705a",
      chart: "#7fb0ff",
    }),
  },
  {
    id: "coral",
    label: "Coral",
    hint: "A warm red on a blush white; the same red brighter on near-black.",
    light: tokens({
      bg: "#fffbfa", card: "#ffffff", sidebar: "#f8f0ee", surface: "#f1e4e1",
      ink: "#1a1211", mutedInk: "#50403d", faint: "#6d5b57",
      line: "#e2d2ce", lineSoft: "#efe3e0", lineStrong: "#bba6a1",
      brand: "#b8304b", brandInk: "#ffffff",
      ok: "#1f6b3f", okBg: "#e2efe7", warn: "#7d4713", destructive: "#a83c28",
      chart: "#b8304b",
    }),
    dark: tokens({
      bg: "#150f0f", card: "#1f1818", sidebar: "#191212", surface: "#2b2222",
      ink: "#f7efee", mutedInk: "#b0a09e", faint: "#988885",
      line: "#382c2c", lineSoft: "#2b2222", lineStrong: "#574747",
      brand: "#ff7a90", brandInk: "#2a0b12",
      ok: "#78cc97", okBg: "#17291d", warn: "#e0a862", destructive: "#ef8a72",
      chart: "#ff7a90",
    }),
  },
  {
    id: "linen",
    label: "Linen",
    hint: "Warm greys and a quiet blue; the closest to the default, one shade warmer.",
    light: tokens({
      bg: "#fbfaf7", card: "#ffffff", sidebar: "#f4f2ec", surface: "#e9e6dd",
      ink: "#1a1814", mutedInk: "#4a453b", faint: "#68624f",
      line: "#dcd7ca", lineSoft: "#ece8de", lineStrong: "#b3ac9a",
      brand: "#295a95", brandInk: "#ffffff",
      ok: "#25643c", okBg: "#e4efe6", warn: "#7d4b16", destructive: "#a53d2d",
      chart: "#295a95",
    }),
    dark: tokens({
      bg: "#12110e", card: "#1c1a16", sidebar: "#171512", surface: "#27241d",
      ink: "#f2efe6", mutedInk: "#a8a294", faint: "#968f80",
      line: "#322e26", lineSoft: "#27241d", lineStrong: "#524c40",
      brand: "#86b2ea", brandInk: "#0d1a2b",
      ok: "#78cc97", okBg: "#17291d", warn: "#e0a862", destructive: "#e0705a",
      chart: "#86b2ea",
    }),
  },
  {
    id: "slate",
    label: "Slate",
    hint: "Neutral cool greys with a bright blue; the darkest of the dark modes.",
    light: tokens({
      bg: "#f7f8f9", card: "#ffffff", sidebar: "#edeff2", surface: "#e4e7ea",
      ink: "#0f1113", mutedInk: "#41474d", faint: "#5e666d",
      line: "#d4d8dd", lineSoft: "#e6e9ec", lineStrong: "#a7aeb6",
      brand: "#0a56be", brandInk: "#ffffff",
      ok: "#186842", okBg: "#e0efe8", warn: "#754711", destructive: "#a93a2b",
      chart: "#0a56be",
    }),
    dark: tokens({
      bg: "#0a0c0e", card: "#15181b", sidebar: "#0f1214", surface: "#1f2429",
      ink: "#eef1f4", mutedInk: "#a0a8b0", faint: "#88919a",
      line: "#2a3035", lineSoft: "#1f2429", lineStrong: "#49515a",
      brand: "#6fb1ff", brandInk: "#06182c",
      ok: "#78cc97", okBg: "#16281d", warn: "#e0a862", destructive: "#e0705a",
      chart: "#6fb1ff",
    }),
  },
  {
    id: "violet",
    label: "Violet",
    hint: "A deep purple on cool white; a plum-black at night.",
    light: tokens({
      bg: "#fbfaff", card: "#ffffff", sidebar: "#f2effa", surface: "#e8e3f4",
      ink: "#14101c", mutedInk: "#443d55", faint: "#615a72",
      line: "#d8d1e7", lineSoft: "#e8e3f2", lineStrong: "#ada3c1",
      brand: "#5334b5", brandInk: "#ffffff",
      ok: "#1f6b3f", okBg: "#e2efe7", warn: "#7c4913", destructive: "#a93c29",
      chart: "#5334b5",
    }),
    dark: tokens({
      bg: "#0e0b15", card: "#191424", sidebar: "#130f1d", surface: "#241d33",
      ink: "#f1eefa", mutedInk: "#a79fbb", faint: "#8f87a4",
      line: "#2f2742", lineSoft: "#241d33", lineStrong: "#4d4468",
      brand: "#b49cff", brandInk: "#1a1030",
      ok: "#78cc97", okBg: "#17291d", warn: "#e0a862", destructive: "#e0705a",
      chart: "#b49cff",
    }),
  },
  {
    id: "mono",
    label: "Mono",
    hint: "Black, white and the hairlines. Colour only where a state needs one.",
    light: tokens({
      bg: "#ffffff", card: "#ffffff", sidebar: "#f4f4f4", surface: "#ebebeb",
      ink: "#0b0b0b", mutedInk: "#454545", faint: "#616161",
      line: "#d4d4d4", lineSoft: "#e6e6e6", lineStrong: "#a3a3a3",
      brand: "#0b0b0b", brandInk: "#ffffff",
      ok: "#1f6b3f", okBg: "#ececec", warn: "#6b4a12", destructive: "#9c2f21",
      chart: "#0b0b0b",
    }),
    dark: tokens({
      bg: "#0a0a0a", card: "#171717", sidebar: "#101010", surface: "#242424",
      ink: "#f5f5f5", mutedInk: "#a6a6a6", faint: "#8f8f8f",
      line: "#303030", lineSoft: "#242424", lineStrong: "#555555",
      brand: "#f5f5f5", brandInk: "#0a0a0a",
      ok: "#8fd6a5", okBg: "#1c241e", warn: "#dfb277", destructive: "#ef8f7a",
      chart: "#f5f5f5",
    }),
  },
];

export const DEFAULT_PALETTE: PaletteId = "paper";

export const paletteIds = PALETTES.map((p) => p.id);

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === "string" && (paletteIds as string[]).includes(v);
}

export function palette(id: string | null | undefined): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]!;
}

/**
 * THE SWATCH a settings tile draws, for one palette in one mode.
 *
 * It reads the palette's OWN tokens rather than the ones currently applied, so
 * the tile shows what choosing it would do — which is the entire point of a
 * preview. `paper` has no tokens, so it falls back to the stylesheet's default
 * values, written out here once. Those four hexes are the only duplication of
 * index.css in this file and they are the default's page, card, ink and brand.
 */
export function swatch(id: PaletteId, mode: "light" | "dark"): string[] {
  const p = palette(id);
  const t = mode === "light" ? p.light : p.dark;
  if (!t)
    return mode === "light"
      ? ["#fbfbfa", "#ffffff", "#100f0e", "#1f6b3f"]
      : ["#0e0e0d", "#1a1a18", "#f4f2ed", "#78cc97"];
  return [t.background, t.card, t.foreground, t.primary];
}

/* ------------------------------------------------------------- contrast */

/** #rgb or #rrggbb → 0–255 triples. Throws on anything else, because a colour
 *  this cannot parse in a palette is a typo and the test must fail on it. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex colour: "${hex}"`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** AA for normal-size text. Everything this app draws in these colours is
 *  normal size — 14px body, 11.5px meta — so the large-text 3:1 exemption is
 *  never the applicable one here. */
export const AA = 4.5;

/**
 * EVERY TEXT-ON-SURFACE PAIR A PALETTE PRODUCES.
 *
 * Named rather than looped over blindly, because "which token is text and
 * which is a surface" is a fact about how the components use them and not
 * something derivable from the token list. The test asserts every pair here.
 */
export function textPairs(t: Tokens): { name: string; fg: string; bg: string }[] {
  const surfaces: [string, string][] = [
    ["background", t.background],
    ["card", t.card],
    ["sidebar", t.sidebar],
    ["muted", t.muted],
  ];
  const inks: [string, string][] = [
    ["foreground", t.foreground],
    ["muted-foreground", t["muted-foreground"]],
    ["faint", t.faint],
    ["ok", t.ok],
    ["warn", t.warn],
    ["destructive", t.destructive],
  ];
  const pairs = surfaces.flatMap(([sn, s]) =>
    inks.map(([inkName, ink]) => ({ name: `${inkName} on ${sn}`, fg: ink, bg: s })),
  );
  /* The two that are not ink-on-surface: a button's label on its own fill, and
     the ok colour on the ok tint it is drawn on. */
  pairs.push({ name: "primary-foreground on primary", fg: t["primary-foreground"], bg: t.primary });
  pairs.push({ name: "ok on ok-bg", fg: t.ok, bg: t["ok-bg"] });
  return pairs;
}
