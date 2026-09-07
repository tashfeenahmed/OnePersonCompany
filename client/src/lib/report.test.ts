import assert from "node:assert/strict";
import { test } from "node:test";
import { isHtmlReport, reportText, textOfHtml, titleOfHtml, unfenceHtml } from "./report.ts";

const DOC =
  `<!doctype html><html><head><style>body{font:14px system-ui}</style></head>` +
  `<body><h1>Jane Doe</h1><p class="dateline">7 September 2026 &middot; founder, Acme</p>` +
  `<h2>Snapshot</h2><p>She founded Acme in Dublin.</p></body></html>`;

const MD =
  "## Snapshot\nJane Doe is the founder of Acme, based in Dublin.\n\n" +
  "## Sources\n- https://example.com — the profile\n";

test("isHtmlReport tells the dossier from every other kind of report", () => {
  assert.equal(isHtmlReport(DOC), true);
  assert.equal(isHtmlReport("```html\n" + DOC + "\n```"), true, "a fenced document is still a document");
  assert.equal(isHtmlReport("<style>p{}</style><p>a paragraph</p>"), true);
  assert.equal(isHtmlReport(MD), false);
  assert.equal(
    isHtmlReport("## Snapshot\nHer markup is `<html><h1>Acme</h1><p>x</p></html>`."),
    false,
    "markdown that quotes a document is markdown",
  );
  assert.equal(isHtmlReport("<h1>Jane</h1>"), false, "a heading alone is not a document");
  assert.equal(isHtmlReport(""), false, "an empty report is not a document");
  assert.equal(isHtmlReport("<div>a fragment</div>"), false, "a fragment with no prose and no wrapper");
});

test("isHtmlReport is true as soon as a streaming document has its first paragraph", () => {
  /* The panels draw a report while it is still being written, so the answer
     must not flip from markdown to HTML halfway down the page. */
  assert.equal(isHtmlReport("<!doctype html><html><head><style>body{margin:0"), true, "the doctype settles it");
  const half = `<!doctype html><html><head><style>body{margin:0}</style></head><body><h1>Jane Doe</h1><p>She`;
  assert.equal(isHtmlReport(half), true);
});

test("unfenceHtml takes off a fence and nothing else", () => {
  assert.equal(unfenceHtml("```html\n<p>hi</p>\n```"), "<p>hi</p>");
  assert.equal(unfenceHtml("```HTML\n<p>hi</p>"), "<p>hi</p>", "an unclosed fence is a document still arriving");
  assert.equal(unfenceHtml("<p>hi</p>"), "<p>hi</p>");
  assert.equal(unfenceHtml("Prose that ends in a fence\n```"), "Prose that ends in a fence\n```");
});

test("textOfHtml gives back the words, and not the stylesheet", () => {
  const text = textOfHtml(DOC);
  assert.match(text, /Jane Doe/);
  assert.match(text, /She founded Acme in Dublin\./);
  assert.doesNotMatch(text, /system-ui/, "a <style> block is not prose");
  assert.doesNotMatch(text, /</, "and no markup survives");
  assert.equal(textOfHtml("<p>Acme &amp; Co &mdash; &quot;launched&quot;</p>"), 'Acme & Co — "launched"');
  assert.equal(textOfHtml("<p>one</p><p>two</p>"), "one\ntwo");
  assert.equal(
    textOfHtml("<p>7 Sep 2026 &middot; founder &hellip; &#8212; &amp;amp; more</p>"),
    "7 Sep 2026 · founder … — &amp; more",
    "one decoding pass, so an escaped entity stays escaped",
  );
  assert.equal(textOfHtml(""), "");
});

test("reportText counts the words of either shape, and only the words", () => {
  assert.equal(reportText(MD), MD, "markdown is its own text");
  const words = reportText(DOC).split(/\s+/).length;
  assert.ok(words > 5 && words < 30, `a short dossier is a short word count, got ${words}`);
  assert.equal(reportText("```html\n" + DOC + "\n```").includes("```"), false, "the fence is not words");
});

test("titleOfHtml prefers the title, falls back to the first h1, and says null for neither", () => {
  assert.equal(titleOfHtml("<html><head><title> The &amp; finding </title></head><body><h1>Other</h1></body></html>"), "The & finding");
  assert.equal(titleOfHtml("<html><body><h1>Only <em>an</em> h1</h1></body></html>"), "Only an h1");
  assert.equal(titleOfHtml("<html><body><p>nothing named</p></body></html>"), null);
  assert.equal(titleOfHtml("<title>   </title>"), null);
});
