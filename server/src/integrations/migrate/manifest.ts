/**
 * MIGRATE — coming from somewhere else, and taking the products with you.
 *
 * NO PLUGIN, NO CREDENTIAL, NO COLLECTOR. This area holds nothing that could
 * be connected and nothing that runs on a schedule — a router, a skill, and
 * one setting (below) with nothing behind it but a filename pattern.
 *
 * WHY NO COLLECTOR. Everything here is either a one-off — an import happens
 * once and is then a ledger entry — or belongs to somebody else's schedule: the
 * product endpoints are collected by `users` and `product-stats`, which already
 * run every half hour, and a second timer re-reading the same documents to
 * decorate them would be two collectors disagreeing about one endpoint.
 *
 * WHY (ALMOST) NO PLUGIN, when `backups` and `people` both hold settings under
 * a plugin id. Where the WorkDash directory is and which kinds to take are
 * arguments to a command somebody runs in a shell once; a stored setting for
 * them would be a setting that is wrong the moment the import is finished,
 * sitting on a page forever. The one exception is `admin-token-files`: which
 * filenames are this owner's own product admin tokens is not something the
 * importer can know without being told, and unlike the rest it is stable
 * across runs.
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
import { adminTokenStems } from "./workdash.ts";

export const manifest: IntegrationManifest = {
  id: "migrate",
  skills: SKILLS,
  packs: PACKS,
  config: {
    migrate: {
      keys: {
        "admin-token-files": {
          label: "Product admin token filenames",
          hint:
            "Which `*-admin-token` files in the WorkDash directory are your " +
            "own products' admin secrets, one stem per line or comma " +
            "separated — “acme” matches `acme-admin-token`. They are never " +
            "opened either way (anything ending `-token` is refused on sight); " +
            "this only decides whether the reconnect list names them.",
          ph: "",
          check(value) {
            const bad = adminTokenStems(value).find((s) => !/^[a-z0-9][a-z0-9_-]*$/.test(s));
            return bad
              ? `“${bad}” is not a plain filename stem — letters, digits, - and _, no path.`
              : null;
          },
        },
      },
    },
  },
  routes: [{ path: "/api/migrate", app: migrateRoutes }],
};
