/**
 * THE PIPELINE AREA — one visible schedule, and one cross-source pass.
 *
 * TWO PSEUDO-PLUGINS, `pipeline` AND `synthesis`, neither of which holds a
 * credential. `plugin_config` has a foreign key onto `plugins`, so a setting
 * has to hang off a row; both rows exist so that the decisions this area cannot
 * work out for itself — what hour the night starts, when the owner does not
 * want anything running, how much a night may spend, how many ventures get a
 * pass — can be typed on the Integrations page and read back. It is the device
 * `rounds`, `briefing`, `capture` and `studio` already use, and the argument is
 * theirs: a value that governs whether money is spent unattended should not be
 * a constant in a file the owner cannot reach.
 *
 * TWO ENTRIES RATHER THAN ONE, because they are two decisions with two
 * audiences. The pipeline's settings are about TIME — the hour, the zone, the
 * blackouts, the budget. Synthesis's are about JUDGEMENT — how many ventures a
 * night, how many proposals each, how long before the same idea may be raised
 * again. Putting them on one page would make the owner scroll past six timing
 * fields to change how many cards land on his board.
 *
 * NEITHER APPEARS UNDER INTEGRATIONS, and that is worth saying because the
 * settings registry usually implies it does. That page renders from
 * `client/src/data/plugins.ts`, a catalog of things you CONNECT, and neither of
 * these holds a credential to connect. Both sets of dials therefore live on the
 * Pipeline tab, next to the schedule and the proposals they govern — which is
 * where somebody changing them is already looking. The config registry is still
 * the right home for the values themselves: it is the one place they are
 * validated before they are stored.
 *
 * ONE TIMER, AND IT IS IDLE UNTIL IT IS SWITCHED ON. `startPipeline` wakes
 * every ten minutes and returns immediately unless the owner has set
 * `enabled = on`. On a fresh install it is a no-op for ever, which is the
 * correct behaviour for a feature nobody has configured — and it must be,
 * because the alternative is a box that starts spending money on its second
 * night without anybody asking it to.
 *
 * THE STAGES ARE REGISTERED IN `onStart` AND NOT AT MODULE LOAD, and the reason
 * is ORDER rather than imports. An earlier version of this comment claimed the
 * deferral kept `chief/rounds.ts` out of the manifest's module graph; that was
 * simply false — `./stages-called.ts` is imported statically two lines below
 * and imports rounds itself, harmlessly, since chief's own manifest already
 * does. What the deferral actually buys is that registration happens once, after
 * every area's module has been evaluated, so a stage another area registers on
 * this registry (seoops, say) cannot be overwritten by a re-registration during
 * import, and so `registerStage` is never called before the migrations that
 * create the tables its prefs live in have run.
 */
import { validZone } from "../../shared/time.ts";
import type { IntegrationManifest } from "../manifest.ts";
import { registerBuiltins } from "./builtins.ts";
import { startPipeline } from "./nightly.ts";
import { pipelineRoutes } from "./routes.ts";
import {
  DEFAULT_HOUR,
  DEFAULT_MAX_MINUTES,
  PIPELINE_PLUGIN,
  parseBlackouts,
  settings,
} from "./registry.ts";
import { PACKS, SKILLS } from "./skills.ts";
import { registerCalledStages } from "./stages-called.ts";
import {
  DEFAULT_PER_NIGHT,
  DEFAULT_PER_NIGHT_VENTURES,
  DEFAULT_PER_VENTURE,
  DEFAULT_REPEAT_DAYS,
  SYNTHESIS_PLUGIN,
  registerSynthesisStage,
} from "./synthesis.ts";
import { synthesisRoutes } from "./synthesis-routes.ts";
import { upsertPlugin } from "../../db.ts";
import { installWorkflowEngine } from "./workflow-engine.ts";

/** A whole-number setting check, shared by the six that want one. */
const whole = (min: number, max: number, unit: string) => (value: string) => {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= min && n <= max ? null : `A whole number of ${unit}, ${min} to ${max}.`;
};

