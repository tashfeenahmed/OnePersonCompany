/**
 * THE PIECES OF THIS AREA THAT CAN BE ASSERTED AT ALL.
 *
 * THE NOVELTY GATE IS A MODEL'S JUDGMENT SINCE 2026-09-21, so what is tested
 * about it CHANGED SHAPE. It used to be arithmetic and this file used to assert
 * the arithmetic — including, in as many words, that "exam prep with an AI
 * tutor" is the same piece of work as "AI tutoring for exams" because two stems
 * matched. That test passed for a year while being a claim about MEANING that a
 * stemmer had no way to make, and it is exactly the assertion that made a word
 * list look correct. It is gone.
 *
 * WHAT IS TESTED NOW IS EVERYTHING AROUND THE JUDGMENT, which is where an LLM
 * gate actually fails: the branches that must never reach a model (no topic, a
 * window of zero, an empty history, a word-for-word duplicate), the wiring (ONE
 * judge call per check, recorded once, keyed by the topic), and above all THE
 * LEAN AND THE FAIL-OPEN — with no provider in a test process, every path that
 * asks a model must ALLOW the generation and say so. That is the production
 * case of a busy GPU, and it is the direction this gate is deliberately wrong
 * in: a wrong refusal stops the owner's autopilot silently, a wrong allow costs
 * one duplicate video.
 *
 * The model's own similarity verdicts are NOT asserted anywhere. A test pinning
 * one would be testing the model, would pass against a stub, and would be the
 * old mistake with a new spelling.
 *
 * The ranking and the small parsers below are still pure arithmetic — duration
 * fit, recency, engine agreement, a video id — and are still asserted as such,
 * because none of them is a question a competent person could answer two ways.
 *
 * The two that spend money are not tested here and cannot be: `animate` calls
 * Replicate and `discover` calls a search node. What IS asserted about the
 * expensive path is the thing that matters — that with no model configured the
 * animation step returns `skipped` and never opens a connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../db.ts";
import { recentVerdicts } from "../../models/judge.ts";
import {
  checkTopic,
  forget,
  judgeTopic,
  normalise,
  NOVELTY_GATE,
  reindex,
  remember,
} from "./novelty.ts";
import { pagePosts, POST_INSIGHT_METRICS } from "../../providers/meta.ts";
import { parseChannels, parseDuration, rank, videoId, type RawCandidate } from "./sourcing.ts";
import { animate } from "./ugc.ts";

/* ------------------------------------------------- the exact-match key */

test("the key folds capitals, punctuation and spacing, because those are one string", () => {
  assert.equal(normalise("  The BEST way — to make a chatbot!! "), "the best way to make a chatbot");
  assert.equal(normalise("Pricing: explained"), normalise("pricing explained"));
});

test("the key drops NOTHING and re-orders NOTHING — it is not a fingerprint", () => {
  /* THIS IS THE CONVERSION, ASSERTED. The old normaliser dropped stop words,
     stemmed what was left and SORTED it, so these pairs collapsed into one
     token string and the gate then called them the same piece of work by
     counting. Whether they are is a judgment and belongs to the model; all this
     function may say is whether the two strings are the same string. */
  assert.notEqual(normalise("tutoring"), normalise("tutors"));
  assert.notEqual(normalise("planning permission guide"), normalise("guide to planning permission"));
  assert.notEqual(normalise("why we changed our pricing"), normalise("our pricing, explained"));
  assert.ok(normalise("the best way to make a chatbot").includes("the best way"));
});

test("a URL is part of the string rather than being deleted from it", () => {
  /* The old fingerprint removed URLs whole, because a link supplied a dozen
     tokens of host and path and swamped the overlap score. There is no score
     any more, and for an EXACT match a link is simply part of what was written. */
  assert.equal(normalise("chatbot https://example.com/x?q=1"), "chatbot https example com x q 1");
});

