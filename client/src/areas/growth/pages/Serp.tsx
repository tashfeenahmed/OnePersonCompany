import { RunApp } from "@/components/runs/RunApp";

/**
 * WHAT THE PAGES ABOVE US ACTUALLY HAVE ON THEM.
 *
 * The SEO app reads our own crawl and can only ever measure us against a
 * checklist. This one is per QUERY and measures us against the pages that are
 * actually beating us — read out of their own HTML by the server, so the
 * comparison in the report is arithmetic rather than an impression.
 */
export function Serp() {
  return <RunApp kind="serp" slug="serp" name="SERP teardown" />;
}
