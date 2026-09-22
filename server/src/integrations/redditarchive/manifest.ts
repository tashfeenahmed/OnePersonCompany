/**
 * REDDIT ARCHIVE — Reddit posts, comments and threads for agents, read from
 * Arctic Shift because reddit.com blocks this box. See arctic.ts.
 *
 * One router and one skill; no plugin, no credential, no collector. The watch
 * list collector (providers/demand.ts) is separate and still reads Reddit's
 * own Atom search feed, which remains open.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { redditRoutes } from "./routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "redditarchive",
  skills: SKILLS,
  packs: PACKS,
  routes: [{ path: "/api/reddit", app: redditRoutes }],
};