test("a non-Latin topic keys to something rather than to nothing", () => {
  /* THIS IS THE REGRESSION, AND IT IS WORTH KEEPING THROUGH THE CONVERSION.
     `[^a-z0-9\s]` does not mean "drop punctuation", it means "drop every letter
     that is not English" — so both of these came out as the empty string, and an
     empty string was read as a refusal. On an install whose model answers in
     Russian or Japanese the gate refused 100% of topics, forever. */
  assert.equal(normalise("Как обрабатывать повторяющиеся вопросы"), "как обрабатывать повторяющиеся вопросы");
  /* Japanese has no spaces to collapse and every character here is a letter,
     so the string survives whole. That is the honest answer for an exact-match
     key: it is not this function's job to segment a script it cannot read. */
  assert.equal(normalise("日本語のトピック"), "日本語のトピック");
});

test("Japanese dakuten survive — ピ must not become ヒ", () => {
  /* Stripping `\p{M}` wholesale would take the dakuten off with the accents,
     turning a `pi` into a `hi`: a different sound and a different word. Only
     the Latin/Greek/Cyrillic combining block is removed, and NFC puts back
     anything that was decomposed and not stripped. */
  assert.ok(normalise("トピック").includes("ピ"));
});

test("accents are normalised away, so gérer and gerer are one string", () => {
  assert.equal(normalise("gérer les demandes répétitives"), normalise("gerer les demandes repetitives"));
  /* And they are not MANGLED, which is what the old normaliser did: it turned
     "répétitives" into "titiv" by deleting the accented letters mid-word. */
  assert.ok(normalise("répétitives").startsWith("repeti"), normalise("répétitives"));
});

/* ------------------------------------------------------------- the gate */

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

const row = (id: number, topic: string, at: string) => ({
  id,
  topic,
  fingerprint: normalise(topic),
  created_at: at,
});

/** Every gate verdict recorded since this file started, newest first. The judge
 *  writes one row per item it was asked about, so this is also the count of
 *  what was PUT to a model. */
const judged = () => recentVerdicts(NOVELTY_GATE, 50);

