/**
 * THE AUDIT, CRAWLING A SITE MADE OF STRINGS.
 *
 * `fetch` is replaced for the duration of a test and every request is written
 * down, so "this page was never fetched" is an assertion this file can make —
 * which is the whole of the first fault it covers: a link that exists only
 * inside a <script> must not be followed, and the proof is that nothing asked
 * for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, now } from "../../db.ts";
import {
  runAudit,
  stripNonContent,
  extractLinks,
  failureCode,
  noindexSeverity,
  type AuditDoc,
  type Finding,
} from "./audit.ts";

/* ------------------------------------------------------------------ pure */

test("links inside script, style, template, noscript and comments are not links", () => {
  const html = `<!doctype html><html><body>
    <a href="/real">Real</a>
    <script>
      const card = '<a class="model-card" href="' + href + '">' + name + '</a>';
      document.body.innerHTML = '<a href="/script-only">nope</a>';
    </script>
    <style>a[href="/style-only"] { color: red }</style>
    <template><a href="/template-only">nope</a></template>
    <noscript><a href="/noscript-only">nope</a></noscript>
    <!-- <a href="/comment-only">nope</a> -->
    <a href="https://elsewhere.test/away">Away</a>
  </body></html>`;

  const { links, internal, external } = extractLinks(
    stripNonContent(html),
    "https://site.test/",
    "site.test",
  );
  assert.deepEqual(links, ["https://site.test/real"]);
  assert.equal(internal, 1);
  assert.equal(external, 1);
  for (const bad of ["script-only", "style-only", "template-only", "noscript-only", "comment-only", "href"])
    assert.ok(!links.join(" ").includes(bad), `${bad} was extracted as a link`);
});

test("an unclosed script takes the rest of the truncated document with it", () => {
  const cut = `<body><a href="/kept">Kept</a><script>var s = '<a href="/lost">';`;
  const stripped = stripNonContent(cut);
  assert.deepEqual(extractLinks(stripped, "https://site.test/", "site.test").links, [
    "https://site.test/kept",
  ]);
  assert.ok(!stripped.includes("var s"));
});

test("a failure is a page error or a broken link depending on who asked for it", () => {
  assert.equal(failureCode(404, null, "link"), "broken-link");
  assert.equal(failureCode(410, null, "link"), "broken-link");
  assert.equal(failureCode(404, null, "start"), "page-error");
  assert.equal(failureCode(404, null, "sitemap"), "page-error");
  assert.equal(failureCode(403, null, "link"), "page-error");
  assert.equal(failureCode(500, null, "link"), "page-error");
  assert.equal(failureCode(0, "No answer within 10 seconds.", "link"), "page-error");
  assert.equal(failureCode(200, null, "link"), null);
  assert.equal(failureCode(301, null, "start"), null);
  assert.equal(noindexSeverity(true), "error");
  assert.equal(noindexSeverity(false), "notice");
  assert.equal(noindexSeverity(false, true), "error");
});

/* ------------------------------------------------------------ the crawl */

type Route = { status?: number; body?: string; type?: string; location?: string };

const asked: { method: string; url: string }[] = [];

function serve(routes: Record<string, Route>) {
  const real = globalThis.fetch;
  asked.length = 0;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const method = (init?.method ?? "GET").toUpperCase();
    asked.push({ method, url });
    const r: Route = routes[url] ?? { status: 404, body: "<html><title>Not found</title></html>" };
    const headers: Record<string, string> = { "content-type": r.type ?? "text/html; charset=utf-8" };
    if (r.location) headers.location = r.location;
    const status = r.status ?? 200;
    return new Response(method === "HEAD" || status >= 300 && status < 400 ? null : (r.body ?? ""), {
      status,
      headers,
    });
  }) as typeof globalThis.fetch;
  return () => void (globalThis.fetch = real);
}

/** A venture with a website, written straight in: creating one through the API
 *  would enrich it, which is a second crawl of a site that does not exist. */
let seq = 0;
function venture(website: string): string {
  const slug = `audit-test-${++seq}`;
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, 'launched', '#c1663f', 'owner', ?, ?, ?)`,
  ).run(slug, slug, slug, website, new URL(website).hostname, seq, now(), now());
  return slug;
}

const prose = "The support widget answers the questions a customer asks before they buy. ".repeat(4);
const page = (title: string, body: string, extraHead = "") =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta name="description" content="${title} — everything on this page, described at a length Google is happy to print under the link.">` +
  `${extraHead}</head><body><h1>${title}</h1><p>${prose}</p>${body}</body></html>`;

const find = (doc: AuditDoc, code: string, severity: Finding["severity"]) =>
  doc.findings.find((f) => f.code === code && f.severity === severity);

