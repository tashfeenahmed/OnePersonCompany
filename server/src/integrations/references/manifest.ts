/**
 * REFERENCES — the material a generator is given before it makes anything, in
 * one place, per business.
 *
 * THE GAP THIS CLOSES. Three generators write words for a venture and one
 * draws pictures for it, and between them they read four things: the name and
 * the sentence on the venture record, the stage, the palette measured off the
 * site, and — if somebody remembered to select one — a picture out of the
 * publishing area's asset library. Nowhere among those is there anywhere to
 * say how the business SOUNDS. The owner could type a tone of voice into every
 * brief, forever, or he could type it once. This is once.
 *
 * A SMALL AREA WITH ONE TABLE, ONE ROUTER AND ONE SKILL. There is no
 * collector, because nothing here is read off anybody else's machine; there is
 * no plugin and no credential, because the contents are what the owner typed;
 * there is no timer, because a style guide does not go stale on a schedule.
 * The whole of the area is: a table of opinion, a route that joins it to two
 * things other areas already own, and a page.
 *
 * WHAT IT DOES NOT OWN, and this is the deliberate half. The ASSET LIBRARY is
 * the publishing area's — the table, the multipart upload, the 12 MB cap, the
 * byte sniffing and the SSRF-checked URL importer — and the References page
 * posts to `/api/publishing/assets` like the Assets tab does. The BRAND is
 * ventures/enrich.ts's, measured off the site and rewritten whole on every
 * read. Duplicating either would be a second place to get it wrong, and in the
 * brand's case a second place to be overwritten from.
 *
 * WHERE THE GUIDE ACTUALLY GETS USED. Not here. `guidePrompt` is called by
 * ventures/studio.ts (the caption), video/script.ts (the faceless script) and
 * videoplus/reel.ts (the dialogue); `guideVisuals` by the Studio's image
 * prompt. Each call is three lines and each is guarded on the guide existing,
 * so a box where nobody has written one builds exactly the prompts it built
 * before.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { referencesRoutes } from "./routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "references",
  skills: SKILLS,
  packs: PACKS,
  routes: [{ path: "/api/references", app: referencesRoutes }],
};
