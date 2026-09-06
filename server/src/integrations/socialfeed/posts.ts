/**
 * ORGANIC POST HISTORY — what actually went out, and how it did.
 *
 * WHAT THIS BOX COULD SEE BEFORE. Meta's collector reads Page identity,
 * followers and advertising insights. The publishing area knows what it queued
 * and what it sent. Nothing anywhere could answer "how did the post we made
 * last week actually do", because nothing read the timeline back.
 *
 * IT READS THROUGH THE PUBLISHING AREA'S DESTINATIONS AND NOT THROUGH THE
 * VAULT DIRECTLY, and that is the decision this file turns on. A destination
 * row already holds the three things a read needs — which Meta account, which
 * Page, and WHICH VENTURE THE OWNER SAID IT BELONGS TO — and it holds the
 * last of those because a person typed it. Deriving the venture again here by
 * matching a Page name against a venture name would be a second answer to a
 * question that already has one, and it would be wrong the first time somebody
 * named a Page differently from their business.
 *
 * THE PAGE TOKEN IS MINTED PER COLLECTION AND NEVER STORED. `publishablePages`
 * asks `/me/accounts?fields=…,access_token` and Meta either hands over a Page
 * credential or refuses the edge; either answer is recorded. A Page token
 * written into this database would be a second copy of a credential with its
 * own expiry, in a table that is not the vault.
 *
 * THE METRIC NAMES ARE META'S, NOT OURS. See migration 340 and the organic
 * reads section of providers/meta.ts: the whole `post_impressions` family was
 * retired on 15 November 2025 and answers 400, taking the entire page of posts
 * with it; what survives is `post_media_view` (renders, not people),
 * `post_clicks` and `post_video_views`, plus the reaction and comment
 * summaries, which need no insights permission at all. Every one of those was
 * probed live on 2026-09-06 against the three connected Pages.
 *
 * ZERO IS A MEASUREMENT AND ABSENCE IS NOT. Every figure in this table came
 * back as a number from Meta. A metric that did not come back is simply not a
 * key in the row's `metrics` object, and the note beside it says so — nothing
 * here writes a zero because a field was missing, which is the failure that
 * would put a flat line on a chart and read as a collapse in performance.
 *
 * NO COLLECTOR ENTRY ON THE MANIFEST, deliberately. `manifestCollectors()`
 * merges by plugin id and an entry under `meta` would SILENTLY REPLACE the
 * collector that reads the ad spend. This runs on its own timer and on demand.
 */
import { configValue, db, now, ventureRowById } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import * as meta from "../../providers/meta.ts";
/* THE LIVE TRANSPORT, which is a GET-only path here: `publishablePages` is
   the one call this file makes through it and it lists Pages. The transport
   exists so the publishing pipeline can be rehearsed; this reader has nothing
   to rehearse and takes the live one. */
import { liveTransport } from "../../providers/social.ts";
import { mappedPages, META_PLUGIN } from "../publishing/destinations.ts";
import { SOCIALFEED_PLUGIN } from "./novelty.ts";

/** How many posts are read per Page. Meta pages its edges and this is one
 *  request; a bigger number is a bigger response, not more requests. */
export const DEFAULT_LIMIT = 25;

/** How long between automatic reads. Engagement on a post keeps moving for
 *  days, so re-reading every few minutes would be spending somebody's rate
 *  limit to watch a number that has not changed. */
export const READ_EVERY_MS = 6 * 3_600_000;

export type PostRow = {
  platform: string;
  external_id: string;
  account_id: number | null;
  page_id: string;
  page_name: string | null;
  venture_id: string | null;
  created_time: string | null;
  permalink: string | null;
  media_type: string | null;
  image_url: string | null;
  text: string | null;
  metrics: string;
  note: string | null;
  fetched_at: string;
};

export type AccountRow = {
  platform: string;
  page_id: string;
  account_id: number | null;
  account_label: string | null;
  page_name: string | null;
  venture_id: string | null;
  last_ok_at: string | null;
  last_try_at: string | null;
  posts: number | null;
  error: string | null;
  insights_error: string | null;
};

const parse = (raw: string): Record<string, number> => {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
};

