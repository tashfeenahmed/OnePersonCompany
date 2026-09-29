/**
 * THE WORKFLOWS PAGE IN PLAIN WORDS.
 *
 * Everything on the Workflows page that turns a server field into a sentence
 * lives here, as pure functions, so the three tabs say the same thing about
 * the same run and the wording can be tested without a browser. Nothing in
 * this file imports the app: it is read by `node --test` as well as by Vite.
 *
 * THE VOCABULARY. The server speaks of stages, blocks, dry runs and
 * over-budget outcomes. The owner reads steps, previews and "ran out of time".
 * The server words stay in the collapsible technical details, never in a
 * heading.
 */

export type StepOutcome = "completed" | "skipped" | "failed" | "over-budget";
export type Tone = "ok" | "fail" | "warn" | "skip" | "running" | "none";

/* ------------------------------------------------------------------ words */

export const OUTCOME_WORD: Record<StepOutcome, string> = {
  completed: "Done",
  /* Not a problem: a weekly step on a Tuesday, or one with nothing due. */
  skipped: "Not needed",
  failed: "Failed",
  "over-budget": "Out of time",
};

export function outcomeTone(o: string | null | undefined): Tone {
  if (o === "completed") return "ok";
  if (o === "failed") return "fail";
  if (o === "over-budget") return "warn";
  if (o === "skipped") return "skip";
  return "none";
}

/** The Tailwind fill for one square of a history strip or step grid. */
export const TONE_FILL: Record<Tone, string> = {
  ok: "bg-ok",
  fail: "bg-destructive",
  warn: "bg-warn",
  skip: "bg-muted-foreground/25",
  running: "bg-blue-400 animate-pulse",
  none: "bg-muted",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  fail: "text-destructive",
  warn: "text-warn",
  skip: "text-muted-foreground",
  running: "text-blue-400",
  none: "text-muted-foreground",
};

/* ----------------------------------------------------------------- phases */

/**
 * FOUR PHASES, because fifteen steps in a row is a list nobody reads and four
 * named groups is a story: gather the numbers, let the specialists look,
 * decide what to do, tell the owner.
 */
export type Phase = "gather" | "analyse" | "decide" | "report" | "other";
export const PHASES: { key: Phase; label: string; about: string }[] = [
  { key: "gather", label: "Gather", about: "Refresh your data, check alerts and read new mail." },
  { key: "analyse", label: "Analyse", about: "Specialist sub-agents each review a few of your ventures." },
  { key: "decide", label: "Decide", about: "Turn their findings into proposals and board cards." },
  { key: "report", label: "Report", about: "Relationships, memory and your morning brief." },
  { key: "other", label: "Other steps", about: "Work that does not belong to one of the phases above." },
];

const PHASE_OF_KIND: Record<string, Phase> = {
  collect: "gather",
  alerts: "gather",
  triage: "gather",
  agent: "analyse",
  synthesis: "decide",
  board: "decide",
  "seo-ops": "decide",
  relationships: "report",
  memory: "report",
  briefing: "report",
};

export function phaseOf(kind: string | null | undefined, area?: string | null): Phase {
  if (kind && PHASE_OF_KIND[kind]) return PHASE_OF_KIND[kind]!;
  if (area === "subagents") return "analyse";
  return "other";
}

/** One sentence per kind of step, for the owner rather than for the editor. */
export const KIND_PLAIN: Record<string, string> = {
  collect: "Pulls fresh numbers from every connected service (analytics, payments, search, stores).",
  alerts: "Checks your alert rules against the fresh numbers.",
  triage: "Reads your inboxes and flags mail that needs a reply.",
  agent: "A specialist sub-agent reviews a few ventures and writes a report on each.",
  synthesis: "Reads the evidence and the specialists' reports and proposes the next actions.",
  board: "Files the proposals and open issues as cards on your board.",
  "seo-ops": "Checks due search follow-ups and runs the visual checks you opted into.",
  relationships: "Reviews the week's correspondence and who you have gone quiet with.",
  memory: "Tidies the assistant's memory: merges duplicates and retires stale notes.",
  briefing: "Writes your morning brief: figures, findings and what is waiting on you.",
};

/* ------------------------------------------------------------------- time */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

