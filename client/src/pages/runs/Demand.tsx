import { RunApp } from "@/components/runs/RunApp";

/**
 * WHAT STRANGERS ARE ASKING FOR, in their own words.
 *
 * The demand signals — Reddit, Hacker News, the searched keywords — are
 * collected already and are individually close to useless: one thread is one
 * person having a bad afternoon. The run's job is the reading across them, and
 * the thing worth having out of it is the sentence somebody actually typed,
 * which is why the brief asks for evidence with URLs rather than a summary.
 *
 * WHAT ARRIVES HERE IS AN HTML DOCUMENT, not markdown, since the run was given
 * the two-turn shape the research report and the competitor sweep have: an
 * investigation that goes out and collects the wording, then a tools-off
 * writer that lays it out. The page carries a table of verbatim asks with
 * their hostname, date and score, a bar chart of threads per watch phrase
 * drawn only where the brief holds real counts, the phrases that produced
 * nothing, proposed replacements for the watch list, and ranked actions —
 * followed by the usual ```json cards``` fence.
 *
 * NOTHING BELOW CHANGES FOR ANY OF THAT. `RunApp` frames an HTML report
 * already (client/src/lib/report.ts detects it on the text, ReportFrame
 * sandboxes it, the artifact download ships report.html), so this page stays
 * the one line it was — which is the point of detecting the format on the
 * output rather than forking the client on the kind.
 */
export function Demand() {
  return <RunApp kind="demand" slug="demand" name="Demand" />;
}
