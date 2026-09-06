import { JournalFeed } from "./JournalFeed";

/**
 * THE VENTURE'S JOURNAL — the same feed, pinned.
 *
 * Pinned rather than filtered: the composer files against this venture without
 * being asked, because somebody on a venture page logging work is logging work
 * about that venture, and making them choose it again from a list they just
 * navigated through is the friction this whole feature is trying to avoid.
 */
export function JournalTab({ slug }: { slug: string }) {
  return (
    <div className="p-4.5">
      <JournalFeed ventureSlug={slug} />
    </div>
  );
}
