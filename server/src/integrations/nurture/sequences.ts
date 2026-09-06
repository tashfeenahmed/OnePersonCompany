/**
 * THE SEQUENCE ENGINE — enrol, stop, and DRAFT. Never send.
 *
 * THE PROPERTY THIS FILE EXISTS TO PRESERVE, stated the way outbox.ts states
 * its own, because this is the file that would break it:
 *
 *   1. There is no import of `sendMessage`, of `resendSend`, or of
 *      `sendApproved` anywhere in this module, and no path from it to one.
 *      `grep -n "send" sequences.ts` returns this comment, the word "sent" in
 *      prose, and the reply check's Gmail query. The only thing this engine can
 *      do is put a card on the queue.
 *   2. Every row it writes goes through `prepareDraft`, which writes the literal
 *      string 'draft' into `status` and nothing else.
 *   3. A step comes due because the calendar moved. A message leaves because a
 *      person pressed a button. Those two facts are unrelated and this file is
 *      the boundary between them.
 *
 * THE PASS, IN ORDER, AND THE ORDER MATTERS.
 *
 *   1. STOP first, before anything is written. Checking after drafting would
 *      mean the pass that discovers somebody replied has already written them
 *      another note.
 *   2. ENROL second, inside the active cap.
 *   3. DRAFT third, only what is due, only for enrolments that were not
 *      stopped or held, and only up to the caps.
 *
 * A HOLD IS NOT A GO. If the reply check could not be made — Gmail refused, no
 * account is connected, the quota is spent — the enrolment HOLDS with the
 * reason on it and drafts nothing. "The check failed so carry on" is precisely
 * how somebody gets a fourth note after answering the third, and it is the
 * failure this whole mechanism exists to avoid.
 *
 * ONCE A DAY, KEYED BY THE CALENDAR DAY. `nurture_passes` has the local day as
 * its primary key; a pass that finds today's row already there does nothing.
 * The timer checks every ten minutes whether the configured hour has arrived,
 * which is how "at 08:00" survives a server that restarts on every file save —
 * a `setTimeout` armed for eight hours would be cancelled a hundred times a day
 * and never fire.
 *
 * WHAT THE THREE AUTOMATIC ENROLMENT KINDS NEED, said plainly because a
 * sequence that silently enrols nobody looks identical to one that is working.
 * `signup`, `trial` and `churned` are answered from the PRODUCT'S OWN users
 * document (the `users` plugin, contract in integrations/activity/users.ts).
 * With no such document connected they enrol nobody and the pass says so.
 * They are NOT approximated from mail headers: "this address wrote to me" is
 * not "this person signed up", and a sequence that treated it as one would be
 * sending onboarding mail to strangers.
 */
