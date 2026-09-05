import { RunApp } from "@/components/runs/RunApp";

/**
 * WHAT STRANGERS ARE ASKING FOR, in their own words.
 *
 * The demand signals — Reddit, Hacker News, the searched keywords — are
 * collected already and are individually close to useless: one thread is one
 * person having a bad afternoon. The run's job is the reading across them, and
 * the thing worth having out of it is the sentence somebody actually typed,
 * which is why the brief asks for evidence with URLs rather than a summary.
 */
export function Demand() {
  return <RunApp kind="demand" slug="demand" name="Demand" />;
}
