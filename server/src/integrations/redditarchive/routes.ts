/**
 * `/api/reddit` — Reddit posts, comment searches and whole threads, read from
 * the Arctic Shift archive. See arctic.ts for why the archive and not Reddit.
 *
 * Three GETs, each a view of the `reddit` skill:
 *
 *   /search    posts in a subreddit (or by an author) in a date window,
 *              optionally matching a keyword query
 *   /comments  comments matching a full-text query in a subreddit, by an
 *              author, or under one thread
 *   /thread    one post and its comment tree, by id or reddit.com URL
 *
 * Every answer names its source and its window, and every failure is a JSON
 * error with the archive's own reason — never an empty list standing in for a
 * request that was not answered.
 */
import { Hono, type Context } from "hono";
import {
  ArcticError,
  parseAuthor,
  parseDate,
  parseSubreddit,
  parseThreadRef,
  readThread,
  searchComments,
  searchPosts,
  SETTLE_DAYS,
} from "./arctic.ts";

export const redditRoutes = new Hono();

const SOURCE = "Arctic Shift Reddit archive (arctic-shift.photon-reddit.com)";

const SCORE_NOTE =
  `Scores and comment counts are the archive's re-read about ${SETTLE_DAYS * 24} hours after posting; ` +
  `anything younger carries score null and scoreSettled false (the archive only holds a placeholder yet).`;

function int(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function sortOf(raw: string | undefined): "new" | "old" | "top" {
  return raw === "old" || raw === "top" ? raw : "new";
}

/** The date window from `after`/`before` or `days`, as epoch seconds. */
function window(c: Context): { after: number; before: number | null; days: number } | { error: string } {
  const days = int(c.req.query("days"), 90, 1, 3650);
  const afterRaw = c.req.query("after");
  const beforeRaw = c.req.query("before");
  const after = afterRaw ? parseDate(afterRaw) : Math.floor(Date.now() / 1000 - days * 86_400);
  const before = beforeRaw ? parseDate(beforeRaw) : null;
  if (after === null) return { error: `--after "${afterRaw}" is not a date. Use YYYY-MM-DD.` };
  if (beforeRaw && before === null) return { error: `--before "${beforeRaw}" is not a date. Use YYYY-MM-DD.` };
  if (before !== null && before <= after) return { error: "--before must be later than --after." };
  return { after, before, days: afterRaw ? Math.round(((before ?? Date.now() / 1000) - after) / 86_400) : days };
}

const isoDay = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString());

function fail(c: Context, err: unknown) {
  if (err instanceof ArcticError)
    return c.json(
      { error: err.message, kind: err.kind, retryAfter: err.retryAfter, source: SOURCE },
      err.status as 400 | 404 | 429 | 502 | 504,
    );
  const why = err instanceof Error ? err.message : String(err);
  return c.json({ error: `Reading the Reddit archive failed: ${why}`, kind: "unreachable", source: SOURCE }, 502);
}

const WHO_NEEDED =
  "The archive only searches INSIDE a subreddit or an author's history — a sitewide keyword search is refused. " +
  "Pass --subreddit (find candidate subreddits with `opc search --q \"site:reddit.com <topic>\"`) or --author.";