import { configValue, db, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { GmailError, open } from "../../providers/gmail.ts";
import { gmailDate, messageIds } from "../people/gmail-meta.ts";
import {
  dismissSequenceDrafts,
  firstGmailAccount,
  prepareDraft,
  settings as outboxSettings,
} from "../mailflow/outbox.ts";
import { contactFor, productUser } from "./facts.ts";
import { defaultIdentity, identityRow, transportFor } from "./identities.ts";
import { planAndFacts, PlanRefused } from "./planner.ts";
import { word } from "./wording.ts";
import {
  dueStep,
  verdict,
  STOP_CONDITIONS,
  type Observed,
  type SequenceStep,
} from "./validate.ts";

export const PLUGIN = "nurture";

export const DEFAULT_HOUR = 8;
export const DEFAULT_MAX_ACTIVE = 50;
export const DEFAULT_DRAFTS_PER_PASS = 8;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const MAX_HISTORY = 40;

const int = (key: string, fallback: number, lo: number, hi: number) => {
  const raw = (configValue(PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

export function nurtureSettings() {
  return {
    hour: int("hour", DEFAULT_HOUR, 0, 23),
    maxActive: int("max-active", DEFAULT_MAX_ACTIVE, 0, 500),
    draftsPerPass: int("drafts-per-pass", DEFAULT_DRAFTS_PER_PASS, 0, 50),
  };
}

/* ------------------------------------------------------------------- rows */

export type SequenceRow = {
  id: number;
  venture: string | null;
  name: string;
  enabled: number;
  steps: string;
  enrol_kind: string;
  enrol_filter: string;
  stop_on: string;
  daily_cap: number;
  identity_id: number | null;
  created_at: string;
  updated_at: string;
};

export type EnrollmentRow = {
  id: number;
  sequence_id: number;
  address: string;
  name: string;
  venture: string | null;
  step: number;
  next_due: string | null;
  status: string;
  stop_reason: string | null;
  blocked: string | null;
  enrolled_at: string;
  stopped_at: string | null;
  last_draft_at: string | null;
  history: string;
};

export const ENROL_KINDS = ["signup", "trial", "churned", "manual"] as const;

export function sequenceRows(): SequenceRow[] {
  return db.prepare("SELECT * FROM nurture_sequences ORDER BY id").all() as unknown as SequenceRow[];
}

export function sequenceRow(id: number): SequenceRow | undefined {
  return db.prepare("SELECT * FROM nurture_sequences WHERE id = ?").get(id) as SequenceRow | undefined;
}

export function enrollmentRows(opts: { sequenceId?: number; status?: string; limit?: number } = {}): EnrollmentRow[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 1000);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.sequenceId) { where.push("sequence_id = ?"); args.push(opts.sequenceId); }
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  return db
    .prepare(
      `SELECT * FROM nurture_enrollments ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY status = 'active' DESC, next_due, id LIMIT ?`,
    )
    .all(...args, limit) as unknown as EnrollmentRow[];
}

/** Steps as a list, whatever is in the column. A malformed `steps` is an empty
 *  sequence — one that drafts nothing — rather than an exception that takes the
 *  whole pass down with it. */
export function stepsOf(seq: SequenceRow): SequenceStep[] {
  try {
    const raw = JSON.parse(seq.steps) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((s) => {
      const o = s as Record<string, unknown>;
      const dayOffset = Number(o.dayOffset ?? o.day_offset);
      const purpose = typeof o.purpose === "string" ? o.purpose.trim() : "";
      if (!Number.isFinite(dayOffset) || !purpose) return [];
      return [{ dayOffset, purpose, hint: typeof o.hint === "string" ? o.hint : null }];
    });
  } catch {
    return [];
  }
}

export function stopOnOf(seq: SequenceRow): string[] {
  try {
    const raw = JSON.parse(seq.stop_on) as unknown;
    return Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === "string" && (STOP_CONDITIONS as readonly string[]).includes(s))
      : [];
  } catch {
    return [];
  }
}

export function filterOf(seq: SequenceRow): Record<string, unknown> {
  try {
    const raw = JSON.parse(seq.enrol_filter) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function note(enrollment: EnrollmentRow, what: string, outboxId: number | null = null) {
  let history: unknown[];
  try {
    const raw = JSON.parse(enrollment.history) as unknown;
    history = Array.isArray(raw) ? raw : [];
  } catch {
    history = [];
  }
  history.push({ at: now(), what, outboxId });
  db.prepare("UPDATE nurture_enrollments SET history = ? WHERE id = ?").run(
    JSON.stringify(history.slice(-MAX_HISTORY)),
    enrollment.id,
  );
}

/* ---------------------------------------------------------- stop conditions */

/**
 * Did they reply, since we started writing to them?
 *
 * ONE GMAIL QUERY, IDS ONLY. `from:<address> after:<day>` with a `fields` mask
 * that returns message ids and nothing else — no subject, no snippet, no body.
 * That is the same shape people/ uses and for the same reason: this needs to
 * know THAT they wrote, never what they said.
 *
 * The tri-state is the point. `{ replied: false, checked: false }` is "the
 * question could not be asked", which is a hold and not a go — see the file
 * header.
 */
async function repliedSince(
  address: string,
  sinceIso: string,
  accountId: number,
): Promise<{ replied: boolean; at: string | null; checked: boolean; why: string | null }> {
  try {
    const session = await open("nurture_reply_check", accountId);
    const since = new Date(Date.parse(sinceIso) || Date.now());
    const q = `from:${address} after:${gmailDate(since)}`;
    const { ids } = await messageIds(session, q, 1);
    return { replied: ids.length > 0, at: ids.length ? now() : null, checked: true, why: null };
  } catch (err) {
    const why =
      err instanceof GmailError
        ? `Gmail answered ${err.status}${err.body ? ` — ${err.body.slice(0, 160)}` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { replied: false, at: null, checked: false, why: `cannot check for a reply — ${why}` };
  }
}

function optedOutRow(address: string): boolean {
  return Boolean(db.prepare("SELECT address FROM nurture_optouts WHERE address = ?").get(address));
}

function dismissedFor(sequenceId: number, address: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT id FROM mailflow_outbox WHERE sequence_id = ? AND lower(to_address) = lower(?) AND status = 'dismissed' LIMIT 1",
      )
      .get(sequenceId, address),
  );
}

/**
 * Everything observed about one enrolled person on one pass.
 *
 * The reply check is the only one that costs a network call, so it is made LAST
 * and skipped entirely when a cheaper condition has already answered. A
 * sequence with fifty active enrolments would otherwise spend fifty Gmail
 * requests to discover that half of them had already been stopped for free.
 */
async function observe(
  enrollment: EnrollmentRow,
  stopOn: string[],
  gmailAccount: number | null,
): Promise<Observed> {
  const optedOut = optedOutRow(enrollment.address);
  const dismissedDraft = stopOn.includes("dismissed") && dismissedFor(enrollment.sequence_id, enrollment.address);
  let paying: boolean | null = null;
  if (stopOn.includes("purchased")) {
    const { user } = productUser(enrollment.address);
    paying = user ? (user.paid === null ? null : user.paid === 1) : null;
  }
  if (optedOut || dismissedDraft || paying === true)
    return { repliedAt: null, paying, dismissedDraft, optedOut, unreachable: null };

  if (!stopOn.includes("replied"))
    return { repliedAt: null, paying, dismissedDraft, optedOut, unreachable: null };
  if (gmailAccount === null)
    return {
      repliedAt: null,
      paying,
      dismissedDraft,
      optedOut,
      unreachable:
        "cannot check for a reply — no Gmail account is connected, and this sequence stops on a reply",
    };
  const reply = await repliedSince(enrollment.address, enrollment.enrolled_at, gmailAccount);
  return {
    repliedAt: reply.replied ? (reply.at ?? now()) : null,
    paying,
    dismissedDraft,
    optedOut,
    unreachable: reply.checked ? null : reply.why,
  };
}

function stopEnrollment(enrollment: EnrollmentRow, reason: string, why: string) {
  db.prepare(
    "UPDATE nurture_enrollments SET status = 'stopped', stop_reason = ?, stopped_at = ?, blocked = NULL WHERE id = ?",
  ).run(`${reason}: ${why}`, now(), enrollment.id);
  note(enrollment, `stopped — ${reason}: ${why}`);
  /* A draft written for a step that should no longer happen is taken out of the
     queue rather than left sitting there looking approvable. */
  dismissSequenceDrafts(enrollment.sequence_id, enrollment.address, `${reason}: ${why}`);
}

/* ------------------------------------------------------------- enrolment */

/**
 * Who is eligible, for one sequence, right now.
 *
 * ADDRESSES COME FROM `people_contacts`, WHICH HOLDS REAL ONES. The product
 * users document holds a SALTED HASH and no address at all, deliberately — you
 * cannot write to a hash. So the candidate list is the addresses this box has
 * corresponded with, and the users document is what says which of them signed
 * up, when, on what plan and whether they are paying: each candidate address is
 * hashed with the same install salt and looked up. Nothing is decrypted and no
 * capability is widened; this is the direction that always worked.
 *
 * BULK AND SELF ADDRESSES ARE NOT CANDIDATES. A no-reply address is not a
 * person, and an address on one of the owner's own domains is a colleague seen
 * from inside. Both would otherwise be enrolled by the first sequence anybody
 * switches on.
 */
export function candidates(seq: SequenceRow, limit: number): { address: string; name: string; why: string }[] {
  const kind = seq.enrol_kind;
  if (kind === "manual" || limit <= 0) return [];

  const filter = filterOf(seq);
  const withinDays = Number(filter.withinDays ?? 30);
  const quietDays = Number(filter.quietDays ?? 60);
  const wantPlan = typeof filter.plan === "string" ? filter.plan.toLowerCase() : null;
  const wantProduct = typeof filter.product === "string" ? filter.product.toLowerCase() : null;
  const wantDomain = typeof filter.domain === "string" ? filter.domain.toLowerCase() : null;

  const known = new Set(
    (db.prepare("SELECT address FROM nurture_enrollments WHERE sequence_id = ?").all(seq.id) as unknown as {
      address: string;
    }[]).map((r) => r.address),
  );

  const rows = db
    .prepare(
      `SELECT address, name, domain FROM people_contacts
        ORDER BY (received + sent) DESC LIMIT 2000`,
    )
    .all() as unknown as { address: string; name: string; domain: string }[];

  const out: { address: string; name: string; why: string }[] = [];
  const nowMs = Date.now();
  for (const row of rows) {
    if (out.length >= limit) break;
    if (known.has(row.address) || optedOutRow(row.address)) continue;
    if (wantDomain && row.domain !== wantDomain) continue;
    const { user } = productUser(row.address);
    if (!user) continue;
    if (wantProduct && user.product.toLowerCase() !== wantProduct) continue;
    if (wantPlan && (user.plan ?? "").toLowerCase() !== wantPlan) continue;

    const ageDays = Math.floor((nowMs - (Date.parse(user.createdAt) || nowMs)) / 86_400_000);
    const paying = user.paid === null ? null : user.paid === 1;

    if (kind === "signup") {
      if (paying === true) continue;
      if (Number.isFinite(withinDays) && ageDays > withinDays) continue;
      out.push({
        address: row.address,
        name: row.name,
        why: `${user.product}'s users document says they signed up on ${user.createdAt.slice(0, 10)} and is not reporting them as paying`,
      });
      continue;
    }
    if (kind === "trial") {
      if (paying === true) continue;
      if (!user.plan) continue;
      if (wantPlan === null && !/trial|free|starter/i.test(user.plan)) continue;
      out.push({
        address: row.address,
        name: row.name,
        why: `${user.product}'s users document puts them on the “${user.plan}” plan and is not reporting them as paying`,
      });
      continue;
    }
    if (kind === "churned") {
      /* THE HONEST READING, and it is narrower than the word suggests. This box
         holds no cancellation event and no Stripe address, so "churned" here
         means exactly: the product says they are NOT paying, and the product
         has not seen them for longer than the quiet window. It is a lapse
         reading and the enrolment's own reason says so, rather than claiming a
         cancellation nobody observed. */
      if (paying !== false) continue;
      const seenDays = user.lastSeen
        ? Math.floor((nowMs - (Date.parse(user.lastSeen) || nowMs)) / 86_400_000)
        : null;
      if (seenDays === null || !Number.isFinite(quietDays) || seenDays < quietDays) continue;
      out.push({
        address: row.address,
        name: row.name,
        why: `${user.product}'s users document reports them as not paying and last seen ${user.lastSeen!.slice(0, 10)}, ${seenDays} days ago — a lapse reading, not an observed cancellation`,
      });
    }
  }
  return out;
}

