import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, fileNameFor, reportDocument, wordCount } from "./reportDocument.ts";

test("escapeHtml turns the five markup characters into entities and nothing else", () => {
  assert.equal(escapeHtml(`<b class="x">Tom & Jerry's</b>`), "&lt;b class=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;");
  assert.equal(escapeHtml("plain — text"), "plain — text");
});

test("wordCount counts runs of non-space and says 0 for nothing", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("   \n  "), 0);
  assert.equal(wordCount("one"), 1);
  assert.equal(wordCount("one two\nthree\t four "), 4);
});

test("fileNameFor drops the characters a filesystem refuses", () => {
  assert.equal(fileNameFor('Dossier: Jane/Doe "founder"?'), "Dossier Jane Doe founder");
  assert.equal(fileNameFor("   "), "report");
});

test("reportDocument escapes what people typed and passes the rendered body through", () => {
  const html = reportDocument({
    title: "Research — <Acme>",
    subtitle: 'Acme Researcher · for "Acme"',
    facts: [
      { label: "Date", value: "5 Sep 2026, 14:02" },
      { label: "Took", value: "" },
      { label: "Words", value: "1,204" },
    ],
    brief: "Who buys this? <script>alert(1)</script>",
    bodyHtml: "<h2>Finding</h2><p>Planners, not builders.</p>",
    footer: "Acme Researcher · hermes · run-1",
  });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes("<title>Research — Acme</title>"), "the file name is the title made safe");
  assert.ok(html.includes("<h1>Research — &lt;Acme&gt;</h1>"));
  assert.ok(html.includes('Acme Researcher · for &quot;Acme&quot;'));
  assert.ok(html.includes("<dt>Date</dt><dd>5 Sep 2026, 14:02</dd>"));
  assert.ok(!html.includes("<dt>Took</dt>"), "an empty fact is left off rather than drawn blank");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the brief is text, never markup");
  assert.ok(!html.includes("<script>"), "no script tag survives anywhere in the document");
  assert.ok(html.includes("<main><h2>Finding</h2><p>Planners, not builders.</p></main>"));
  assert.ok(html.includes("<footer>Acme Researcher · hermes · run-1</footer>"));
});

test("reportDocument leaves out the parts it was not given", () => {
  const html = reportDocument({ title: "T", bodyHtml: "<p>x</p>" });
  assert.ok(!html.includes('class="sub"'));
  assert.ok(!html.includes("<dl>"));
  assert.ok(!html.includes('class="brief"'));
  assert.ok(!html.includes("<footer>"));
});
