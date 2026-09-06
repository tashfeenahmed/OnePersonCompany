/**
 * CUSTOMERS — the three things this box could measure about a business but
 * not about the people paying for it.
 *
 * It had subscription counts and a leakage document; it had no list of who is
 * leaving, no dispute-level table at all (activity/leakage.ts said so in a
 * comment), and no way to be told that a payment failed at the moment it did
 * rather than in a threshold crossing the next morning. Those are three
 * absences with one shape: an aggregate cannot name a person or a moment, and
 * both halves of "who, and by when" are what somebody acts on.
 *
 * NO CREDENTIAL AND NO ACCOUNTS. Everything here reads through the STRIPE
 * plugin's accounts, with the vault reader every other collector uses. A
 * second copy of a Stripe key would be a second thing to rotate, and this
 * integration would then have a key with different permissions from the one
 * the revenue figures came from — which is exactly the confusion the disputes
 * document is built to avoid.
 *
 * THE COLLECTOR IS REGISTERED UNDER `customers` AND NOT UNDER `stripe`, which
 * is the whole reason the id exists. `manifestCollectors()` merges every
 * area's map OVER collector.ts's built-ins by plugin id; an entry under
 * `stripe` would replace the revenue collector and take MRR, the ledger and
 * the balance off every page on the dashboard. mailflow/manifest.ts wrote the
 * same warning down about `gmail`.
 *
 * THE TIMER IS BESIDE THE COLLECTOR RATHER THAN INSTEAD OF IT. The collector
 * entry gives the Integrations page its Collect button and a run in the
 * ledger; the ten-minute timer exists because the point of an event feed is
 * that it is not a digest, and the half-hour scheduler is a digest.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { validZone } from "../proactive/briefing.ts";

import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_TRIAL_DAYS,
  PLUGIN,
  parseQuiet,
} from "./store.ts";
import { collectCustomers, markPlugin, startCustomersTimer } from "./collect.ts";
import { recoveryRoutes } from "./recovery-routes.ts";
import { disputeRoutes } from "./disputes-routes.ts";
import { businessEventRoutes } from "./events-routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "customers",

  config: {
    [PLUGIN]: {
      keys: {
        "contact-access": {
          label: "Contact access",
          hint:
            "“on” or “off”. OFF UNTIL YOU TURN IT ON. With it off, a customer's " +
            "email address is stored only as a salted hash and a domain — the " +
            "same policy the Users area keeps — and no route publishes one, so " +
            "the recovery queue can tell you a person is leaving and cannot tell " +
            "you who. With it on, the address is stored and shown, and the queue " +
            "can prepare a follow-up addressed to them. Turning it back off " +
            "DELETES every address already stored on the next pass; the hashes " +
            "stay, so nothing loses its identity.",
          ph: "off",
          check(value) {
            const t = value.trim().toLowerCase();
            if (!t) return null;
            return ["on", "off", "yes", "no", "true", "false", "1", "0"].includes(t)
              ? null
              : "“on” or “off”.";
          },
        },
        telegram: {
          label: "Push events to Telegram",
          hint:
            "“on” or “off”. OFF until you turn it on, for the reason the daily " +
            "briefing is: a message arriving on your phone because a default " +
            "said so is a surprise. With it off, events are still collected, " +
            "still deduplicated and still readable on the Customers page — what " +
            "is not happening is a push. Needs a Telegram bot connected and a " +
            "chat paired.",
          ph: "off",
          check(value) {
            const t = value.trim().toLowerCase();
            if (!t) return null;
            return ["on", "off", "yes", "no", "true", "false", "1", "0"].includes(t)
              ? null
              : "“on” or “off”.";
          },
        },
        "quiet-hours": {
          label: "Quiet hours",
          hint:
            "Two hours in 24-hour clock, like “22-8”: no event is pushed between " +
            "them, and anything that arrives inside the window waits for the end " +
            "of it rather than being dropped. In your own timezone (below). " +
            "Leave empty, or type “off”, for no quiet hours. Nothing in this " +
            "area pierces them — a dispute deadline is days away and a failed " +
            "card is a morning job.",
          ph: "22-8",
          check(value) {
            const t = value.trim().toLowerCase();
            if (!t || t === "off" || t === "none" || t === "0") return null;
            if (!parseQuiet(value))
              return "Two hours, 0–23, separated by a dash — “22-8”. The same hour twice means no quiet hours, so it is refused as a typo.";
            return null;
          },
        },
        timezone: {
          label: "Timezone",
          hint:
            "An IANA zone like “Europe/Dublin”, for quiet hours and for the " +
            "local rendering of a dispute deadline. Leave it empty and the " +
            "briefing's timezone is used; with neither set, this machine's own " +
            "zone. Two places to type a timezone is two places for it to be " +
            "wrong, so this only overrides.",
          ph: "Europe/Dublin",
          check(value) {
            const t = value.trim();
            if (!t) return null;
            return validZone(t) ? null : `“${t}” is not a timezone Node recognises.`;
          },
        },
        "trial-days": {
          label: "Trial warning",
          hint:
            `How many days before a trial ends a case opens. Default ${DEFAULT_TRIAL_DAYS}. ` +
            "Zero switches trial cases off entirely — the other three kinds are " +
            "not affected.",
          ph: String(DEFAULT_TRIAL_DAYS),
          check(value) {
            const t = value.trim();
            if (!t) return null;
            const n = Number(t);
            return Number.isInteger(n) && n >= 0 && n <= 60
              ? null
              : "A whole number of days, 0 to 60.";
          },
        },
        "horizon-days": {
          label: "Cancellation horizon",
          hint:
            "How far ahead a scheduled cancellation is worth a case. Default " +
            `${DEFAULT_HORIZON_DAYS} days, which is /api/stripe's own “ending soon”. An annual ` +
            "plan that switched off auto-renew on day one stays paid for eleven " +
            "months; putting that at the top of a queue beside a monthly one " +
            "ending on Thursday is how a queue stops being read.",
          ph: String(DEFAULT_HORIZON_DAYS),
          check(value) {
            const t = value.trim();
            if (!t) return null;
            const n = Number(t);
            return Number.isInteger(n) && n >= 1 && n <= 400
              ? null
              : "A whole number of days, 1 to 400.";
          },
        },
      },
      /* Saving a setting is also the moment to recompute the flag: this plugin
         has no accounts of its own, so "connected" means a Stripe account is. */
      after() {
        markPlugin(null);
      },
    },
  },

  collectors: {
    /* Under `customers`. See this file's header on why it must never be
       `stripe`. */
    [PLUGIN]: collectCustomers,
  },

  routes: [
    { path: "/api/recovery", app: recoveryRoutes },
    { path: "/api/disputes", app: disputeRoutes },
    { path: "/api/business-events", app: businessEventRoutes },
  ],

  skills: SKILLS,
  packs: PACKS,

  onStart() {
    /* The flag first, so the scheduler knows whether to call the collector at
       all, and then the timer. Neither throws — an integration that could
       take the server down at boot is worse than one that is late. */
    try {
      markPlugin(null);
    } catch {
      /* A database that is not ready yet is a problem the next pass reports. */
    }
    startCustomersTimer();
  },
};