redditRoutes.get("/search", async (c) => {
  const subRaw = c.req.query("subreddit");
  const authorRaw = c.req.query("author");
  const subreddit = subRaw ? parseSubreddit(subRaw) : null;
  const author = authorRaw ? parseAuthor(authorRaw) : null;
  if (subRaw && !subreddit) return c.json({ error: `"${subRaw}" is not a subreddit name.` }, 400);
  if (authorRaw && !author) return c.json({ error: `"${authorRaw}" is not a Reddit username.` }, 400);
  if (!subreddit && !author) return c.json({ error: WHO_NEEDED }, 400);
  const w = window(c);
  if ("error" in w) return c.json({ error: w.error }, 400);
  const q = (c.req.query("q") ?? "").trim() || null;
  const limit = int(c.req.query("limit"), 25, 1, 100);
  const sort = sortOf(c.req.query("sort"));
  try {
    const r = await searchPosts({
      subreddit,
      author,
      q,
      after: w.after,
      before: w.before,
      limit,
      sort,
      textChars: int(c.req.query("text"), 400, 0, 4000),
    });
    return c.json({
      source: SOURCE,
      query: { subreddit, author, q, after: isoDay(w.after), before: isoDay(w.before), days: w.days, sort, limit },
      method: r.method,
      count: r.posts.length,
      scanned: r.scanned,
      scanComplete: r.scanComplete,
      note: [r.note, SCORE_NOTE, "Read a thread with `opc reddit thread --id <id or permalink>`."].filter(Boolean).join(" "),
      posts: r.posts,
    });
  } catch (err) {
    return fail(c, err);
  }
});

redditRoutes.get("/comments", async (c) => {
  const subRaw = c.req.query("subreddit");
  const authorRaw = c.req.query("author");
  const threadRaw = c.req.query("thread");
  const subreddit = subRaw ? parseSubreddit(subRaw) : null;
  const author = authorRaw ? parseAuthor(authorRaw) : null;
  const ref = threadRaw ? parseThreadRef(threadRaw) : null;
  if (subRaw && !subreddit) return c.json({ error: `"${subRaw}" is not a subreddit name.` }, 400);
  if (authorRaw && !author) return c.json({ error: `"${authorRaw}" is not a Reddit username.` }, 400);
  if (threadRaw && (!ref || "shortPath" in ref))
    return c.json({ error: `"${threadRaw}" is not a thread id or a reddit.com/r/<sub>/comments/<id> URL.` }, 400);
  const threadId = ref && "postId" in ref ? ref.postId : null;
  if (!subreddit && !author && !threadId) return c.json({ error: WHO_NEEDED.replace("or --author", "--author or --thread") }, 400);
  const w = window(c);
  if ("error" in w) return c.json({ error: w.error }, 400);
  const q = (c.req.query("q") ?? "").trim() || null;
  const limit = int(c.req.query("limit"), 25, 1, 100);
  const sort = sortOf(c.req.query("sort"));
  try {
    const comments = await searchComments({
      subreddit,
      author,
      threadId,
      q,
      /* A thread's comments are wanted whatever their age. */
      after: threadId && !c.req.query("after") && !c.req.query("days") ? 0 : w.after,
      before: w.before,
      limit,
      sort,
      textChars: int(c.req.query("text"), 600, 0, 4000),
    });
    return c.json({
      source: SOURCE,
      query: { subreddit, author, thread: threadId, q, after: isoDay(w.after), before: isoDay(w.before), days: w.days, sort, limit },
      count: comments.length,
      note: `${SCORE_NOTE} Each comment links its thread; read the whole thread with \`opc reddit thread --id <threadId>\`.`,
      comments,
    });
  } catch (err) {
    return fail(c, err);
  }
});

redditRoutes.get("/thread", async (c) => {
  const id = (c.req.query("id") ?? "").trim();
  if (!id) return c.json({ error: "--id is required: a post id (1w8su8w, t3_1w8su8w) or a reddit.com thread URL." }, 400);
  try {
    const t = await readThread(id, {
      maxComments: int(c.req.query("comments"), 40, 0, 300),
      textChars: int(c.req.query("text"), 500, 0, 4000),
      postChars: int(c.req.query("postText"), 3000, 0, 20000),
    });
    return c.json({
      source: SOURCE,
      post: t.post,
      focus: t.focus,
      archivedComments: t.archived,
      returnedComments: t.returned,
      omittedComments: t.omitted,
      note:
        `Comments are ordered by score within each level and cut breadth-first to --comments (${t.returned} of ${t.archived}); ` +
        `moreReplies on a comment counts replies left out under it. Raise --comments or lower --text to see more. ${SCORE_NOTE}`,
      comments: t.comments,
    });
  } catch (err) {
    return fail(c, err);
  }
});
