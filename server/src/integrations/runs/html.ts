/**
 * A MODEL-WRITTEN HTML DOCUMENT, MADE SAFE TO KEEP.
 *
 * ---------------------------------------------------------------------------
 * THE DOSSIER IS THE FIRST REPORT ON THIS BOX THAT IS NOT MARKDOWN. It is a
 * whole HTML document — the analyst designs it, column and rule and fact strip
 * and all — because a profile of a person is READ rather than skimmed, and the
 * markdown pipeline renders every report on this box in the same nine
 * typographic decisions. See `people/dossier.ts` for the brief that asks for
 * one and `client/src/components/runs/ReportFrame.tsx` for the sandboxed frame
 * it is drawn in.
 *
 * WHY THE SERVER SANITISES AT ALL, GIVEN THE FRAME. The frame is the boundary
 * and it is the real one: a sandbox without `allow-scripts` cannot run a
 * script that survived every filter ever written. This runs anyway, on the way
 * IN, for a different reason — `agent_runs.output` is a column other things
 * read. It is exported to PDF, quoted back into the next dossier's brief, and
 * will one day be handed to something that has never heard of an iframe. A
 * column that only ever holds clean documents is a column nobody has to
 * remember to be careful with.
 *
 * NO DOM AND NO DEPENDENCIES. There is no DOMParser on this side, and pulling
 * a parser in for one report kind is a dependency the whole server then
 * carries. So this is a small tag scanner: it walks the string, reads each tag
 * the way a browser reads one — quoted attribute values may contain `>`, and a
 * regex over `<[^>]*>` gets that wrong — and rebuilds the document out of the
 * tags it keeps. It is deliberately DUMBER than a parser: it builds no tree,
 * corrects no nesting, and rewrites nothing it did not recognise. What it
 * cannot understand is dropped, never guessed at.
 *
 * WHAT COMES OUT IS STILL UNTRUSTED. This removes the things that execute; it
 * does not make the document true, and it does not make it safe to render
 * outside a sandbox. Both ends do their own half — the client parses the same
 * document again with a DOM before framing it — because a single filter is one
 * missed case away from being no filter.
 */

/* ---------------------------------------------------------------- the fence */

/**
 * A model told "no markdown" wraps the document in a markdown fence anyway,
 * perhaps one time in five. The backticks would render as literal backticks at
 * the top of the dossier, so they come off.
 *
 * THE CLOSING FENCE COMES OFF ONLY IF THERE WAS AN OPENING ONE. A document
 * that happens to end in three backticks and never opened a fence is a
 * document with three backticks in it, and cutting them off would be this
 * function editing prose. The reverse is not true — an opening fence with no
 * close is the ordinary state of a report that is still streaming, and it is
 * stripped so the half-written document draws.
 */
const FENCE_OPEN = /^```[ \t]*(?:html|xml)?[ \t]*\r?\n/i;
const FENCE_CLOSE = /\r?\n?[ \t]*```[ \t]*$/;

export function unfence(text: string): string {
  const t = text.trim();
  if (!FENCE_OPEN.test(t)) return t;
  return t.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
}

/* ------------------------------------------------------- the fence AFTER it */

/**
 * A DOCUMENT WITH A MARKDOWN FENCE SITTING AFTER ITS CLOSING </html>, SPLIT
 * IN TWO.
 *
 * ---------------------------------------------------------------------------
 * THE COMPETITOR SWEEP PUTS ONE THERE ON PURPOSE. Its report is an HTML
 * landscape document, and the board-card suggestions that every reporting kind
 * emits still have to travel in the ```` ```json cards ```` fence that
 * `GET /runs/:id` parses and the client strips — so the run appends the fence
 * after the document rather than asking the writing turn to embed it, which
 * would have put JSON inside a page. See integrations/runs/competitors.ts.
 *
 * SO THE SANITISER HAS TO KNOW WHERE THE MARKUP STOPS. Everything before the
 * closing `</html>` is a document and is scanned tag by tag; everything after
 * it is markdown, is not markup, and must survive BYTE FOR BYTE. Without this
 * split a card whose title contains a `<` — "ship <10s clips", which is the
 * kind of thing a competitor sweep proposes — would be read as an unterminated
 * tag and the rest of the JSON eaten with it, and the cards would silently
 * stop appearing.
 *
 * IT SPLITS ONLY ON A REAL CLOSING TAG AT THE END. A document that never
 * closed — one still streaming — has no tail, which is the correct answer: the
 * whole of it is markup so far.
 */
