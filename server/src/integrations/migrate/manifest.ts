/**
 * MIGRATE — coming from somewhere else, and taking the products with you.
 *
 * NO PLUGIN, NO CREDENTIAL, NO COLLECTOR. This area holds nothing that could
 * be connected and nothing that runs on a schedule, which makes it the smallest
 * manifest in the tree: a router and a skill.
 *
 * WHY NO COLLECTOR. Everything here is either a one-off — an import happens
 * once and is then a ledger entry — or belongs to somebody else's schedule: the
 * product endpoints are collected by `users` and `product-stats`, which already
 * run every half hour, and a second timer re-reading the same documents to
 * decorate them would be two collectors disagreeing about one endpoint.
 *
 * WHY NO PLUGIN EITHER, when `backups` and `people` both hold settings under a
 * plugin id. Because there is nothing to set. Where the WorkDash directory is
 * and which kinds to take are arguments to a command somebody runs in a shell
 * once; a stored setting for them would be a setting that is wrong the moment
 * the import is finished, sitting on a page forever.
 *
 * The adapter TEMPLATES live outside this tree entirely, in deploy/adapters/,
 * because they run on the product's host and not on this one. What is here is
 * the validator that tells somebody whether the document their adapter produces
 * would be accepted — and it calls the collector's own `validate()` rather than
 * a copy of it, which is the only way the answer stays true.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { migrateRoutes } from "./routes.ts";
import { PACKS, SKILLS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "migrate",
  skills: SKILLS,
  packs: PACKS,
  routes: [{ path: "/api/migrate", app: migrateRoutes }],
};
