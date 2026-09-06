/**
 * WHAT THE MANAGED RUNTIME'S OWN SCHEDULER HAS DONE — read, never written.
 *
 * THE GAP, in the analysis's words: "OPC starts a managed gateway and has its
 * own timers, but no equivalent OPC adapter was found for reading arbitrary
 * native cron results and relaying them." Both runtimes this app manages have
 * a scheduler of their own, both are running it (the gateway process is the
 * ticker), and until now nothing on this side could say what they had done.
 *
 * THIS FILE CREATES NO JOBS AND TICKS NOTHING. The system this replaces had to
 * tick, because that deployment ran no gateway and the cron loop lived inside
 * one; this one runs the gateway, so the jobs already fire. Adding a second
 * scheduler here would be two clocks disagreeing about whether a job is due —
 * the gap analysis says so in its own recommendation ("preserve successful
 * native behaviour rather than adding a second scheduler blindly") and it is
 * right. Scheduling is the runtime's. This is a reader.
 *
 * WHERE EACH RUNTIME KEEPS IT — measured on this box, 6 September 2026, not
 * inferred from documentation:
 *
 *   HERMES    $HOME/.hermes/cron/
 *               jobs.json       {"jobs":[…]} — id, name, schedule_display,
 *                               enabled, state, next_run_at, last_run_at,
 *                               last_status, last_error. A bare list and an
 *                               id-keyed map are also legal (cron/jobs.py
 *                               auto-repairs both), so all three are read.
 *               executions.db   (id, job_id, source, status, claimed_at,
 *                               started_at, finished_at, error). NO OUTPUT
 *                               COLUMN — which is why the results come from
 *                               the files below and not from here.
 *               output/<job>/<YYYY-MM-DD_HH-MM-SS>.md
 *                               One markdown envelope per run, written
 *                               tmp-then-rename for successes AND failures.
 *                               This is the only place a run's text exists.
 *
 *   OPENCLAW  $HOME/.openclaw/state/openclaw.sqlite
 *               cron_jobs          (job_id, name, enabled, payload_kind,
 *                                   job_json, state_json). The schedule and
 *                                   the last run/status/error are JSON inside
 *                                   those two columns.
 *               cron_run_receipts  (receipt_id, job_id, status, started_at_ms,
 *                                   finished_at_ms, error_text). Statuses are
 *                                   running | ok | error | skipped |
 *                                   interrupted | superseded. NO OUTPUT
 *                                   COLUMN either, and OpenClaw writes no
 *                                   per-run output file: its results are
 *                                   delivered into its own session. So a
 *                                   receipt is relayed as WHAT HAPPENED, and
 *                                   the row says plainly that the text is not
 *                                   readable from here rather than inventing
 *                                   one.
 *
 * BOTH DATABASES ARE OPENED READ-ONLY, and that is not politeness. They are
 * live files belonging to a running process; a second writer near a SQLite
 * file whose whole design assumes one is how a store gets corrupted. A file
 * that is missing, locked or unreadable produces a stated reason and an empty
 * list — never an exception on a timer, and never a silent zero.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
/*
  A TYPE-ONLY IMPORT, AND THE PATHS ARE REBUILT RATHER THAN ASKED FOR.

  `agents/instance.ts` is the authority on where a managed runtime lives —
  `spec(id).home` — and importing that function here would be the natural
  thing. It cannot be done: this file is reached from the area's manifest, and
  instance.ts imports `skills/hermes.ts`, which imports `skills/registry.ts`,
  which builds `ENTRIES` from `manifestSkills()` at module scope. A manifest
  that pulls that chain in while `MANIFESTS` is still being defined fails with
  "Cannot access 'MANIFESTS' before initialization" and the server does not
  boot. `import type` is erased by `--experimental-strip-types`, so the AgentId
  above costs nothing at runtime; the two paths below are the price of the
  cycle, and they are checked against instance.ts's `SPECS` — hermes' root is
  `<DATA_DIR>/hermes` with `home` under it and `HERMES_HOME` at `home/.hermes`;
  OpenClaw's `OPENCLAW_HOME` is `<DATA_DIR>/openclaw/home` and its config and
  state land at `$OPENCLAW_HOME/.openclaw/`.
*/
import type { AgentId } from "../../agents/instance.ts";
import { DATA_DIR } from "../../config.ts";

const AGENT_IDS: AgentId[] = ["hermes", "openclaw"];

/** One scheduled job, as both runtimes can describe one. Everything past `id`
 *  is nullable because the two stores disagree about what they record, and a
 *  field this reader cannot fill is `null` with the reason on the runtime
 *  rather than a plausible-looking blank. */
