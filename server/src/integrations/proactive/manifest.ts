/**
 * PROACTIVE — the half of this dashboard that speaks first.
 *
 * Everything else on this box answers a question. You open a page, you ask the
 * agent, you run `opc stripe`. That is the right shape for almost all of it and
 * it has one failure mode, which is the only one that actually costs money: the
 * thing you did not think to look at. A certificate that expired on a Sunday, a
 * disk that filled overnight, a payment provider that started declining, a
 * traffic collapse three days old by the time somebody opened the page.
 *
 * SO: TWO PIECES, AND THEY ARE THE SAME IDEA AT TWO CADENCES.
 *
 *   ALERTS    A rule is a skill, a view, a path into the document that view
 *             returns, an operator and a threshold. Every evaluation reads that
 *             document over loopback HTTP — the same request `opc` makes — and
 *             records an event when the comparison the owner configured comes
 *             out true. A document that cannot be read is an event of its own
 *             kind and never a trip.
 *
 *   BRIEFING  Once a day, the same reading habit applied to everything at once:
 *             what alerted, what moved, what finished, what is due, one line a
 *             venture. Assembled as facts, written up by a model, and stored
 *             with both halves so any sentence can be checked against something.
 *
 * WHAT MAKES IT GENERIC, which is the requirement it was built against. Nothing
 * in this area knows what Stripe is. A rule addresses a document by the same
 * catalogue `GET /api/skills` publishes to an agent, and the briefing's
 * "movement" section is a diff of two snapshots of whatever documents happened
 * to be connected. Add an integration next year and it is alertable and in the
 * briefing without a line of this area changing. The only place a service is
 * named at all is `seed.ts`, which writes five suggested rules for skills that
 * are connected — and every one of them is deletable, marked as suggested, and
 * skipped entirely on a box where that plugin is not connected.
 *
 * ONE CONFIG-ONLY PLUGIN AND NO CREDENTIALS. `briefing` holds settings under a
 * plugin id — the hour, the zone, whether to push to Telegram, which sections
 * to include — so it can use the same closed, checked settings registry
 * everything else uses rather than a file nobody can correct from the page. It
 * has no secret, no account and no collector. `alerts` has no plugin at all:
 * there is nothing to configure about it that is not a rule.
 *
 * THE TIMER RUNS A MINUTE AFTER THE COLLECTOR'S, and that offset is the whole
 * scheduling design. Evaluating rules DURING a collection would read documents
 * that are half-written — some plugins refreshed, some not — and produce trips
 * that no longer hold sixty seconds later. Running a minute behind means every
 * rule reads a document that reflects the collection that just finished.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { COLLECT_MINUTES } from "../../config.ts";
import { upsertPlugin } from "../../db.ts";

import { evaluateAll } from "./engine.ts";
import { seedDefaults } from "./seed.ts";
import { alertRoutes } from "./alerts-routes.ts";
import {
  DEFAULT_HOUR,
  PLUGIN as BRIEFING,
  startBriefing,
  systemZone,
  validZone,
} from "./briefing.ts";
import { briefingRoutes } from "./briefing-routes.ts";
import { SKILLS, PACKS } from "./skills.ts";

/** A minute after each collect tick — see the file header. */
const OFFSET_MS = 60_000;

const onOffCheck = (value: string) => {
  const v = value.trim().toLowerCase();
  return !v || ["on", "off", "yes", "no", "true", "false", "1", "0"].includes(v)
    ? null
    : "Either “on” or “off”.";
};

