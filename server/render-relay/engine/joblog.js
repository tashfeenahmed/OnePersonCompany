/**
 * The run ledger — every scheduled job's history, in one file.
 *
 * Every job on this box already keeps a "last" somewhere: nightly.json holds
 * one cycle, seo-analysis.json holds one lastError, the studio tick's outcome
 * lives in a pm2 log line and the digest's in a watermark. History is
 * overwritten each run, and some of it is module-level memory that pm2's
 * forty-odd restarts erase without a trace. So "what happened the last five
 * nights" has never been answerable from the dashboard, which is exactly the
 * kind of question a dashboard exists for.
 *
 * This module is the answer, and it is deliberately dumb: three verbs
 * (jobStart / jobLog / jobEnd) that the jobs call at their own edges, a
 * bounded document on disk, and one read function shaped exactly like the
 * /agent/runs contract. It knows nothing about what the jobs DO — no import
 * of nightly.js, enrich.js or anything else that could close a cycle. Modules
 * import this file; this file imports node builtins and config.js, full stop.
 *
 * TWO RULES CARRY THE WHOLE DESIGN.
 *
 *   THE JOB MATTERS MORE THAN ITS RECORD. Every export swallows every failure.
 *   A disk that refuses the write, a document that will not parse, a caller
 *   holding a jobId this registry has never heard of — none of it may throw
 *   into a nightly cycle or a publish tick. A run that happened and was not
 *   recorded is a small loss; a run that died because its diary was full is
 *   an absurd one.
 *
 *   HISTORY IS RE-READ FROM DISK, NEVER TRUSTED FROM MEMORY. The document is
 *   loaded once at module load, and that load is where a crash gets settled:
 *   any run still open in the file belongs to a process that no longer
 *   exists — a run cannot survive a restart — so it is closed right there as
 *   interrupted, with the honest wording research.js uses for the same
 *   situation. That is the whole "history survives pm2" guarantee: the file
 *   is the record, this process is only its current author.
 *
 * Bounded twice, because it lives on an SD card: thirty runs per job (a
 * month of nightlies, and the noisy ticks only record runs that DID
 * something, so thirty covers weeks there too), and ~200 log lines per run
 * with long lines sliced. Oldest runs are pruned with their logs.
 *
 * Times are UNIX SECONDS throughout — startedAt, finishedAt, log[].at — to
 * match the contract's nextAt. One endpoint, one unit; the frontend should
 * never have to guess which fields are milliseconds.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"
import { JOBLOG_STATE } from "./config.js"

/** Last N runs kept per job, oldest pruned with their logs. */
const MAX_RUNS = 30

/** Log lines one run may hold. The 200th line is a marker saying the cap hit,
 *  so a capped log confesses rather than silently ending mid-story. */
const MAX_LINES = 200

/** One line's ceiling, in characters. A log line is a sentence, not a dump —
 *  anything longer is sliced rather than trusted. */
const MAX_LINE_CHARS = 300

const now = () => Math.floor(Date.now() / 1000)

/**
 * The registry: which jobs exist, what a person calls them, and when they
 * run. A closed list, like actions.js's PLATFORMS and for the same reason —
 * these ids JOIN (the frontend keys its cards on them), and an unknown id is
 * refused rather than accumulated. Cadence strings are defaults; server.js
 * overrides the ones it can compute live (the nightly's real window, for
 * one), because the schedule is the owner's to edit and this file cannot
 * read it without importing half the repo.
 */