export type NativeJob = {
  runtime: AgentId;
  id: string;
  name: string | null;
  /** The schedule in the runtime's own words ("every 30m", "0 3 * * *"). */
  schedule: string | null;
  enabled: boolean | null;
  /** The runtime's own word for its state ("scheduled", "paused"). */
  state: string | null;
  /** ISO 8601 where the store holds a real instant; the runtime's own local
   *  stamp, verbatim and labelled, where that is all it keeps. */
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  /** How this box can read the run's text, or null when it cannot. */
  outputRef: string | null;
};

/** One run's result as this box can read it. `body` is null when the runtime
 *  stores no text for the run — which is a fact about the runtime, not an
 *  empty result. */
export type NativeResult = {
  runtime: AgentId;
  jobId: string;
  jobName: string | null;
  /** The run's own identity in the runtime's store: Hermes' output filename,
   *  OpenClaw's receipt id. It is the dedupe key and it must be stable. */
  ref: string;
  at: string | null;
  status: string | null;
  failed: boolean;
  body: string | null;
  /** Set when the runtime's own conventions say this run deliberately produced
   *  nothing worth a person's attention. */
  silent: boolean;
};

export type JobsReading = {
  runtime: AgentId;
  label: string;
  /** Whether this box could read the store at all. */
  readable: boolean;
  /** Exactly what was looked for and what happened, in one sentence. Shown on
   *  the panel when `readable` is false, so "not readable for this runtime"
   *  always comes with the path it tried. */
  note: string;
  /** Where the store is, published because an owner debugging an empty panel
   *  needs the path and it is not a secret — it is a directory this app
   *  created. */
  store: string;
  jobs: NativeJob[];
};

/* -------------------------------------------------------------------- paths */

function hermesCronDir(): string {
  return join(DATA_DIR, "hermes", "home", ".hermes", "cron");
}

function openclawDb(): string {
  return join(DATA_DIR, "openclaw", "home", ".openclaw", "state", "openclaw.sqlite");
}

/** Read-only, and short-lived: opened per read and closed in a `finally`, so a
 *  reader on a timer never holds a handle on somebody else's live database. */
function withReadOnly<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;

/* ------------------------------------------------------------------- hermes */

type HermesJobRecord = Record<string, unknown>;

/** `{"jobs":[…]}` is canonical; a bare list and an id-keyed map are both legal
 *  and both auto-repaired by cron/jobs.py, so all three are accepted here for
 *  the same reason it accepts them: a store this reader calls corrupt is a
 *  panel that says "no jobs" about a box that has some. */
function hermesJobRecords(text: string): HermesJobRecord[] {
  const doc: unknown = JSON.parse(text);
  if (Array.isArray(doc)) return doc.filter((j): j is HermesJobRecord => !!j && typeof j === "object");
  if (doc && typeof doc === "object") {
    const jobs = (doc as { jobs?: unknown }).jobs;
    if (Array.isArray(jobs)) return jobs.filter((j): j is HermesJobRecord => !!j && typeof j === "object");
    if (jobs && typeof jobs === "object")
      return Object.entries(jobs as Record<string, unknown>)
        .filter(([, v]) => !!v && typeof v === "object")
        .map(([k, v]) => ({ ...(v as HermesJobRecord), id: (v as HermesJobRecord).id ?? k }));
  }
  return [];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function hermesJobs(): JobsReading {
  const dir = hermesCronDir();
  const file = join(dir, "jobs.json");
  const base: JobsReading = {
    runtime: "hermes",
    label: "Hermes",
    readable: false,
    note: "",
    store: dir,
    jobs: [],
  };

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const why = (err as NodeJS.ErrnoException).code;
    return {
      ...base,
      /* NOT AN ERROR. Hermes writes jobs.json the first time a job is created;
         its absence is "no job has ever been scheduled here", which is a
         different sentence from "the store could not be read" and must not be
         drawn as a fault. */
      readable: why === "ENOENT",
      note:
        why === "ENOENT"
          ? `No job has been scheduled in Hermes yet — its scheduler writes ${file} when the first one is created.`
          : `${file} could not be read (${why ?? "unknown error"}).`,
    };
  }

  let records: HermesJobRecord[];
  try {
    records = hermesJobRecords(text);
  } catch {
    return { ...base, note: `${file} is not readable JSON — Hermes repairs its own store, so this is usually a half-written file; it will read on the next pass.` };
  }

  const jobs = records.map((j): NativeJob => {
    const id = str(j.id) ?? "unknown";
    const outputDir = join(dir, "output", id);
    let hasOutput = false;
    try {
      hasOutput = readdirSync(outputDir).some((f) => f.endsWith(".md"));
    } catch {
      /* No directory yet — the job has never produced a run. */
    }
    return {
      runtime: "hermes",
      id,
      name: str(j.name),
      schedule: str(j.schedule_display) ?? str((j.schedule as { display?: string } | undefined)?.display),
      enabled: typeof j.enabled === "boolean" ? j.enabled : null,
      state: str(j.state),
      /* Hermes stores these as its own ISO-ish strings; they are copied
         verbatim rather than re-parsed, because a stamp reformatted by this
         reader is a stamp that can disagree with `hermes cron status`. */
      lastRunAt: str(j.last_run_at),
      lastStatus: str(j.last_status),
      lastError: str(j.last_error),
      nextRunAt: str(j.next_run_at),
      outputRef: hasOutput ? outputDir : null,
    };
  });

  return {
    ...base,
    readable: true,
    note: jobs.length
      ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} in Hermes' own scheduler. Creating and editing them is Hermes' — ask it, or run \`hermes cron\`.`
      : "Hermes' scheduler has no jobs.",
    jobs,
  };
}

