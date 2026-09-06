/**
 * NURTURE — the four things the outbox was missing to become a working
 * correspondence rather than a place to type an email.
 *
 *   A SCHEDULE (sequences.ts). Steps come due because the calendar moved, and a
 *   due step becomes a DRAFT. The whole area has no import of a send.
 *
 *   A REASON (planner.ts, facts.ts). Who is written to, why now, which business
 *   and which address are decided by plain code over rows this box already
 *   holds, and the facts that justify the message are stored on it and shown
 *   beside it.
 *
 *   A GATE (validate.ts, wording.ts). The model is handed the plan and the fact
 *   packet and asked for sentences. What it returns is read back token by token
 *   and REFUSED if it carries a number, an amount, a date, a link or an address
 *   the packet does not have. Refused, not repaired — a deterministic template
 *   built from the same packet is used instead and the card says so.
 *
 *   A RETURN ADDRESS (identities.ts, resend-send.ts). A note about a product
 *   arriving from a personal gmail.com address looks like a stranger wrote it.
 *   An identity says which domain a message may claim to be from and which
 *   transport is entitled to make that claim, with the same approval and
 *   idempotency protections the Gmail door has always had.
 *
 * ONE CONFIG-ONLY PLUGIN, NO CREDENTIAL, NO COLLECTOR.
 *
 * No credential: the Gmail half uses the `gmail` plugin's accounts and the
 * Resend half uses the `resend` plugin's keys, both through the doors those
 * plugins already own. A second copy of either would be a second thing to
 * revoke.
 *
 * No collector, and it is the trap `mailflow/manifest.ts` writes down next
 * door: `manifestCollectors()` merges every area's map OVER the built-ins by
 * plugin id, so an entry here under `gmail` or `resend` would silently REPLACE
 * a working collector. The daily pass therefore runs on this area's own timer
 * and keeps its own one-row-per-day ledger in `nurture_passes`.
 *
 * The `nurture` plugin id holds SETTINGS ONLY — four decisions about when and
 * how much gets written — for the reason the outbox's does: the settings
 * registry is the one place a value is checked before it is stored, and a
 * number governing how many strangers get an email should not be a constant in
 * a file the owner cannot reach from the page.
 */
import type { IntegrationManifest } from "../manifest.ts";

import { nurtureRoutes } from "./routes.ts";
import {
  DEFAULT_DRAFTS_PER_PASS,
  DEFAULT_HOUR,
  DEFAULT_MAX_ACTIVE,
  PLUGIN,
  startNurtureTimer,
} from "./sequences.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "nurture",

  config: {
    [PLUGIN]: {
      keys: {
        hour: {
          label: "Hour the daily pass runs",
          hint:
            `Local, 0–23. The pass stops what should stop, enrols what should ` +
            `enrol and DRAFTS what is due; it sends nothing at any hour. ` +
            `Default ${DEFAULT_HOUR}, which puts the morning's drafts in the ` +
            `Outbox before you open it. It is checked every ten minutes rather ` +
            `than armed as a long timer, so a server restart cannot make the ` +
            `pass skip a day.`,
          ph: String(DEFAULT_HOUR),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 23) return "A whole hour, 0 to 23.";
            return null;
          },
        },
        "max-active": {
          label: "People in sequences at once",
          hint:
            `Across every sequence. Once this many people are active, nobody ` +
            `new is enrolled until somebody finishes or is stopped — a ceiling ` +
            `on how much correspondence this can start, not on how much it can ` +
            `send. Default ${DEFAULT_MAX_ACTIVE}. Zero stops all automatic ` +
            `enrolment, which is a decision rather than a default.`,
          ph: String(DEFAULT_MAX_ACTIVE),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 500) return "A whole number, 0 to 500.";
            return null;
          },
        },
        "drafts-per-pass": {
          label: "Drafts one pass may write",
          hint:
            `How many cards one morning may put in the Outbox, across every ` +
            `sequence. It is a READING limit: a day that dumped forty drafts on ` +
            `you is a day you approve none of them. Default ` +
            `${DEFAULT_DRAFTS_PER_PASS}. It has nothing to do with how much ` +
            `mail can leave — that is the Outbox's own daily cap, and it is ` +
            `unchanged by anything here.`,
          ph: String(DEFAULT_DRAFTS_PER_PASS),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 50) return "A whole number, 0 to 50.";
            return null;
          },
        },
        "style-learning": {
          label: "Learn my writing style from my edits",
          hint:
            "“yes” or “no”, and it is NO unless you type otherwise. With it on, " +
            "a draft the machine wrote that you EDIT and then APPROVE is kept as " +
            "a before/after pair, and the pairs are read into a handful of short " +
            "rules about wording — greetings, sign-offs, sentence length, what " +
            "you cut. The rules go into the wording prompt and nowhere else: a " +
            "rule carrying a digit, an address, a link, a domain or anybody's " +
            "name is refused rather than stripped, and every finished message is " +
            "still checked against its fact packet afterwards. THE PAIRS QUOTE " +
            "WHOLE EMAIL BODIES, yours and the machine's. No route publishes " +
            "one — the page shows the rules and how many edits they came from — " +
            "but reading a voice out of writing means showing the writing, so up " +
            "to twelve pairs ARE sent to your connected model provider each time " +
            "the rules are derived. “Forget the voice” on the Nurture page erases " +
            "the rules and every stored pair.",
          ph: "no",
          check(value) {
            const v = value.trim().toLowerCase();
            if (!v) return null;
            if (["yes", "no", "on", "off", "true", "false"].includes(v)) return null;
            return "Either “yes” or “no”. Anything else is read as no.";
          },
        },
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [{ path: "/api/nurture", app: nurtureRoutes }],

  /* The only timer this area owns, and it can only write drafts. See
     sequences.ts: it has no import of a send and no path to one. */
  onStart() {
    startNurtureTimer();
  },
};
