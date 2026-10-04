import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now, setConfig, upsertPlugin, ventureRowById } from "../../db.ts";
import {
  SAVED_QUERIES_KEY,
  SAVED_QUERIES_PLUGIN,
  describedQueries,
  parseSavedQueries,
  pickQueries,
  propertyFor,
  teardownWorthy,
} from "./serp.ts";

function venture(slug: string, name: string, host: string, description: string) {
  const id = `v-${slug}`;
  db.prepare(
    "INSERT INTO ventures(id,slug,name,description,website,host,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, slug, name, description, `https://${host}`, host, "launched", "#123456", "owner", now(), now(), 0, "{}");
  return ventureRowById(id)!;
}

let account: number | null = null;
function property(prop: string, queries: [string, number, number][]) {
  if (account === null) {
    upsertPlugin("gsc", true);
    account = Number(
      db
        .prepare("INSERT INTO plugin_accounts(plugin_id,label,connected,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run("gsc", "Account 1", 1, now(), now()).lastInsertRowid,
    );
  }
  db.prepare("INSERT INTO gsc_sites(property,account_id,account_label,seen_at) VALUES(?,?,?,?)").run(prop, account, "Account 1", now());
  for (const [query, impressions, position] of queries)
    db.prepare("INSERT INTO gsc_queries(property,query,clicks,impressions,ctr,position,seen_at) VALUES(?,?,?,?,?,?,?)").run(
      prop, query, 0, impressions, 0, position, now(),
    );
}

test("a subdomain venture does not inherit its parent domain's Search Console queries", () => {
  property("sc-domain:studio.example", [["neu sotwe", 40, 8], ["studio software agency", 30, 9]]);
  assert.equal(propertyFor("studio.example"), "sc-domain:studio.example");
  assert.equal(propertyFor("www.studio.example"), "sc-domain:studio.example", "www. is the same site");
  assert.equal(propertyFor("notes.studio.example"), null, "a product on a subdomain is not the studio");

  const v = venture("notes-app", "Notes App", "notes.studio.example", "Ask questions about your notes on iPhone. Private.");
  const picked = pickQueries(v, "");
  assert.ok(picked.every((q) => q.source === "description"), JSON.stringify(picked));
  assert.ok(!picked.some((q) => q.query === "neu sotwe"));
});

test("single-word and test-traffic queries are not torn down", () => {
  assert.equal(teardownWorthy("neu"), false);
  assert.equal(teardownWorthy("scallop ai"), false, "'ai' is under three letters, so one countable word");
  assert.equal(teardownWorthy('"agent smoke027786" "example.com"'), false);
  assert.equal(teardownWorthy("planning permission search"), true);
  assert.equal(teardownWorthy("best apps 2026"), true, "a year is not test traffic");
});

test("the striking band skips junk, then falls back to the busiest multi-word queries at any position", () => {
  property("sc-domain:shop.example", [
    ["shop", 90, 6],
    ["agent smoke027786 example.com", 50, 7],
    ["shop opening hours dublin", 12, 11],
  ]);
  const shop = venture("shop", "Shop", "shop.example", "A shop.");
  assert.deepEqual(pickQueries(shop, "").map((q) => [q.query, q.source]), [["shop opening hours dublin", "gsc"]]);

  property("sc-domain:far.example", [["far", 90, 6], ["far away product page", 20, 41]]);
  const far = venture("far", "Far", "far.example", "Far.");
  const picked = pickQueries(far, "");
  assert.deepEqual(picked.map((q) => [q.query, q.source, q.gscPosition]), [["far away product page", "gsc", 41]]);
});

test("saved queries win over Search Console and the description; typed queries win over saved ones", () => {
  property("sc-domain:saved.example", [["saved product search", 30, 8]]);
  const v = venture("saved-one", "Saved One", "saved.example", "A product that is saved.");
  setConfig(SAVED_QUERIES_PLUGIN, SAVED_QUERIES_KEY, "# comment\nsaved one = first query here | second query here\nOther = x y");
  assert.deepEqual(pickQueries(v, "").map((q) => [q.query, q.source]), [
    ["first query here", "owner"],
    ["second query here", "owner"],
  ]);
  assert.deepEqual(pickQueries(v, "typed query now").map((q) => q.query), ["typed query now"]);
  setConfig(SAVED_QUERIES_PLUGIN, SAVED_QUERIES_KEY, "saved-one = by slug query");
  assert.deepEqual(pickQueries(v, "").map((q) => q.query), ["by slug query"], "the slug works as the name");
  setConfig(SAVED_QUERIES_PLUGIN, SAVED_QUERIES_KEY, "");
  assert.deepEqual(pickQueries(v, "").map((q) => [q.query, q.source]), [["saved product search", "gsc"]]);
});

test("the saved-queries format", () => {
  const m = parseSavedQueries("Sosho = a b | c d\n\nno equals sign\n= orphan\nSosho = e f");
  assert.deepEqual([...m.entries()], [["sosho", ["a b", "c d", "e f"]]]);
});

test("the description fallback derives a multi-word query labelled description", () => {
  const v = venture(
    "scallop",
    "ScallopBot",
    "scallop.example",
    "ScallopBot is a self-hosted AI assistant that remembers. It runs on a Pi.",
  );
  const picked = describedQueries(v, 2);
  assert.equal(picked[0]!.source, "description");
  assert.ok(picked[0]!.query.split(" ").length >= 2, picked[0]!.query);
  assert.ok(teardownWorthy(picked[0]!.query));
});
