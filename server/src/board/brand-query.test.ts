/**
 * WHAT IS TESTED HERE, AND WHAT DELIBERATELY IS NOT.
 *
 * The verdict is a model's and is not asserted. The file this replaced asserted
 * verdicts — that `freellmap` is brand and `best free llm api` is not — because
 * the gate was a spelling comparison and the comparison was the thing to pin.
 * Those assertions cannot survive the move to a judgment: a test that pins
 * `freellmapi github` to `brand` against a stubbed reply is testing the stub,
 * and against a live model it is a test that fails when a GPU is busy. The one
 * thing it would prove — that the model reads search intent the way the owner
 * does — is proved by the `gate_verdicts` rows on a real night, not here.
 *
 * What is tested is everything around the judgment, which is where an LLM gate
 * actually fails: the two facts that must never reach a model, that the whole
 * sweep is ONE call, that the venture roster is really in the prompt, that
 * verdicts key back to the caller's own rows, and — the one that matters most —
 * that a sweep with nothing to answer it judges nothing rather than everything.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { recentVerdicts } from "../models/judge.ts";
import { registerProvider, setProviderChoiceReader } from "../models/provider.ts";
import {
  BRAND_QUERY_GATE, QUERIES_JUDGED_PER_SWEEP, SEARCH_INTENTS, judgeSearchIntent, navigationalByFact, queryKey,
} from "./brand-query.ts";

const freellmapi = { name: "FreeLLMAPI", slug: "freellmapi", host: "freellmapi.co" };
/* Stored as Search Console returns it, prefix and all, because that is what a
   venture row actually carries. */
const neu = { name: "Neu", slug: "neu", host: "sc-domain:neu.ie" };
const brands = [freellmapi, neu];

/**
 * A MODEL ON THE WIRE, answering with whatever `verdict` says for each key it
 * was given. Everything between here and the reply is the real code path: the
 * real provider, the real request body, the real `readJudgement`.
 */
function stubModel(verdict: (key: string) => string | null) {
  const original = globalThis.fetch;
  const sent: { system: string; user: string; keys: string[] }[] = [];
  registerProvider("local", () => ({
    id: "local", label: "Test model", defaultModel: "test-judge",
    endpoints: [{ baseUrl: "https://local.invalid/v1", key: null, label: "Test" }],
    policy: { mode: "parallel", concurrency: 1, balance: "round-robin", timeoutMs: 1000 },
  }));
  setProviderChoiceReader(() => "local");
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages.find(m => m.role === "user")?.content ?? "";
    const keys = [...user.matchAll(/^key: (.+)$/gm)].map(m => m[1]!);
    sent.push({ system: body.messages.filter(m => m.role === "system").map(m => m.content).join("\n"), user, keys });
    const verdicts = keys.map(key => ({ key, verdict: verdict(key), why: "a test reply" })).filter(v => v.verdict);
    return Response.json({
      choices: [{ message: { role: "assistant", content: JSON.stringify({ verdicts }) }, finish_reason: "stop" }],
      model: "test-judge", usage: { prompt_tokens: 10, completion_tokens: 10 },
    });
  };
  return { sent, restore: () => { globalThis.fetch = original; setProviderChoiceReader(() => null); } };
}

beforeEach(() => {
  db.exec("DELETE FROM gate_verdicts");
  setProviderChoiceReader(() => null);
});

test("the two facts are settled in code and never put to a model", async () => {
  /* A `site:` operator is what the searcher DID, and a query that is exactly one
     of our hostnames is an address typed into the search box. Both hold with no
     model reachable at all, which is the state of this test process. */
  const intents = await judgeSearchIntent(
    ["site:freellmapi.co", "site:anything.example", "freellmapi.co", "https://freellmapi.co/", "www.neu.ie", "NEU.IE"],
    brands,
  );
  for (const [key, intent] of intents) assert.equal(intent, "brand", `expected brand by fact: ${key}`);
  assert.equal(recentVerdicts(BRAND_QUERY_GATE).length, 0, "a fact is not a verdict and is not recorded as one");
});

test("the factual check stops at equality and does not reach for meaning", () => {
  /* The moment this starts answering "nearly our hostname" it is the edit
     distance gate again, and `free llm api` is why that gate had to go. */
  for (const query of ["freellmapi", "freellmapi github", "freelmapi", "free llm api", "neu", ""]) {
    assert.equal(navigationalByFact(query, brands), false, `not a fact: ${query}`);
  }
  assert.equal(navigationalByFact("freellmapi.co", [{ name: "Other", slug: "other", host: "other.test" }]), false);
});