const JOBS = [
  { id: "nightly", name: "Nightly analysis", cadence: "nightly 03:00 window" },
  { id: "enrich", name: "AI enrichment", cadence: "hourly when the Dell is awake + nightly" },
  { id: "seo", name: "SEO analysis", cadence: "on demand + nightly" },
  { id: "competitors", name: "Competitor analysis", cadence: "on demand + nightly" },
  { id: "gardening", name: "Gardening rounds", cadence: "on demand + nightly" },
  /* The same gardener pointed at products instead of areas — projectgarden.js.
     On demand only, and that is the whole cadence: nothing schedules it,
     because a walk of every project is a hundred completions and the owner
     should be the one who decides to spend them. */
  { id: "projectgarden", name: "Project rounds", cadence: "on demand" },
  { id: "research", name: "Deep research", cadence: "on demand + nightly" },
  /* The academic room — read the year's literature, write a paper. The daily
     literature sweep is pure Pi and unrecorded here on purpose (it is HTTP,
     not GPU); what this row counts is the WRITING, which is four completions
     and the most expensive thing in the room. */
  { id: "academic", name: "Academic papers", cadence: "on demand + nightly rotation" },
  /*
    The Aug-16 round's five. Every one of these modules already calls
    jobStart/jobLog/jobEnd with the id below — the verbs are silent no-ops for
    an id this registry does not carry, so without the row the run happens and
    the ledger never hears about it. Nothing else keys on them: useRuns.ts
    reads whatever the endpoint sends and draws a card per job.
  */
  { id: "goals-review", name: "Goals weekly review", cadence: "weekly, in the nightly window + on demand" },
  { id: "demandread", name: "Demand reading", cadence: "on demand + nightly" },
  { id: "geo", name: "AI visibility", cadence: "on demand + nightly rotation" },
  { id: "shotsqa", name: "Screenshot visual QA", cadence: "weekly after the Monday capture + on demand" },
  { id: "briefing", name: "Morning briefing", cadence: "nightly, last + on demand" },
  { id: "commitments", name: "Commitment catcher", cadence: "every 6h + on demand" },
  { id: "studio-tick", name: "Studio publish", cadence: "every 5m, when due" },
  { id: "outcomes", name: "Outcomes recompute", cadence: "hourly, when stale" },
  { id: "digest", name: "Morning digest", cadence: "daily 07:00" },
  /*
    Faceless videos — owner-triggered, full stop. Nothing schedules it and
    nothing should: one press is a Dell wake and half an hour of that box's
    GPU, which is a decision a person makes and not a cadence. The row exists
    because faceless.js already calls jobStart/jobLog/jobEnd, and the verbs are
    silent no-ops for an id this registry does not carry — without it the
    render happens and the ledger never hears a word about it, which is
    precisely the failure this file was written to end.
  */
  { id: "faceless", name: "Faceless videos", cadence: "on demand" },
  /*
    Motion graphics — owner-triggered like the other video rows, but the only
    one that renders on this Pi: one completion for the spec, then Remotion in
    the system Chromium. No wake and no GPU, so the row is here purely so the
    ledger hears about the minutes of CPU each press spends.
  */
  { id: "motion", name: "Motion graphics", cadence: "on demand" },
  /*
    The video autopilot — one press walks every project through all three
    generators and sends each video to Telegram. Hours of the Dell per run,
    started by a person, never by a clock; the row exists for the same reason
    faceless's does.
  */
  { id: "autopilot", name: "Video autopilot", cadence: "on demand" },
  /* reel.js and shorts.js have called these verbs since they shipped; the
     rows were simply never added, so every render went unrecorded. */
  { id: "reel", name: "Peter & Stewie reels", cadence: "on demand" },
  { id: "shorts", name: "YouTube shorts", cadence: "on demand" },
  /*
    Reading a homepage's own colours, fonts and tone. On the studio tick
    rather than in the nightly, because it is headless Chromium on the Pi and
    needs no GPU — see branddna.js. One project per hour at most, and the
    cadence below is what a project is re-read on, not how often the sweep
    looks.
  */
  { id: "branddna", name: "Brand DNA", cadence: "one stale project per hour + on demand" },
  /*
    The growth-analytics round, Aug 2026. Two of the three never call a model
    and their rows exist for the same reason faceless's does — the verbs are
    silent no-ops for an unregistered id, so without a row the run happens and
    the ledger hears nothing. `soul` is the only one that spends the GPU, one
    completion per project per night.
  */
  { id: "cro", name: "Conversion experiments", cadence: "weekly, in the nightly's opening seconds + on demand" },
  { id: "aso", name: "Store listing audit", cadence: "weekly after the store collectors + on demand" },
  { id: "soul", name: "Product truth file", cadence: "nightly, one project per pass" },
]

const KNOWN = new Set(JOBS.map((j) => j.id))

const emptyDoc = () => ({ jobs: {} })

/**
 * Load, and settle the past while doing it.
 *
 * A run left open in the file was abandoned by a process that died — a crash,
 * a deploy, pm2 doing what pm2 does — and nothing will ever close it now, so
 * it is closed HERE, as interrupted, before anything else reads the document.
 * Done at load rather than lazily on read so the file itself becomes honest,
 * not just the view of it.
 */
