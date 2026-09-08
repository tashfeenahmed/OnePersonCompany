/**
 * The hues the Payments page draws with, named for what they mean rather than
 * what they look like, so a card cannot paint "churned" green by accident.
 * Every value is a token from index.css, so the page follows the theme.
 */
export const HUE = {
  ok: "var(--ok)",
  bad: "var(--destructive)",
  warn: "var(--warn)",
  one: "var(--chart-line-1)",
  two: "var(--chart-line-2)",
  three: "var(--chart-line-3)",
  four: "var(--chart-line-4)",
  ink: "var(--chart-1)",
  mid: "var(--chart-3)",
  faint: "var(--chart-4)",
} as const;
