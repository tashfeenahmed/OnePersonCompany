/**
 * A durable job queue — the one thing an in-memory `for` loop cannot be.
 *
 * The autopilot walked its projects with a loop and an array; a pm2 restart
 * two hours into a night of renders forgot every item not yet done, and the
 * next press started again from the first project. runs.js turns a fourth
 * chat away rather than queue it, and that refusal is right — a chat is a
 * person waiting — but a video nobody is watching render is the opposite
 * case: it should wait its turn and survive a restart.
 *
 * So: a JSON file of items, a worker per KIND registered by the module that
 * knows how to do that kind of work, and a ten-second tick that runs one
 * pending item per kind at a time. On boot anything that was `running` when
 * the process died is put back to `pending` with the attempt counted and an
 * honest error line — it did not finish, and the ledger must not say it did.
 *
 * Retries back off (1m, 5m, 15m) and stop at maxAttempts. The queue knows
 * nothing about GPUs, Dells or Telegram; a worker that needs the Dell asks
 * for it itself, exactly as the modules always have. What the queue owns is
 * ORDER and MEMORY, nothing else.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"

import { ROOT } from "./config.js"
export const QUEUE_STATE = `${ROOT}/queue.json`

const TICK_MS = 10_000
const KEEP_FINISHED_S = 48 * 3600
const KEEP_MAX = 200
const BACKOFF_S = [60, 300, 900]
const FINISHED = new Set(["done", "failed", "cancelled"])

const now = () => Math.floor(Date.now() / 1000)

/* ---------------------------------------------------------------- state */

function load() {
  let doc
  try {
    doc = JSON.parse(readFileSync(QUEUE_STATE, "utf8"))
    if (!Array.isArray(doc?.items)) throw new Error("shape")
  } catch {
    return { items: [] }
  }
  // Settle the restart: a run cannot survive a process.
  for (const it of doc.items) {
    if (it.status !== "running") continue
    it.attempts = (it.attempts ?? 0) + 1
    it.error = "interrupted by a restart"
    it.startedAt = null
    if (it.attempts >= it.maxAttempts) {
      it.status = "failed"
      it.finishedAt = now()
    } else {
      it.status = "pending"
      it.nextAttemptAt = now()
    }
  }
  return doc
}

const state = load()

function persist() {
  try {
    const tmp = `${QUEUE_STATE}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, QUEUE_STATE)
  } catch (err) {
    console.error("[queue] could not persist:", err.message)
  }
}

/* -------------------------------------------------------------- workers */

const workers = new Map() // kind → async (item, ctx) => result
const inFlight = new Map() // kind → item id
const cancelRequested = new Set()
const laneOf = new Map() // kind → lane name, for kinds that share a lane

/** A module says how its kind of work is done. `fn(item, ctx)`: ctx.log(line)
 *  and ctx.progress(text) update the item; ctx.cancelled() lets a long worker
 *  stop early. A throw is a failed attempt; a return is done.
 *
 *  `lane` puts the kind in a named lane: kinds sharing a lane run strictly
 *  ONE AT A TIME across all of them, oldest item first, where laneless kinds
 *  keep the original rule (one per kind, kinds in parallel). The lane exists
 *  for the AI runs — there is one GPU, and a dossier, an SEO analysis and a
 *  competitor sweep queued together should drain in series, not fight. */
export function registerWorker(kind, fn, { lane = null } = {}) {
  workers.set(kind, fn)
  if (lane) laneOf.set(kind, lane)
}

/* -------------------------------------------------------------- verbs */

export function enqueue({ kind, label, meta = {}, maxAttempts = 3, id = null }) {
  if (!kind) throw new Error("an item needs a kind")
  const item = {
    id: id ?? `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label: String(label ?? kind).slice(0, 160),
    status: "pending",
    attempts: 0,
    maxAttempts: Math.max(1, Number(maxAttempts) || 1),
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: now(),
    error: null,
    progress: null,
    meta: meta && typeof meta === "object" ? meta : {},
    result: null,
  }
  state.items.unshift(item)
  prune()
  persist()
  return item
}

export const findItem = (id) => state.items.find((i) => i.id === id) ?? null

/** Pending items of a kind, oldest first — for a module deciding whether to
 *  add more or wait. */
export const pendingOf = (kind) =>
  state.items.filter((i) => i.kind === kind && (i.status === "pending" || i.status === "running")).reverse()