function load() {
  let doc
  try {
    const saved = JSON.parse(readFileSync(JOBLOG_STATE, "utf8"))
    if (!saved || typeof saved.jobs !== "object" || !saved.jobs) throw new Error("shape")
    doc = { ...emptyDoc(), ...saved }
  } catch {
    return emptyDoc()
  }

  let settled = false
  for (const job of Object.values(doc.jobs)) {
    if (!Array.isArray(job?.runs)) continue
    for (const r of job.runs) {
      if (r && r.finishedAt === null) {
        r.finishedAt = now()
        r.ok = false
        r.error = "interrupted — the process restarted mid-run"
        settled = true
      }
    }
  }
  // Written back immediately so a second reader of the FILE (there is none
  // today, but the guarantee is about the file) sees the settled truth too.
  if (settled) persistDoc(doc)
  return doc
}

/**
 * Atomic, and 0600 — actions.js's and nightly.json's write, verbatim: temp
 * then rename so a Pi that loses power mid-write comes back holding the old
 * document whole, and the explicit chmod because writeFileSync's mode only
 * applies when it CREATES the file and the temp may have survived a kill.
 * 0600 rather than the analysis files' 0644 because run histories quote
 * error strings, and error strings quote whatever broke.
 */
function persistDoc(doc) {
  try {
    const tmp = `${JOBLOG_STATE}.tmp`
    writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, JOBLOG_STATE)
  } catch (err) {
    // Never thrown — the in-memory copy is updated either way, so the page
    // keeps working and a broken disk costs history, not jobs.
    console.error("[joblog] could not persist:", err.message)
  }
}

let cached = load()

const persist = () => persistDoc(cached)

const runsOf = (jobId) => {
  if (!cached.jobs[jobId]) cached.jobs[jobId] = { runs: [] }
  if (!Array.isArray(cached.jobs[jobId].runs)) cached.jobs[jobId].runs = []
  return cached.jobs[jobId].runs
}

/** Newest first, so the open run — when there is one — is always runs[0]. */
const openRun = (jobId) => (cached.jobs[jobId]?.runs ?? []).find((r) => r?.finishedAt === null)

/**
 * Open a run. Returns the run id, or null when nothing was recorded — an
 * unknown jobId, or the whole call failing — and the caller is expected to
 * ignore the answer either way: the job never depends on its record.
 *
 * A run already open for this job is closed as superseded first. Every job
 * here enforces one-at-a-time itself, so this is a safety net for the day
 * one of them does not — two open runs would make `running` a lie.
 */
export function jobStart(jobId, meta = null) {
  try {
    if (!KNOWN.has(jobId)) return null

    const already = openRun(jobId)
    if (already) {
      already.finishedAt = now()
      already.ok = false
      already.error = "superseded — a new run of this job started before this one closed"
    }

    const run = {
      id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: now(),
      finishedAt: null,
      ok: null,
      error: null,
      summary: null,
      meta: meta && typeof meta === "object" ? meta : null,
      log: [],
    }
    const runs = runsOf(jobId)
    runs.unshift(run)
    // Pruned at start as well as at end, so a job that keeps crashing before
    // jobEnd still cannot grow the file without bound.
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS
    persist()
    return run.id
  } catch (err) {
    // The rule at the top of this file: a logging failure is swallowed,
    // because the job matters more than its record.
    console.error("[joblog] jobStart failed:", String(err?.message ?? err))
    return null
  }
}

/**
 * One line into the open run. No open run means no-op — garden() is testable
 * without a run, and a stray line after jobEnd is noise, not an error.
 * Swallows everything, for the same reason every export here does: adding a
 * log line must NEVER be the thing that kills a job.
 */
export function jobLog(jobId, line) {
  try {
    const run = openRun(jobId)
    if (!run) return
    if (run.log.length >= MAX_LINES) return
    if (run.log.length === MAX_LINES - 1) {
      // The last slot confesses the cap rather than holding one more line a
      // reader would mistake for the end of the story.
      run.log.push({ at: now(), line: `…log capped at ${MAX_LINES} lines for this run` })
    } else {
      run.log.push({ at: now(), line: String(line ?? "").slice(0, MAX_LINE_CHARS) })
    }
    persist()
  } catch (err) {
    console.error("[joblog] jobLog failed:", String(err?.message ?? err))
  }
}