test("a brief with no words in it is refused as a fact, and no model is asked", async () => {
  const before = judged().length;
  const v = await judgeTopic("  —  !! ", [], { days: 30 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no topic to compare/);
  assert.equal(judged().length, before, "there was nothing to judge, so nothing was asked");
});

test("a window of zero days switches the topic check off entirely, without a model", async () => {
  const before = judged().length;
  const history = [row(7, "AI tutoring for exam preparation", day(19))];
  const v = await judgeTopic("AI tutoring for exam preparation", history, {
    days: 0,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /zero days/);
  assert.equal(judged().length, before, "a switched-off gate must not spend a round trip");
});

test("an empty history is an allow, and no model is asked to compare with nothing", async () => {
  const before = judged().length;
  const v = await judgeTopic("how identity verification works for tutors", [], {
    days: 30,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /nothing this could repeat/);
  assert.equal(judged().length, before);
});

test("a word-for-word duplicate is refused by string equality, before any model", async () => {
  /* AN EXACT MATCH IS A FACT AND NOT A JUDGEMENT, so it stays in code — and it
     is the one refusal that can still name the row it clashed with, which is
     why `matched` is filled here and null on a model's verdict. */
  const before = judged().length;
  const history = [row(7, "AI tutoring for exam preparation", day(19))];
  const v = await judgeTopic("  ai TUTORING for exam preparation!  ", history, {
    days: 30,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /word-for-word/);
  assert.equal(v.matched?.id, 7);
  assert.equal(v.matched?.score, 1);
  assert.equal(judged().length, before, "an identical string needs no model");
});

test("the same topic outside the window is never shown to the judge at all", async () => {
  const before = judged().length;
  const history = [row(7, "AI tutoring for exam preparation", day(1))];
  const v = await judgeTopic("AI tutoring for exam preparation", history, {
    days: 5,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true, "a business may make the same point twice a year");
  assert.equal(v.matched, null);
  assert.equal(judged().length, before);
});

test("with no model reachable the topic is ALLOWED and recorded as unjudged", async () => {
  /* THE LEAN, AND THE WHOLE REASON IT IS STATED. There is no provider in a test
     process, which is the production case of a busy or missing GPU. A gate that
     refused here would stop the owner's autopilot producing anything, night
     after night, and report the outage to nobody. */
  const before = judged().length;
  const history = [row(7, "AI tutoring for exam preparation", day(19))];
  const v = await judgeTopic("how identity verification works for tutors", history, {
    days: 30,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /ALLOWED rather than refused/);
  assert.match(v.reason, /unjudged/);
  assert.equal(v.matched, null);

  const rows = judged();
  assert.equal(rows.length - before, 1, "exactly one verdict recorded, so the failure is visible");
  assert.equal(rows[0]!.verdict, "unjudged");
});

test("one check is ONE judge call, whatever the history holds", async () => {
  /* The candidate is the item and the history is the context. A call per
     history row would be forty round trips for one question — and a model shown
     one old topic at a time cannot notice that three of them are one subject. */
  const before = judged().length;
  const history = [
    row(1, "tutoring exams without pricing", day(14)),
    row(2, "tutoring exams payment", day(15)),
    row(3, "what our tutors are paid", day(16)),
    row(4, "how a lesson is booked", day(17)),
  ];
  const v = await judgeTopic("a parent's first week with us", history, {
    days: 30,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
  const rows = judged();
  assert.equal(rows.length - before, 1, "one item judged, not one per history row");
  assert.equal(rows[0]!.subject, "a parent's first week with us", "recorded under the topic itself");
});

/* --------------------------------------------- the gate against the table */

test("checkTopic reads the venture's live history, refuses an exact repeat and writes it down", async () => {
  const venture = "v-novelty-exact";
  remember({ ventureId: venture, format: "post", topic: "Why we changed our pricing" });

  const repeated = await checkTopic(venture, "post", "why we changed our pricing!");
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /word-for-word/);

  const check = db
    .prepare("SELECT * FROM novelty_checks WHERE venture_id = ? ORDER BY id DESC LIMIT 1")
    .get(venture) as { verdict: string; score: number | null; fingerprint: string | null };
  assert.equal(check.verdict, "refuse");
  assert.equal(check.score, 1, "1 is the exact-duplicate fact; a model's verdict has no score");
  assert.equal(check.fingerprint, "why we changed our pricing");

  /* A DIFFERENT FORMAT IS A DIFFERENT LEDGER. The same subject as a post and as
     a video is two pieces of work, so the video side sees no history at all. */
  const asVideo = await checkTopic(venture, "faceless", "why we changed our pricing");
  assert.equal(asVideo.ok, true);
});

test("an archived history entry is not put to the judge, which is what archiving IS", async () => {
  const venture = "v-novelty-archived";
  const entry = remember({ ventureId: venture, format: "post", topic: "The one about onboarding" });
  const refused = await checkTopic(venture, "post", "the one about onboarding");
  assert.equal(refused.ok, false, "an exact repeat while the entry is live");

  forget(entry.id);
  const allowed = await checkTopic(venture, "post", "the one about onboarding");
  assert.equal(allowed.ok, true, "archiving is how the owner overrules the gate");
  assert.match(allowed.reason, /nothing this could repeat/);
});

test("a stored key is brought back into step by the reindex", () => {
  /* WHY THE REINDEX SURVIVED THE CONVERSION. The column is a cache of a pure
     function of the topic, and that function was REPLACED: it used to be sorted
     stems and it is now the exact-match key. A row written before the change
     holds a string nothing will ever equal, so the free word-for-word check
     would see straight past a topic proposed twice. */
  const venture = "v-novelty-reindex";
  const entry = remember({ ventureId: venture, format: "post", topic: "Our new pricing page" });
  db.prepare("UPDATE content_history SET fingerprint = ? WHERE id = ?").run("new page price", entry.id);

  const changed = reindex();
  assert.ok(changed >= 1);
  const after = db.prepare("SELECT fingerprint FROM content_history WHERE id = ?").get(entry.id) as {
    fingerprint: string;
  };
  assert.equal(after.fingerprint, "our new pricing page");
  /* Idempotent: a second pass over rows that already agree writes nothing. */
  assert.equal(reindex(), 0);
});

/* ---------------------------------------------------------- the ranking */

const candidate = (over: Partial<RawCandidate>): RawCandidate => ({
  url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  title: "A talk",
  author: null,
  engine: "youtube",
  engines: ["youtube"],
  publishedAt: null,
  durationS: 1200,
  durationFrom: "searxng",
  ...over,
});

const band = { minSeconds: 180, maxSeconds: 5400, used: new Set<string>() };

test("a source under the floor is refused for being under the floor", () => {
  const [r] = rank([candidate({ durationS: 30 })], band);
  assert.equal(r!.verdict, "refused");
  assert.match(r!.reason!, /under the 3 min floor/);
});

test("a source over the ceiling is refused for being over the ceiling", () => {
  const [r] = rank([candidate({ durationS: 20_000 })], band);
  assert.equal(r!.verdict, "refused");
  assert.match(r!.reason!, /over the 90 min ceiling/);
});

test("a source already used is refused before its duration is considered", () => {
  /* The order of the checks is part of the answer: somebody reading "already
     used" wants that before "and also too short". */
  const used = new Set(["aaaaaaaaaaa"]);
  const [r] = rank([candidate({ durationS: 30 })], { ...band, used });
  assert.equal(r!.verdict, "refused");
  assert.match(r!.reason!, /already used/);
});

test("a source is matched by video id, not by the spelling of its URL", () => {
  const used = new Set(["aaaaaaaaaaa"]);
  const [r] = rank([candidate({ url: "https://youtu.be/aaaaaaaaaaa" })], { ...band, used });
  assert.equal(r!.verdict, "refused");
  assert.match(r!.reason!, /already used/);
});

test("eligible candidates sort above refused ones whatever their score", () => {
  const out = rank(
    [candidate({ url: "https://youtu.be/short", durationS: 10 }), candidate({ url: "https://youtu.be/good" })],
    band,
  );
  assert.equal(out[0]!.verdict, "eligible");
  assert.equal(out[1]!.verdict, "refused");
  /* Refused rows are KEPT so the page can show why. */
  assert.equal(out.length, 2);
});

test("a duration nearer the middle of the band outranks one at its edge", () => {
  const mid = candidate({ url: "https://youtu.be/mid", durationS: 2790 });
  const edge = candidate({ url: "https://youtu.be/edge", durationS: 200 });
  const out = rank([edge, mid], band);
  assert.equal(out[0]!.url, "https://youtu.be/mid");
});

test("a recent video outranks an old one of the same length", () => {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const fresh = candidate({ url: "https://youtu.be/fresh", publishedAt: "2025-12-01" });
  const old = candidate({ url: "https://youtu.be/old", publishedAt: "2020-01-01" });
  const out = rank([old, fresh], { ...band, at });
  assert.equal(out[0]!.url, "https://youtu.be/fresh");
});

test("an unmeasured duration scores as unknown rather than as bad", () => {
  /* Half the engines publish no length. Treating that as zero would rank every
     one of their results last for a fact about the engine. */
  const unknown = rank([candidate({ url: "https://youtu.be/x", durationS: null, durationFrom: null })], band)[0]!;
  const edge = rank([candidate({ url: "https://youtu.be/y", durationS: 200 })], band)[0]!;
  assert.equal(unknown.verdict, "eligible");
  assert.ok(unknown.score > edge.score);
});

/* --------------------------------------------------------- small parsers */

test("a duration is read from either shape an engine sends", () => {
  assert.equal(parseDuration("40:11"), 2411);
  assert.equal(parseDuration("1:02:33"), 3753);
  assert.equal(parseDuration(2002), 2002);
  assert.equal(parseDuration("2002"), 2002);
  /* Null means the engine did not say — never zero, which would be a claim. */
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("live"), null);
});

test("a video id is read out of every spelling YouTube uses", () => {
  assert.equal(videoId("https://www.youtube.com/watch?v=abc123"), "abc123");
  assert.equal(videoId("https://youtu.be/abc123"), "abc123");
  assert.equal(videoId("https://www.youtube.com/shorts/abc123"), "abc123");
  assert.equal(videoId("https://www.youtube-nocookie.com/embed/abc123"), "abc123");
  /* A host this does not know is compared by URL instead, which is weaker and
     is the honest fallback rather than a guess. */
  assert.equal(videoId("https://example.com/talk"), null);
});

test("the per-venture channel setting takes slug = url lines and ignores the rest", () => {
  const parsed = parseChannels(
    ["# a comment", "acme = https://www.youtube.com/@acme", "  Beta=https://youtube.com/@beta ", "broken", "x = notaurl"].join("\n"),
  );
  assert.deepEqual(parsed, {
    acme: "https://www.youtube.com/@acme",
    beta: "https://youtube.com/@beta",
  });
});

/* ------------------------- P1: one dead metric must not kill the timeline (3) */

/** A fake Graph. `fetch` is global, so the test swaps it, and every call is
 *  recorded so the assertions can be about WHAT WAS ASKED and not only about
 *  what came back. */
function fakeGraph(reply: (url: string) => { status: number; body: unknown }) {
  const calls: { url: string; auth: string | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, auth: headers.get("authorization") });
    const { status, body } = reply(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const METRIC_400 = {
  error: { message: "(#100) The value must be a valid insights metric", type: "OAuthException", code: 100 },
};

test("a retired metric costs the engagement figures, not the whole timeline", async () => {
  /* THIS IS THE REGRESSION. Insights ride on the posts edge as ONE field
     expansion, so a single retired metric name answers 400 and takes every
     post with it — which is exactly what the `post_impressions` family did on
     15 November 2025. Before this fix the Page simply stopped updating. */
  const graph = fakeGraph((url) =>
    url.includes(encodeURIComponent("insights.metric"))
      ? { status: 400, body: METRIC_400 }
      : { status: 200, body: { data: [{ id: "p1", message: "hello", created_time: "2026-09-06T12:00:00+0000" }] } },
  );
  try {
    const read = await pagePosts("123", "PAGE-TOKEN", 5);
    assert.equal(read.ok, true, "the posts must survive a dead metric");
    assert.equal(read.posts.length, 1);
    assert.equal(read.error, null);
    /* The gap is NAMED rather than silently absent. */
    assert.match(read.insightsError ?? "", /valid insights metric/);
    assert.match(read.insightsError ?? "", /engagement figures are not/);
    /* Exactly two requests: the one with insights, then the one without. */
    assert.equal(graph.calls.length, 2);
    assert.ok(graph.calls[0]!.url.includes(encodeURIComponent("insights.metric")));
    assert.ok(!graph.calls[1]!.url.includes(encodeURIComponent("insights.metric")));
  } finally {
    graph.restore();
  }
});

test("a permission refusal is NOT retried — it would fail identically", async () => {
  const graph = fakeGraph(() => ({
    status: 403,
    body: { error: { message: "(#210) This call requires a Page access token", code: 210 } },
  }));
  try {
    const read = await pagePosts("123", "PAGE-TOKEN", 5);
    assert.equal(read.ok, false);
    assert.match(read.error ?? "", /Page access token/);
    assert.equal(graph.calls.length, 1, "a second request would spend somebody's rate limit to learn the same thing");
  } finally {
    graph.restore();
  }
});

test("the Page token travels in the Authorization header and never in the URL", async () => {
  /* providers/meta.ts states this rule for its own reasons — a credential in a
     URL is a credential in an access log, a Referer and every error message
     that echoes the request. These two reads were written breaking it. */
  const graph = fakeGraph(() => ({ status: 200, body: { data: [] } }));
  try {
    await pagePosts("123", "SECRET-PAGE-TOKEN", 5);
    assert.ok(graph.calls.length >= 1);
    for (const call of graph.calls) {
      assert.ok(!call.url.includes("SECRET-PAGE-TOKEN"), `token leaked into the URL: ${call.url}`);
      assert.ok(!call.url.includes("access_token="), `access_token= is in the URL: ${call.url}`);
      assert.equal(call.auth, "Bearer SECRET-PAGE-TOKEN");
    }
  } finally {
    graph.restore();
  }
});

test("the metric list asked for is the measured one", () => {
  /* If somebody adds a name here without probing it, every Page falls back to
     the no-insights read on the next collection. The list is small on purpose. */
  assert.deepEqual([...POST_INSIGHT_METRICS], ["post_media_view", "post_clicks", "post_video_views"]);
});

/* -------------------------------------------------------- the money gate */

test("with no video model configured the animation is skipped and nothing is called", async () => {
  /* The test database has no plugin_config row, so `videoModel()` is null.
     This is the assertion the whole no-default design exists for: the step
     returns before a token is read or a connection is opened. */
  const res = await animate({ imagePath: "/nonexistent.png", prompt: "x", seconds: 5, out: "/tmp/never.mp4" });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.skipped, true);
  assert.equal(res.ok === false && res.model, null);
  assert.match(res.ok === false ? res.error : "", /NOTHING WAS SPENT/);
});
