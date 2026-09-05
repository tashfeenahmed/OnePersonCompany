import { RunApp } from "@/components/runs/RunApp";
import { GeoAnswers } from "@/components/runs/GeoAnswers";

/**
 * WHAT THE MODELS SAY WHEN SOMEBODY ASKS THEM ABOUT YOU.
 *
 * The odd one out: this run uses no tools and does not touch the web on
 * purpose. Giving the model a search tool would measure the search engine,
 * which every other page in here already does — the question is what it
 * believes with nothing in front of it, because that is what a stranger asking
 * it for a recommendation gets.
 *
 * The answers live under the composer rather than only inside their reports,
 * because the interesting reading is across runs: the same question, asked of
 * the same provider a month apart.
 */
export function Visibility() {
  return (
    <RunApp
      kind="geo"
      slug="visibility"
      name="AI visibility"
      extras={({ venture, settled }) => (
        <GeoAnswers venture={venture} refreshKey={settled} />
      )}
    />
  );
}