function toMs(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = typeof v === "number" ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function dayIndex(d: Date): number {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}

/**
 * A MOMENT AS A PERSON SAYS IT: "today 14:02", "yesterday 02:00",
 * "tomorrow 02:00", "Mon 02:00", "12 Sep 02:00". Local time, 24-hour clock.
 * A missing moment is "never"; one that will not parse is a dash.
 */
export function humanWhen(v: string | number | Date | null | undefined, now: Date = new Date()): string {
  if (v === null || v === undefined || v === "") return "never";
  const ms = toMs(v);
  if (ms === null) return "—";
  const d = new Date(ms);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = dayIndex(d) - dayIndex(now);
  if (diff === 0) return `today ${clock}`;
  if (diff === -1) return `yesterday ${clock}`;
  if (diff === 1) return `tomorrow ${clock}`;
  if (Math.abs(diff) < 7) return `${WEEKDAYS[d.getDay()]} ${clock}`;
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${clock}`;
}

/** A day with no clock: "29 Sep", for a `YYYY-MM-DD` the server counted. */
export function humanDay(v: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const diff = dayIndex(d) - dayIndex(now);
  if (diff === 0) return "today";
  if (diff === -1) return "yesterday";
  if (diff === 1) return "tomorrow";
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** "in 3 hours", "in 25 minutes", "2 days ago", "just now". */
export function relative(v: string | number | Date | null | undefined, now: Date = new Date()): string {
  const ms = toMs(v);
  if (ms === null) return v === null || v === undefined || v === "" ? "never" : "—";
  const delta = ms - now.getTime();
  const mins = Math.round(Math.abs(delta) / 60_000);
  if (mins < 1) return "just now";
  let span: string;
  if (mins < 60) span = `${mins} minute${mins === 1 ? "" : "s"}`;
  else if (mins < 60 * 36) {
    const h = Math.round(mins / 60);
    span = `${h} hour${h === 1 ? "" : "s"}`;
  } else {
    const days = Math.round(mins / 1440);
    span = `${days} day${days === 1 ? "" : "s"}`;
  }
  return delta > 0 ? `in ${span}` : `${span} ago`;
}

/** Whole days between a moment and now, rounded down; null when unknown. */
export function daysSince(v: string | null | undefined, now: Date = new Date()): number | null {
  const ms = toMs(v);
  return ms === null ? null : Math.floor((now.getTime() - ms) / 86_400_000);
}

/** "1h 58m", "14m", "25s", "under a second". Null is "—". */
export function took(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "under a second";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const BARE_DAY = /\b\d{4}-\d{2}-\d{2}\b/g;

/** Server sentences carry raw timestamps ("last completed 2026-09-23T01:25Z");
 *  this rewrites every one into the page's own words. */
export function humaniseText(text: string, now: Date = new Date()): string {
  return text.replace(ISO, (m) => humanWhen(m, now)).replace(BARE_DAY, (m) => humanDay(m, now));
}

/* ------------------------------------------------------------------- runs */

export type RunLike = {
  finishedAt: string | null;
  planned: number;
  completed: number;
  skipped: number;
  failed: number;
  overBudget: number;
  note: string | null;
  dry: boolean;
  trigger: string;
};

export function runTone(r: RunLike): Tone {
  if (!r.finishedAt) return "running";
  if (r.failed > 0) return "fail";
  if (r.overBudget > 0) return "warn";
  if (r.planned === 0) return r.note ? "warn" : "none";
  return "ok";
}

/** One line for a run: what happened, in the owner's words. */
export function runHeadline(r: RunLike): string {
  if (!r.finishedAt) return "Running now";
  if (r.planned === 0) return r.note ? "Stopped before any step ran" : "Nothing was due";
  if (r.dry) return `Preview: ${r.planned} step${r.planned === 1 ? "" : "s"} would run`;
  const parts: string[] = [];
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.overBudget) parts.push(`${r.overBudget} ran out of time`);
  if (!parts.length && r.completed === 0 && r.skipped === r.planned) return "Nothing was due";
  if (!parts.length) return r.completed === r.planned - r.skipped ? "Every due step finished" : `${r.completed} of ${r.planned} steps done`;
  return `${r.completed} of ${r.planned} done · ${parts.join(" · ")}`;
}

export function triggerWord(r: { dry: boolean; trigger: string }): string {
  if (r.dry) return "Preview";
  if (r.trigger === "schedule") return "Scheduled";
  if (r.trigger === "stage") return "One step, by hand";
  return "Started by hand";
}

/* -------------------------------------------------------------- attention */

export type AttentionItem = {
  tone: "fail" | "warn" | "info";
  title: string;
  detail: string;
  action?: { label: string; to: string };
};

export type AttentionInput = {
  scheduleOn: boolean;
  running: boolean;
  skipNight: { day: string; reason: string | null } | null;
  catchUpDay: string | null;
  maxMinutes: number | null;
  /** The last real run's steps, with a title each and the kind of step. */
  last: {
    startedAt: string;
    steps: { title: string; kind: string | null; outcome: string; error: string | null }[];
  } | null;
  /** Steps as the schedule sees them: enabled, cadence and last completion. */
  stages: { title: string; enabled: boolean; cadence: string; lastRun: string | null }[];
  /** Sub-agent jobs waiting in the single queue, or null when unknown. */
  queued: number | null;
};

const STALE_AFTER: Record<string, number> = { daily: 3, weekly: 10, monthly: 40 };

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * WHAT NEEDS THE OWNER, most serious first. Each item says what happened,
 * why in one sentence where the page can tell, and where to go about it.
 * An empty list means the workflow is healthy.
 */
export function attention(input: AttentionInput, now: Date = new Date()): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (!input.scheduleOn)
    out.push({
      tone: "warn",
      title: "The nightly workflow is switched off",
      detail: "Nothing runs on its own until the schedule is turned back on. You can still start a run by hand.",
      action: { label: "Open the schedule", to: "/workflows/editor" },
    });

  const last = input.last;
  if (last && !input.running) {
    const failed = last.steps.filter((s) => s.outcome === "failed");
    const starved = failed.filter((s) => s.kind === "agent" && /stopped before all reports finished/i.test(s.error ?? ""));
    if (starved.length && (input.queued ?? 0) > 0)
      out.push({
        tone: "fail",
        title: `${starved.length} specialist${starved.length === 1 ? "" : "s"} never got to start`,
        detail:
          `${list(starved.map((s) => s.title))} waited behind ${input.queued} other sub-agent job${input.queued === 1 ? "" : "s"} ` +
          "already in the queue, hit their time limit and were cancelled. Clear or hold the queued jobs, or give these steps more time.",
        action: { label: "Open the sub-agent queue", to: "/subagents" },
      });
    const otherFailed = failed.filter((s) => !(starved.includes(s) && (input.queued ?? 0) > 0));
    if (otherFailed.length)
      out.push({
        tone: "fail",
        title: `${otherFailed.length} step${otherFailed.length === 1 ? "" : "s"} failed in the last run`,
        detail: `${list(otherFailed.map((s) => s.title))}. Open the run to read what each one said.`,
        action: { label: "See the last run", to: "/workflows/runs" },
      });
    const outOfTime = last.steps.filter((s) => s.outcome === "over-budget");
    if (outOfTime.length)
      out.push({
        tone: "warn",
        title: `${outOfTime.length} step${outOfTime.length === 1 ? "" : "s"} never ran — the night ran out of time`,
        detail:
          `${list(outOfTime.map((s) => s.title))} were left out because the steps before them used up ` +
          `${input.maxMinutes ? `the night's ${input.maxMinutes}-minute limit` : "the night's time limit"}.`,
        action: { label: "Change the time limits", to: "/workflows/editor" },
      });
  }

  /* A step already named above for failing or running out of time is not
     named again: the list is what ELSE has quietly stopped finishing. */
  const named = new Set((input.running ? [] : (last?.steps ?? []))
    .filter((s) => s.outcome === "failed" || s.outcome === "over-budget")
    .map((s) => s.title));
  const stale = input.stages
    .filter((s) => s.enabled && !named.has(s.title) && STALE_AFTER[s.cadence] !== undefined)
    .map((s) => ({ s, days: daysSince(s.lastRun, now) }))
    .filter(({ s, days }) => days === null ? false : days >= STALE_AFTER[s.cadence]!)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  if (stale.length)
    out.push({
      tone: "warn",
      title: `${stale.length} step${stale.length === 1 ? " hasn't" : "s haven't"} finished in a while`,
      detail: stale.map(({ s, days }) => `${s.title} (${days} days)`).join(", ") + ".",
    });

  if (input.skipNight)
    out.push({
      tone: "info",
      title: `The scheduled run for ${humanDay(input.skipNight.day, now)} will be skipped`,
      detail: input.skipNight.reason ?? "You asked to skip it. Starting a run by hand still works.",
    });
  if (input.catchUpDay)
    out.push({
      tone: "info",
      title: `The missed run of ${humanDay(input.catchUpDay, now)} will catch up`,
      detail: "It starts at the next scheduler check.",
    });
  return out;
}
