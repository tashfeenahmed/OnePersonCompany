/**
 * WHICH KIND OF DOCUMENT A RUN WROTE, AND WHAT ITS WORDS ARE.
 *
 * ---------------------------------------------------------------------------
 * SIX KINDS OF RUN WRITE MARKDOWN AND THE DOSSIER WRITES HTML. The People
 * Analyst is handed a brief that asks for a whole designed document — see the
 * server's `integrations/people/dossier.ts` — because a profile of a person is
 * read rather than skimmed, and the markdown renderer has one set of
 * typographic decisions for every report on this box. So the four places that
 * draw a report ask this file which one they are holding, and either hand it
 * to `<Markdown>` as they always have or to `<ReportFrame>`, which puts it in
 * a sandbox and lets it look like itself.
 *
 * THE TEST IS ON THE TEXT, NOT ON THE KIND. A dossier written before this
 * existed is markdown and still renders; a dossier whose model ignored the
 * brief and answered in markdown renders too. Nothing here forks on
 * `run.kind`, so no future kind has to be added to a list to be drawn
 * correctly, and no run is drawn wrongly because a model did something
 * unexpected.
 *
 * IT IS THE SERVER'S RULE, SAID AGAIN. `integrations/runs/html.ts` decides the
 * same question on the way INTO the row, and has to: it is the thing that
 * sanitises. This side asks it again because a row can predate that code, and
 * because a renderer that trusted a flag it did not compute itself is a
 * renderer that draws raw HTML as prose the first time the flag is wrong. The
 * two answers agree by construction — the conditions below are the same three.
 *
 * A LEAF. No imports and no DOM, so `report.test.ts` can strip the types and
 * run it under node. The DOM half — the sanitising wrapper that actually
 * builds the frame's document — lives in `components/runs/ReportFrame.tsx`,
 * where DOMParser is.
 */

/** The tags a written document has in it. */
const MARKUP = /<(?:h1|h2|p)[\s>]/i;

/** What makes it a DOCUMENT rather than a paragraph of markdown with a stray
 *  tag in it. One of these has to be there too. */
const DOCUMENT = /<!doctype\s+html|<html[\s>]|<style[\s>]|<body[\s>]/i;

/** A fence the model wrapped the document in despite being told not to. The
 *  server takes it off on the way in; this side still copes with a row that
 *  arrived before it did. */
const FENCE_OPEN = /^```[ \t]*(?:html|xml)?[ \t]*\r?\n/i;
const FENCE_CLOSE = /\r?\n?[ \t]*```[ \t]*$/;

/** The document, with a markdown fence taken off it if it had one. */
export function unfenceHtml(text: string): string {
  const t = text.trim();
  if (!FENCE_OPEN.test(t)) return t;
  return t.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
}

/** An opening that only a document has. */
const OPENING = /^<!doctype\s+html|^<html[\s>]/i;

/**
 * IS THIS REPORT AN HTML DOCUMENT?
 *
 * Three conditions, and the third is the one that matters: it has document
 * markup, it has a document wrapper, and it STARTS with a tag. Without the
 * third, a markdown report quoting an HTML snippet would be framed instead of
 * rendered — a wrong answer rather than an ugly one.
 */
export function isHtmlReport(text: string): boolean {
  const t = unfenceHtml(text);
  if (!t.startsWith("<")) return false;
  /* A doctype settles it on its own, and is checked first so that a document
     still ARRIVING — doctype, head, half a stylesheet, no paragraph yet — is
     framed from the first tick rather than drawn as raw markup until its
     first heading lands. */
  if (OPENING.test(t)) return true;
  return MARKUP.test(t) && DOCUMENT.test(t);
}

/**
 * The entities that carry punctuation in prose, and a general numeric decode
 * beside them. ONE PASS over the string rather than a chain of replaces, so
 * `&amp;lt;` comes out as `&lt;` — the text that was written — rather than
 * decoded twice into a tag that was never there.
 */
const TEXT_ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  middot: "·",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  amp: "&",
};

function decodeText(s: string): string {
  return s.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      try {
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return whole;
      }
      const found = name ? TEXT_ENTITIES[name] ?? TEXT_ENTITIES[name.toLowerCase()] : undefined;
      return found ?? whole;
    },
  );
}

/**
 * The WORDS of an HTML document — for the word count in a facts strip and for
 * anywhere a rail wants a label out of a report it cannot render.
 *
 * Not a renderer and not a sanitiser: `<style>` and `<head>` go entirely,
 * block tags become line breaks, every other tag becomes a space. Its twin on
 * the server is `textOfHtml` in `integrations/runs/html.ts`, which quotes a
 * previous dossier into the next one's brief with it — the same job, on the
 * side of the wire that needs it.
 */
export function textOfHtml(html: string): string {
  return decodeText(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|dl|dd)\s*>/gi, "\n")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The words of a report whichever shape it is in, for counting.
 *
 * The one place the two formats have to be told apart before anything is
 * measured, so it is said once here rather than at each of the panels that
 * draws a word count.
 */
export function reportText(body: string): string {
  return isHtmlReport(body) ? textOfHtml(unfenceHtml(body)) : body;
}

/**
 * WHAT AN HTML REPORT CALLS ITSELF: its <title>, else its first <h1>, as text.
 *
 * Workdash's generators title a report by its biggest finding — "CapCut now
 * offers the core feature for free" — and that is a better heading for a run
 * than the venture's name, which is all a run started from an app without a
 * typed brief has. Null when the document names nothing, so the caller keeps
 * its own fallback rather than drawing an empty heading.
 */
export function titleOfHtml(html: string): string | null {
  const m =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ??
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!m) return null;
  const text = textOfHtml(m[1] ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}