export function postRows(opts: {
  ventureId?: string | null;
  platform?: string | null;
  limit?: number;
}): PostRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  if (opts.platform) {
    where.push("platform = ?");
    args.push(opts.platform);
  }
  args.push(Math.max(1, Math.min(300, Math.floor(opts.limit ?? 60))));
  return db
    .prepare(
      `SELECT * FROM social_posts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_time DESC LIMIT ?`,
    )
    .all(...args) as unknown as PostRow[];
}

export function accountRows(): AccountRow[] {
  return db
    .prepare("SELECT * FROM social_accounts ORDER BY platform, page_name")
    .all() as unknown as AccountRow[];
}

/**
 * The publish item that produced this post, if one did.
 *
 * THE JOIN IS ON THE EXTERNAL ID AND NOTHING ELSE. When the publishing area
 * sends something, Meta answers with the post's id and that id is written onto
 * the `publish_items` row. The same id arrives here on the way back. So a
 * draft this box generated and a post on the timeline are the same row twice,
 * and joining them is exact rather than a guess by caption or by timestamp.
 * A post the owner made in the Facebook app has no publish item and the join
 * finds none, which is the correct answer.
 */
export function itemForPost(externalId: string): { id: string; sourceKind: string; sourceId: string | null; caption: string | null } | null {
  const row = db
    .prepare("SELECT id, source_kind, source_id, caption FROM publish_items WHERE external_id = ? LIMIT 1")
    .get(externalId) as { id: string; source_kind: string; source_id: string | null; caption: string | null } | undefined;
  return row ? { id: row.id, sourceKind: row.source_kind, sourceId: row.source_id, caption: row.caption } : null;
}

export function shapePost(r: PostRow) {
  const v = r.venture_id ? ventureRowById(r.venture_id) : undefined;
  const item = itemForPost(r.external_id);
  return {
    platform: r.platform,
    id: r.external_id,
    pageId: r.page_id,
    pageName: r.page_name,
    ventureId: r.venture_id,
    ventureName: v?.name ?? null,
    createdTime: r.created_time,
    permalink: r.permalink,
    mediaType: r.media_type,
    imageUrl: r.image_url,
    text: r.text,
    /* KEYED BY META'S OWN NAMES. `post_media_view` counts renders and
       Instagram's `reach` counts people; they are not the same figure and are
       never added. A key that is absent was not reported. */
    metrics: parse(r.metrics),
    note: r.note,
    fetchedAt: r.fetched_at,
    /* The draft this box generated, where this post came out of one. Null
       means it was posted somewhere else, which is most posts. */
    fromDraft: item,
  };
}

/* ---------------------------------------------------------------- the read */

export type ReadResult = {
  ok: boolean;
  at: string;
  pages: number;
  posts: number;
  /** Accounts whose read failed, with Meta's own sentence. */
  problems: { page: string; error: string }[];
  /** Instagram accounts found linked to the Pages. Zero is the measured state
   *  on this install and is reported rather than hidden. */
  instagram: number;
  error: string | null;
};

let reading = false;

/**
 * When the timelines were last tried, READ OUT OF THE TABLE rather than kept
 * in memory.
 *
 * The same argument the collector scheduler makes about its own "last run": a
 * variable in this module is reset by the restart `node --watch` performs on
 * every save, and the timer would then read Meta again the next time it woke —
 * a request to somebody else's API every time the owner typed. The rows
 * already know, so the rows are the answer.
 */
export function lastRead(): string | null {
  const row = db
    .prepare("SELECT MAX(last_try_at) AS at FROM social_accounts")
    .get() as { at: string | null } | undefined;
  return row?.at ?? null;
}

function limit(): number {
  const raw = (configValue(SOCIALFEED_PLUGIN, "posts") ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(100, Math.round(n))) : DEFAULT_LIMIT;
}

/**
 * Read every mapped Page's timeline once.
 *
 * ONE FAILURE IS ONE PAGE'S FAILURE, the rule every multi-account collector on
 * this box keeps. A Page whose token cannot be minted records its own error
 * and the other two are still read; the pass fails only when there was nothing
 * to read at all.
 */
