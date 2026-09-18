import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractHtmlDocument,
  isScriptUrl,
  looksLikeHtmlReport,
  sanitizeReportHtml,
  splitTrailingFence,
  textOfHtml,
  unfence,
} from "./html.ts";

test("extractHtmlDocument cuts the page out of the narration a model wrote around it", () => {
  const wrapped = `The user is right — I need to produce the finished HTML document. Let me compose it carefully.\n\n${DOC}\n\nThat is the complete landscape.`;
  const found = extractHtmlDocument(wrapped);
  assert.ok(found);
  assert.equal(found.doc, DOC);
  assert.equal(found.trimmed, true);
  /* The cards fence after the close is the tail, byte for byte. */
  const withCards = `${DOC}\n\n\`\`\`json cards\n[{"title":"ship <10s clips"}]\n\`\`\`\n`;
  const kept = extractHtmlDocument(withCards);
  assert.equal(kept?.doc, DOC);
  /* `unfence` trims the answer's ends, so the fence keeps its shape and not
     the newline the model put after it. */
  assert.equal(kept?.tail, `\n\n\`\`\`json cards\n[{"title":"ship <10s clips"}]\n\`\`\``);
  /* A clean answer is itself, untrimmed. */
  assert.deepEqual(extractHtmlDocument(DOC), { doc: DOC, tail: "", trimmed: false });
  assert.equal(extractHtmlDocument("```html\n" + DOC + "\n```")?.doc, DOC, "fenced is unfenced first");
  /* No complete document, no answer: markdown, or a page still open. */
  assert.equal(extractHtmlDocument("## Findings\n\nNothing here."), null);
  assert.equal(extractHtmlDocument("<!doctype html><html><body><h1>Half</h1><p>a page"), null);
  assert.equal(extractHtmlDocument("Let me write it.\n\n<!doctype html><html><head></head><body><h1>x</h1>"), null);
});

const DOC =
  `<!doctype html><html><head><style>body{font:14px system-ui}</style></head>` +
  `<body><h1>Jane Doe</h1><p class="dateline">7 September 2026</p>` +
  `<h2>Snapshot</h2><p>She founded Acme.</p></body></html>`;

test("unfence takes off a fence the model added, and nothing else", () => {
  assert.equal(unfence("```html\n<p>hi</p>\n```"), "<p>hi</p>");
  assert.equal(unfence("```\n<p>hi</p>\n```"), "<p>hi</p>");
  assert.equal(unfence("```HTML\n<p>hi</p>"), "<p>hi</p>", "an unclosed fence is a report still streaming");
  assert.equal(unfence("<p>hi</p>"), "<p>hi</p>");
  assert.equal(
    unfence("Some prose ending in a fence\n```"),
    "Some prose ending in a fence\n```",
    "a close with no open is prose, not a fence",
  );
  assert.equal(unfence("```json\n{}\n```"), "```json\n{}\n```", "a fence of another language is left whole");
});

test("looksLikeHtmlReport wants markup, a document and a document that STARTS with one", () => {
  assert.equal(looksLikeHtmlReport(DOC), true);
  assert.equal(looksLikeHtmlReport("```html\n" + DOC + "\n```"), true, "fenced still counts");
  assert.equal(looksLikeHtmlReport("<style>p{}</style><p>a paragraph</p>"), true);
  assert.equal(looksLikeHtmlReport("## Snapshot\nJane Doe is a founder."), false, "markdown is markdown");
  assert.equal(
    looksLikeHtmlReport("## Snapshot\nHer site's markup is `<html><h1>Acme</h1><p>x</p></html>`."),
    false,
    "markdown that quotes a document is still markdown",
  );
  assert.equal(looksLikeHtmlReport("<h1>Jane</h1>"), false, "a heading alone is not a document");
  assert.equal(
    looksLikeHtmlReport("<!doctype html><html><head><style>body{margin:0"),
    true,
    "a document still arriving is already a document — the doctype settles it",
  );
  assert.equal(looksLikeHtmlReport("<div>a fragment</div>"), false, "a fragment with no prose and no wrapper");
  assert.equal(looksLikeHtmlReport(""), false);
});

