import { duration as span } from "@/lib/format";
import type { RunStatus, RunSummary } from "@/lib/api/runs";

/**
 * The words and the tones the six run apps and the Sub-agents page share.
 *
 * A .ts beside the components rather than inside one of them: five files draw
 * a run's status and a run's duration, and the fifth copy is the one that
 * starts saying "0.0s" where the others say "still going".
 *
 * THE DURATION ITSELF IS `@/lib/format`'s. It was written here in
 * milliseconds and, under the same name, in seconds on the integration
 * panels — one signature, a factor of a thousand apart, so importing the wrong
 * one drew a four-second run as "1h 6m" with nothing to catch it.
 */

/**
 * DEPRECATED: call `duration` from `@/lib/format` and pass the word absence
 * means as `nullText`.
 *
 * The shared one answers with a word for a run that has not finished; this
 * shim answers with `null` so the callers that still write `?? "still going"`
 * keep meaning it. Nothing here computes a duration — only the absent case
 * differs.
 */
export function duration(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) || ms < 0 ? null : span(ms);
}

/** How long a run has been going, from its start to now. Used only while it is
 *  running, where the server's `ms` is not written yet. */
export function since(iso: string | null): string | null {
  const ms = iso ? Date.now() - Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? span(ms) : null;
}

/** The status as a sentence fragment a row can end with. */
export function statusWord(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "waiting its turn";
    case "running":
      return "working";
    case "done":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** The dot's colour. Cancelled is grey rather than red on purpose: somebody
 *  pressed stop, which is not a fault. */
export function statusTone(status: RunStatus): string {
  switch (status) {
    case "running":
      return "bg-ok animate-pulse";
    case "queued":
      return "bg-warn";
    case "done":
      return "bg-ok opacity-60";
    case "failed":
      return "bg-destructive";
    case "cancelled":
      return "bg-border";
  }
}

/**
 * WHO ACTUALLY WROTE THE REPORT, in a phrase.
 *
 * `hermes` and `provider:openrouter` are not two flavours of the same thing:
 * one is a live agent that searched the web and ran this box's own skills, the
 * other is a single completion from a model that was told it has no tools and
 * must answer only from the brief. A report from the second is a smaller
 * claim, and every place a run is listed says which it was.
 */
export function backendPhrase(run: Pick<RunSummary, "backend" | "model">): string {
  const model = run.model ? ` · ${run.model}` : "";
  if (!run.backend) return model ? model.slice(3) : "no backend recorded";
  if (run.backend.startsWith("provider:"))
    return `${run.backend.slice("provider:".length)}, no tools${model}`;
  return `${run.backend}${model}`;
}

/** "3rd", for a place in the queue. English only, like the rest of the copy in
 *  this app — there is no i18n here and a bare number reads as a count. */
export function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** 0 low · 1 normal · 2 high · 3 urgent — the board's own scale, worded the
 *  way the board words it. */
export const URGENCY = ["Low", "Normal", "High", "Urgent"];