/* --------------------------------------------- the hermes output envelope */

/**
 * THE SILENCE SENTINEL, MIRRORED FROM THE RUNTIME.
 *
 * cron/scheduler.py defines `SILENT_MARKER = "[SILENT]"` and INSTRUCTS a
 * scheduled agent to answer exactly that when a tick found nothing worth a
 * person's attention. It then skips its own delivery — and still SAVES the
 * output file, sentinel and all. A relay that did not know the word would push
 * the literal string "[SILENT]" to the owner's phone every time a watchdog was
 * working correctly, which is the fastest possible way to get a bot muted.
 *
 * `(No response generated)` is the other placeholder in the same envelope:
 * run_job writes it INTO THE FILE while keeping the real response empty for
 * its delivery decision, so reading the file naively turns "the model said
 * nothing" into a push saying so.
 */
const SILENT_MARKERS = new Set(["[SILENT]", "SILENT", "NO_REPLY", "NO REPLY"]);
const isToken = (line: string) => SILENT_MARKERS.has(line.trim().toUpperCase().split(/\s+/).join(" "));

export function isSilence(text: string | null | undefined): boolean {
  const stripped = String(text ?? "").trim();
  if (!stripped) return true;
  if (stripped === "(No response generated)") return true;
  if (isToken(stripped)) return true;
  const lines = stripped.split("\n").filter((l) => l.trim());
  if (lines.length && (isToken(lines[0]!) || isToken(lines[lines.length - 1]!))) return true;
  return stripped.toUpperCase().startsWith("[SILENT]");
}

/**
 * One Hermes run document, read back.
 *
 * Four shapes, all beginning "# Cron Job: <name>" (cron/scheduler.py):
 *   agent, ok          "## Response"  then the model's final answer
 *   agent, failed      title carries "(FAILED)", "## Error" then a fenced line
 *   script, ok         "**Mode:** no_agent", a "---" rule, then stdout
 *   script/gate, quiet "**Status:** silent (…)" and no body at all
 *
 * A SHAPE THIS DOES NOT RECOGNISE RETURNS A NULL BODY and is treated as
 * silence rather than forwarded raw. A relay that pastes a header block into
 * the owner's chat when the format shifts is worse than one that misses a run:
 * the second is visible in `hermes cron runs`, and the first trains the owner
 * to ignore the bot.
 *
 * `lastIndexOf`, NOT `indexOf`. The envelope puts the PROMPT above the
 * payload, and the scheduler prepends a preamble that talks about delivery in
 * prose — a job whose own prompt quotes "## Response" would otherwise have its
 * instructions read back as the answer. The payload is always last.
 */