test("a script-embedded href is never crawled, and a link-discovered 404 is a broken link rather than a page error", async () => {
  const site = "https://support.example.test";
  const restore = serve({
    [`${site}/robots.txt`]: { body: `User-agent: *\nDisallow: /cdn-cgi/\nSitemap: ${site}/sitemap.xml\n`, type: "text/plain" },
    [`${site}/sitemap.xml`]: {
      type: "application/xml",
      body:
        `<?xml version="1.0"?><urlset><url><loc>${site}/</loc></url>` +
        `<url><loc>${site}/pricing</loc></url>` +
        `<url><loc>${site}/legacy</loc></url>` +
        `<url><loc>${site}/retired</loc></url></urlset>`,
    },
    "http://support.example.test/": { status: 301, location: `${site}/` },
    [`${site}/`]: {
      body: page(
        "Support Example",
        `<script>
           const card = '<a class="model-card" href="' + href + '">' + name + '</a>';
           document.write('<a href="/script-only">nope</a>');
         </script>
         <noscript><a href="/noscript-only">nope</a></noscript>
         <template><a href="/template-only">nope</a></template>
         <!-- <a href="/comment-only">nope</a> -->
         <a href="/pricing">Pricing</a><a href="/legacy">Legacy</a>
         <a href="/manage">Manage</a><a href="/gone">Gone</a><a href="/retired">Retired</a>
         <a href="https://elsewhere.test/x">Elsewhere</a>`,
        `<link rel="canonical" href="${site}/">`,
      ),
    },
    [`${site}/pricing`]: { body: page("Pricing", "", `<link rel="canonical" href="${site}/pricing">`) },
    [`${site}/legacy`]: {
      body: page("Legacy", "", `<meta name="robots" content="noindex,follow"><link rel="canonical" href="${site}/legacy">`),
    },
    [`${site}/manage`]: {
      body: page("Manage your account", "", `<meta name="robots" content="noindex"><link rel="canonical" href="${site}/manage">`),
    },
    [`${site}/gone`]: { status: 404, body: page("Not found", "") },
    [`${site}/retired`]: { status: 404, body: page("Not found", "") },
  });

  try {
    const doc = (await runAudit(venture(`${site}/`))) as AuditDoc;
    assert.ok(!("error" in doc), JSON.stringify(doc));

    /* Nothing that was not a link was ever asked for. */
    const urls = asked.map((a) => a.url).join(" ");
    for (const bad of ["script-only", "noscript-only", "template-only", "comment-only", "model-card", "href%20"])
      assert.ok(!urls.includes(bad), `${bad} was fetched`);
    const home = doc.pages.find((p) => p.url === `${site}/`)!;
    assert.equal(home.internalLinks, 5);
    assert.equal(home.externalLinks, 1);

    /* The sitemap URL that 404s is the site's own fault; the one only a link
       pointed at is a broken link, and it names the page that links to it. */
    const pageError = find(doc, "page-error", "error")!;
    assert.deepEqual(pageError.pages, [`${site}/retired`]);
    const brokenWarning = find(doc, "broken-link", "warning")!;
    assert.deepEqual(brokenWarning.pages, [`${site}/gone`]);
    assert.equal(find(doc, "broken-link", "error"), undefined);
    const broken = doc.links.broken.find((b) => b.url === `${site}/gone`)!;
    assert.deepEqual(broken.linkedFrom, [`${site}/`]);
    assert.equal(broken.status, 404);
    /* Crawled pages are not HEADed a second time. */
    assert.equal(doc.links.broken.filter((b) => b.url === `${site}/gone`).length, 1);
    assert.equal(asked.filter((a) => a.method === "HEAD" && a.url === `${site}/gone`).length, 0);

    /* A noindex the sitemap contradicts is an error; one it says nothing about
       is a notice. */
    assert.deepEqual(find(doc, "noindex", "error")!.pages, [`${site}/legacy`]);
    assert.deepEqual(find(doc, "noindex", "notice")!.pages, [`${site}/manage`]);
    assert.equal(doc.sitemap.urls, 4);
    assert.ok(doc.sitemap.locs!.includes(`${site}/legacy`));
  } finally {
    restore();
  }
});

test("the start URL failing is a page error whatever the status", async () => {
  const site = "https://video.example.test";
  const restore = serve({
    [`${site}/robots.txt`]: { status: 404, body: "no" },
    [`${site}/`]: { status: 500, body: "<html><body>Application error</body></html>" },
    "http://video.example.test/": { status: 301, location: `${site}/` },
  });
  try {
    const doc = (await runAudit(venture(`${site}/`))) as AuditDoc;
    assert.ok(!("error" in doc), JSON.stringify(doc));
    assert.deepEqual(find(doc, "page-error", "error")!.pages, [`${site}/`]);
    assert.equal(find(doc, "broken-link", "warning"), undefined);
    assert.equal(doc.links.broken.length, 0);
    assert.equal(doc.sitemap.found, null);
  } finally {
    restore();
  }
});
