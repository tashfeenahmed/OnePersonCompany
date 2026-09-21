import { RunApp } from "@/components/runs/RunApp";
import { GeoAnswers } from "@/components/runs/GeoAnswers";

/**
 * WHAT THE MODELS SAY WHEN SOMEBODY ASKS THEM ABOUT YOU.
 *
 * The model is asked the way a stranger's assistant would be asked today: with
 * a web search tool in its hands, one it may use a few times per question.
 * What it searched and what it was shown are kept beside every answer,
 * because that is where the answer came from and where a change has to land.
 * The older no-tools reading is still available from the composer, for
 * comparison, and every row says which way it was asked.
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
