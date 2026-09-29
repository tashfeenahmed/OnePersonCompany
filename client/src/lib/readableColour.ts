/**
 * A brand colour that can be SEEN on either theme.
 *
 * GitHub, X, OpenAI, Vercel and this app's own mark are near-black; painted
 * as themselves they vanish on the dark theme's cards. Anything that dark is
 * drawn in the text colour instead — black on light, white on dark — which is
 * how those brands draw themselves on a dark page anyway. Everything else
 * keeps its own hue.
 */
export function isVeryDark(hex: string | null | undefined): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L < 0.03;
}

/** The colour to paint a glyph in. */
export const readableColour = (hex: string) => (isVeryDark(hex) ? "var(--foreground)" : hex);

/** A faint tile background behind the glyph: the brand's own tint, or a
 *  neutral one for a near-black brand. */
export const tileBackground = (hex: string) =>
  isVeryDark(hex) ? "color-mix(in oklab, var(--foreground) 9%, transparent)" : `${hex}1f`;