export function enrol(
  sequenceId: number,
  address: string,
  why: string,
): { enrollment: EnrollmentRow } | { refused: string } {
  const seq = sequenceRow(sequenceId);
  if (!seq) return { refused: `There is no sequence ${sequenceId}.` };
  const addr = address.trim().toLowerCase();
  if (!addr.includes("@")) return { refused: `“${address}” is not an email address.` };
  if (optedOutRow(addr)) return { refused: `${addr} asked not to be written to again.` };
  const existing = db
    .prepare("SELECT * FROM nurture_enrollments WHERE sequence_id = ? AND address = ?")
    .get(sequenceId, addr) as EnrollmentRow | undefined;
  if (existing)
    return {
      refused: `${addr} is already in “${seq.name}” (${existing.status}${existing.stop_reason ? ` — ${existing.stop_reason}` : ""}).`,
    };

  const steps = stepsOf(seq);
  const at = now();
  const nextDue = steps.length
    ? new Date(Date.parse(at) + steps[0]!.dayOffset * 86_400_000).toISOString()
    : null;
  const contact = contactFor(addr);
  const info = db
    .prepare(
      `INSERT INTO nurture_enrollments (sequence_id, address, name, venture, step, next_due, status, enrolled_at, history)
       VALUES (?, ?, ?, ?, 0, ?, 'active', ?, ?)`,
    )
    .run(
      sequenceId,
      addr,
      contact?.name ?? "",
      seq.venture,
      nextDue,
      at,
      JSON.stringify([{ at, what: `enrolled — ${why}`, outboxId: null }]),
    );
  return {
    enrollment: db.prepare("SELECT * FROM nurture_enrollments WHERE id = ?").get(Number(info.lastInsertRowid)) as EnrollmentRow,
  };
}