/**
 * Close the open run. `ok` is coerced to a boolean, `error` and `summary`
 * default to null — absent facts stay null rather than becoming the string
 * "undefined". No open run is a no-op: doRun exits that already closed the
 * run race their own .catch handlers, and the second closer must lose
 * silently rather than reopen anything.
 */
export function jobEnd(jobId, { ok = false, error = null, summary = null } = {}) {
  try {
    const run = openRun(jobId)
    if (!run) return
    run.finishedAt = now()
    run.ok = ok === true
    run.error = error == null ? null : String(error).slice(0, 500)
    run.summary = summary == null ? null : String(summary).slice(0, 500)
    const runs = runsOf(jobId)
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS
    persist()
  } catch (err) {
    console.error("[joblog] jobEnd failed:", String(err?.message ?? err))
  }
}

/**
 * Which jobs have a run open right now, cheaply — id, name and when it
 * started, without building every job's history the way runsOverview() does.
 * shutdown.js polls this once a second while it drains, and a poll that
 * copied thirty logs a second would be its own reason not to drain.
 */
export function openJobs() {
  const out = []
  for (const j of JOBS) {
    const open = (cached.jobs[j.id]?.runs ?? []).find((r) => r?.finishedAt === null)
    if (open) out.push({ id: j.id, name: j.name, startedAt: open.startedAt })
  }
  return out
}

/**
 * A history entry in the contract's exact shape and nothing else — meta and
 * the internal id stay in the file. The IN-FLIGHT run is included at the
 * head with `finishedAt: null, ok: null`, because the live view's whole
 * point is reading a run's log lines WHILE it is going, and history[].log is
 * the only place the contract carries them.
 */
const toHistory = (r) => ({
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  ok: r.ok,
  error: r.error,
  summary: r.summary,
  log: Array.isArray(r.log) ? r.log : [],
})

/**
 * The GET /agent/runs skeleton, exactly. Every registered job appears even
 * with no runs — "never ran" is a row with empty history, which the browser
 * must be able to tell from the job not existing. What this file cannot
 * know — each module's own live flag, the nightly's next window, the
 * digest's clock — is overlaid by server.js, which owns those imports;
 * `running`/`current` here are the joblog's own best answer (an open run)
 * and `nextAt` is null until someone who knows better says otherwise.
 */
/**
 * Every log line matching `q`, newest run first — the "search inside job
 * logs" xyOps has and this ledger never did. Case-insensitive substring,
 * bounded by `limit`; the ledger is at most 30 runs × 200 lines per job.
 */
export function searchRuns(q, { job = null, limit = 200 } = {}) {
  const needle = String(q ?? "").trim().toLowerCase()
  if (!needle) return { q: "", matches: [], total: 0 }
  const matches = []
  let total = 0
  for (const j of JOBS) {
    if (job && j.id !== job) continue
    for (const r of cached.jobs[j.id]?.runs ?? []) {
      for (const l of r.log ?? []) {
        if (!String(l.line).toLowerCase().includes(needle)) continue
        total++
        if (matches.length < limit) matches.push({ job: j.id, jobName: j.name, runStartedAt: r.startedAt, at: l.at, line: l.line })
      }
      if (r.error && String(r.error).toLowerCase().includes(needle)) {
        total++
        if (matches.length < limit) matches.push({ job: j.id, jobName: j.name, runStartedAt: r.startedAt, at: r.finishedAt, line: `error: ${r.error}` })
      }
    }
  }
  matches.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return { q: needle, matches, total }
}

export function runsOverview() {
  return {
    generatedAt: now(),
    jobs: JOBS.map((j) => {
      const runs = cached.jobs[j.id]?.runs ?? []
      const open = runs.find((r) => r?.finishedAt === null) ?? null
      return {
        id: j.id,
        name: j.name,
        kind: "agent",
        cadence: j.cadence,
        nextAt: null,
        running: open !== null,
        current: open
          ? {
              startedAt: open.startedAt,
              stage: null,
              // The freshest line, so a card can narrate without opening the
              // whole log.
              detail: open.log.length ? open.log[open.log.length - 1].line : null,
            }
          : null,
        history: runs.map(toHistory),
      }
    }),
  }
}
