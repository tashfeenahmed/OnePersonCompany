import { RunApp } from "@/components/runs/RunApp";

/**
 * WHAT TO CHANGE ON THE SITE, RANKED — and nothing is crawled to produce it.
 *
 * The audit already crawled. Search Console, Bing, the backlink readings and
 * the presence sweep have all already been collected by their own integrations
 * on their own schedules. This run READS those, which is the whole design: a
 * second crawler in the same box would be a second set of numbers that
 * disagreed with the first, and the interesting work was never the fetching —
 * it was deciding which of forty findings is worth an afternoon.
 */
export function Seo() {
  return <RunApp kind="seo" slug="seo" name="SEO" />;
}
