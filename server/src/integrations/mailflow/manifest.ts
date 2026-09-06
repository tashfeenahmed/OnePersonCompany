/**
 * MAILFLOW — the two halves of a working inbox that this box did not have.
 *
 * `/api/mail` measures the mailbox (how much, how fast, how many waiting) and
 * `/api/mailbox` reads it. Neither answers the two questions a person actually
 * has in the morning: which of these need me, and what do I say. Triage is the
 * first; the outbox is the second, with the send behind a button.
 *
 * ONE CONFIG-ONLY PLUGIN, NO CREDENTIAL, AND NO COLLECTOR.
 *
 * No credential: both halves use the GMAIL plugin's accounts through
 * `providers/gmail.ts`'s own `open()`. There is no second Google token here
 * and there must not be — a second copy of a refresh token is a second thing
 * to revoke.
 *
 * No collector, and this is the trap worth writing down: `manifestCollectors()`
 * merges every area's map OVER `collector.ts`'s built-ins, keyed by plugin id.
 * An entry under `gmail` here would silently REPLACE the mail collector and
 * take the whole of `/api/mail` down with it. So the triage pass runs on this
 * area's own half-hour timer (`onStart`) and keeps its own one-row-per-mailbox
 * ledger in `mailflow_triage_runs`.
 *
 * The `outbox` plugin id holds SETTINGS ONLY — four decisions about mail that
 * leaves — for the reason `backups` does the same: the settings registry is
 * the one place a value is checked before it is stored, and a number that
 * governs whether a stranger gets an email should not be a constant in a file
 * the owner cannot reach from the page.
 */
import type { IntegrationManifest } from "../manifest.ts";

import { triageRoutes } from "./triage-routes.ts";
import { startTriageTimer } from "./triage.ts";
import { recoverInterruptedSends, DEFAULT_DAILY_CAP, DEFAULT_GAP_DAYS, PLUGIN as OUTBOX } from "./outbox.ts";
import { outboxRoutes } from "./outbox-routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "mailflow",

  config: {
    [OUTBOX]: {
      keys: {
        "gap-days": {
          label: "Days between mails to one address",
          hint:
            `The floor. A second draft to the same address inside this many ` +
            `days is refused, and so is a send. EVERY ROW COUNTS, INCLUDING ` +
            `DISMISSED ONES — a dismissal is “not this person, not now”, and ` +
            `re-offering the same address two days later is how a queue ` +
            `teaches you to stop reading it. Default ${DEFAULT_GAP_DAYS}. Zero ` +
            `switches the floor off, which is a decision rather than a default.`,
          ph: String(DEFAULT_GAP_DAYS),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 365)
              return "A whole number of days, 0 to 365. 0 turns the floor off.";
            return null;
          },
        },
        signature: {
          label: "Signature",
          hint:
            "Appended under every message that leaves, with a blank line above " +
            "it. It is shown in the draft preview as well, so what you approve " +
            "is exactly what is sent — a signature added invisibly at send time " +
            "would mean the document you read is not the one that went out. " +
            "Leave it empty for none.",
          ph: "— Sam",
          check(value) {
            if (value.length > 600)
              return "That is more than 600 characters. A signature, not a letterhead.";
            return null;
          },
        },
        "daily-cap": {
          label: "Messages a day",
          hint:
            `How many messages may actually LEAVE in one local day, counted ` +
            `across every venture and every recipient. It is a circuit breaker ` +
            `rather than a policy: whatever goes wrong upstream, this box ` +
            `cannot become a sender of volume without somebody changing this ` +
            `number. Default ${DEFAULT_DAILY_CAP}. Drafts do not count — only ` +
            `sends.`,
          ph: String(DEFAULT_DAILY_CAP),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 500)
              return "A whole number of messages a day, 0 to 500. 0 stops all sending.";
            return null;
          },
        },
        approval: {
          label: "Drafts require approval",
          hint:
            "“yes” or “no”, and it is YES unless you type otherwise — anything " +
            "unrecognised is read as yes, because this is the setting that " +
            "must fail towards a person pressing a button. It governs one " +
            "thing only: whether YOUR Send button may approve on the way past. " +
            "IT CHANGES NOTHING FOR THE AGENT. The outbox skill publishes no " +
            "approve and no send action at any setting, and both routes refuse " +
            "a request that came through the skills proxy — so no value here, " +
            "and no request an agent can make, lets anything but a person send " +
            "mail from this box.",
          ph: "yes",
          check(value) {
            const v = value.trim().toLowerCase();
            if (!v) return null;
            if (["yes", "no", "on", "off", "true", "false"].includes(v)) return null;
            return "Either “yes” or “no”. Anything else is read as yes.";
          },
        },
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/triage", app: triageRoutes },
    { path: "/api/outbox", app: outboxRoutes },
  ],

  /* The only timer this area owns, and it can only write triage scores. See
     triage.ts: it has no import of the outbox and no path to a send. */
  onStart() {
    recoverInterruptedSends();
    startTriageTimer();
  },
};
