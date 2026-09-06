/**
 * THE KNOWLEDGE AREA — evidence-backed product knowledge, per venture.
 *
 * NO `plugins` AND NO `collectors`. It holds no credential of its own: the
 * repository is read with the github plugin's token through `providers/
 * github.ts`, and the measured tier is derived from tables five other areas
 * already fill. Registering a collector would mean claiming a plugin, and the
 * one thing this area is not is a plugin — it is the place the other areas'
 * measurements turn into sentences about a product.
 *
 * NO `config` EITHER. There is one model on this box — the one chosen on the
 * Models page — and extraction uses it like everything else. The first real
 * extraction here was routed by the gateway to a REASONING model, which spent
 * its whole output allowance writing "We need to produce a JSON with at most
 * 12 facts…" and emitted none; the answer to that is the salvage parser in
 * extract.ts and the report quoting the first line of what came back, not a
 * second model setting the owner has to know about. The plugin row still
 * exists so the area has a page under Integrations.
 *
 * THE SETTING THAT IS *NOT* HERE is the one this feature most obviously needs —
 * which repository is this venture's. That is PER VENTURE and `plugin_config`
 * is one value for the whole box, so it lives in `knowledge_repos`, is edited
 * on the venture's own Knowledge tab, and defaults to whatever `venture_links`
 * already says. A global "the repository" box would be a setting that is wrong
 * for eighteen of nineteen businesses.
 *
 * ONE TIMER, and it is deterministic. `startDeriving` re-reads the measured
 * tier out of the live plugin tables every half hour and does nothing else; it
 * asks no model, spends no request off this box, and on a fresh install with no
 * links produces nothing at all. The repository read — the one thing here that
 * costs anything — has no timer on purpose: it is a button on the page and an
 * action on the skill, because a nightly pass over nineteen repositories is
 * nineteen completions the owner did not ask for.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { startDeriving } from "./derive.ts";
import { knowledgeRoutes } from "./routes.ts";
import { PACKS, SKILLS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "knowledge",
  routes: [{ path: "/api/knowledge", app: knowledgeRoutes }],


  skills: SKILLS,
  packs: PACKS,
  onStart() {
    startDeriving();
  },
};