export async function readPosts(): Promise<ReadResult> {
  const at = now();
  if (reading)
    return { ok: false, at, pages: 0, posts: 0, problems: [], instagram: 0, error: "A read was already in flight." };
  reading = true;
  try {
    const mapped = mappedPages();
    if (!mapped.length)
      return {
        ok: false,
        at,
        pages: 0,
        posts: 0,
        problems: [],
        instagram: 0,
        error:
          "No Meta destination has been probed, so this box does not know which Page belongs to which " +
          "business. Probe them under Social media → Publishing first; nothing here guesses a mapping.",
      };

    /* The owner's mapping, page id → venture, out of the ONE accessor that
       answers that question — see publishing/destinations.ts. Read once here
       rather than per post: building it inline per post is how a Page
       re-mapped to another venture ends up filed under both. */
    const ventureOf = new Map(mapped.map((p) => [p.externalId, p.ventureId]));

    const { ready } = accounts.credentialed(META_PLUGIN, ["token"], "socialfeed_posts");
    const problems: { page: string; error: string }[] = [];
    let pages = 0;
    let posts = 0;
    let instagram = 0;
    const n = limit();

    for (const { account, values } of ready) {
      const token = meta.parseLines(values.token ?? "")[0] ?? "";
      if (!token) continue;
      const app = meta.parseApp(values.app ?? "");
      const proof = app ? meta.appSecretProof(token, app) : null;

      const listing = await meta.publishablePages(token, proof, liveTransport());
      if (!listing.ok) {
        problems.push({ page: account.label, error: listing.error ?? "the Pages could not be listed" });
        writeAccount({
          platform: "facebook",
          pageId: `account:${account.id}`,
          accountId: account.id,
          accountLabel: account.label,
          pageName: null,
          ventureId: null,
          ok: false,
          posts: null,
          error: listing.error ?? "the Pages could not be listed",
          insightsError: null,
        });
        continue;
      }

      for (const page of listing.pages) {
        /* Only Pages the owner has mapped to a venture are read. A token can
           administer Pages belonging to businesses this box has never heard of
           and reading them would be collecting somebody else's data. */
        const ventureId = ventureOf.get(page.id) ?? null;
        if (!ventureId) continue;
        pages += 1;

        if (!page.token) {
          problems.push({ page: page.name ?? page.id, error: page.tokenError ?? "no Page token" });
          writeAccount({
            platform: "facebook",
            pageId: page.id,
            accountId: account.id,
            accountLabel: account.label,
            pageName: page.name,
            ventureId,
            ok: false,
            posts: null,
            error: page.tokenError ?? "Meta sent no access token for this Page.",
            insightsError: null,
          });
          continue;
        }

        const read = await meta.pagePosts(page.id, page.token, n);
        writeAccount({
          platform: "facebook",
          pageId: page.id,
          accountId: account.id,
          accountLabel: account.label,
          pageName: page.name,
          ventureId,
          ok: read.ok,
          posts: read.ok ? read.posts.length : null,
          error: read.error,
          insightsError: read.insightsError,
        });
        if (!read.ok) {
          problems.push({ page: page.name ?? page.id, error: read.error ?? "the posts edge refused" });
          continue;
        }
        posts += writePosts("facebook", page, account.id, ventureId, read.posts);

        /* INSTAGRAM, WHERE THERE IS ONE. Measured on 2026-09-06: none of the
           three Pages this token administers has a linked business account, so
           this loop body has never run against a live account. That is
           reported as zero LINKED ACCOUNTS, which is a different statement
           from zero posts. */
        if (page.instagram.id) {
          instagram += 1;
          const ig = await meta.instagramMedia(page.instagram.id, page.token, n);
          writeAccount({
            platform: "instagram",
            pageId: page.instagram.id,
            accountId: account.id,
            accountLabel: account.label,
            pageName: page.instagram.username,
            ventureId,
            ok: ig.ok,
            posts: ig.ok ? ig.posts.length : null,
            error: ig.error,
            insightsError: ig.insightsError,
          });
          if (ig.ok)
            posts += writePosts(
              "instagram",
              { id: page.instagram.id, name: page.instagram.username },
              account.id,
              ventureId,
              ig.posts,
            );
          else problems.push({ page: page.instagram.username ?? page.instagram.id, error: ig.error ?? "media refused" });
        }
      }
    }

    return {
      ok: pages > 0,
      at,
      pages,
      posts,
      problems,
      instagram,
      error:
        pages === 0
          ? "No mapped Page could be read. Either no Meta account is connected or none of its Pages is mapped to a venture."
          : null,
    };
  } finally {
    reading = false;
  }
}

