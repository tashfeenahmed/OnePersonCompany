/**
 * JOURNAL — the operating history of the half of the company nothing collects.
 *
 * NO PLUGIN, NO CREDENTIAL, NO COLLECTOR, and all three absences are the
 * design rather than an omission. Every other area here exists because a
 * service publishes something and a collector can fetch it. This one exists
 * because the most consequential work in a one-person company — the call, the
 * rewrite, the post on a forum with no API, the decision — publishes nothing
 * anywhere, and three months later the dashboard's own history says the week
 * was empty.
 *
 * SO IT IS ALWAYS LIVE. `plugins: []` on the skill means a box with nothing
 * connected at all can still keep this, which is the correct behaviour for the
 * one table whose contents are entirely the owner's.
 *
 * THREE DOORS, ONE GATE. The Journal page, a Telegram `/did`, and the agent's
 * `add_entry` all reach `entries.ts::addEntry`, which is where every rule about
 * what an entry may be is enforced. Each door stamps its own `source` and none
 * reads one from its request.
 *
 * THAT HOLDS THROUGH THE SKILLS SURFACE, WHICH IS THE SURFACE IT IS ABOUT, and
 * saying so precisely matters more than saying it strongly. The skill publishes
 * exactly two writes — `add_entry`, which is the `/agent` route, and
 * `set_result` — so an agent working through the proxy cannot file a row as the
 * owner's, cannot delete one and cannot reach the export. It is NOT a claim
 * about an agent with a shell: `/api` has no auth on this box (see the README's
 * own note on that), and anything running as the owner can POST anywhere. The
 * defence there is the same one the whole box has, and the stamp's job here is
 * to make the provenance of every row VISIBLE — which is why the streak counts
 * only the owner's sources and publishes the agent-filed count beside itself,
 * rather than trusting that nothing could ever have written the row.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { journalRoutes } from "./routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "journal",
  skills: SKILLS,
  packs: PACKS,
  routes: [{ path: "/api/journal", app: journalRoutes }],
};