export const manifest: IntegrationManifest = {
  id: "pipeline",

  routes: [
    { path: "/api/pipeline", app: pipelineRoutes },
    { path: "/api/synthesis", app: synthesisRoutes },
  ],

  config: {
    [PIPELINE_PLUGIN]: {
      keys: {
        enabled: {
          label: "Run a nightly pipeline",
          hint:
            `"on" to walk the stage schedule once a day. Anything else, including empty, and the ` +
            `timer wakes every ten minutes and does nothing. A night dispatches REAL sub-agent runs ` +
            `and sends real model calls billed to your account. It also takes the rounds over: with ` +
            `this on, the rounds run as a stage of the night rather than on their own hour, so the ` +
            `work happens once.`,
          ph: "on",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "on" || v === "off" ? null : `"on" to switch the pipeline on, empty or "off" to leave it off.`;
          },
        },
        hour: {
          label: "Hour the night starts",
          hint:
            `The hour, 0–23, in the time zone below. Default ${DEFAULT_HOUR}. The timer checks every ` +
            `ten minutes rather than sleeping until the hour, so a laptop that was shut at two runs ` +
            `the night when it wakes instead of skipping the day.`,
          ph: String(DEFAULT_HOUR),
          check: whole(0, 23, "hours"),
        },
        timezone: {
          label: "Time zone",
          hint:
            `An IANA zone — Europe/Dublin, America/New_York. Empty means this machine's own, which ` +
            `is right until the machine travels. It also decides what "today" means for the ` +
            `once-a-day check, for the cadences, and for "skip tonight".`,
          ph: Intl.DateTimeFormat().resolvedOptions().timeZone,
          check(value) {
            const v = value.trim();
            if (!v) return null;
            return validZone(v) ? null : `"${v}" is not a time zone this machine knows. Use an IANA name like Europe/Dublin.`;
          },
        },
        blackouts: {
          label: "Blackout windows",
          hint:
            `Windows in which nothing (or named stages) may START. One per line: ` +
            `"22:00-23:30" for everything, "09:00-17:00 stages=synthesis days=1,2,3,4,5" for one ` +
            `stage on weekdays. Days are 0 (Sunday) to 6. A window MAY wrap past midnight. A stage ` +
            `already running is never stopped by a blackout — this decides what starts.`,
          ph: "22:00-23:30",
          check(value) {
            const { errors } = parseBlackouts(value);
            return errors.length ? errors[0]! : null;
          },
        },
        "max-minutes": {
          label: "Most minutes one night may take",
          hint:
            `The maximum elapsed time for a night. At the limit, its active block is asked to stop ` +
            `and no more blocks start. Default ${DEFAULT_MAX_MINUTES}. 0 means no overall clock ` +
            `cap; individual block time limits still apply.`,
          ph: String(DEFAULT_MAX_MINUTES),
          check: whole(0, 1440, "minutes"),
        },
        "max-usd": {
          label: "Most dollars one night may spend",
          hint:
            `Checked BEFORE each stage starts, never during one. Empty or 0 means no cap. It can ` +
            `only be enforced if a price per million tokens is set in the runtime budgets — with no ` +
            `price this box cannot count dollars at all, and the night's cost is reported as unknown ` +
            `rather than as zero.`,
          ph: "2.50",
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isFinite(n) && n >= 0 && n <= 10_000 ? null : "A dollar amount, 0 (no cap) to 10000.";
          },
        },
      },
      /* The plugin row is what makes the settings visible under Integrations;
         there is no credential to connect, so "connected" means "switched on".
         Arming the timer here means switching the pipeline on at nine takes
         effect tonight rather than after the next restart. `startPipeline` is
         idempotent, so the two callers cannot make two timers. */
      after(values) {
        upsertPlugin(PIPELINE_PLUGIN, (values.enabled ?? "").trim().toLowerCase() === "on", null);
        startPipeline();
      },
    },

    [SYNTHESIS_PLUGIN]: {
      keys: {
        "ventures-per-night": {
          label: "Ventures given a pass each night",
          hint:
            `How many businesses the synthesis stage looks at, in least-recently-covered order. ` +
            `Default ${DEFAULT_PER_NIGHT_VENTURES}, which covers nineteen ventures in about a week. ` +
            `Each one is a model call over its whole evidence packet, so this is the main dial on ` +
            `what the pass costs.`,
          ph: String(DEFAULT_PER_NIGHT_VENTURES),
          check: whole(1, 50, "ventures"),
        },
        "per-venture": {
          label: "Most proposals from one venture's pass",
          hint:
            `The cap the gate applies per venture, before the night's own cap. Default ` +
            `${DEFAULT_PER_VENTURE}. Three concrete actions is a morning's work; ten is a list ` +
            `nobody opens.`,
          ph: String(DEFAULT_PER_VENTURE),
          check: whole(1, 5, "proposals"),
        },
        "per-night": {
          label: "Most proposals in one night, across every venture",
          hint:
            `Default ${DEFAULT_PER_NIGHT}. Ventures later in the rotation have their proposals ` +
            `dropped with that reason on the record once this is spent, and are first in line next ` +
            `time.`,
          ph: String(DEFAULT_PER_NIGHT),
          check: whole(1, 30, "proposals"),
        },
        "repeat-days": {
          label: "Days before the same action may be proposed again",
          hint:
            `An action similar to one proposed inside this window is refused, whether it was filed ` +
            `or dropped then. Default ${DEFAULT_REPEAT_DAYS}. 0 switches the check off, which means ` +
            `the same idea can come back every night.`,
          ph: String(DEFAULT_REPEAT_DAYS),
          check: whole(0, 365, "days"),
        },
      },
      after(values) {
        void values;
        upsertPlugin(SYNTHESIS_PLUGIN, true, null);
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  onStart() {
    /* THE ROWS BEFORE THE SETTINGS. `plugin_config` has a foreign key onto
       `plugins`, so neither pseudo-plugin's settings can be stored until its
       row exists — and the row is what puts it on the Integrations page, where
       the owner finds the switch. `synthesis` is created connected because it
       always is: it has no switch of its own, only dials. */
    try {
      upsertPlugin(PIPELINE_PLUGIN, settings().enabled, null);
      upsertPlugin(SYNTHESIS_PLUGIN, true, null);
    } catch {
      /* A first boot where the plugins table is mid-migration. The row is
         created again on the next save, and nothing here may throw. */
    }

    registerBuiltins();
    registerCalledStages();
    registerSynthesisStage();
    installWorkflowEngine();
    startPipeline();
  },
};