export const manifest: IntegrationManifest = {
  id: "proactive",

  config: {
    /*
      SETTINGS AND NOT A PLUGIN. There is no credential, no account and no
      collector; what there is is a schedule and five switches, and they belong
      in the one registry that checks a value before storing it. The same
      argument ops/backups.ts makes for itself.
    */
    [BRIEFING]: {
      keys: {
        hour: {
          label: "Hour of the briefing",
          hint:
            `The local hour, 0–23, in the time zone below. Default ${DEFAULT_HOUR}. ` +
            `The timer checks every ten minutes rather than sleeping until the ` +
            `hour, so a laptop that was shut at seven builds the morning's ` +
            `briefing when it wakes instead of skipping the day. One briefing ` +
            `per day, whatever happens: the day is the key.`,
          ph: String(DEFAULT_HOUR),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            if (!Number.isInteger(n) || n < 0 || n > 23)
              return "An hour of the day, 0 to 23.";
            return null;
          },
        },
        timezone: {
          label: "Time zone",
          hint:
            `An IANA zone name — Europe/Dublin, America/New_York. Left empty ` +
            `it is this machine's own (${systemZone()}). It decides two things: ` +
            `which hour counts as the briefing's hour, and which calendar day a ` +
            `briefing belongs to. Changing it does not move briefings that were ` +
            `already built; each row keeps the zone it was built in.`,
          ph: systemZone(),
          check(value) {
            if (!value.trim()) return null;
            if (!validZone(value.trim()))
              return `“${value.trim()}” is not a time zone this machine knows. It is an IANA name like Europe/Dublin.`;
            return null;
          },
        },
        telegram: {
          label: "Push to Telegram",
          hint:
            "“on” or “off”. OFF UNTIL YOU TURN IT ON: a message arriving on " +
            "your phone every morning because a default said so is a surprise. " +
            "It goes only to the chat your bot is already paired with — the " +
            "same lock the chat bridge uses, so it cannot reach anybody else — " +
            "and rich blocks are flattened to lines of text on the way. With no " +
            "bot paired it simply does not go, and the briefing says so.",
          ph: "off",
          check: onOffCheck,
        },
        sectionAlerts: {
          label: "Include: alerts",
          hint:
            "“on” or “off”, on by default. Alerts raised since the previous " +
            "briefing, and how many are still unacknowledged. A section " +
            "switched off is left out of the facts entirely — it is not " +
            "reported as empty, because nobody asked.",
          ph: "on",
          check: onOffCheck,
        },
        sectionMovement: {
          label: "Include: what moved",
          hint:
            "“on” or “off”, on by default. Figures that changed over 24 hours, " +
            "found by diffing two snapshots of each connected skill's own " +
            "document. It says nothing at all until this box has held snapshots " +
            "for a day.",
          ph: "on",
          check: onOffCheck,
        },
        sectionRuns: {
          label: "Include: agent runs",
          hint:
            "“on” or “off”, on by default. Sub-agent runs that finished since " +
            "the previous briefing, with their kind, venture and outcome.",
          ph: "on",
          check: onOffCheck,
        },
        sectionBoard: {
          label: "Include: board cards",
          hint:
            "“on” or “off”, on by default. Cards that are overdue, and cards " +
            "due within three days. Cards with no due date are never in it.",
          ph: "on",
          check: onOffCheck,
        },
        sectionVentures: {
          label: "Include: per-venture lines",
          hint:
            "“on” or “off”, on by default. One line per venture: its stage, " +
            "how many alerts are open against it and how many runs finished for " +
            "it. A venture with nothing to say is left out by the write-up.",
          ph: "on",
          check: onOffCheck,
        },
      },
      /* CONNECTED MEANS "THE BRIEFING IS SCHEDULED", which it always is — the
         settings only decide when and what is in it. Marking the row connected
         is what puts it on the Integrations page beside the plugins whose
         settings it sits with. */
      after() {
        upsertPlugin(BRIEFING, true, null);
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/alerts", app: alertRoutes },
    { path: "/api/briefing", app: briefingRoutes },
  ],

  /**
   * Two timers and one seeding pass, none of which may throw.
   *
   * THE SEEDING PASS IS DELAYED, and the delay is load-bearing rather than
   * cautious: `seedDefaults` reads `GET /api/skills` over loopback, and
   * `onStart` runs inside the listen callback — the port is open, but every
   * area's `onStart` runs in the same tick and a request made from the first
   * one is a request into a server that is still arranging itself. Five
   * seconds is well past that and long before anybody has looked at the page.
   *
   * THE EVALUATION TIMER IS ANCHORED TO THE COLLECTOR'S. index.ts arms a plain
   * interval at COLLECT_MINUTES from the moment it starts listening; this arms
   * the same interval a minute later, so the two stay a minute apart forever
   * without either knowing about the other. With the scheduler switched off
   * (COLLECT_MINUTES = 0) this does not arm at all — there would be nothing
   * fresh to read — and the page's "Check now" is the only way rules are
   * evaluated, which is the honest behaviour for a box with no collection.
   */
  onStart() {
    /* THE ROW BEFORE THE SETTINGS. `plugin_config` has a foreign key onto
       `plugins`, so the briefing's settings cannot be stored until the row
       exists — and the row is what puts it on the Integrations page, where the
       owner finds the hour and the switches. It is created connected because
       it always is: the schedule runs whatever the settings say, and the
       settings only decide when and what is in it. */
    upsertPlugin(BRIEFING, true, null);

    setTimeout(() => {
      void seedDefaults()
        .then((seeds) => {
          for (const s of seeds)
            console.log(`[alerts] seeded ${s.created} default rule(s) for ${s.skill}: ${s.names.join(", ")}`);
        })
        .catch((err) => console.error("[alerts] could not seed defaults:", err));
    }, 5_000).unref();

    if (COLLECT_MINUTES > 0) {
      const everyMs = COLLECT_MINUTES * 60_000;
      setTimeout(() => {
        const pass = () => {
          void evaluateAll()
            .then((r) => {
              if (r.evaluated || r.events.length)
                console.log(
                  `[alerts] ${r.evaluated} rule(s): ${r.tripped} tripped, ` +
                    `${r.unreadable} unreadable, ${r.skipped} in cooldown, ` +
                    `${r.events.length} event(s), ${r.snapshots} snapshot(s)`,
                );
            })
            .catch((err) => console.error("[alerts] evaluation failed:", err));
        };
        pass();
        setInterval(pass, everyMs).unref();
      }, everyMs + OFFSET_MS).unref();
    }

    startBriefing();
  },
};
