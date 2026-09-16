/**
 * Who is running the GPU's background programme right now, if anyone.
 *
 * The nightly cycle's whole design is stages in series — nightly.js awaits
 * each one before the next starts, and once the cap passes, later stages
 * decline rather than pile on. What that file cannot do alone is stop the
 * OPPORTUNISTIC starters from jumping into the middle of its night: the
 * hourly enrichment tick fires precisely when "the Dell is ready and the
 * document is stale", which at 03:05 is always, and a browser left open on
 * the Priority tab kicks a triage pass the minute it sees the box up. Either
 * one lands its completions between a stage's own, and "one thing at a time"
 * quietly stops being true.
 *
 * So: one claim, held by the cycle from first stage to shutdown, checked by
 * everything that starts GPU work on its own initiative. Deliberately NOT
 * checked by anything a person triggers — chat, the run buttons, a scheduled
 * studio post — because a human pressing a button at 03:10 has decided the
 * overlap is worth it, and a mutex that makes the owner queue behind his own
 * housekeeping would have the priorities exactly backwards.
 *
 * A flag rather than a promise-queue on purpose: the declined tick does not
 * want to WAIT for the night to end — its next interval is soon enough — and
 * a queue would hold stale closures over work that will have been done by a
 * nightly stage anyway.
 */

let holder = null

export function holdGpu(who) {
  holder = who
}

/** Keyed to the claimant so a stray release cannot clear somebody else's
 *  claim — the same reason markRead takes a threadId and not "whatever". */
export function releaseGpu(who) {
  if (holder === who) holder = null
}

/** The claimant's name, or null. Callers put it in their `reason` verbatim,
 *  so a skipped tick reads "the nightly holds the GPU" rather than "busy". */
export function gpuHeldBy() {
  return holder
}
