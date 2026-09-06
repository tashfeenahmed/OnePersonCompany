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
 * ONE `config` KEY AND IT IS A PSEUDO-PLUGIN, on `rounds`' and `backups`'
 * precedent: `plugin_config` hangs settings off plugins, and "which model reads
 * a repository" is a decision rather than a secret.
 *
 * WHY THAT KEY EXISTS AT ALL, since the box already has a chosen provider. The
 * first real extraction on this box was routed by the gateway to a REASONING
 * model, which spent its whole output allowance writing "We need to produce a
 * JSON with at most 12 facts…" and was cut off before it emitted any. Nothing
 * was wrong with the prompt — the same prompt at the same size answers with
 * clean JSON on an instruction-following model. Extraction is a strict-shape
 * task under an output ceiling, and it is the one job on this box where the
 * default "let the gateway pick" is actively wrong. So the owner may name a
 * model for it, empty means the provider's own choice, and the failure is
 * legible either way: the extraction report quotes the first line of whatever
 * came back.
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
import { KNOWLEDGE_PLUGIN } from "./extract.ts";
import { knowledgeRoutes } from "./routes.ts";
import { PACKS, SKILLS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "knowledge",
  routes: [{ path: "/api/knowledge", app: knowledgeRoutes }],

  config: {
    [KNOWLEDGE_PLUGIN]: {
      keys: {
        model: {
          label: "Model that reads a repository",
          hint:
            `The model id an extraction is sent to, on whichever provider is ` +
            `chosen on the Models page. Empty means the provider's own default, ` +
            `which is right for everything else on this box and is the one ` +
            `setting worth overriding here: reading a repository is a ` +
            `strict-JSON task under an output ceiling, and a reasoning model ` +
            `routed to it spends the whole ceiling thinking and returns nothing ` +
            `this parser can read. Name an instruction-following model if the ` +
            `extraction report keeps saying the answer could not be read.`,
          ph: "gemini-3.8-flash",
        },
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,
  onStart() {
    startDeriving();
  },
};