function writePosts(
  platform: string,
  page: { id: string; name: string | null },
  accountId: number,
  ventureId: string,
  posts: meta.OrganicPost[],
): number {
  const stmt = db.prepare(
    `INSERT INTO social_posts
       (platform, external_id, account_id, page_id, page_name, venture_id, created_time,
        permalink, media_type, image_url, text, metrics, note, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform, external_id) DO UPDATE SET
       account_id = excluded.account_id, page_id = excluded.page_id, page_name = excluded.page_name,
       venture_id = excluded.venture_id, created_time = excluded.created_time,
       permalink = excluded.permalink, media_type = excluded.media_type,
       image_url = excluded.image_url, text = excluded.text, metrics = excluded.metrics,
       note = excluded.note, fetched_at = excluded.fetched_at`,
  );
  const ts = now();
  for (const p of posts)
    stmt.run(
      platform,
      p.id,
      accountId,
      page.id,
      page.name,
      ventureId,
      p.createdTime,
      p.permalink,
      p.mediaType,
      p.imageUrl,
      p.text,
      JSON.stringify(p.metrics),
      p.note,
      ts,
    );
  return posts.length;
}

function writeAccount(e: {
  platform: string;
  pageId: string;
  accountId: number | null;
  accountLabel: string | null;
  pageName: string | null;
  ventureId: string | null;
  ok: boolean;
  posts: number | null;
  error: string | null;
  insightsError: string | null;
}) {
  const ts = now();
  db.prepare(
    `INSERT INTO social_accounts
       (platform, page_id, account_id, account_label, page_name, venture_id, last_ok_at, last_try_at, posts, error, insights_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform, page_id) DO UPDATE SET
       account_id = excluded.account_id, account_label = excluded.account_label,
       page_name = excluded.page_name, venture_id = excluded.venture_id,
       -- The success date is only moved forward BY a success. A failing Page
       -- keeps the date it last worked, which is the whole point of having two
       -- columns rather than one.
       last_ok_at = CASE WHEN excluded.last_ok_at IS NULL THEN social_accounts.last_ok_at ELSE excluded.last_ok_at END,
       last_try_at = excluded.last_try_at, posts = excluded.posts,
       error = excluded.error, insights_error = excluded.insights_error`,
  ).run(
    e.platform,
    e.pageId,
    e.accountId,
    e.accountLabel,
    e.pageName,
    e.ventureId,
    e.ok ? ts : null,
    ts,
    e.posts,
    e.error,
    e.insightsError,
  );
}

/**
 * The timer.
 *
 * WAKES EVERY FIFTEEN MINUTES AND DOES NOTHING until six hours have passed
 * since the last read AND at least one Meta destination exists. The same
 * argument backups.ts and the autopilot make: this runs on a laptop that gets
 * shut, and a timer set for six hours' time does not fire on a machine that
 * was asleep for five of them.
 */
export function startPostsTimer() {
  const tick = () => {
    try {
      const last = lastRead();
      if (last && Date.now() - Date.parse(last) < READ_EVERY_MS) return;
      if (!mappedPages().length) return;
      void readPosts().catch(() => {
        /* A read that throws has already written whatever it managed. The
           timer must not die with it. */
      });
    } catch {
      /* onStart work must not throw. See the manifest contract. */
    }
  };
  /* A FIRST TICK AFTER A MINUTE, because `node --watch` restarts this server on
     every save and a timer whose first fire is fifteen minutes away may never
     fire on a box somebody is working on. It is NOT a read on every restart —
     the tick's own six-hour freshness check, which is read out of the table
     rather than out of memory, is what makes that safe: a save storm costs one
     SELECT each and no request to Meta. */
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, 900_000).unref?.();
}
