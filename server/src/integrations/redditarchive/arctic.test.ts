/**
 * The Arctic Shift reader, against a fake archive: reference parsing, the
 * unsettled-score rule, the scan fallback when the keyword index times out,
 * the comment tree cut, and rate-limit handling. No network.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ArcticError,
  arcticGet,
  matches,
  parseSubreddit,
  parseThreadRef,
  queryTerms,
  readThread,
  searchPosts,
  setTransportForTests,
  shapePost,
} from "./arctic.ts";
import { redditRoutes } from "./routes.ts";

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

type Handler = (u: URL) => { status?: number; body: unknown; headers?: Record<string, string> };
function fake(handler: Handler): string[] {
  const seen: string[] = [];
  setTransportForTests(async (url) => {
    seen.push(url);
    const r = handler(new URL(url));
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  });
  return seen;
}

afterEach(() => setTransportForTests(null));

const post = (id: string, ageDays: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Post ${id}`,
  selftext: "",
  created_utc: now() - ageDays * DAY,
  score: 12,
  num_comments: 3,
  author: "someone",
  subreddit: "Tutoring",
  url: `https://www.reddit.com/r/Tutoring/comments/${id}/x/`,
  ...extra,
});

test("thread references: ids, t3_, every reddit.com URL shape, comment permalinks, redd.it and share links", () => {
  assert.deepEqual(parseThreadRef("1w8su8w"), { postId: "1w8su8w", commentId: null });
  assert.deepEqual(parseThreadRef("t3_1W8SU8W"), { postId: "1w8su8w", commentId: null });
  for (const u of [
    "https://www.reddit.com/r/Tutoring/comments/1w8su8w/im_so_done/",
    "https://old.reddit.com/r/Tutoring/comments/1w8su8w/",
    "reddit.com/r/Tutoring/comments/1w8su8w",
    "https://m.reddit.com/r/Tutoring/comments/1w8su8w/im_so_done/?utm_source=share",
    "https://redd.it/1w8su8w",
  ])
    assert.deepEqual(parseThreadRef(u), { postId: "1w8su8w", commentId: null }, u);
  assert.deepEqual(parseThreadRef("https://www.reddit.com/r/Tutoring/comments/1w8su8w/im_so_done/p9qo9pb/"), {
    postId: "1w8su8w",
    commentId: "p9qo9pb",
  });
  assert.deepEqual(parseThreadRef("https://www.reddit.com/r/running/s/3TzXiyxaMD"), { shortPath: "/r/running/s/3TzXiyxaMD" });
  assert.equal(parseThreadRef("https://example.com/r/x/comments/abc123"), null);
  assert.equal(parseThreadRef("not a thread at all"), null);
  assert.equal(parseSubreddit("r/Tutoring/"), "Tutoring");
  assert.equal(parseSubreddit("a b"), null);
});

test("a post younger than the archive's re-read has no score rather than its placeholder", () => {
  const fresh = shapePost(post("aaa111", 0.5, { score: 1, num_comments: 0 }), 100);
  assert.equal(fresh.score, null);
  assert.equal(fresh.comments, null);
  assert.equal(fresh.scoreSettled, false);
  const old = shapePost(post("bbb222", 5), 100);
  assert.equal(old.score, 12);
  assert.equal(old.scoreSettled, true);
  assert.equal(old.permalink, "https://www.reddit.com/r/Tutoring/comments/bbb222/");
  assert.equal(old.link, null, "a self post has no outbound link");
  const escaped = shapePost(post("ccc333", 5, { title: "Q&amp;A", selftext: "&#x200B;\n\na &lt;b&gt; &amp; c" }), 100);
  assert.equal(escaped.title, "Q&A");
  assert.equal(escaped.text, "a <b> & c");
});

test("query terms: every word, quoted phrases, exclusions", () => {
  const t = queryTerms('online "math tutor" -spam');
  assert.deepEqual(t, { need: ["online", "math tutor"], not: ["spam"] });
  assert.ok(matches("Looking for an ONLINE Math Tutor", t));
  assert.ok(!matches("online math tutor spam", t));
  assert.ok(!matches("online tutor for math", t));
});

test("when the keyword index times out, the window is scanned and the answer says so", async () => {
  const seen = fake((u) => {
    if (u.searchParams.has("query")) return { status: 422, body: { data: null, error: "Timeout. Maybe slow down a bit" } };
    const before = u.searchParams.get("before");
    if (!before) {
      const rows = Array.from({ length: 100 }, (_, i) =>
        post(`p${i}`, 1 + i * 0.1, i % 10 === 0 ? { title: "Need an online tutor" } : {}),
      );
      return { body: { data: rows } };
    }
    return { body: { data: [post("zz1", 40, { selftext: "any good ONLINE tutor sites?" })] } };
  });
  const r = await searchPosts({
    subreddit: "tutoring",
    author: null,
    q: "online tutor",
    after: now() - 90 * DAY,
    before: null,
    limit: 50,
    sort: "new",
    textChars: 200,
  });
  assert.equal(r.method, "scan");
  assert.equal(r.scanned, 101);
  assert.equal(r.scanComplete, true);
  assert.equal(r.posts.length, 11);
  assert.ok(r.posts.some((p) => p.id === "zz1"), "the body is matched, not only the title");
  assert.match(r.note ?? "", /reached the start of the window/);
  assert.equal(seen.length, 3, "one refused index call, two listing pages");
});

test("a working keyword index is used as is", async () => {
  fake(() => ({ body: { data: [post("abc123", 10)] } }));
  const r = await searchPosts({ subreddit: "tutoring", author: null, q: "x", after: 0, before: null, limit: 5, sort: "new", textChars: 10 });
  assert.equal(r.method, "index");
  assert.equal(r.posts[0]?.id, "abc123");
});

test("a thread comes back with its comments by score, cut breadth-first, with the cut counted", async () => {
  const c = (id: string, score: number, replies: unknown[] = [], parent = "t3_abc123") => ({
    kind: "t1",
    data: {
      id,
      body: `comment ${id}`,
      score,
      created_utc: now() - 10 * DAY,
      author: "a",
      parent_id: parent,
      replies: replies.length ? { kind: "Listing", data: { children: replies } } : "",
    },
  });
  fake((u) => {
    if (u.pathname.endsWith("/posts/ids")) return { body: { data: [post("abc123", 10, { selftext: "the post body" })] } };
    return {
      body: {
        data: [
          c("low", 1),
          c("high", 50, [c("r1", 3, [], "t1_high"), c("r2", 9, [], "t1_high")]),
          c("mid", 7),
          { kind: "t1", data: { id: "gone", body: "[removed]", score: 99, created_utc: now() - 10 * DAY, author: "[deleted]", parent_id: "t3_abc123", replies: "" } },
          { kind: "more", data: { count: 4, children: ["x1", "x2", "x3", "x4"] } },
        ],
      },
    };
  });
  const t = await readThread("https://www.reddit.com/r/Tutoring/comments/abc123/slug/", {
    maxComments: 4,
    textChars: 100,
    postChars: 100,
  });
  assert.equal(t.post.text, "the post body");
  assert.deepEqual(t.comments.map((x) => x.id), ["high", "mid", "low"]);
  assert.deepEqual(t.comments[0]!.replies.map((x) => x.id), ["r2"], "the higher-scored reply survives the cut");
  assert.equal(t.comments[0]!.moreReplies, 1);
  assert.equal(t.archived, 10);
  assert.equal(t.returned, 4);
  assert.equal(t.omitted, 6, "the removed comment scored 99 and still lost its place");
  assert.match(t.comments[0]!.permalink, /\/comments\/abc123\/_\/high\/$/);
});

test("a 429 blocks the next request instead of hammering the archive", async () => {
  let calls = 0;
  fake(() => {
    calls++;
    return { status: 429, body: { error: "rate limited" }, headers: { "x-ratelimit-reset": "45" } };
  });
  await assert.rejects(arcticGet("/posts/search", { subreddit: "a" }), (e: unknown) => e instanceof ArcticError && e.kind === "rate-limited" && e.retryAfter === 45);
  await assert.rejects(arcticGet("/posts/search", { subreddit: "b" }), (e: unknown) => e instanceof ArcticError && e.kind === "rate-limited");
  assert.equal(calls, 1, "the second call was refused locally");
});

test("answers are cached, and the route refuses a sitewide search with the fix in the message", async () => {
  let calls = 0;
  fake(() => {
    calls++;
    return { body: { data: [post("abc123", 10)] } };
  });
  await arcticGet("/posts/ids", { ids: "abc123" });
  await arcticGet("/posts/ids", { ids: "abc123" });
  assert.equal(calls, 1);

  const res = await redditRoutes.request("/search?q=online%20tutor");
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /--subreddit/);

  const ok = await redditRoutes.request("/thread?id=abc123&comments=5");
  assert.equal(ok.status, 200);
  const doc = (await ok.json()) as { post: { id: string }; source: string };
  assert.equal(doc.post.id, "abc123");
  assert.match(doc.source, /Arctic Shift/);
});
