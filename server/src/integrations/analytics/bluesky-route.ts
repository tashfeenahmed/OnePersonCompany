/**
 * Bluesky — the handles being watched, what they have, and what the last fifty
 * posts did.
 *
 * TWO KINDS OF FIGURE ON ONE PAGE, and confusing them is the way to be wrong
 * here. `profile` is a STOCK: followers, follows and total posts, true at the
 * moment of the last read, with a real history in `readings` behind the
 * follower count. `windows` is a FLOW over posts made in the last 7 or 30
 * days, recomputed from one page of the feed on every collection.
 *
 * A WINDOW MAY BE A FLOOR AND IT SAYS SO. The author feed is read one page
 * deep — fifty posts, one request — so an account that posted more than that
 * inside the window has figures that are floors: at least this many likes,
 * possibly many more. `truncated` rides with the row and this route neither
 * hides it nor quietly rounds it away. A floor drawn as a total is how a busy
 * month reads as a quiet one.
 *
 * ENGAGEMENT IS CURRENT, NOT EARNED-IN-WINDOW. A like arriving today on a post
 * from three weeks ago is counted in this week's read of that post and in next
 * week's too. So `windows[].likes` is "likes those posts have NOW", which is
 * what it is called throughout, and it is never presented as "likes gained
 * this week" — a figure nothing on the public API can produce.
 *
 * REPOSTS BY THE HANDLE ARE NOT ITS POSTS. Somebody else's post, somebody
 * else's likes. They are excluded from every count here.
 *
 * NOTHING IS SUMMED ACROSS HANDLES EXCEPT COUNTS OF POSTS. Followers are
 * de-duplicated per account by definition — one person following three of the
 * owner's handles is one person — so `portfolio.followers.combined` is null
 * with the reason beside it, the same shape `/api/umami` uses for visitors.
 */
import { Hono } from "hono";
import { configValue, series } from "../../db.ts";
import { parseHandles, FEED_LIMIT, WINDOWS } from "./bluesky.ts";
import { blueskyProfiles, blueskyWindows, clockAt } from "./store.ts";

export const blueskyRoutes = new Hono();

/** How much follower history a read asks for. Ninety days is a quarter, which
 *  is long enough for growth to be visible and short enough to draw. */
const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

blueskyRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? DEFAULT_DAYS) || DEFAULT_DAYS, 1, MAX_DAYS);
  const configured = parseHandles(configValue("bluesky", "handles"));
  const profiles = blueskyProfiles();
  const windows = blueskyWindows();

  const handles = configured.map((handle) => {
    const p = profiles.find((x) => x.handle === handle);
    const history = series(`bluesky.${handle}.followers`, days).map((r) => ({
      ts: r.ts,
      followers: r.value,
    }));
    /* Growth over the history HELD, which is not necessarily the window asked
       for: a handle added yesterday has one reading and no growth, and that is
       reported as null rather than as zero. */
    const first = history[0]?.followers ?? null;
    const last = history.at(-1)?.followers ?? null;
    return {
      handle,
      /** The stable key `venture_links` points at. See `/entities`. */
      entity: handle,
      did: p?.did ?? null,
      displayName: p?.display_name ?? null,
      avatar: p?.avatar ?? null,
      profile: {
        followers: p?.followers ?? null,
        follows: p?.follows ?? null,
        posts: p?.posts ?? null,
        seenAt: p?.seen_at ?? null,
      },
      growth: {
        days,
        from: first,
        to: last,
        /*
          NULL ON A SINGLE READING, NOT ZERO. One reading is one point, and the
          difference between a point and itself is not "no growth" — it is no
          measurement of growth at all. Reporting 0 here would put a flat line
          on the page for a handle added this morning, which is the exact
          silent zero this codebase refuses everywhere else.
        */
        change:
          history.length >= 2 && first !== null && last !== null ? last - first : null,
        readings: history.length,
        note:
          history.length < 2
            ? "Fewer than two readings held — there is no growth figure yet, and that is not a flat line."
            : null,
      },
      history,
      windows: WINDOWS.map((n) => {
        const w = windows.find((x) => x.handle === handle && x.window_days === n);
        if (!w) return { days: n, held: false as const };
        return {
          days: n,
          held: true as const,
          posts: w.posts,
          likes: w.likes,
          reposts: w.reposts,
          replies: w.replies,
          quotes: w.quotes,
          /** Engagement per post, computed here and null when there were no
           *  posts to divide by — a handle that posted nothing has no rate. */
          perPost:
            w.posts > 0
              ? Math.round(((w.likes + w.reposts + w.replies + w.quotes) / w.posts) * 10) / 10
              : null,
          /** TRUE MEANS EVERY FIGURE ABOVE IS A FLOOR. See the header. */
          truncated: w.truncated === 1,
          oldestSeen: w.oldest_seen,
          seenAt: w.seen_at,
        };
      }),
      lastOkAt: p?.last_ok_at ?? null,
      lastError: p?.last_error ?? null,
      lastReadAt: clockAt("bluesky", handle),
    };
  });

  const answering = handles.filter((h) => h.profile.followers !== null);
  const sum = (pick: (h: (typeof handles)[number]) => number | null) => {
    const values = handles.map(pick).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  const window30 = (h: (typeof handles)[number]) =>
    h.windows.find((w) => w.days === 30 && w.held) as
      | Extract<(typeof handles)[number]["windows"][number], { held: true }>
      | undefined;

  return c.json({
    handles,
    portfolio: {
      handles: handles.length,
      answering: answering.length,
      failing: handles.filter((h) => h.lastError).length,
      /** THE ONE THAT IS NULL ON PURPOSE. */
      followers: {
        combined: null,
        perHandle: Object.fromEntries(handles.map((h) => [h.handle, h.profile.followers])),
        note:
          "Followers are not added across handles: one person following two " +
          "of these accounts is one person, and Bluesky's public API offers no " +
          "way to de-duplicate them. Quote them per handle.",
      },
      /** Posts DO add — a post is a post, whichever account made it — and so
       *  do the engagement counts on those posts, because each belongs to
       *  exactly one post. The flag below is what makes the sum quotable. */
      last30: {
        posts: sum((h) => window30(h)?.posts ?? null),
        likes: sum((h) => window30(h)?.likes ?? null),
        reposts: sum((h) => window30(h)?.reposts ?? null),
        replies: sum((h) => window30(h)?.replies ?? null),
        anyTruncated: handles.some((h) => window30(h)?.truncated === true),
      },
    },
    notes: {
      windows:
        `Windows are computed from one page of the author feed (${FEED_LIMIT} ` +
        "posts). A window whose `truncated` is true is a FLOOR — there were at " +
        "least this many, and possibly many more.",
      engagement:
        "Likes, reposts, replies and quotes are the counts those posts carry " +
        "NOW, not engagement earned inside the window. An old post gathering " +
        "new likes moves this figure.",
      reposts:
        "A repost BY the handle is somebody else's post and is excluded from " +
        "every count. `reposts` is how often the handle's OWN posts were " +
        "reposted by others.",
      followers:
        "Follower counts are Bluesky's own totals as of the last read. The " +
        "history behind them is this box's own, one reading per collection.",
      auth: "The public AppView, unauthenticated. No credential is held and none is needed.",
    },
  });
});

blueskyRoutes.get("/entities", (c) => {
  const profiles = blueskyProfiles();
  return c.json({
    entities: parseHandles(configValue("bluesky", "handles")).map((handle) => {
      const p = profiles.find((x) => x.handle === handle);
      return {
        plugin: "bluesky",
        entity: handle,
        label: p?.display_name ? `${p.display_name} (@${handle})` : `@${handle}`,
        /*
          NULL, ALWAYS, AND ON PURPOSE. A handle is a domain and it is
          tempting to read it as one — but `alice.bsky.social` is a name
          Bluesky issued, not a website anybody owns, and a custom handle like
          `example.com` is the same string as the venture's host by
          COINCIDENCE of the verification scheme rather than because the
          account is the site. Auto-linking on it would file a personal
          account under a business the day somebody verified a handle with a
          company domain. The owner links these by hand.
        */
        host: null,
      };
    }),
  });
});
