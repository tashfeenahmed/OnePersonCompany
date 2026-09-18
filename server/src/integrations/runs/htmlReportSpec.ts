/**
 * WHAT EVERY HTML REPORT ON THIS BOX IS TOLD ABOUT ITS OWN FORM.
 *
 * Two runs write designed HTML documents — the competitor landscape and the
 * research report — and the dossier is a third. Each used to carry its own
 * copy of the same two paragraphs: what "self-contained" means in a sandbox
 * that fetches nothing, and what the page should look like. The competitor
 * sweep's copy was the full one, ported section for section from Workdash's
 * REPORT_SPEC; the research writer's was a compressed paraphrase that left
 * out the design entirely, and its reports came back looking typed rather
 * than designed. Two copies of one rule drift, so the rule lives here once
 * and the two writers quote it.
 *
 * THESE ARE THE PARTS THAT ARE THE SAME FOR EVERY DOCUMENT — the sandbox's
 * constraints and the house style. What each report is ABOUT, and in what
 * order, stays with the run that writes it: a landscape's sections are not a
 * research report's.
 */

/** The sandbox's rules, as the writer is told them. The client's ReportFrame
 *  enforces every one of these with a CSP and a sandbox attribute; saying
 *  them here is what stops a model reaching for a CDN font and shipping a
 *  page that silently loses its typography. */
export const SELF_CONTAINED_RULES = `SELF-CONTAINED IS A HARD RULE, not a preference. The document is rendered in a sandbox that fetches nothing and runs nothing:
- ONE inline <style> block, and no other styling. No <link>, no external stylesheet, no web font, no icon file — anything from off this box does not arrive and leaves a broken page with no error anywhere.
- NO <script>, of any kind, for any reason, and no event handlers (onclick and the rest). They are stripped before anybody sees the document.
- CHARTS ARE INLINE <svg> THAT YOU DRAW YOURSELF, built ONLY from numbers in the brief. Label the axes and print the value on every mark. Draw what the data earns — a bar chart where there are figures to compare, a trend line where there is a series, a proportion bar for a funnel — and no chart at all is the right answer to no numbers. Never draw a bar you cannot label with a real figure.
- Images only via https: URLs that appear in the brief. Never construct or guess one. Using none is fine.`;

/**
 * The house style. One accent, one grey, a narrow column, system-ui — the
 * restraint of a printed briefing rather than a landing page, because the
 * document is read inside a dashboard panel beside forty others.
 */
export function designRules(today: string): string {
  return `MAKE IT LOOK DESIGNED, NOT TYPED. Near-black text on white, one grey, one calm accent colour (#4f63d2 unless you have a reason to pick another), used consistently for the header rule, the section markers and the links:
- a centred column about 46rem wide, system-ui, 14px/1.6 body text, generous whitespace, print-like restraint;
- a HEADER BLOCK: an <h1> carrying the finding at about 26px and 650 weight, under it a muted dateline reading ${today}, and a 3px accent rule beneath the block;
- <h2>s at 15px and 600 weight, each with a short accent-coloured left border and space above it;
- tables with thin rules, 10px uppercase muted column heads, and no vertical borders;
- a PULL QUOTE for the one sentence that matters, and a BIG-NUMBER CALLOUT when one number is the story — each used at most once or twice, never as decoration;
- every source link showing its HOSTNAME ONLY — <a href="https://example.com/a/long/path">example.com</a> — accent-coloured, underlined only on hover;
- a muted 12px footer naming the date the document was written and how many sources it used.`;
}

/** How a writing turn is told to open. Repeated because it is the line models
 *  most often break: they introduce the document before writing it, and the
 *  sentence of introduction is what keeps the page from being framed. */
export const DOCUMENT_OPENING = `Start with <!doctype html>. Then <html>, a <head> with <meta charset="utf-8">, a <title> that names THE SINGLE BIGGEST FINDING (never "Report on X"), ONE <style> block, and a <body>. The first characters of your answer are the doctype and the last are </html>. No preamble, no markdown fence, no sentence introducing the document, no note afterwards.`;

/** The refusal, when a writing turn narrated instead of writing. Shared so
 *  the two writers say the same thing to the same failure. */
export const DOCUMENT_AGAIN =
  "STOP. That was not the report — it reads as more investigating or as a note about the report, and there " +
  "is nothing left to call. The investigation is over. Answer again with ONLY " +
  "the finished HTML document. The first characters of your answer must be " +
  "exactly: <!doctype html> and the last must be </html>. Shorten it if you must so that it is complete.";