const HTML_CLOSE = /<\/html\s*>/gi;

export function splitTrailingFence(text: string): { doc: string; tail: string } {
  let last = -1;
  let end = -1;
  for (const m of text.matchAll(HTML_CLOSE)) {
    last = m.index;
    end = m.index + m[0].length;
  }
  if (last < 0) return { doc: text, tail: "" };
  return { doc: text.slice(0, end), tail: text.slice(end) };
}

/* ----------------------------------------------------------- is it a report */

/** The tags a written document has in it. */
const MARKUP = /<(?:h1|h2|p)[\s>]/i;

/** What makes it a DOCUMENT rather than a paragraph of markdown with a stray
 *  tag in it. One of these has to be there too. */
const DOCUMENT = /<!doctype\s+html|<html[\s>]|<style[\s>]|<body[\s>]/i;

/** An opening that only a document has. */
const OPENING = /^<!doctype\s+html|^<html[\s>]/i;

/**
 * IS THIS ANSWER AN HTML REPORT?
 *
 * THREE CONDITIONS, AND THE THIRD IS THE ONE THAT MATTERS. It has document
 * markup, it has a document wrapper, and it STARTS with a tag. Without the
 * third, a markdown report that quoted an HTML snippet in a fenced example
 * would be filed as HTML and rendered as one — a wrong answer rather than an
 * ugly one — so the bar is that the whole answer is the document.
 *
 * A NO IS NOT A FAILURE. Every caller falls back to the markdown path, which
 * is what every other kind of run produces and what a dossier written by a
 * model that ignored the brief still produces. This decides which renderer,
 * not whether the run worked.
 */
export function looksLikeHtmlReport(text: string): boolean {
  const t = unfence(text);
  if (!t.startsWith("<")) return false;
  /* AN ANSWER THAT OPENS WITH A DOCTYPE IS A DOCUMENT AND NOTHING ELSE, and
     it is said before the two tests below so that a document ARRIVING — the
     doctype, the <head>, half a stylesheet, and not one paragraph yet — is
     already known to be one. Without this the panels draw a few hundred
     characters of raw markup as prose for as long as the <style> block takes
     to stream, and then flip. No markdown report has ever begun this way. */
  if (OPENING.test(t)) return true;
  return MARKUP.test(t) && DOCUMENT.test(t);
}

/* ------------------------------------------------ the document inside the answer */

const DOC_OPEN = /<!doctype\s+html[^>]*>|<html[\s>]/i;

/**
 * THE DOCUMENT A MODEL WROTE, CUT OUT OF WHATEVER IT WROTE AROUND IT.
 *
 * Told to answer with a page and nothing else, a model still — often enough
 * to matter — says something first: "The user is right, I need to produce the
 * finished HTML document. Let me compose it carefully." and THEN the doctype.
 * Two competitor reports on the live box arrived exactly like that from a free
 * hosted model, passed the length floor, were filed as done, and were drawn
 * as raw markup because the client's framing test asks whether the answer
 * STARTS with a tag — which is the right test for "is this whole answer a
 * document" and the wrong one for "is there a document in here".
 *
 * So this finds the first opening a document has and the last `</html>`, and
 * hands back what lies between — plus whatever follows the close, byte for
 * byte, because the competitor sweep and the research writer both put a
 * ```json cards``` fence there on purpose (see `splitTrailingFence`). Null
 * when there is no complete document: no opening, or an opening with no
 * close, which is a page still being written or one that was cut off, and
 * either way not something to frame as finished.
 *
 * IT DOES NOT SANITISE. That is `sanitizeReportHtml`'s job and every caller
 * still does it; this only decides where the document is.
 */
export function extractHtmlDocument(text: string): { doc: string; tail: string; trimmed: boolean } | null {
  const t = unfence(text);
  const open = DOC_OPEN.exec(t);
  if (!open) return null;
  const { doc: upToClose, tail } = splitTrailingFence(t);
  if (upToClose === t && !/<\/html\s*>\s*$/i.test(t)) return null;
  const doc = upToClose.slice(open.index);
  if (!doc.trim()) return null;
  return { doc, tail, trimmed: open.index > 0 || doc !== upToClose.slice(open.index) };
}