export function stop(enrollmentId: number, reason: string): EnrollmentRow | null {
  const row = db.prepare("SELECT * FROM nurture_enrollments WHERE id = ?").get(enrollmentId) as
    | EnrollmentRow
    | undefined;
  if (!row) return null;
  stopEnrollment(row, "stopped by hand", reason || "no reason given");
  return db.prepare("SELECT * FROM nurture_enrollments WHERE id = ?").get(enrollmentId) as EnrollmentRow;
}

export function optOut(address: string, reason: string | null): { address: string; at: string } {
  const addr = address.trim().toLowerCase();
  const at = now();
  db.prepare("INSERT OR REPLACE INTO nurture_optouts (address, reason, at) VALUES (?, ?, ?)").run(addr, reason, at);
  /* Every live enrolment for them stops now rather than on the next pass, and
     every draft written for them comes out of the queue. An opt-out that took
     until tomorrow to take effect is an opt-out that can still send a message
     tonight. */
  for (const e of db
    .prepare("SELECT * FROM nurture_enrollments WHERE address = ? AND status = 'active'")
    .all(addr) as unknown as EnrollmentRow[])
    stopEnrollment(e, "unsubscribed", "they asked not to be written to again");
  return { address: addr, at };
}

/* --------------------------------------------------------------- the pass */

