/**
 * THE SEAM BETWEEN THE EXECUTOR AND THIS AREA'S TWO RUN KINDS.
 *
 * `runs/executor.ts` owns the queue, the slot, the cancellation and the
 * flushing of a growing report; this area owns what a SERP teardown and a store
 * listing audit actually DO. The executor's branch for these two kinds is
 * therefore nine lines and an import, and it hands over the four things a run
 * needs to be visible while it works — a way to write into the report, a way to
 * open and close a step, and a way to take one turn on whatever is answering.
 *
 * IT IS AN INTERFACE RATHER THAN AN IMPORT IN THE OTHER DIRECTION, and that is
 * not politeness. `executor.ts` imports this file; if this file imported the
 * executor for `turn()` and `Session` the two would be a cycle, and a cycle
 * through a module that reads `integrations/index.ts` at import time does not
 * start the process at all — measured on this box, not theorised. So the
 * capabilities arrive as functions and this area never learns what a Session
 * is.
 */
import type { VentureRow } from "../../db.ts";
import type { ChatTurn } from "../../chat/backend.ts";
import type { Step } from "../runs/store.ts";
import { serpRun } from "./serp.ts";
import { asoRun } from "./aso.ts";

/** What the executor lends a run of this area's kinds. */
export type RunTools = {
  /** Something this server did rather than something a model said. Flushed at
   *  once, so the page shows the run is alive while pages are being fetched. */
  say(text: string): void;
  startStep(tool: string, label: string | null): Step;
  endStep(step: Step, label?: string | null): void;
  /** One turn on whoever is answering — an agent when one is live, the raw
   *  provider when not. `toOutput` streams it into the report. */
  turn(turns: ChatTurn[], opts: { toOutput: boolean; forceProvider?: boolean }): Promise<{ text: string }>;
  /** Whether anything answering has tools. Both kinds here fetch what they
   *  need themselves, so this only changes what the brief promises. */
  hasTools: boolean;
};

/** The executor's one branch for this area. A kind that is not ours is a
 *  programming error rather than a run failure, so it throws with the kind in
 *  the message. */
export async function growthRun(
  kind: string,
  runId: string,
  venture: VentureRow,
  input: Record<string, string>,
  tools: RunTools,
): Promise<void> {
  if (kind === "serp") return serpRun(runId, venture, input, tools);
  if (kind === "aso") return asoRun(runId, venture, input, tools);
  throw new Error(`“${kind}” is not a growth run kind.`);
}
