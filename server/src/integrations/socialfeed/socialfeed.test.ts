/**
 * THE THREE PIECES OF ARITHMETIC THIS AREA TURNS ON.
 *
 * Everything here is pure: the fingerprint, the judgement made against a list
 * of rows, and the candidate ranking. That is not an accident of how the code
 * came out — each of the three was deliberately separated from the database
 * call around it so that it could be asserted, because each one is a rule that
 * REFUSES something and a refusal nobody can check is a refusal nobody will
 * trust.
 *
 * The two that spend money are not tested here and cannot be: `animate` calls
 * Replicate and `discover` calls a search node. What IS asserted about the
 * expensive path is the thing that matters — that with no model configured the
 * animation step returns `skipped` and never opens a connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, judgeTopic, overlap, stem } from "./novelty.ts";
import { pagePosts, POST_INSIGHT_METRICS } from "../../providers/meta.ts";
import { parseChannels, parseDuration, rank, videoId, type RawCandidate } from "./sourcing.ts";
import { animate } from "./ugc.ts";

/* --------------------------------------------------------- fingerprinting */

test("the fingerprint drops stop words, short words and punctuation", () => {
  assert.equal(fingerprint("The best way to make a chatbot!"), "chatbot");
  /* Word order does not change it: the tokens are sorted. */
  assert.equal(fingerprint("planning permission guide"), fingerprint("guide to planning permission"));
});

test("the fingerprint stems, so inflections collapse", () => {
  assert.equal(fingerprint("tutoring"), fingerprint("tutors"));
  assert.equal(fingerprint("tutoring"), "tutor");
});

test("a URL is removed whole rather than tokenised", () => {
  /* Otherwise a link in a brief supplies a dozen tokens of host and path and
     swamps every real word in the comparison. */
  assert.equal(fingerprint("chatbot https://example.com/very/long/path?q=1"), "chatbot");
});

