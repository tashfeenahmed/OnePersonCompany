/**
 * ACTIVITY — who signed up, what happened, and what is on the floor.
 *
 * Three things that are one question asked at three distances. `users` asks
 * the products themselves who is using them, which is the one population no
 * vendor on this box can be asked about. `activity` merges every source
 * already being collected into a single timeline, which is the only surface
 * here on the time axis. `leakage` asks the Stripe tables what was tried and
 * not collected — the one figure worth opening a dashboard for, because unlike
 * MRR it is a number a person can change this afternoon.
 *
 * ONE CREDENTIALED PLUGIN, AND TWO DERIVATIONS THAT ARE NOT PLUGINS AT ALL.
 * `users` holds a real credential, one account per product endpoint, exactly
 * the shape `product-stats` has for the same reason: one account is one URL and
 * the label is the product's name. The feed and the leakage figures own no
 * credential, no account and no collector — the feed is a PASS over tables
 * other integrations fill, and the leakage document is computed on every read
 * and stored nowhere. Neither could be a plugin without inventing a connection
 * that does not exist.
 *
 * THE ONE SETTING IS THE VENTURE MAPPING, and it is a setting rather than a
 * constant because the link between "the product called Example App 2" and "the venture
 * called Overbrilliant" is a fact about this owner's businesses and nothing
 * else on this box knows it. It is checked against the real venture list when
 * it is typed, so a slug with a typo is refused at the field rather than
 * silently filing a product's users under nothing.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { COLLECT_MINUTES } from "../../config.ts";

import { PLUGIN as USERS, collectUsers, verify as verifyUsers } from "./users.ts";
import { userRoutes } from "./users-routes.ts";
import { checkMapping } from "./link.ts";
import { activityRoutes } from "./feed-routes.ts";
import { runFeedPass, startFeed } from "./feed.ts";
import { leakageRoutes } from "./leakage.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "activity",

  plugins: {
    /*
      ONE ACCOUNT IS ONE PRODUCT, and the label is the product's name — it is
      what every figure is captioned with and what the venture mapping is
      written against. The token is optional because an endpoint listing your
      own users is usually either behind a secret in the URL or on a host only
      you can reach; when there is one it goes out as a bearer.

      `verify` VALIDATES THE CONTRACT AND NOT MERELY THE CONNECTION. The owner
      is standing at the form with the endpoint's code open, which is the one
      moment "users[0].createdAt is missing" costs a minute instead of half a
      day.
    */
    [USERS]: {
      secret: "users",
      fields: ["url", "token"],
      optional: ["token"],
      verify: verifyUsers,
    },
  },

  config: {
    [USERS]: {
      keys: {
        ventures: {
          label: "Which venture each product belongs to",
          hint:
            "One line per endpoint: “endpoint label = venture slug”. This is " +
            "the STRONGEST of the three ways a product is filed — it beats a " +
            "link made on the venture map, and both beat the hostname guess " +
            "this makes when neither exists. You only need a line here for a " +
            "product whose endpoint is on a different domain from the " +
            "business: an endpoint at api.example.com finds the venture at " +
            "example.com by itself. A slug that names no venture is refused " +
            "here rather than filing that product's users under nothing.",
          ph: "Example App 2 = overbrilliant\nExample App 1 = example-app-1",
          check: checkMapping,
        },
      },
    },
  },

  collectors: {
    /*
      THE FEED PASS RUNS AFTER THE COLLECTION AND NOT INSTEAD OF IT. A fresh
      set of user rows with no signup events on the feed until the next timer
      would make the Collect button look like it half worked. It is wrapped
      because a derivation must never fail a collection that succeeded — the
      rows are written either way, and a broken pass is a log line rather than
      a red plugin.
    */
    [USERS]: async () => {
      const result = await collectUsers();
      try {
        runFeedPass();
      } catch (err) {
        console.error("[activity] feed pass after collect failed:", err);
      }
      return result;
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/users", app: userRoutes },
    { path: "/api/activity", app: activityRoutes },
    { path: "/api/leakage", app: leakageRoutes },
  ],

  /* The feed pass, on the collectors' own cadence. It is the only timer this
     area owns, it writes nothing but events derived from tables that already
     exist, and it is unref'd so it can never be the reason the process will
     not exit. */
  onStart: () => startFeed(COLLECT_MINUTES),
};
