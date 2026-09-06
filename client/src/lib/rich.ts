/** The five fence languages the chat draws as widgets — the same list as
 *  server/src/skills/present.ts. Kept apart from the components so fast
 *  refresh keeps working for the file that draws them. */
export const RICH_LANGS = ["cards", "chart", "bars", "meters", "table"] as const;
export type RichLang = (typeof RICH_LANGS)[number];

/** The rich language on a react-markdown code element's class, or null. */
export function richLang(className: string | undefined): RichLang | null {
  const m = /language-([a-z]+)/.exec(className ?? "");
  const lang = m?.[1];
  return lang && (RICH_LANGS as readonly string[]).includes(lang) ? (lang as RichLang) : null;
}
