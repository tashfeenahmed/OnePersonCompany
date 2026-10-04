import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { corroborates, github, needles, parseProducts, wikidata, wikipedia } from "./sources.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers each request by the first route whose fragment is in the URL. */
function serve(routes: [string, unknown][]) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const zb1 = parseProducts("ZB-1 = zebrabyte.example")[0]!;
const planwise = parseProducts("Planwise = planwise.example")[0]!;

test("a short name is only corroborated by the host or the host stem", () => {
  assert.equal(corroborates("An an unrelated article is a logic error", zb1), false);
  assert.equal(corroborates("ZB-1 is a terminal coding agent by Zebrabyte", zb1), true);
  assert.equal(corroborates("see zebrabyte.example", zb1), true);
  assert.equal(corroborates("Planwise is a planning search", planwise), true);
});

test("wikipedia: a redirect to an unrelated article is not presence", async () => {
  serve([["page/summary/ZB-1", { type: "standard", title: "Zettabyte", description: "Logical error", extract: "An an unrelated article…", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Off-by-one_error" } } }]]);
  const f = await wikipedia(zb1);
  assert.equal(f.status, "absent");
  assert.match(f.note ?? "", /Zettabyte/);
});

test("wikipedia: a distinctive name's own article is still present", async () => {
  serve([["page/summary/Planwise", { type: "standard", title: "Planwise", extract: "Planwise is a planning search.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Planwise" } } }]]);
  assert.equal((await wikipedia(planwise)).status, "present");
});

test("wikidata: an exact label on a short name needs a description about the product", async () => {
  serve([["wikidata.org", { search: [{ label: "ZB-1", description: "ship built in 1979", concepturi: "http://www.wikidata.org/entity/Q1000001" }] }]]);
  const f = await wikidata(zb1);
  assert.equal(f.status, "absent");
});

test("github: the host-stem account's repo with our homepage is found", async () => {
  serve([
    ["q=user%3Azebrabyte", { items: [{ full_name: "Zebrabyte/zb-1", description: "coding agent", homepage: "https://zebrabyte.example", html_url: "https://github.com/Zebrabyte/zb-1" }] }],
    ["search/repositories", { items: [{ full_name: "someone/zb-1-wan", description: "star wars", homepage: null, html_url: "https://github.com/someone/zb-1-wan" }] }],
  ]);
  const f = await github(zb1, needles(zb1));
  assert.equal(f.status, "present");
  assert.equal(f.url, "https://github.com/Zebrabyte/zb-1");
});
