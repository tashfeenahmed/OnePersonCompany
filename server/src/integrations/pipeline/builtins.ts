/**
 * WHAT THIS BOX ALREADY DOES ON ITS OWN, WRITTEN DOWN.
 *
 * Fourteen timers were armed across nine `onStart` hooks before this file
 * existed, and none of them appeared anywhere the owner could see. This module
 * puts every one of them on the schedule. Two of them the pipeline now CALLS;
 * the other thirteen keep their own timers and are listed as self-scheduled, with
 * the last time each actually did something read out of its own table.
 *
 * THE LAST-RUN READING IS NOT A LOG OF THE TIMER. There is no table anywhere
 * that records "the timer woke and decided to do nothing", so the honest
 * reading for a self-scheduled stage is the newest row of whatever it WRITES —
 * and `lastRunMeans` on each entry says, in one sentence, exactly which row
 * that is. A pass that ran and found nothing to do therefore reads as older
 * than it is, which is a limitation stated on the page rather than hidden
 * behind a timestamp that looks authoritative.
 *
 * WHY NOT CALL THEM ALL. Because calling a stage whose own timer is still
 * armed does the work TWICE, and doing the mail triage twice at two in the
 * morning costs real API quota to produce the same answer. Standing a timer
 * down means editing that area's file, and those files belong to other areas.
 * So the rule is: the pipeline calls what it owns, lists what it does not, and
 * an area that wants to be scheduled here deletes its timer and calls
 * `registerStage` with a `run`. Nothing in this file has to change for that.
 *
 * A LAST-RUN READER MUST NEVER THROW. It runs inside a route and inside a
 * timer, over a table that may not exist on a box where that area was never
 * migrated. Every one is wrapped; a missing table answers null, which reads as
 * "never".
 */
import { db } from "../../db.ts";
import { registerStage, type Stage } from "./registry.ts";

/** The newest value of one column, or null. Wrapped for the reason in the
 *  header: a table another area has not created yet is not an error here. */
function newest(table: string, column: string): string | null {
  try {
    const row = db.prepare(`SELECT MAX(${column}) AS ts FROM ${table}`).get() as { ts: string | null };
    return row?.ts ?? null;
  } catch {
    return null;
  }
}

/**
 * WHAT EACH SELF-SCHEDULED STAGE'S LAST-RUN READING ACTUALLY MEASURES.
 *
 * Published on the wire beside the timestamp, because the two are different
 * claims and the difference matters: "the last briefing was built at 07:00"
 * is the pass itself; "the newest row in the activity feed is from Tuesday" is
 * the pass's OUTPUT, and a feed with nothing new in it looks stale when it is
 * merely quiet.
 */
export const LAST_RUN_MEANS: Record<string, string> = {};

type SelfStage = Omit<Stage, "run" | "lastRun"> & {
  /** The table and column the last-run reading comes from. */
  reading: { table: string; column: string };
  lastRunMeans: string;
};

/* ---------------------------------------------- the thirteen self-scheduled */

