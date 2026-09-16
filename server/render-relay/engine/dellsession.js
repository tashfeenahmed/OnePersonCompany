/**
 * Who woke the Dell, and when it may be put back.
 *
 * This used to live inside reel.js as three module-level variables, which was
 * correct exactly as long as reels were the only thing that woke the box. They
 * are not any more: the shorts tab wakes it too, and two independent linger
 * timers is a bug with a clear failure — a reel finishes, schedules its
 * ten-minute sleep, the owner starts a shorts job, and the reel's timer fires
 * halfway through and powers off the machine the shorts job is using.
 *
 * So ownership and the timer are ONE thing, here, shared. The rules are
 * unchanged in substance and are still the rules reel.js established:
 *
 * WE POWER OFF EXACTLY WHAT WE POWERED ON. If `powerState()` said anything but
 * "off" when a job started, the box is up for somebody else's reasons — the
 * bots, planintel — and this dashboard is a guest that leaves it running.
 *
 * OWNERSHIP OUTLIVES A JOB. Reel A wakes the box and schedules a sleep; job B
 * two minutes later honestly finds it "already-awake", but the machine is only
 * up because of A. If B's bookkeeping were the whole story nothing would ever
 * power it off again. The flag is the source of truth for who pays; each job's
 * own `dell` field stays a truthful record of what that job found.
 *
 * NOBODY SLEEPS A BUSY BOX. Every caller registers a predicate saying whether
 * it is mid-job, and a pending sleep that comes due while any of them says yes
 * is abandoned rather than honoured.
 *
 * Lost on restart, deliberately unrecovered: a pm2 restart leaves a woken Dell
 * running, which is the safe direction to fail. The alternative is persisting a
 * timer that could power off a box somebody else is by then using.
 */

import { sleep } from "./power.js"

let weOwnPower = false
let sleepTimer = null
let dueAt = null

/** name -> () => boolean. Any true blocks a shutdown. */
const busyChecks = new Map()

/** Declare a predicate that says "I am mid-job, do not power anything off". */
export function registerBusy(name, fn) {
  busyChecks.set(name, fn)
}

/**
 * Exported so a shutdown asked for from somewhere other than this file — the
 * /dell-off command in telegram.js — can refuse for the same reason and in the
 * same words rather than growing a second, drifting idea of "busy".
 */
export function anyoneBusy() {
  for (const [, fn] of busyChecks) {
    try {
      if (fn()) return true
    } catch {
      /* a broken predicate must not strand the box awake forever */
    }
  }
  return false
}

/** This dashboard sent the wake, so this dashboard owes the shutdown. */
export function claimPower() {
  weOwnPower = true
}

export function ownsPower() {
  return weOwnPower
}

/** Unix seconds when the Dell is currently due to be powered off, or null. */
export function sleepDueAt() {
  return dueAt
}

export function cancelSleep() {
  if (sleepTimer) clearTimeout(sleepTimer)
  sleepTimer = null
  dueAt = null
}

/**
 * Power the Dell off, but not yet. Cancels any timer already pending so the
 * newest job sets the deadline rather than the oldest.
 *
 * Sleeping the instant a job lands is the wrong economy — videos are made in
 * handfuls, and each re-wake is ninety seconds of staring at a progress bar to
 * save a couple of minutes of idle.
 */
export function scheduleSleep(lingerMs, { onDue, onSlept, log } = {}) {
  cancelSleep()
  if (!weOwnPower) return

  if (lingerMs <= 0) {
    void doSleep({ onSlept })
    return
  }
  dueAt = Math.floor((Date.now() + lingerMs) / 1000)
  onDue?.(dueAt)
  log?.(`leaving the Dell up for ${Math.round(lingerMs / 60000)} minutes`)
  sleepTimer = setTimeout(() => void doSleep({ onSlept }), lingerMs)
}

async function doSleep({ onSlept } = {}) {
  cancelSleep()
  // Another job may have started between the timer firing and this line.
  if (anyoneBusy()) return
  try {
    const s = await sleep()
    onSlept?.(s.ok)
  } catch {
    onSlept?.(false)
  } finally {
    weOwnPower = false
  }
}

/** The "sleep it now" button — only ever offered for a box we woke. */
export async function sleepNow({ onSlept } = {}) {
  if (!weOwnPower) return { ok: false, error: "this dashboard did not wake the Dell" }
  if (anyoneBusy()) return { ok: false, error: "something is still rendering" }
  await doSleep({ onSlept })
  return { ok: true }
}
