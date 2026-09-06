import { PageShell } from "@/components/PageShell";
import { JournalFeed } from "./JournalFeed";

/**
 * THE JOURNAL PAGE — the portfolio view of work that happened off this box.
 *
 * ONE PAGE AND NO TABS. Everything the journal has is one list and one
 * composer; a tab strip over a single list would be furniture. The venture cut
 * of the same data is the venture page's Journal tab, which renders the same
 * component pinned to that venture, so there is one implementation of "what
 * does an entry look like" rather than two that drift.
 */
export function JournalPage() {
  return (
    <PageShell
      title="Journal"
      sub="Work you did away from the dashboard — calls, pages rewritten by hand, posts somewhere with no API, decisions. Typed by you, never measured."
    >
      <JournalFeed />
    </PageShell>
  );
}
