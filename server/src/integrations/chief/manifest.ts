/**
 * THE CHIEF OF STAFF AREA — the four things a dashboard needs before it can
 * advise rather than report.
 *
 * EVERY OTHER AREA ON THIS BOX MEASURES SOMETHING. This one holds the four
 * documents that make the measurements mean anything, and none of them is
 * collected from anywhere:
 *
 *   GOALS      — what the owner is trying to do, in their own words. Without
 *                it "traffic is down 12%" is a fact with no significance.
 *   MEMORY     — what the assistant has learned and can be held to, dated.
 *                Without it, every conversation starts from nothing.
 *   ROUNDS     — a reason for work to happen on a Tuesday when nobody opened
 *                the dashboard.
 *   OUTCOMES   — whether anything that was done changed a number.
 *
 * NO `plugins` AND NO `collectors`. Nothing here holds a credential and nothing
 * here goes stale on a cadence: three of the four are the owner's own writing
 * or the agent's, and the fourth reads other areas' documents through the
 * skills surface at the moment a reading is due. There is ONE `config` entry
 * and it is a pseudo-plugin — `rounds`, the schedule — for the same reason
 * `workspace`, `chat` and `backups` are: plugin_config points at plugins, a
 * setting has to hang off something, and a schedule is a decision rather than a
 * secret.
 *
 * THREE TIMERS, ALL OF WHICH DO NOTHING UNTIL THEY ARE ASKED TO. The rounds
 * timer wakes every ten minutes and returns immediately unless the owner has
 * switched rounds on; the consolidation timer wakes hourly and returns unless a
 * week has passed and there are at least three notes; the readings timer wakes
 * hourly and returns unless an outcome is due a reading. On a fresh install all
 * three are no-ops for ever, which is the correct behaviour for a feature
 * nobody has configured.
 *
 * WHY ONE AREA AND NOT FOUR. They are one feature: the round reads the goals to
 * write its briefs, the outcome measures what the round produced, and the
 * memory is where what was learned from both ends up. Four directories would
 * mean four manifests importing each other, and the seam is designed to make
 * that unnecessary rather than tidy.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { NOW, settleOpenRows } from "../../shared/settle.ts";
import { validZone } from "../../shared/time.ts";
import { goalRoutes } from "./goals-routes.ts";
import { memoryRoutes } from "./memory-routes.ts";
import { outcomeRoutes } from "./outcomes-routes.ts";
import { roundRoutes } from "./rounds-routes.ts";
import { startConsolidation } from "./memory.ts";
import { startReadings } from "./outcomes.ts";
import {
  DEFAULT_DAYS,
  DEFAULT_HOUR,
  DEFAULT_MAX,
  DEFAULT_QUIET,
  DEFAULT_ROLES,
  ROUNDS_PLUGIN,
  afterConfig,
  startRounds,
} from "./rounds.ts";
import { ROLES } from "../subagents/store.ts";
import { PACKS, SKILLS } from "./skills.ts";

const ROLE_LIST = ROLES.map((r) => r.role).join(", ");

export const manifest: IntegrationManifest = {
  id: "chief",

  routes: [
    { path: "/api/goals", app: goalRoutes },
    { path: "/api/memory", app: memoryRoutes },
    { path: "/api/rounds", app: roundRoutes },
    { path: "/api/outcomes", app: outcomeRoutes },
  ],

  config: {
    /*
      THE SCHEDULE, AND NOTHING ELSE.
      Goals and memory have no settings on purpose: they are documents, they
      are edited where they are read, and a "maximum notes" box on a settings
      page would be a knob nobody turns standing next to the thing it limits.
      Outcomes have none either — 7/14/30 days is not a preference, it is the
      shape of the question.
    */
    [ROUNDS_PLUGIN]: {
      keys: {
        enabled: {
          label: "Run rounds",
          hint:
            `"on" to walk the estate once a day. Anything else, including ` +
            `empty, and the timer wakes every ten minutes and does nothing. ` +
            `A round dispatches REAL runs into the single run slot and spends ` +
            `real tokens.`,
          ph: "on",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "on" || v === "off" ? null : `"on" to switch rounds on, empty or "off" to leave them off.`;
          },
        },
        hour: {
          label: "Hour of the round",
          hint:
            `The hour, 0–23, in the time zone below. Default ${DEFAULT_HOUR}. ` +
            `The timer checks every ten minutes rather than sleeping until the ` +
            `hour, so a laptop that was shut at six runs the round when it ` +
            `wakes instead of skipping the day.`,
          ph: String(DEFAULT_HOUR),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isInteger(n) && n >= 0 && n <= 23 ? null : "An hour of the day, 0 to 23.";
          },
        },
        timezone: {
          label: "Time zone",
          hint:
            `An IANA zone — Europe/Dublin, America/New_York. Empty means this ` +
            `machine's own, which is right until the machine travels. It also ` +
            `decides what "today" means for the once-a-day check.`,
          ph: Intl.DateTimeFormat().resolvedOptions().timeZone,
          check(value) {
            const v = value.trim();
            if (!v) return null;
            return validZone(v) ? null : `"${v}" is not a time zone this machine knows. Use an IANA name like Europe/Dublin.`;
          },
        },
        roles: {
          label: "Roles each round dispatches",
          hint:
            `Which of the six sub-agents get a job on a venture that is due, ` +
            `comma separated: ${ROLE_LIST}. Default ${DEFAULT_ROLES.join(", ")}. ` +
            `Each role named here is a whole run — minutes of the one slot and ` +
            `real tokens — per venture worked, so two roles is twice the bill.`,
          ph: DEFAULT_ROLES.join(", "),
          check(value) {
            const v = value.trim();
            if (!v) return null;
            const bad = v
              .split(/[,\s]+/)
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
              .filter((r) => !ROLES.some((x) => x.role === r));
            return bad.length ? `Not a role: ${bad.join(", ")}. The six are ${ROLE_LIST}.` : null;
          },
        },
        max: {
          label: "Most runs in one round",
          hint:
            `The cap on how much of the single run slot one round may spend. ` +
            `Default ${DEFAULT_MAX}. Ventures past the cap are recorded as ` +
            `skipped with that reason and are first in line next time.`,
          ph: String(DEFAULT_MAX),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isInteger(n) && n >= 1 && n <= 20 ? null : "A whole number of runs, 1 to 20.";
          },
        },
        days: {
          label: "Days between rounds on one venture",
          hint:
            `A venture worked by a round is left alone for this many days. ` +
            `Default ${DEFAULT_DAYS}. 0 means every round may work every ` +
            `venture, which with nineteen of them is a queue with a day of ` +
            `work in it.`,
          ph: String(DEFAULT_DAYS),
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isInteger(n) && n >= 0 && n <= 365 ? null : "A whole number of days, 0 to 365.";
          },
        },
        quiet: {
          label: "Stages a round skips",
          hint:
            `Comma separated venture stages that get no scheduled work: ` +
            `idea, pre-launch, launched. Default ${DEFAULT_QUIET.join(", ")} — ` +
            `an idea-stage venture with no site has nothing for an analyst to ` +
            `read, and a round that dispatched one would spend the slot on a ` +
            `report saying so.`,
          ph: DEFAULT_QUIET.join(", "),
          check(value) {
            const v = value.trim();
            if (!v) return null;
            const known = ["idea", "pre-launch", "launched"];
            const bad = v
              .split(/[,\s]+/)
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
              .filter((s) => !known.includes(s));
            return bad.length ? `Not a stage: ${bad.join(", ")}. The three are ${known.join(", ")}.` : null;
          },
        },
      },
      after: afterConfig,
    },
  },

  skills: SKILLS,
  packs: PACKS,

  /*
    THE ROUNDS LEDGER IS SETTLED FIRST, before the timers below are armed.
    See `shared/settle.ts` for why every open-row ledger needs this at boot —
    `runRound`'s `finally` cannot run for a round the process died inside.
  */
  onStart() {
    const stale = settleOpenRows({
      table: "chief_rounds",
      openWhen: "finished_at IS NULL",
      set: { finished_at: NOW },
      /* NO NOTE. `chief_rounds.notes` is a JSON array the page parses, not
         prose — a sentence written into it would be read back as an empty
         list, losing the per-venture lines the round did manage to file. The
         closed row with its counters still at zero is the whole of the fact
         here; the reason lives in this comment and in the boot log. */
    });
    if (stale) console.log(`[chief] closed ${stale} round(s) the process died inside`);

    /* Three timers, armed together and each idle until it is configured. None
       of them throws: they run with nobody to catch them. */
    startRounds();
    startConsolidation();
    startReadings();
  },
};
