/**
 * MOBILE HEALTH — what the apps DO, beside the area that measures what they
 * EARN.
 *
 * /api/mobile reads two credentials for money and headline units: Google's
 * report bucket over `devstorage.read_only`, and App Store Connect's sales and
 * finance reports. Its own header says, in as many words, that it deliberately
 * calls neither the Android Publisher API nor the Play Developer Reporting API
 * because each is a separate grant that can be missing on its own. This area is
 * everything on the other side of that line:
 *
 *   #11  the SLICED Play exports — installs by country, device, OS version,
 *        carrier, language and version code; store listing conversion; the
 *        retained-installer curve where the bucket has one
 *   #12  crash and ANR figures, from three sources kept apart, on a path that
 *        can be refused without costing revenue a single row
 *   #13  the reviews themselves, both stores, with a trend summary that cites
 *        the review ids it read
 *   #14  the App Store Connect analytics pipeline and the version-state
 *        history Apple publishes no history for
 *
 * NO PLUGIN AND NO CREDENTIAL OF ITS OWN. It reads the `playstore` and
 * `appstore` accounts through the vault the same way their own providers do. A
 * second copy of a service-account key would be a second thing to revoke.
 *
 * AND NO COLLECTOR ENTRY, WHICH IS THE TRAP WORTH NAMING TWICE.
 * `manifestCollectors()` merges every area's map OVER `collector.ts`'s
 * built-ins, keyed by plugin id: an entry under `playstore` here would
 * SILENTLY REPLACE the collector that reads the installs and the payouts. So
 * this area runs its own six-hour timer (`onStart`) and offers
 * POST /api/mobilehealth/collect for a run on demand.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { mobileHealthRoutes } from "./routes.ts";
import { startMobileHealthTimer } from "./collect.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "mobilehealth",
  skills: SKILLS,
  packs: PACKS,
  routes: [{ path: "/api/mobilehealth", app: mobileHealthRoutes }],
  /* Arms nothing on its own: the timer wakes every fifteen minutes and does
     nothing at all until six hours have passed AND one of the two stores is
     connected. */
  onStart: startMobileHealthTimer,
};