export type PassResult = {
  day: string;
  ranAt: string;
  ok: boolean;
  enrolled: number;
  drafted: number;
  stopped: number;
  skipped: { address: string; why: string }[];
  trigger: string;
  error: string | null;
  /** True when today's pass had already run and this call did nothing. */
  alreadyRan?: boolean;
};

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function lastPasses(limit = 14): PassResult[] {
  return (
    db.prepare("SELECT * FROM nurture_passes ORDER BY day DESC LIMIT ?").all(limit) as unknown as {
      day: string; ran_at: string; ok: number; enrolled: number; drafted: number; stopped: number;
      skipped: string; trigger: string; error: string | null;
    }[]
  ).map((r) => ({
    day: r.day,
    ranAt: r.ran_at,
    ok: r.ok === 1,
    enrolled: r.enrolled,
    drafted: r.drafted,
    stopped: r.stopped,
    skipped: ((): { address: string; why: string }[] => {
      try {
        const v = JSON.parse(r.skipped) as unknown;
        return Array.isArray(v) ? (v as { address: string; why: string }[]) : [];
      } catch {
        return [];
      }
    })(),
    trigger: r.trigger,
    error: r.error,
  }));
}

/**
 * ONE PASS. Stop what should stop, enrol what should enrol, draft what is due.
 *
 * `force` is the owner's own button and the only way to run a second pass on a
 * day that has already had one. It exists because a sequence edited at noon
 * should not have to wait until tomorrow to be tried; it does not widen
 * anything, because a second pass writes drafts exactly like the first.
 */