test("the fingerprint of nothing is empty, and that is a refusal rather than a match", () => {
  assert.equal(fingerprint("the and for with"), "");
  const v = judgeTopic("the and for with", [], { days: 30, limit: 0.6 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no distinctive words/);
});

test("overlap is asymmetric: the share of the NEW topic already covered", () => {
  const short = fingerprint("AI tutoring exams");
  const long = fingerprint("how AI tutoring helps students prepare for their exams at home");
  /* Everything in the short one is in the long one. */
  assert.equal(overlap(short, long), 1);
  /* The reverse is not true, and must not be: the longer brief says more. */
  assert.ok(overlap(long, short) < 1);
});

/* --------------------------------------- P1: the flagship example (review 6) */

test("the example the settings hint, the header and the README all promise is caught", () => {
  /* THIS IS THE REGRESSION. The five-character truncation this shipped with
     did NOT collapse `exams`/`exam` — neither word is five characters long, so
     neither was touched — and the overlap came out at 0.33 and 0.5, both under
     the 0.6 default. So the owner read "these score high on purpose" in three
     places and it was false. Stripping the inflection BEFORE truncating is
     what makes the promise true. */
  assert.equal(fingerprint("AI tutoring for exams"), "exam tutor");
  assert.equal(fingerprint("exam prep with an AI tutor"), "exam prep tutor");
  const score = overlap(fingerprint("exam prep with an AI tutor"), fingerprint("AI tutoring for exams"));
  assert.ok(score >= 0.6, `overlap was ${score}, which the default 0.6 threshold would allow`);

  const v = judgeTopic("exam prep with an AI tutor", [row(1, "AI tutoring for exams", day(10))], {
    days: 30,
    limit: 0.6,
    at: new Date(day(12)),
  });
  assert.equal(v.ok, false);
  assert.equal(v.matched?.id, 1);
});

test("the stem takes one inflection off and never `s` after `s`", () => {
  assert.equal(stem("exams"), "exam");
  assert.equal(stem("tutoring"), "tutor");
  assert.equal(stem("tutors"), "tutor");
  assert.equal(stem("stories"), "story");
  /* Porter's rule, and it is what lets a plural meet its singular: `business`
     keeps its `ss`, `businesses` loses `es`, and both land on `business`. */
  assert.equal(stem("business"), "business");
  assert.equal(stem("businesses"), "business");
  assert.equal(stem("processes"), stem("process"));
  /* The floor: four characters have to survive, so short words are left whole
     rather than colliding with each other. */
  assert.equal(stem("cars"), "cars");
});

test("the stem no longer collapses words that are not the same word", () => {
  /* The five-character truncation over-refused as well as under-refusing:
     these two pairs fingerprinted identically, so a genuinely new topic could
     be refused at 1.0 against something unrelated. */
  assert.notEqual(fingerprint("marketing automation"), fingerprint("marker automation"));
  assert.notEqual(fingerprint("customer support"), fingerprint("custom support"));
});

/* --------------------------------- P1: every script, not just English (5) */

test("a non-Latin topic fingerprints to something rather than to nothing", () => {
  /* THIS IS THE REGRESSION. `[^a-z0-9\s]` does not mean "drop punctuation",
     it means "drop every letter that is not English" — so both of these came
     out as the empty string, which judgeTopic turns into a refusal saying the
     topic "has no distinctive words left". On an install whose model answers
     in Russian or Japanese the gate refused 100% of topics, forever. */
  const cyrillic = fingerprint("Как обрабатывать повторяющиеся вопросы");
  assert.notEqual(cyrillic, "");
  assert.ok(cyrillic.includes("вопросы"), cyrillic);

  /* A script with no spaces survives as ONE token. That is a weak fingerprint
     and it is the honest one: a weak gate lets work through, which is the
     correct direction to be wrong in. */
  assert.equal(fingerprint("日本語のトピック"), "日本語のトピック");
});

test("Japanese dakuten survive — ピ must not become ヒ", () => {
  /* Stripping `\p{M}` wholesale would take the dakuten off with the accents,
     turning a `pi` into a `hi`: a different sound and a different word. Only
     the Latin/Greek/Cyrillic combining block is removed, and NFC puts back
     anything that was decomposed and not stripped. */
  assert.ok(fingerprint("トピック").includes("ピ"));
});

test("accents are normalised away, so gérer and gerer are one word", () => {
  assert.equal(fingerprint("gérer les demandes répétitives"), fingerprint("gerer les demandes repetitives"));
  /* And they are not MANGLED, which is what the old normaliser did: it turned
     "répétitives" into "titiv" by deleting the accented letters mid-word. */
  assert.ok(fingerprint("répétitives").startsWith("repeti"), fingerprint("répétitives"));
});

test("a non-Latin topic is judged on its words rather than refused as empty", () => {
  const history = [row(1, "Как обрабатывать повторяющиеся вопросы", day(10))];
  const same = judgeTopic("повторяющиеся вопросы: как их обрабатывать", history, {
    days: 30,
    limit: 0.6,
    at: new Date(day(12)),
  });
  assert.equal(same.ok, false, "a Russian rewording should be refused as a repeat");
  const different = judgeTopic("проверка личности преподавателя", history, {
    days: 30,
    limit: 0.6,
    at: new Date(day(12)),
  });
  assert.equal(different.ok, true, "an unrelated Russian topic should be allowed");
});

/* ------------------------------------------------------------- the gate */

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

const row = (id: number, topic: string, at: string) => ({
  id,
  topic,
  fingerprint: fingerprint(topic),
  created_at: at,
});

test("a topic that is a rewording of a recent one is refused, with the clash quoted", () => {
  const history = [row(7, "AI tutoring for exam preparation", day(10))];
  const v = judgeTopic("exam prep with an AI tutor", history, {
    days: 30,
    limit: 0.6,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, false);
  assert.equal(v.matched?.id, 7);
  assert.match(v.reason, /AI tutoring for exam preparation/);
  assert.match(v.reason, /novelty window is 30 days/);
});

test("the same topic outside the window is allowed back", () => {
  const history = [row(7, "AI tutoring for exam preparation", day(1))];
  const v = judgeTopic("exam prep with an AI tutor", history, {
    days: 5,
    limit: 0.6,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
  assert.equal(v.matched, null);
});

test("a genuinely different topic is allowed even inside the window", () => {
  const history = [row(7, "AI tutoring for exam preparation", day(19))];
  const v = judgeTopic("how identity verification works for tutors", history, {
    days: 30,
    limit: 0.6,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
});

test("a window of zero days switches the topic check off entirely", () => {
  const history = [row(7, "AI tutoring for exam preparation", day(19))];
  const v = judgeTopic("AI tutoring for exam preparation", history, {
    days: 0,
    limit: 0.6,
    at: new Date(day(20)),
  });
  assert.equal(v.ok, true);
  assert.match(v.reason, /zero days/);
});

test("the WORST clash is the one reported, not the first one found", () => {
  /* Row 1 covers two of the three tokens and row 2 covers all three. A gate
     that reported the first match over the threshold would quote the weaker
     one, and the sentence a person reads would name the wrong video. */
  const history = [
    row(1, "tutoring exams without pricing", day(18)),
    row(2, "tutoring exams payment", day(19)),
  ];
  const v = judgeTopic("tutoring exams payment", history, { days: 30, limit: 0.6, at: new Date(day(20)) });
  assert.equal(v.ok, false);
  assert.equal(v.matched?.id, 2);
  assert.equal(v.matched?.score, 1);
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