/* ----------------------------------------------------------------- the strip */

/**
 * Elements dropped WITH EVERYTHING INSIDE THEM. An unclosed one eats the rest
 * of the document, which is what a browser does with an unclosed `<script>`
 * and the only safe reading of one.
 */
const DROP_TREE = new Set(["script", "iframe", "object", "form", "frame", "frameset"]);

/** Elements dropped as a single tag: `link` and `base` are void, and an
 *  `embed` somebody closed by hand leaves a stray close tag that goes the same
 *  way. */
const DROP_TAG = new Set(["link", "base", "embed", "applet"]);

/** Attribute names that carry a URL, and are therefore where a scheme can
 *  hide. `style` is not one of them and is kept: it is the design. */
const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "srcset",
  "action",
  "formaction",
  "data",
  "background",
  "poster",
]);

/** The named entities worth decoding for a scheme check. `&colon;` is the one
 *  that appears in the wild, in `java&colon;script`-shaped dodges; the rest
 *  are here for completeness and cost nothing. */
const NAMED: Record<string, string> = {
  colon: ":",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  tab: "\t",
  newline: "\n",
};

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));?/g;

function decodeEntities(v: string): string {
  return v.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    try {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    } catch {
      /* A code point out of range is not a character and is left as written. */
      return whole;
    }
    if (name) {
      const found = NAMED[name] ?? NAMED[name.toLowerCase()];
      if (found) return found;
    }
    return whole;
  });
}

/**
 * Does this attribute value name a scheme that executes?
 *
 * ENTITIES DECODED AND WHITESPACE REMOVED FIRST, because a browser does both
 * before it looks at the scheme: `java&#9;script:x` and a `javascript:` broken
 * over a newline are both live links by the time anything navigates. A
 * trim-and-compare — which is all a one-line filter ever does — misses both.
 */
export function isScriptUrl(value: string): boolean {
  const v = decodeEntities(value)
    .replace(/[\u0000-\u0020]/g, "")
    .toLowerCase();
  return v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:text/html");
}

type Attr = { name: string; value: string | null };
type Tag = { name: string; close: boolean; selfClose: boolean; attrs: Attr[]; end: number };

const SPACE = /\s/;
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9:._-]*/;
const ATTR_NAME = /^[^\s/>=]+/;
const UNQUOTED = /^[^\s>]*/;

/**
 * One tag, read from `at`, or null when what follows the `<` is not a tag name
 * — a bare `<` in prose, which stays as it is.
 *
 * The attribute loop is the fiddly part and it is fiddly on purpose: a value
 * is read to its closing quote, so `title="a > b"` does not end the tag, and
 * an unterminated quote runs to the end of the document rather than throwing.
 */
