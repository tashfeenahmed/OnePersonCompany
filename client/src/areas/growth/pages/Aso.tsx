import { RunApp } from "@/components/runs/RunApp";

/**
 * THE STORE LISTING, AS A SHOPPER READS IT.
 *
 * /api/mobile has had the units and the money for months and never once looked
 * at the page they are earned on. This audits the listing against each store's
 * own rules and scores it with the arithmetic printed — and says, in the
 * report, which fields it could not read rather than passing them by silence.
 */
export function Aso() {
  return <RunApp kind="aso" slug="aso" name="Store listing audit" />;
}
