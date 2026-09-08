import { publishingApi, type PublishItem, type StatusCounts } from "@/areas/publishing/api";
import { socialfeedApi, type PostsDoc } from "@/areas/socialfeed/api";

/**
 * THE POSTS THEMSELVES, FETCHED FOR THE SOCIAL BOARD.
 *
 * The Social board used to be seven cards of counts — followers per Page, a
 * paid reach figure, a list of what the token would not read — because that
 * was everything `/api/meta` could answer. It is not everything this box
 * holds. The socialfeed area reads each mapped Page's TIMELINE back from Meta
 * every six hours and stores what came out: the words, the picture's URL, the
 * permalink, the media type, and Meta's own per-post metric names. The
 * publishing area holds the other half of the loop — what has been queued,
 * approved and sent, and where it went. Neither was on any board.
 *
 * TWO ROUTES, ONE DOCUMENT, AND NOTHING SUMS ACROSS THEM. A published item in
 * the publishing queue and the post it became in the timeline are the SAME
 * post seen from two ends, joined by Meta's own post id (`externalId`), so
 * adding a "published" count to a "posts" count would count it twice. The
 * cards that use the queue ask about work IN FLIGHT — drafted, approved,
 * scheduled — which is the half the timeline can never see, and the one card
 * that reads published items reads them for their DESTINATION, because that
 * is the only place a LinkedIn or TikTok URL exists on this box.
 *
 * NEITHER ROUTE IS BEHIND A CREDENTIAL OF ITS OWN — both read tables this box
 * writes, filled through the Meta token the meta plugin already holds — so
 * this bundle is fetched unconditionally, the way the audit, the run ledger
 * and the SEO documents are. One route failing leaves its field null and the
 * other's cards alone, which is what `settled` below is for.
 *
 * NOTHING HERE DOWNLOADS MEDIA. `imageUrl` on a post is a signed, expiring
 * Meta CDN address good only for as long as this document is fresh, and
 * `media.url` on a queued item is a path on this server. Both are rendered as
 * plain `<img src>` behind a fixed box; a 403 on an expired signature must
 * read as "the picture could not be fetched just now" and never as a post
 * that lost its picture.
 */
export type SocialBoardDocs = {
  /** The timeline read back from Meta: every collected post, newest first. */
  posts: PostsDoc | null;
  /** What is queued, approved, scheduled, sent or stuck — and where to. */
  publishing: { counts: StatusCounts; items: PublishItem[] } | null;
  /** When the bundle was assembled. NOT a source's clock: `posts.lastReadAt`
   *  is when Meta was actually asked, and that is what the cards quote. */
  fetchedAt: string;
};

const settled = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export const socialboard = {
  /** Both halves, each null on its own failure and never on the other's. */
  docs: async (): Promise<SocialBoardDocs> => {
    const [posts, publishing] = await Promise.all([
      /* Three hundred is the route's own cap. A board that draws the newest
         five posts still has to COUNT the ones in its window, and a limit of
         fifty would silently turn "nine posts in ninety days" into a floor
         nobody was told about. */
      settled(socialfeedApi.posts({ limit: 300 })),
      settled(publishingApi.items({})),
    ]);
    return {
      posts,
      publishing: publishing ? { counts: publishing.counts, items: publishing.items } : null,
      fetchedAt: new Date().toISOString(),
    };
  },
};