function readTag(src: string, at: number): Tag | null {
  let i = at + 1;
  let close = false;
  if (src[i] === "/") {
    close = true;
    i++;
  }
  const m = TAG_NAME.exec(src.slice(i, i + 64));
  if (!m) return null;
  const name = m[0].toLowerCase();
  i += m[0].length;

  const attrs: Attr[] = [];
  let selfClose = false;
  for (;;) {
    while (i < src.length && SPACE.test(src[i] ?? "")) i++;
    if (i >= src.length) break;
    if (src[i] === ">") {
      i++;
      break;
    }
    if (src[i] === "/" && src[i + 1] === ">") {
      selfClose = true;
      i += 2;
      break;
    }
    if (src[i] === "/") {
      i++;
      continue;
    }
    const nm = ATTR_NAME.exec(src.slice(i));
    if (!nm?.[0]) {
      i++;
      continue;
    }
    const aname = nm[0];
    i += aname.length;
    let j = i;
    while (j < src.length && SPACE.test(src[j] ?? "")) j++;
    if (src[j] !== "=") {
      attrs.push({ name: aname, value: null });
      i = j;
      continue;
    }
    j++;
    while (j < src.length && SPACE.test(src[j] ?? "")) j++;
    const q = src[j];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, j + 1);
      attrs.push({ name: aname, value: src.slice(j + 1, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 1;
    } else {
      const value = UNQUOTED.exec(src.slice(j))?.[0] ?? "";
      attrs.push({ name: aname, value });
      i = j + value.length;
    }
  }
  return { name, close, selfClose, attrs, end: i };
}

/** Whether an attribute survives. Everything `on…` goes, whatever it is called
 *  — a filter that lists the handlers it knows about is a filter that misses
 *  the one the platform added last year. */
function keepAttr(a: Attr): boolean {
  if (/^on/i.test(a.name)) return false;
  if (a.value !== null && URL_ATTRS.has(a.name.toLowerCase()) && isScriptUrl(a.value)) return false;
  return true;
}

/** Values come back out in double quotes whatever they went in as, so the two
 *  characters that would break out of them are the two that are escaped. An
 *  ampersand that already begins an entity is left alone, or every re-write
 *  would double it. */
const escapeValue = (v: string) =>
  v.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, "&amp;").replace(/"/g, "&quot;");

function render(tag: Tag): string {
  if (tag.close) return `</${tag.name}>`;
  const kept = tag.attrs
    .filter(keepAttr)
    .map((a) => (a.value === null ? a.name : `${a.name}="${escapeValue(a.value)}"`));
  return `<${[tag.name, ...kept].join(" ")}${tag.selfClose ? " /" : ""}>`;
}

/** Where the matching close tag ends, or null when there is not one. Nesting
 *  is not counted: a nested `<object>` would end the drop one tag early, and
 *  the alternative — a counter that miscounts on a stray close and eats the
 *  document — is the worse failure. Neither has appeared in a dossier. */
function closeAfter(src: string, name: string, from: number): number | null {
  const at = src.slice(from).search(new RegExp(`</${name}[\\s>]`, "i"));
  if (at < 0) return null;
  const gt = src.indexOf(">", from + at);
  return gt < 0 ? src.length : gt + 1;
}

/**
 * The document with everything that executes taken out of it.
 *
 * Comments and the doctype pass through untouched — a comment cannot run, and
 * the doctype is what puts the frame in standards mode, without which the
 * analyst's column measures against the wrong root.
 */
export function sanitizeReportHtml(html: string): string {
  const src = html;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      const stop = end < 0 ? src.length : end + 3;
      out += src.slice(lt, stop);
      i = stop;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      const stop = end < 0 ? src.length : end + 1;
      out += src.slice(lt, stop);
      i = stop;
      continue;
    }

    const tag = readTag(src, lt);
    if (!tag) {
      out += "<";
      i = lt + 1;
      continue;
    }
    i = tag.end;

    if (DROP_TAG.has(tag.name)) continue;
    if (DROP_TREE.has(tag.name)) {
      if (tag.close) continue;
      i = closeAfter(src, tag.name, tag.end) ?? src.length;
      continue;
    }
    /* `<meta http-equiv=…>` is a second Content-Security-Policy, a redirect or
       a charset override, written into a document the frame already gives a
       CSP of its own. The frame's wins because it is first; this one goes so
       there is no argument to have. */
    if (tag.name === "meta" && !tag.close && tag.attrs.some((a) => a.name.toLowerCase() === "http-equiv"))
      continue;

    out += render(tag);
  }
  return out;
}

/**
 * The entities that carry punctuation in prose, and a general numeric decode
 * beside them. ONE PASS over the string rather than a chain of replaces, so
 * `&amp;lt;` comes out as `&lt;` — the text that was written — rather than
 * decoded twice into a tag that was never there.
 *
 * NOT `decodeEntities` ABOVE: that one is deliberately lenient about the
 * missing semicolon a scheme dodge relies on, and knows only the entities that
 * can hide a colon. This one is about prose and is strict about the semicolon,
 * because `AT&T; a company` is not an entity.
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
 * The WORDS of an HTML document, for counting and for quoting.
 *
 * Not a renderer: `<style>` and `<head>` go entirely, block tags become line
 * breaks, every other tag becomes a space, and the entities that carry
 * punctuation are turned back into characters. Used for the previous dossier
 * quoted into the next one's brief — a model handed nine thousand characters
 * of CSS in place of last month's findings learns nothing from them — and, on
 * the client, for the word count under the report.
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
