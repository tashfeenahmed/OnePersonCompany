/**
 * THE STAGES THE PIPELINE ACTUALLY CALLS.
 *
 * There are two, and the number is small on purpose: a stage moves in here
 * only when its own timer has been made to stand down, because the one failure
 * this whole area exists to avoid is doing a night's work twice. See
 * builtins.ts for the twelve that keep their timers and are listed rather than
 * called.
 *
 * ROUNDS. `runRound` in chief/rounds.ts is imported and called directly — not
 * over a loopback POST, and not re-implemented. That function is where a
 * round's rules live (quiet stages, the cadence, the cap, a worker that is
 * already busy), and a second author for those rules is a second set of them.
 * Its own timer defers to this one whenever the pipeline is switched on and
 * the rounds stage is enabled; `pipelineOwnsRounds()` below is the single
 * predicate both sides read, so the two cannot disagree about who is driving.
 *
 * A DRY ROUND DOES NOT SIMULATE THE WALK. rounds-routes.ts already argues why
 * there is no dry round — "a dry run of which ventures are due would be a
 * second implementation of the walk, and the only thing worth testing is the
 * real one" — and that argument is not weakened by being inconvenient here. So
 * a planned night reports this stage's SETTINGS: what it would dispatch, to
 * how many roles, under what cap. That is the honest half of the answer, and
 * it is a smaller lie than a plan derived from a copy of the rules.
 */
import { configValue } from "../../db.ts";
import { ROUNDS_PLUGIN, runRound, settings as roundSettings } from "../chief/rounds.ts";
import { PIPELINE_PLUGIN, prefs, registerStage, settled, stage, type StageResult } from "./registry.ts";

/**
 * Does the pipeline drive the rounds tonight?
 *
 * Read by BOTH the rounds timer (which returns immediately when this is true)
 * and the nightly walk (which skips the stage when it is false, naming the
 * reason). Three conditions, all of which the owner can see on a page:
 *
 *   — the pipeline is switched on at all,
 *   — the `rounds` stage exists and is enabled,
 *   — and rounds themselves are switched on, because the rounds settings are
 *     still the authority on whether a round may happen. The pipeline decides
 *     WHEN work runs; it does not overrule a feature the owner turned off.
 *
 * It reads config rather than holding a flag, so a settings change takes effect
 * on the next tick of either timer without a restart.
 */
export function pipelineOwnsRounds(): boolean {
  if ((configValue(PIPELINE_PLUGIN, "enabled") ?? "").trim().toLowerCase() !== "on") return false;
  const s = stage("rounds");
  if (!s) return false;
  if (!settled(s, prefs().get("rounds")).enabled) return false;
  return (configValue(ROUNDS_PLUGIN, "enabled") ?? "").trim().toLowerCase() === "on";
}

export function registerCalledStages(): void {
  registerStage({
    id: "rounds",
    area: "chief",
    title: "Dispatch the rounds",
    about:
      "Walk the estate and give the configured sub-agent roles a job on the " +
      "ventures that are due. It DISPATCHES rather than does: each job is a " +
      "run queued into the single slot, taking minutes and real tokens, and " +
      "the reports arrive under the rounds conversation as they finish.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    /* No dollar cap by default. The round's own cap is a number of RUNS, which
       is the unit the owner already reasons about here; a second cap in
       dollars would be two knobs for one decision. */
    budget: { maxMinutes: 5 },
    async run(ctx): Promise<StageResult> {
      const s = roundSettings();
      if (!s.enabled)
        return {
          outcome: "skipped",
          reason:
            "rounds are switched off in their own settings. The pipeline decides when " +
            "work runs; it does not switch a feature back on.",
        };
      if (ctx.dry)
        return {
          outcome: "completed",
          note:
            `Would walk ${s.quietStages.length ? `every venture except those at stage ${s.quietStages.join(", ")}` : "every venture"}, ` +
            `dispatching ${s.roles.join(", ")} to any that has not been worked for ${s.daysBetween} day${s.daysBetween === 1 ? "" : "s"}, ` +
            `up to ${s.maxRuns} run${s.maxRuns === 1 ? "" : "s"}. Which ventures those are is decided by the walk itself and is not ` +
            `planned here — see stages-called.ts for why there is no second copy of that rule.`,
          counts: { maxRuns: s.maxRuns, roles: s.roles.length },
        };
      const out = await runRound("schedule");
      if (!out.ran) return { outcome: "skipped", reason: out.why ?? "the round declined to walk" };
      const r = out.round!;
      return {
        outcome: "completed",
        note:
          `${r.dispatched} run${r.dispatched === 1 ? "" : "s"} dispatched across ${r.ventures} venture${r.ventures === 1 ? "" : "s"}, ` +
          `${r.skipped} skipped. The runs are queued, not done.`,
        counts: { dispatched: r.dispatched, skipped: r.skipped, ventures: r.ventures },
      };
    },
  });
}