test("sanitizeReportHtml keeps the design and drops what executes", () => {
  const dirty =
    `<!doctype html><html><head><style>h1{color:#4f63d2}</style>` +
    `<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=http://evil">` +
    `<link rel="stylesheet" href="http://evil/x.css"><base href="http://evil/">` +
    `</head><body onload="steal()"><h1 style="font-size:26px">Jane Doe</h1>` +
    `<script>fetch("http://evil")</script>` +
    `<p onclick="x()">She founded <a href="https://acme.example">Acme</a>.</p>` +
    `<iframe src="http://evil"><p>fallback</p></iframe><form action="http://evil"><p>go</p></form>` +
    `</body></html>`;
  const clean = sanitizeReportHtml(dirty);

  assert.match(clean, /<style>h1\{color:#4f63d2\}<\/style>/, "the design survives");
  assert.match(clean, /<meta charset="utf-8">/, "an ordinary meta survives");
  assert.match(clean, /<h1 style="font-size:26px">Jane Doe<\/h1>/);
  assert.match(clean, /<a href="https:\/\/acme\.example">Acme<\/a>/);
  assert.doesNotMatch(clean, /script|iframe|<form|<link|<base|http-equiv/i);
  assert.doesNotMatch(clean, /onload|onclick/i);
  assert.doesNotMatch(clean, /fetch\(/, "the script's body goes with the script");
  assert.doesNotMatch(clean, /fallback|>go</, "so does what was inside the frame and the form");
});

test("sanitizeReportHtml reads a tag the way a browser does, not with a regex", () => {
  assert.equal(
    sanitizeReportHtml('<p title="a > b">x</p>'),
    '<p title="a > b">x</p>',
    "a quoted value may contain a closing bracket",
  );
  assert.equal(sanitizeReportHtml("<p>3 < 4 is true</p>"), "<p>3 < 4 is true</p>", "a bare < in prose stays");
  assert.equal(sanitizeReportHtml("<hr/>"), "<hr />");
  assert.equal(sanitizeReportHtml("<p class=lead>x</p>"), '<p class="lead">x</p>', "unquoted values come back quoted");
  assert.equal(
    sanitizeReportHtml('<svg viewBox="0 0 10 10"><rect/></svg>'),
    '<svg viewBox="0 0 10 10"><rect /></svg>',
    "attribute case is kept — SVG's viewBox means nothing lower-cased",
  );
  assert.equal(sanitizeReportHtml("<p hidden>x</p>"), "<p hidden>x</p>", "a bare attribute keeps its bareness");
  assert.equal(sanitizeReportHtml("<!-- a note --><p>x</p>"), "<!-- a note --><p>x</p>", "comments pass through");
  assert.equal(sanitizeReportHtml("<script>alert(1)"), "", "an unclosed script eats the rest, as a browser does");
});

test("isScriptUrl sees through the encodings a browser sees through", () => {
  assert.equal(isScriptUrl("javascript:alert(1)"), true);
  assert.equal(isScriptUrl("  JaVaScRiPt:alert(1)"), true);
  assert.equal(isScriptUrl("java\nscript:alert(1)"), true, "whitespace inside the scheme is ignored");
  assert.equal(isScriptUrl("java&#9;script:alert(1)"), true, "so is a tab written as an entity");
  assert.equal(isScriptUrl("java&colon;script"), false, "no scheme at all");
  assert.equal(isScriptUrl("&#106;avascript:alert(1)"), true);
  assert.equal(isScriptUrl("vbscript:msgbox"), true);
  assert.equal(isScriptUrl("data:text/html;base64,PHNjcmlwdD4="), true);
  assert.equal(isScriptUrl("https://acme.example/jane"), false);
  assert.equal(isScriptUrl("data:image/png;base64,iVBOR"), false, "an inline image is not a script");
  assert.equal(isScriptUrl("#sources"), false);
});

test("sanitizeReportHtml drops a scripted URL and leaves the element", () => {
  assert.equal(
    sanitizeReportHtml('<a href="javascript:alert(1)">Source</a>'),
    "<a>Source</a>",
    "the link text is the finding; only the scheme goes",
  );
  assert.equal(sanitizeReportHtml('<img src="JAVASCRIPT:x" alt="chart">'), '<img alt="chart">');
  assert.equal(
    sanitizeReportHtml('<svg><use xlink:href="javascript:x"></use></svg>'),
    "<svg><use></use></svg>",
  );
});

test("sanitizeReportHtml is a no-op on a document that was already clean", () => {
  assert.equal(sanitizeReportHtml(DOC), DOC);
});

test("textOfHtml gives back the words, and not the stylesheet", () => {
  const text = textOfHtml(DOC);
  assert.match(text, /Jane Doe/);
  assert.match(text, /She founded Acme\./);
  assert.doesNotMatch(text, /font|system-ui/, "the <style> block is not prose");
  assert.doesNotMatch(text, /</);
  assert.equal(textOfHtml("<p>Acme &amp; Co &mdash; &quot;launched&quot;</p>"), 'Acme & Co — "launched"');
  assert.equal(textOfHtml("<p>one</p><p>two</p>"), "one\ntwo");
  assert.equal(
    textOfHtml("<p>7 Sep 2026 &middot; founder &hellip; &#8212; &amp;amp; more</p>"),
    "7 Sep 2026 · founder … — &amp; more",
    "one decoding pass, so an escaped entity stays escaped",
  );
  assert.equal(textOfHtml(""), "");
});

/* --------------------------------------------------- the fence AFTER the doc */

/**
 * A COMPETITOR SWEEP'S REPORT IS A DOCUMENT WITH A MARKDOWN FENCE AFTER IT.
 * The board cards travel in the same ```` ```json cards ```` block every other
 * kind emits, appended after the closing </html> rather than embedded in the
 * page — see integrations/runs/competitors.ts. Both ends of the pipe have to
 * cope: the report is still recognised as a document, and the fence survives
 * the sanitiser byte for byte, INCLUDING a card title with a `<` in it, which
 * a tag scanner would otherwise read as an unterminated tag and eat the rest
 * of the JSON with.
 */
const CARDS = '\n\n```json cards\n[{"title": "Ship <10s clips", "body": "b", "urgency": 2}]\n```\n';

test("a report with a cards fence after it is still a document", () => {
  assert.equal(looksLikeHtmlReport(DOC + CARDS), true);
});

test("splitTrailingFence cuts at the LAST closing html tag, and only at a real one", () => {
  const { doc, tail } = splitTrailingFence(DOC + CARDS);
  assert.ok(doc.endsWith("</html>"));
  assert.equal(tail, CARDS);

  /* A document still streaming has not closed, so all of it is markup. */
  const half = splitTrailingFence("<!doctype html><html><head><style>body{margin:0");
  assert.equal(half.tail, "");
  assert.equal(half.doc, "<!doctype html><html><head><style>body{margin:0");

  /* Markdown with no document in it is left whole. */
  assert.equal(splitTrailingFence("## Findings\nSomething.").tail, "");
});

test("the cards fence survives the sanitiser, angle bracket and all", () => {
  const { doc, tail } = splitTrailingFence(DOC + CARDS);
  const cleaned = sanitizeReportHtml(unfence(doc)) + tail;
  assert.ok(cleaned.includes('"title": "Ship <10s clips"'), "the card title is not markup and is not scanned");
  assert.ok(cleaned.includes("```json cards"));
  assert.ok(cleaned.includes("<h1>Jane Doe</h1>"), "and the document is still sanitised");
});