const SELF: SelfStage[] = [
  {
    id: "collect",
    area: "plugins",
    title: "Collect every connected plugin",
    about:
      "The half-hourly sweep in index.ts: every connected plugin's collector, " +
      "in turn, writing into its own tables. It is the stage everything else " +
      "reads from, which is why it is declared as the dependency of the passes " +
      "that interpret its output.",
    deps: [],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "runs", column: "finished_at" },
    lastRunMeans: "the newest finished collector run in the `runs` ledger, across all plugins.",
  },
  {
    id: "alerts",
    area: "proactive",
    title: "Evaluate alert rules",
    about:
      "Every enabled rule read against its skill's live document, a minute " +
      "behind the collector sweep it is anchored to. Trips and unreadable " +
      "readings become events.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "alert_observations", column: "ts" },
    lastRunMeans: "the newest recorded rule observation. A box with no rules has none, ever.",
  },
  {
    id: "snapshots",
    area: "security",
    title: "Machine snapshots",
    about: "The snapshot trigger over configured hosts.",
    deps: [],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "security_snapshots", column: "ts" },
    lastRunMeans: "the newest stored snapshot document.",
  },
  {
    id: "queue",
    area: "runs",
    title: "The sub-agent run queue",
    about:
      "The single run slot, pumped continuously. It is not a nightly stage at " +
      "all — it is listed because a night that dispatches work into it needs " +
      "its state on the same page, and because a queue that has been stopped " +
      "makes every dispatching stage a no-op.",
    deps: [],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "agent_runs", column: "finished_at" },
    lastRunMeans: "the newest finished sub-agent run.",
  },
  {
    id: "triage",
    area: "mailflow",
    title: "Mail triage",
    about: "Threads scored per mailbox on the mailflow area's own half-hour timer.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "mailflow_triage_runs", column: "ran_at" },
    lastRunMeans: "the newest triage pass over any mailbox.",
  },
  {
    id: "activity-feed",
    area: "activity",
    title: "The activity feed",
    about: "Business events derived from the collectors' own tables.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "activity_events", column: "found_at" },
    lastRunMeans: "when the feed last FOUND an event. A quiet week reads as a stale pass.",
  },
  {
    id: "indexing",
    area: "growth",
    title: "IndexNow submissions",
    about: "New and changed URLs submitted to the IndexNow endpoints.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "growth_indexing", column: "submitted_at" },
    lastRunMeans: "the newest URL submission, including refused and dry-run ones.",
  },
  {
    id: "capture",
    area: "ventures",
    title: "Venture screenshots",
    about: "The weekly refresh of each venture's site screenshot and brand reading.",
    deps: [],
    defaultEnabled: true,
    defaultCadence: "weekly",
    defaultWindow: null,
    budget: {},
    reading: { table: "venture_shots", column: "ts" },
    lastRunMeans: "the newest screenshot taken of any venture.",
  },
  {
    id: "autopilot",
    area: "video",
    title: "Studio autopilot",
    about: "Scheduled drafting and posting passes over the ventures that have it on.",
    deps: [],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "video_autopilot_log", column: "ts" },
    lastRunMeans: "the newest autopilot decision, including the ones that queued nothing.",
  },
  {
    id: "people-brief",
    area: "people",
    title: "The weekly relationship brief",
    about: "One brief a week over correspondence that has cooled or warmed.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "weekly",
    defaultWindow: null,
    budget: {},
    reading: { table: "people_briefs", column: "written_at" },
    lastRunMeans: "the newest weekly brief written.",
  },
  {
    id: "consolidate",
    area: "chief",
    title: "Memory consolidation",
    about:
      "The weekly pass that merges duplicate notes and fades stale ones. Its " +
      "own timer wakes hourly and declines unless a week has passed and there " +
      "are at least three notes.",
    deps: [],
    defaultEnabled: true,
    defaultCadence: "weekly",
    defaultWindow: null,
    budget: {},
    reading: { table: "chief_memory_passes", column: "ran_at" },
    lastRunMeans: "the newest consolidation pass, whether or not it merged anything.",
  },
  {
    id: "outcome-readings",
    area: "chief",
    title: "Outcome readings",
    about:
      "The 7/14/30-day readings of a figure an outcome is watching. The timer " +
      "wakes hourly and declines unless a reading is due.",
    deps: ["collect"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "chief_outcome_readings", column: "ts" },
    lastRunMeans: "the newest reading taken for any outcome. Null on a box with no outcomes.",
  },
  {
    id: "briefing",
    area: "proactive",
    title: "The morning briefing",
    about:
      "The day's summary, assembled from alerts, movement, runs, the board and " +
      "the ventures, written up and pushed. It is LAST in the dependency graph " +
      "because it harvests what everything above it wrote — a briefing built " +
      "before the night's passes would report yesterday.",
    deps: ["collect", "alerts", "rounds", "synthesis"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: {},
    reading: { table: "briefings", column: "built_at" },
    lastRunMeans: "when the newest briefing was built.",
  },
];

/* --------------------------------------------------------------- registration */

/**
 * Register the catalogue. Called once from the manifest's `onStart`, and safe
 * to call again — `registerStage` is keyed by id, because `node --watch`
 * re-imports this module on every save in the tree.
 *
 * `rounds` AND `synthesis` ARE NOT HERE. They are registered by the modules
 * that own their executors — chief/rounds.ts is wrapped in `stages-called.ts`
 * and the synthesis pass registers itself — so that the function the registry
 * calls and the function that does the work are declared in the same place.
 */
export function registerBuiltins(): void {
  for (const s of SELF) {
    LAST_RUN_MEANS[s.id] = s.lastRunMeans;
    registerStage({
      id: s.id,
      area: s.area,
      title: s.title,
      about: s.about,
      deps: s.deps,
      defaultEnabled: s.defaultEnabled,
      defaultCadence: s.defaultCadence,
      defaultWindow: s.defaultWindow,
      budget: s.budget,
      lastRun: () => newest(s.reading.table, s.reading.column),
    });
  }
}