export function parseHermesRun(text: string): { name: string; failed: boolean; body: string | null } {
  const head = /^#\s*Cron Job:\s*(.+?)\s*$/m.exec(text);
  const rawName = head ? head[1]! : "";
  const failedTitle = /\(FAILED\)\s*$/.test(rawName);
  const name = rawName.replace(/\s*\(FAILED\)\s*$/, "").trim() || "cron job";

  if (/^\*\*Status:\*\*\s*silent\b/m.test(text)) return { name, failed: false, body: null };

  const scriptFailed = /^\*\*Status:\*\*\s*script failed\s*$/m.test(text);
  const blocked = /^\*\*Status:\*\*\s*BLOCKED\b/m.test(text);
  const failed = failedTitle || scriptFailed || blocked;

  const after = (marker: string) => {
    const i = text.lastIndexOf(marker);
    return i === -1 ? null : text.slice(i + marker.length);
  };

  let body: string | null = null;
  if (/^##\s*Response\s*$/m.test(text)) body = after("## Response");
  else if (/^##\s*Error\s*$/m.test(text)) body = after("## Error");
  else if (scriptFailed) body = after("**Status:** script failed");
  else if (blocked) body = after("**Status:** BLOCKED");
  else if (/^---\s*$/m.test(text)) body = after("\n---\n");

  if (body === null) return { name, failed, body: null };
  /* The error body arrives inside a fence; a fence is noise in a chat. */
  body = body.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  if (!body) return { name, failed, body: null };
  /* A FAILED RUN IS NEVER SILENCE. The sentinel only ever appears in a
     response the agent chose, and a failure envelope carries an exception —
     which is the one thing the owner most needs to be told about. */
  if (!failed && isSilence(body)) return { name, failed, body: null };
  return { name, failed, body };
}

/**
 * Every Hermes run output on disk, oldest first.
 *
 * Sorted by filename rather than by mtime: the filename IS the run time, in a
 * format that sorts lexically, and mtime would reorder a directory that was
 * ever restored from a backup.
 */
export function hermesResults(limit = 200, seen?: (id: string) => boolean): NativeResult[] {
  const dir = join(hermesCronDir(), "output");
  let dirs: string[];
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const names = new Map(hermesJobs().jobs.map((j) => [j.id, j.name]));
  const out: NativeResult[] = [];
  for (const jobId of dirs) {
    let files: string[];
    try {
      /*
        `isFile()` AND NOT JUST THE EXTENSION, and the difference is a real
        one. A name ending `.md` under a job's output directory is read and its
        contents become a `runtime_job_results.body` the relay can push to
        Telegram — so a SYMLINK called `x.md` would be followed anywhere on
        this box and its contents mailed to the owner's phone. The job
        directories were already filtered with `isDirectory()`, which does not
        follow one; the files were not. Nothing legitimate is lost: the
        scheduler writes real files, tmp-then-rename.
      */
      files = readdirSync(join(dir, jobId), { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith("."))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      /* ALREADY ACCOUNTED FOR — do not open it again. Hermes keeps fifty
         output files per job, and a two-minute timer that read and parsed
         every one of them forever would be a directory walk that grows with
         the age of the box for no new information. The caller passes what it
         has already recorded; the dedupe itself is still the INSERT OR IGNORE
         in store.ts, so a skip that is wrong costs nothing. */
      if (seen?.(`hermes:${jobId}/${file}`)) continue;
      const path = join(dir, jobId, file);
      let text: string;
      let at: string | null = null;
      try {
        text = readFileSync(path, "utf8");
        /* THE FILE'S OWN MTIME AS THE INSTANT. Hermes' filename stamp is local
           time with no zone on it, so calling it UTC would be a lie of up to a
           day; the file is written once, atomically, at the end of the run, so
           its mtime IS when the result existed. The runtime's own stamp is
           still in the body, where the owner reads it. */
        at = new Date(statSync(path).mtimeMs).toISOString();
      } catch {
        continue;
      }
      const parsed = parseHermesRun(text);
      out.push({
        runtime: "hermes",
        jobId,
        jobName: names.get(jobId) ?? parsed.name,
        ref: file,
        at,
        status: parsed.failed ? "failed" : parsed.body === null ? "silent" : "completed",
        failed: parsed.failed,
        body: parsed.body,
        silent: parsed.body === null && !parsed.failed,
      });
    }
  }
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.jobId < b.jobId ? -1 : 1));
  return out.slice(-limit);
}

/* ----------------------------------------------------------------- openclaw */

function json(v: unknown): Record<string, unknown> {
  if (typeof v !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** OpenClaw's schedule object, in the words its own store uses. */
function openclawSchedule(job: Record<string, unknown>): string | null {
  const s = job.schedule as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return null;
  if (s.kind === "cron" && typeof s.expr === "string") return s.expr;
  if (s.kind === "every" && typeof s.everyMs === "number") {
    const m = Math.round(s.everyMs / 60_000);
    return m % 1440 === 0 ? `every ${m / 1440}d` : m % 60 === 0 ? `every ${m / 60}h` : `every ${m}m`;
  }
  if (typeof s.kind === "string") return String(s.kind);
  return null;
}

export function openclawJobs(): JobsReading {
  const path = openclawDb();
  const base: JobsReading = {
    runtime: "openclaw",
    label: "OpenClaw",
    readable: false,
    note: "",
    store: path,
    jobs: [],
  };
  try {
    const rows = withReadOnly(path, (db) =>
      db
        .prepare(
          "SELECT job_id, name, enabled, payload_kind, job_json, state_json FROM cron_jobs ORDER BY sort_order ASC, updated_at ASC",
        )
        .all() as {
        job_id: string;
        name: string;
        enabled: number;
        payload_kind: string;
        job_json: string;
        state_json: string;
      }[],
    );
    const jobs = rows.map((r): NativeJob => {
      const j = json(r.job_json);
      const st = json(r.state_json);
      return {
        runtime: "openclaw",
        id: r.job_id,
        name: (typeof j.displayName === "string" && j.displayName) || r.name,
        schedule: openclawSchedule(j),
        enabled: r.enabled === 1,
        state: typeof j.wakeMode === "string" ? String(j.wakeMode) : null,
        lastRunAt: iso(typeof st.lastRunAtMs === "number" ? st.lastRunAtMs : null),
        lastStatus: typeof st.lastStatus === "string" ? st.lastStatus : null,
        lastError: typeof st.lastError === "string" ? st.lastError : null,
        nextRunAt: iso(typeof st.nextRunAtMs === "number" ? st.nextRunAtMs : null),
        /* NULL, AND IT IS A FACT RATHER THAN A GAP. OpenClaw keeps no per-run
           output file: a scheduled turn's answer is delivered into its own
           session. What this box can read is the RECEIPT — that it ran, when,
           and whether it failed. */
        outputRef: null,
      };
    });
    return {
      ...base,
      readable: true,
      note: jobs.length
        ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} in OpenClaw's own scheduler. It stores no per-run output text, so results below are what happened rather than what was said.`
        : "OpenClaw's scheduler has no jobs.",
      jobs,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      note:
        `${path} could not be read (${why}). That is where OpenClaw keeps cron_jobs and ` +
        `cron_run_receipts; the file appears once OpenClaw has been installed and started at ` +
        `least once.`,
    };
  }
}

export function openclawResults(limit = 200): NativeResult[] {
  const path = openclawDb();
  try {
    const names = new Map(openclawJobs().jobs.map((j) => [j.id, j.name]));
    const rows = withReadOnly(path, (db) =>
      db
        .prepare(
          `SELECT receipt_id, job_id, status, started_at_ms, finished_at_ms, error_text
             FROM cron_run_receipts
            WHERE status <> 'running'
            ORDER BY started_at_ms DESC, receipt_id DESC
            LIMIT ?`,
        )
        .all(limit) as {
        receipt_id: string;
        job_id: string;
        status: string;
        started_at_ms: number;
        finished_at_ms: number | null;
        error_text: string | null;
      }[],
    );
    return rows.reverse().map((r): NativeResult => {
      const failed = r.status === "error" || r.status === "interrupted";
      /* SKIPPED AND SUPERSEDED ARE NOT NEWS. They are the scheduler tidying up
         after itself — a job that could not start because the previous one was
         still going — and pushing one to a phone would be reporting the
         absence of an event as an event. */
      const silent = r.status === "skipped" || r.status === "superseded";
      return {
        runtime: "openclaw",
        jobId: r.job_id,
        jobName: names.get(r.job_id) ?? null,
        ref: r.receipt_id,
        at: iso(r.finished_at_ms ?? r.started_at_ms),
        status: r.status,
        failed,
        /* THE RECEIPT IS THE WHOLE OF WHAT IS READABLE. Saying so in the body
           is better than sending nothing: the owner learns their job failed,
           and where the text is. */
        body: silent
          ? null
          : failed
            ? `${r.error_text ?? "The run failed and OpenClaw recorded no reason."}\n\n(OpenClaw stores no output text for a scheduled run — this is its run receipt.)`
            : `Ran without error. OpenClaw stores no output text for a scheduled run, so its answer is in OpenClaw's own session rather than here.`,
        silent,
      };
    });
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- both, once */

export function readings(): JobsReading[] {
  return AGENT_IDS.map((id) => (id === "hermes" ? hermesJobs() : openclawJobs()));
}

export function resultsFor(
  id: AgentId,
  limit = 200,
  seen?: (rowId: string) => boolean,
): NativeResult[] {
  /* OpenClaw's receipts are rows rather than files, so re-reading them is one
     indexed SELECT and there is nothing to skip. */
  return id === "hermes" ? hermesResults(limit, seen) : openclawResults(limit);
}