test("with no model reachable nothing is a need, and the silence is on the record", async () => {
  const intents = await judgeSearchIntent(["free llm api", "openrouter alternative"], brands);
  assert.deepEqual([...intents.values()], ["unjudged", "unjudged"]);
  /* THE POINT OF THE WHOLE EXERCISE. `growthCandidates` files only on `need`, so
     a busy GPU costs one sweep instead of filling the board with the brand head
     — and unlike a filed card, an unfiled row is offered again tomorrow. */
  assert.ok([...intents.values()].every(v => v !== "need"), "nothing is filed on a failure to judge");
  const logged = recentVerdicts(BRAND_QUERY_GATE);
  assert.equal(logged.length, 2, "a gate that stopped judging must not look like a gate that approves");
  assert.equal(logged[0]!.verdict, "unjudged");
});

test("one call carries the whole sweep, with every venture's names as its context", async () => {
  const model = stubModel(() => "need");
  try {
    const queries = ["free llm api", "openrouter alternative", "llm router", "planning application search", "note taking app"];
    const intents = await judgeSearchIntent(queries, brands);
    assert.equal(model.sent.length, 1, "one round trip for the batch, not one per query");
    assert.deepEqual(model.sent[0]!.keys, queries);
    for (const name of ["FreeLLMAPI", "freellmapi", "freellmapi.co", "Neu", "neu.ie"]) {
      assert.ok(model.sent[0]!.user.includes(name), `the roster is missing ${name}`);
    }
    /* The stored prefix is Search Console's bookkeeping, not part of a name. */
    assert.ok(!model.sent[0]!.user.includes("sc-domain:"), "the property prefix was passed through as if it were a name");
    /* The question has to carry both words and the lean, or the model cannot
       answer inside the vocabulary and cannot know which way to fall. */
    for (const phrase of [...SEARCH_INTENTS.map(word => `"${word}"`), "CANNOT TELL"]) {
      assert.ok(model.sent[0]!.system.includes(phrase), `the question is missing ${phrase}`);
    }
    assert.equal(intents.get("free llm api"), "need");
    assert.equal(recentVerdicts(BRAND_QUERY_GATE).length, 5, "every verdict is recorded, not just the refusals");
  } finally { model.restore(); }
});

test("a query is asked once however Search Console spelled it, and keys back to either spelling", async () => {
  const model = stubModel(() => "need");
  try {
    const intents = await judgeSearchIntent(["Free LLM API", "  free   llm api ", "free llm api"], brands);
    assert.equal(model.sent[0]!.keys.length, 1, "three spellings of one query are one question");
    assert.equal(intents.size, 1);
    assert.equal(intents.get(queryKey("FREE llm API")), "need");
  } finally { model.restore(); }
});

test("a reply that skips an item, or invents a word, judges nothing at all", async () => {
  /* Both are the same failure seen from downstream: half a batch applied and the
     rest defaulted reads exactly like a model that let the rest through. */
  const partial = stubModel(key => (key === "free llm api" ? "need" : null));
  try {
    const intents = await judgeSearchIntent(["free llm api", "llm router"], brands);
    assert.deepEqual([...intents.values()], ["unjudged", "unjudged"]);
    assert.equal(partial.sent.length, 2, "one retry, then it gives up rather than guessing");
  } finally { partial.restore(); }

  const invented = stubModel(() => "probably brand");
  try {
    const intents = await judgeSearchIntent(["free llm api"], brands);
    assert.equal(intents.get("free llm api"), "unjudged");
  } finally { invented.restore(); }
});

test("a sweep asks about at most one batch, and an unasked query is not a need", async () => {
  const model = stubModel(() => "need");
  try {
    const queries = Array.from({ length: QUERIES_JUDGED_PER_SWEEP + 12 }, (_, i) => `measured query ${i}`);
    const intents = await judgeSearchIntent(queries, brands);
    assert.equal(model.sent.length, 1);
    assert.equal(model.sent[0]!.keys.length, QUERIES_JUDGED_PER_SWEEP, "the reply has to cover every item it is given");
    assert.equal(intents.get(queries[0]!), "need");
    assert.equal(intents.get(queries.at(-1)!), "unjudged", "past the batch nothing is filed");
  } finally { model.restore(); }
});