export async function runPass(trigger = "timer", force = false): Promise<PassResult> {
  const day = localDay();
  const ranAt = now();
  const existing = db.prepare("SELECT day FROM nurture_passes WHERE day = ?").get(day) as { day: string } | undefined;
  if (existing && !force)
    return { day, ranAt, ok: true, enrolled: 0, drafted: 0, stopped: 0, skipped: [], trigger, error: null, alreadyRan: true };

  const s = nurtureSettings();
  const gmailAccount = firstGmailAccount();
  const skipped: { address: string; why: string }[] = [];
  let enrolled = 0;
  let drafted = 0;
  let stopped = 0;
  let error: string | null = null;

  try {
    for (const seq of sequenceRows()) {
      if (!seq.enabled) continue;
      const steps = stepsOf(seq);
      const stopOn = stopOnOf(seq);

      /* ---- 1. stop, before a single word is written --------------------- */
      for (const e of enrollmentRows({ sequenceId: seq.id, status: "active" })) {
        const observed = await observe(e, stopOn, gmailAccount);
        const v = verdict(observed, stopOn);
        if ("stop" in v) {
          stopEnrollment(e, v.stop, v.why);
          stopped += 1;
        } else if ("hold" in v) {
          db.prepare("UPDATE nurture_enrollments SET blocked = ? WHERE id = ?").run(v.hold, e.id);
        } else {
          db.prepare("UPDATE nurture_enrollments SET blocked = NULL WHERE id = ?").run(e.id);
        }
      }

      /* ---- 2. enrol ------------------------------------------------------ */
      const active = (
        db.prepare("SELECT COUNT(*) AS n FROM nurture_enrollments WHERE status = 'active'").get() as { n: number }
      ).n;
      const room = Math.max(0, s.maxActive - active);
      for (const c of candidates(seq, Math.min(room, seq.daily_cap))) {
        const made = enrol(seq.id, c.address, c.why);
        if ("enrollment" in made) enrolled += 1;
        else skipped.push({ address: c.address, why: made.refused });
      }

      /* ---- 3. draft what is due ------------------------------------------ */
      let madeForThisSequence = 0;
      for (const e of enrollmentRows({ sequenceId: seq.id, status: "active" })) {
        if (drafted >= s.draftsPerPass) break;
        if (madeForThisSequence >= seq.daily_cap) break;
        const fresh = db.prepare("SELECT * FROM nurture_enrollments WHERE id = ?").get(e.id) as EnrollmentRow;
        if (fresh.status !== "active") continue;
        if (fresh.blocked) {
          skipped.push({ address: fresh.address, why: fresh.blocked });
          continue;
        }
        const due = dueStep(
          { step: fresh.step, enrolledAtMs: Date.parse(fresh.enrolled_at) || Date.now() },
          steps,
          Date.now(),
        );
        if ("skip" in due) {
          if (due.done) {
            db.prepare(
              "UPDATE nurture_enrollments SET status = 'done', stopped_at = ?, next_due = NULL WHERE id = ?",
            ).run(now(), fresh.id);
            note(fresh, "finished — every step has been drafted");
          } else skipped.push({ address: fresh.address, why: due.skip });
          continue;
        }

        const outcome = await draftStep(seq, fresh, steps, due.index);
        if ("refused" in outcome) {
          skipped.push({ address: fresh.address, why: outcome.refused });
          continue;
        }
        drafted += 1;
        madeForThisSequence += 1;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  db.prepare(
    `INSERT INTO nurture_passes (day, ran_at, ok, enrolled, drafted, stopped, skipped, trigger, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET ran_at = excluded.ran_at, ok = excluded.ok,
       enrolled = nurture_passes.enrolled + excluded.enrolled,
       drafted = nurture_passes.drafted + excluded.drafted,
       stopped = nurture_passes.stopped + excluded.stopped,
       skipped = excluded.skipped, trigger = excluded.trigger, error = excluded.error`,
  ).run(day, ranAt, error ? 0 : 1, enrolled, drafted, stopped, JSON.stringify(skipped.slice(0, 60)), trigger, error);

  return { day, ranAt, ok: !error, enrolled, drafted, stopped, skipped, trigger, error };
}

/**
 * One due step, turned into one draft.
 *
 * The whole of #29 happens inside these six lines: the planner decides, the
 * gatherers assemble, the wording model is handed the plan and the packet and
 * nothing else, the validator reads what came back, and `prepareDraft` files
 * the four documents together. The step's number is stored on the row so a
 * stop can find and dismiss it.
 */
export async function draftStep(
  seq: SequenceRow,
  enrollment: EnrollmentRow,
  steps: SequenceStep[],
  index: number,
): Promise<{ outboxId: number } | { refused: string }> {
  const step = steps[index]!;
  const identity = seq.identity_id ? identityRow(seq.identity_id) : defaultIdentity(seq.venture);
  if (!identity)
    return {
      refused: seq.venture
        ? `“${seq.name}” has no sending identity and its venture has no default one. Nothing was written.`
        : `“${seq.name}” has no sending identity and there is no global default. Nothing was written.`,
    };

  let prepared;
  try {
    prepared = await planAndFacts({
      address: enrollment.address,
      venture: seq.venture,
      identityId: identity.id,
      purpose: step.purpose,
      whyNow:
        `step ${index + 1} of ${steps.length} in “${seq.name}”, due ${step.dayOffset} day${step.dayOffset === 1 ? "" : "s"} ` +
        `after they were enrolled on ${enrollment.enrolled_at.slice(0, 10)}`,
      origin: { kind: "sequence", detail: `${seq.name} — step ${index + 1}` },
      sequenceId: seq.id,
      step: index + 1,
      steps: steps.length,
    });
  } catch (err) {
    return { refused: err instanceof PlanRefused ? err.message : err instanceof Error ? err.message : String(err) };
  }

  const wording = await word(prepared.plan, prepared.facts, prepared.cannotSay);

  /* The Gmail account on the row is the one whose quota a reply-context read
     would spend and the one an identity-less row would send from. For a Resend
     identity it is a bookkeeping value only; the send reads the transport out
     of the approval. */
  const accountId =
    prepared.transport.via === "gmail" ? prepared.transport.accountId : (firstGmailAccount() ?? prepared.transport.accountId);

  const made = prepareDraft({
    accountId,
    to: enrollment.address,
    subject: wording.subject,
    body: wording.body,
    generatedBody: wording.body,
    inReplyTo: null,
    venture: seq.venture,
    identityId: identity.id,
    createdBy: "agent",
    plan: prepared.plan,
    facts: prepared.facts,
    validation: {
      by: wording.by,
      why: wording.why,
      refusals: wording.refusals,
      model: wording.model,
      styleRules: wording.styleRules,
      cannotSay: prepared.cannotSay,
      at: now(),
    },
    sequenceId: seq.id,
    sequenceStep: index + 1,
  });
  if ("refused" in made) return made;

  const nextIndex = index + 1;
  const nextDue =
    nextIndex < steps.length
      ? new Date((Date.parse(enrollment.enrolled_at) || Date.now()) + steps[nextIndex]!.dayOffset * 86_400_000).toISOString()
      : null;
  db.prepare(
    "UPDATE nurture_enrollments SET step = ?, next_due = ?, last_draft_at = ?, blocked = NULL WHERE id = ?",
  ).run(nextIndex, nextDue, now(), enrollment.id);
  note(enrollment, `step ${index + 1} drafted (${wording.by} wording)`, made.item.id);
  return { outboxId: made.item.id };
}

/* --------------------------------------------------------------- the timer */

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The daily tick.
 *
 * IT CHECKS EVERY TEN MINUTES WHETHER THE HOUR HAS ARRIVED rather than arming a
 * `setTimeout` for eight hours, because this server restarts on every file
 * save: a long timer would be cancelled a hundred times a day and the pass
 * would never run. The "once a day" guarantee is the `nurture_passes` primary
 * key, not the timer's arithmetic, so a restart at 08:05 runs the pass it
 * missed and a restart at 08:06 does nothing.
 *
 * IT ALSO DOES NOT RUN AT BOOT. The hour check is what gates it, and a boot at
 * 09:00 on a day whose pass already ran finds today's row and returns.
 */
export function startNurtureTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void (async () => {
      try {
        const { hour } = nurtureSettings();
        if (new Date().getHours() < hour) return;
        if (!sequenceRows().some((s) => s.enabled)) return;
        const out = await runPass("timer");
        if (!out.alreadyRan)
          console.log(
            `[nurture] pass ${out.day} — ${out.enrolled} enrolled, ${out.drafted} drafted, ${out.stopped} stopped. Nothing sends until it is approved in the Outbox.`,
          );
      } catch (err) {
        /* A pass that throws must not take the process with it. The passes row
           already carries anything worth reading. */
        console.error("[nurture] daily pass failed:", err instanceof Error ? err.message : err);
      }
    })();
  }, CHECK_EVERY_MS);
  timer.unref?.();
}

/** Sequence rows whose identity or venture no longer resolves. Published on the
 *  read so a sequence that cannot draft says why on the page rather than
 *  filling the skipped list every morning. */
export function sequenceProblems(seq: SequenceRow): string[] {
  const out: string[] = [];
  if (!stepsOf(seq).length) out.push("it has no usable steps, so nothing will ever be due");
  const identity = seq.identity_id ? identityRow(seq.identity_id) : defaultIdentity(seq.venture);
  if (!identity) out.push("there is no sending identity for it, so a draft would have no honest From line");
  else {
    try {
      transportFor(identity);
    } catch (err) {
      out.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (seq.enrol_kind !== "manual" && !accounts.list("users").some((a) => a.connected))
    out.push(
      `enrolment kind “${seq.enrol_kind}” is answered from a product's own users document, and no product publishes one here — it will enrol nobody`,
    );
  if (outboxSettings().dailyCap === 0)
    out.push("the outbox's daily cap is zero, so nothing approved here could leave anyway");
  return out;
}
