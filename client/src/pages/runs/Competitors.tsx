import { RunApp } from "@/components/runs/RunApp";
import { CompetitorTable } from "@/components/runs/CompetitorTable";

/**
 * THE ONLY ONE OF THE SIX THAT ACCUMULATES.
 *
 * Every other kind writes a document and stops. A sweep here verifies and
 * deepens the profiles the last sweep left behind, so the standing table is
 * the product and the reports are the working — which is why the table is
 * drawn above the history rather than under it.
 *
 * The table refetches itself when a sweep finishes: `extras` is handed a
 * counter that ticks on the transition, so the new rivals appear without
 * anybody pressing refresh on a page that has been watching the run write.
 */
export function Competitors() {
  return (
    <RunApp
      kind="competitors"
      slug="competitors"
      name="Competitors"
      extras={({ venture, settled }) => (
        <CompetitorTable venture={venture} refreshKey={settled} />
      )}
    />
  );
}