export function cancel(id) {
  const it = findItem(id)
  if (!it) return { error: "no such item" }
  if (it.status === "pending") {
    it.status = "cancelled"
    it.finishedAt = now()
    persist()
    return { ok: true }
  }
  if (it.status === "running") {
    cancelRequested.add(id)
    it.progress = "cancel requested — finishing the step in hand"
    persist()
    return { ok: true }
  }
  return { error: `item is already ${it.status}` }
}

export function retry(id) {
  const it = findItem(id)
  if (!it) return { error: "no such item" }
  if (!FINISHED.has(it.status) || it.status === "done") return { error: `item is ${it.status}` }
  it.status = "pending"
  it.maxAttempts = Math.max(it.maxAttempts, it.attempts + 1)
  it.nextAttemptAt = now()
  it.finishedAt = null
  it.error = null
  it.progress = null
  persist()
  return { ok: true }
}

export function clearFinished() {
  const before = state.items.length
  state.items = state.items.filter((i) => !FINISHED.has(i.status))
  persist()
  return { ok: true, removed: before - state.items.length }
}

function prune() {
  const cutoff = now() - KEEP_FINISHED_S
  state.items = state.items.filter((i) => !FINISHED.has(i.status) || (i.finishedAt ?? 0) > cutoff)
  if (state.items.length > KEEP_MAX) {
    const live = state.items.filter((i) => !FINISHED.has(i.status))
    const done = state.items.filter((i) => FINISHED.has(i.status)).slice(0, Math.max(0, KEEP_MAX - live.length))
    state.items = state.items.filter((i) => live.includes(i) || done.includes(i))
  }
}

/* ----------------------------------------------------------------- run */

async function runOne(item, fn) {
  inFlight.set(item.kind, item.id)
  item.status = "running"
  item.startedAt = now()
  item.attempts++
  item.error = null
  persist()
  const ctx = {
    log: (line) => {
      item.progress = String(line).slice(0, 200)
      persist()
    },
    progress: (text) => {
      item.progress = text == null ? null : String(text).slice(0, 200)
      persist()
    },
    cancelled: () => cancelRequested.has(item.id),
  }
  try {
    const result = await fn(item, ctx)
    item.status = cancelRequested.has(item.id) ? "cancelled" : "done"
    item.result = result === undefined ? null : result
    item.finishedAt = now()
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 300)
    item.error = message
    if (cancelRequested.has(item.id)) {
      item.status = "cancelled"
      item.finishedAt = now()
    } else if (item.attempts >= item.maxAttempts) {
      item.status = "failed"
      item.finishedAt = now()
    } else {
      item.status = "pending"
      item.nextAttemptAt = now() + BACKOFF_S[Math.min(item.attempts - 1, BACKOFF_S.length - 1)]
      item.progress = `attempt ${item.attempts} failed — retrying in ${Math.round((item.nextAttemptAt - now()) / 60)}m`
    }
  } finally {
    cancelRequested.delete(item.id)
    inFlight.delete(item.kind)
    persist()
  }
}

export function queueTick() {
  const t = now()
  // A "slot" is what a running item occupies: its lane when it has one, its
  // own kind otherwise — which is exactly the old one-per-kind rule, with
  // laned kinds folded into one shared slot so they drain in series.
  const busy = new Set()
  for (const kind of inFlight.keys()) busy.add(laneOf.get(kind) ?? kind)
  // Oldest first: the array is newest-first, so scan from the end.
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i]
    if (it.status !== "pending" || (it.nextAttemptAt ?? 0) > t) continue
    const fn = workers.get(it.kind)
    if (!fn) continue
    const slot = laneOf.get(it.kind) ?? it.kind
    if (busy.has(slot)) continue
    busy.add(slot)
    void runOne(it, fn).catch((err) => console.error(`[queue] ${it.kind} worker escaped:`, err.message))
  }
}

let timer = null
export function startQueue() {
  if (timer) return
  timer = setInterval(queueTick, TICK_MS)
  // The first tick a moment after boot, so a re-queued render resumes
  // without waiting the full interval — but not synchronously, so the
  // process serves the dashboard before it spends a GPU.
  setTimeout(queueTick, 3000)
}

/* ---------------------------------------------------------------- read */

export function queueDoc() {
  prune()
  const items = state.items.map(({ result: _r, ...i }) => i)
  return {
    generatedAt: now(),
    pending: items.filter((i) => i.status === "pending").length,
    running: items.filter((i) => i.status === "running").length,
    items,
  }
}
