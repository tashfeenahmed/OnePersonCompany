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

const ob1 = parseProducts("OB-1 = overbrilliant.com")[0]!;
const planintel = parseProducts("PlanIntel = planintel.ie")[0]!;

test("a short name is only corroborated by the host or the host stem", () => {
  assert.equal(corroborates("An off-by-one error is a logic error", ob1), false);
  assert.equal(corroborates("OB-1 is a terminal coding agent by Overbrilliant", ob1), true);
  assert.equal(corroborates("see overbrilliant.com", ob1), true);
  assert.equal(corroborates("PlanIntel is an Irish planning search", planintel), true);
});

test("wikipedia: a redirect to an unrelated article is not presence", async () => {
  serve([["page/summary/OB-1", { type: "standard", title: "Off-by-one error", description: "Logical error", extract: "An off-by-one error…", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Off-by-one_error" } } }]]);
  const f = await wikipedia(ob1);
  assert.equal(f.status, "absent");
  assert.match(f.note ?? "", /Off-by-one error/);
});

test("wikipedia: a distinctive name's own article is still present", async () => {
  serve([["page/summary/PlanIntel", { type: "standard", title: "PlanIntel", extract: "PlanIntel is a planning search.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/PlanIntel" } } }]]);
  assert.equal((await wikipedia(planintel)).status, "present");
});

test("wikidata: an exact label on a short name needs a description about the product", async () => {
  serve([["wikidata.org", { search: [{ label: "OB-1", description: "ship built in 1979", concepturi: "http://www.wikidata.org/entity/Q122794233" }] }]]);
  const f = await wikidata(ob1);
  assert.equal(f.status, "absent");
});

test("github: the host-stem account's repo with our homepage is found", async () => {
  serve([
    ["q=user%3Aoverbrilliant", { items: [{ full_name: "Overbrilliant/ob-1", description: "coding agent", homepage: "https://overbrilliant.com", html_url: "https://github.com/Overbrilliant/ob-1" }] }],
    ["search/repositories", { items: [{ full_name: "someone/ob-1-wan", description: "star wars", homepage: null, html_url: "https://github.com/someone/ob-1-wan" }] }],
  ]);
  const f = await github(ob1, needles(ob1));
  assert.equal(f.status, "present");
  assert.equal(f.url, "https://github.com/Overbrilliant/ob-1");
});
