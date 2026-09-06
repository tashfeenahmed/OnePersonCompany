/**
 * /api/nurture — the sequences, the enrolments, the identities and the voice.
 *
 * WHO MAY DO WHAT, WRITTEN AS CODE RATHER THAN AS A CONVENTION, and it is the
 * same shape the outbox next door uses:
 *
 *   read, enrol, stop, opt out, run a pass, prepare a draft
 *                          — anyone, including the agent. Every one of these
 *                            produces a row in this box's own tables or a DRAFT
 *                            in the outbox, and a draft is inert.
 *   identities, sequences, the voice
 *                          — the OWNER. `requireOwner`, because an identity is
 *                            "which domain may this box claim to be", a
 *                            sequence is "who gets written to automatically",
 *                            and the voice is a record of his own writing. None
 *                            of those is a measurement an agent should be able
 *                            to change.
 *
 * THERE IS NO APPROVE AND NO SEND ANYWHERE IN THIS FILE. Not omitted for later:
 * this router has no import of the outbox's `sendApproved`, and the `sequences`
 * skill publishes no such action, so there is no URL for the proxy to compose.
 * The two send routes live on `/api/outbox`, refuse the skills proxy's header,
 * and are unchanged by this area.
 */
import { Hono } from "hono";
import { db, now, ventureRowById, ventureRows } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { requireOwner } from "../security/gate.ts";
import { firstGmailAccount, prepareDraft, row as outboxRow, settings as outboxSettings } from "../mailflow/outbox.ts";
import {
  createIdentity,
  deleteIdentity,
  gmailAddress,
  identityRow,
  identityRows,
  IdentityRefused,
  makeDefault,
  updateIdentity,
  verifyIdentity,
} from "./identities.ts";
import { planAndFacts, PlanRefused, optedOut } from "./planner.ts";
import { word } from "./wording.ts";
import {
  candidates,
  ENROL_KINDS,
  enrol,
  enrollmentRows,
  filterOf,
  lastPasses,
  nurtureSettings,
  optOut,
  runPass,
  sequenceProblems,
  sequenceRow,
  sequenceRows,
  stepsOf,
  stop,
  stopOnOf,
  type SequenceRow,
} from "./sequences.ts";
import { STOP_CONDITIONS } from "./validate.ts";
import {
  addOwnerRule,
  derive,
  forgetVoice,
  learningOn,
  pairs,
  refusals,
  removeRule,
  rules,
} from "./style.ts";

export const nurtureRoutes = new Hono();

const VIA_SKILLS = "x-opc-via";
const viaSkills = (c: { req: { header: (n: string) => string | undefined } }) =>
  (c.req.header(VIA_SKILLS) ?? "").trim().toLowerCase() === "skills";

const fail = (err: unknown) =>
  err instanceof PlanRefused || err instanceof IdentityRefused
    ? { message: err.message, status: err.status }
    : { message: err instanceof Error ? err.message : String(err), status: 500 };

function shapeSequence(seq: SequenceRow, names: Map<string, string>) {
  const steps = stepsOf(seq);
  const enrollments = enrollmentRows({ sequenceId: seq.id, limit: 1000 });
  return {
    id: seq.id,
    name: seq.name,
    venture: seq.venture,
    ventureName: seq.venture ? (names.get(seq.venture) ?? null) : null,
    enabled: seq.enabled === 1,
    steps,
    enrolKind: seq.enrol_kind,
    enrolFilter: filterOf(seq),
    stopOn: stopOnOf(seq),
    dailyCap: seq.daily_cap,
    identityId: seq.identity_id,
    counts: {
      active: enrollments.filter((e) => e.status === "active").length,
      stopped: enrollments.filter((e) => e.status === "stopped").length,
      done: enrollments.filter((e) => e.status === "done").length,
      held: enrollments.filter((e) => e.status === "active" && e.blocked).length,
    },
    /** Why this sequence cannot draft, in words. Empty means it can. */
    problems: sequenceProblems(seq),
    createdAt: seq.created_at,
    updatedAt: seq.updated_at,
  };
}

/* --------------------------------------------------------------------- read */

nurtureRoutes.get("/", (c) => {
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const s = nurtureSettings();
  return c.json({
    settings: {
      hour: s.hour,
      maxActive: s.maxActive,
      draftsPerPass: s.draftsPerPass,
      styleLearning: learningOn(),
      outboxDailyCap: outboxSettings().dailyCap,
      outboxGapDays: outboxSettings().gapDays,
      requireApproval: outboxSettings().requireApproval,
    },
    sequences: sequenceRows().map((s2) => shapeSequence(s2, names)),
    identities: identityRows().map((i) => ({
      id: i.id,
      venture: i.venture,
      ventureName: i.venture ? (names.get(i.venture) ?? null) : null,
      kind: i.kind,
      fromName: i.from_name,
      fromAddress: i.from_address,
      replyTo: i.reply_to,
      accountId: i.account_id,
      isDefault: i.is_default === 1,
      /** Resend's own word, or "mailbox" for a Gmail identity. NULL means
       *  nobody has asked, which is NOT "unverified". */
      verified: i.verified,
      verifiedAt: i.verified_at,
      verifyNote: i.verify_note,
    })),
    passes: lastPasses(),
    enrolKinds: ENROL_KINDS,
    stopConditions: STOP_CONDITIONS,
    optouts: db.prepare("SELECT address, reason, at FROM nurture_optouts ORDER BY at DESC LIMIT 100").all(),
    note:
      "Sequences write DRAFTS. Every step becomes a card in the Outbox and stays there until you " +
      "approve and send it; nothing on this page can send anything. `verified: null` on an identity " +
      "means Resend has not been asked, not that the domain is unverified.",
  });
});

nurtureRoutes.get("/enrollments", (c) => {
  const sequenceId = Number(c.req.query("sequence")) || undefined;
  const status = (c.req.query("status") ?? "").trim() || undefined;
  if (status && !["active", "stopped", "done"].includes(status))
    return c.json({ error: "status is active, stopped or done." }, 400);
  const names = new Map(sequenceRows().map((s) => [s.id, s.name]));
  return c.json({
    items: enrollmentRows({ sequenceId, status, limit: Number(c.req.query("limit")) || 200 }).map((e) => ({
      id: e.id,
      sequenceId: e.sequence_id,
      sequenceName: names.get(e.sequence_id) ?? null,
      address: e.address,
      name: e.name || null,
      venture: e.venture,
      step: e.step,
      nextDue: e.next_due,
      status: e.status,
      /** Why they were stopped, in words, including which condition fired. */
      stopReason: e.stop_reason,
      /** Why this box could not decide today. A held enrolment DRAFTS NOTHING. */
      blocked: e.blocked,
      enrolledAt: e.enrolled_at,
      stoppedAt: e.stopped_at,
      lastDraftAt: e.last_draft_at,
      history: ((): unknown[] => {
        try {
          const v = JSON.parse(e.history) as unknown;
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })(),
    })),
    note:
      "`blocked` is not `stopped`: it means a stop condition could not be checked today, so nothing " +
      "was written for that person. A held enrolment resumes on its own once the check works again.",
  });
});

/** Who a sequence WOULD enrol on its next pass, without enrolling anybody. The
 *  question "why is this sequence not doing anything" is asked far more often
 *  than the pass runs. */
nurtureRoutes.get("/sequences/:id/candidates", (c) => {
  const seq = sequenceRow(Number(c.req.param("id")));
  if (!seq) return c.json({ error: `There is no sequence ${c.req.param("id")}.` }, 404);
  const list = candidates(seq, 25);
  return c.json({
    sequence: { id: seq.id, name: seq.name, enrolKind: seq.enrol_kind },
    items: list,
    problems: sequenceProblems(seq),
    note:
      seq.enrol_kind === "manual"
        ? "This sequence enrols nobody automatically — people are added by hand or by the agent."
        : "These are the people the next pass would enrol, read from a product's own users document. An empty list with no problems means nobody currently matches.",
  });
});

/* ---------------------------------------------------------------- sequences */

nurtureRoutes.post("/sequences", requireOwner, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "The body is JSON." }, 400);
  const name = String(body.name ?? "").trim().slice(0, 120);
  if (!name) return c.json({ error: "A sequence needs a name." }, 400);
  const venture = body.venture ? String(body.venture).trim() : null;
  if (venture && !ventureRowById(venture)) return c.json({ error: `There is no venture “${venture}”.` }, 400);
  const kind = String(body.enrolKind ?? "manual");
  if (!(ENROL_KINDS as readonly string[]).includes(kind))
    return c.json({ error: `Enrolment kind is one of ${ENROL_KINDS.join(", ")}.` }, 400);

  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!steps.length) return c.json({ error: "A sequence needs at least one step." }, 400);
  if (steps.length > 12) return c.json({ error: "Twelve steps is the most a sequence may have." }, 400);
  const clean = steps.map((s) => {
    const o = s as Record<string, unknown>;
    return {
      dayOffset: Math.max(0, Math.trunc(Number(o.dayOffset ?? 0)) || 0),
      purpose: String(o.purpose ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      hint: o.hint ? String(o.hint).slice(0, 200) : null,
    };
  });
  if (clean.some((s) => !s.purpose))
    return c.json({ error: "Every step needs a purpose — one sentence saying what that message is for." }, 400);

  const stopOn = Array.isArray(body.stopOn)
    ? body.stopOn.filter((s): s is string => typeof s === "string" && (STOP_CONDITIONS as readonly string[]).includes(s))
    : [...STOP_CONDITIONS];
  const identityId = body.identityId ? Number(body.identityId) : null;
  if (identityId && !identityRow(identityId)) return c.json({ error: `There is no identity ${identityId}.` }, 400);
  const dailyCap = Math.min(Math.max(Math.trunc(Number(body.dailyCap ?? 5)) || 5, 0), 50);

  const at = now();
  const info = db
    .prepare(
      `INSERT INTO nurture_sequences (venture, name, enabled, steps, enrol_kind, enrol_filter, stop_on, daily_cap, identity_id, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      venture,
      name,
      JSON.stringify(clean),
      kind,
      JSON.stringify(body.enrolFilter && typeof body.enrolFilter === "object" ? body.enrolFilter : {}),
      JSON.stringify(stopOn),
      dailyCap,
      identityId,
      at,
      at,
    );
  const seq = sequenceRow(Number(info.lastInsertRowid))!;
  return c.json(
    {
      item: shapeSequence(seq, new Map(ventureRows().map((v) => [v.id, v.name]))),
      note: "Created and NOT enabled. A sequence that started enrolling people the moment it was typed would draft its first step before anybody had read the steps.",
    },
    201,
  );
});

nurtureRoutes.patch("/sequences/:id", requireOwner, async (c) => {
  const id = Number(c.req.param("id"));
  const seq = sequenceRow(id);
  if (!seq) return c.json({ error: `There is no sequence ${id}.` }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "The body is JSON." }, 400);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); args.push(String(body.name).trim().slice(0, 120)); }
  if (body.enabled !== undefined) { sets.push("enabled = ?"); args.push(body.enabled ? 1 : 0); }
  if (body.dailyCap !== undefined) { sets.push("daily_cap = ?"); args.push(Math.min(Math.max(Math.trunc(Number(body.dailyCap)) || 0, 0), 50)); }
  if (body.identityId !== undefined) {
    const v = body.identityId === null ? null : Number(body.identityId);
    if (v !== null && !identityRow(v)) return c.json({ error: `There is no identity ${v}.` }, 400);
    sets.push("identity_id = ?"); args.push(v);
  }
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps) || !body.steps.length)
      return c.json({ error: "steps is a non-empty list." }, 400);
    const clean = body.steps.slice(0, 12).map((s) => {
      const o = s as Record<string, unknown>;
      return {
        dayOffset: Math.max(0, Math.trunc(Number(o.dayOffset ?? 0)) || 0),
        purpose: String(o.purpose ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
        hint: o.hint ? String(o.hint).slice(0, 200) : null,
      };
    });
    if (clean.some((s) => !s.purpose)) return c.json({ error: "Every step needs a purpose." }, 400);
    sets.push("steps = ?"); args.push(JSON.stringify(clean));
  }
  if (body.stopOn !== undefined) {
    const list = Array.isArray(body.stopOn)
      ? body.stopOn.filter((s): s is string => typeof s === "string" && (STOP_CONDITIONS as readonly string[]).includes(s))
      : [];
    sets.push("stop_on = ?"); args.push(JSON.stringify(list));
  }
  if (body.enrolFilter !== undefined) {
    sets.push("enrol_filter = ?");
    args.push(JSON.stringify(body.enrolFilter && typeof body.enrolFilter === "object" ? body.enrolFilter : {}));
  }
  if (!sets.length) return c.json({ error: "Nothing to change." }, 400);
  db.prepare(`UPDATE nurture_sequences SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, now(), id);
  return c.json({
    item: shapeSequence(sequenceRow(id)!, new Map(ventureRows().map((v) => [v.id, v.name]))),
    note: "Changed. Editing a step's dayOffset MOVES the date for people already enrolled — offsets are measured from enrolment, not from the previous step.",
  });
});

/** A sequence is never deleted while anybody is in it: the enrolments are the
 *  record of who was written to and why, and losing them loses the decisions
 *  with them. Disable it instead — an disabled sequence enrols nobody and
 *  drafts nothing. */
nurtureRoutes.delete("/sequences/:id", requireOwner, (c) => {
  const id = Number(c.req.param("id"));
  if (!sequenceRow(id)) return c.json({ error: `There is no sequence ${id}.` }, 404);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM nurture_enrollments WHERE sequence_id = ?").get(id) as { n: number }).n;
  if (n)
    return c.json(
      {
        error: `${n} ${n === 1 ? "person is" : "people are"} in this sequence. Their enrolments are the record of who was written to and why, so it is disabled rather than deleted — switch it off instead.`,
      },
      409,
    );
  db.prepare("DELETE FROM nurture_sequences WHERE id = ?").run(id);
  return c.json({ deleted: id });
});

/* -------------------------------------------------------------- enrolments */

nurtureRoutes.post("/sequences/:id/enrol", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { address?: string; why?: string } | null;
  const address = String(body?.address ?? "").trim();
  if (!address) return c.json({ error: "Which address?" }, 400);
  const made = enrol(
    id,
    address,
    String(body?.why ?? "").trim() || (viaSkills(c) ? "added by the agent" : "added by hand"),
  );
  if ("refused" in made) return c.json({ error: made.refused }, 409);
  return c.json(
    {
      item: made.enrollment,
      note: "Enrolled. The first step is DRAFTED when it comes due, and every draft waits for your approval in the Outbox.",
    },
    201,
  );
});

nurtureRoutes.post("/enrollments/:id/stop", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { reason?: string } | null;
  const stopped = stop(Number(c.req.param("id")), String(body?.reason ?? "").trim());
  if (!stopped) return c.json({ error: `There is no enrolment ${c.req.param("id")}.` }, 404);
  return c.json({
    item: stopped,
    note: "Stopped, and any draft this sequence had written for them has been taken out of the queue.",
  });
});

nurtureRoutes.post("/optout", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { address?: string; reason?: string } | null;
  const address = String(body?.address ?? "").trim();
  if (!address.includes("@")) return c.json({ error: "Which address?" }, 400);
  const out = optOut(address, String(body?.reason ?? "").trim() || null);
  return c.json({
    ...out,
    note:
      "Recorded. Every live enrolment for them stopped now, their outstanding drafts were dismissed, " +
      "and no sequence — including one written next year — will enrol them again.",
  });
});

/* ------------------------------------------------------------------- passes */

nurtureRoutes.post("/run", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { force?: boolean } | null;
  const out = await runPass(viaSkills(c) ? "agent" : "owner", body?.force === true);
  return c.json({
    ...out,
    note: out.alreadyRan
      ? "Today's pass has already run. Nothing was done. Pass force to run a second one — it writes drafts exactly like the first."
      : "Drafts only. Every step written is a card in the Outbox waiting for your approval.",
  });
});

/* --------------------------------------------------------------- identities */

nurtureRoutes.get("/identities/options", requireOwner, (c) =>
  c.json({
    gmail: accounts
      .list("gmail")
      .filter((a) => a.connected)
      .map((a) => ({ id: a.id, label: a.label, address: gmailAddress(a.id) })),
    resend: accounts
      .list("resend")
      .filter((a) => a.connected)
      .map((a) => ({ id: a.id, label: a.label, domain: a.label })),
    note:
      "A Gmail identity may only claim the mailbox's own address — Google refuses any other From. " +
      "A Resend key here is scoped to ONE sending domain, which is what the key is labelled with.",
  }),
);

nurtureRoutes.post("/identities", requireOwner, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "The body is JSON." }, 400);
  try {
    const made = createIdentity({
      venture: body.venture ? String(body.venture).trim() : null,
      kind: String(body.kind ?? ""),
      fromName: String(body.fromName ?? ""),
      fromAddress: String(body.fromAddress ?? ""),
      replyTo: body.replyTo ? String(body.replyTo) : null,
      accountId: Number(body.accountId),
      isDefault: body.isDefault === true,
    });
    /* Asked immediately, because an identity nobody has verified is an identity
       whose first use is its first test — and its first use is a real email. */
    const verified = await verifyIdentity(made.id).catch(() => made);
    return c.json({ item: verified, note: "Created, and Resend was asked about the domain straight away." }, 201);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.message }, f.status as 400);
  }
});

nurtureRoutes.patch("/identities/:id", requireOwner, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "The body is JSON." }, 400);
  try {
    const patch: Parameters<typeof updateIdentity>[1] = {};
    if (body.fromName !== undefined) patch.fromName = String(body.fromName);
    if (body.replyTo !== undefined) patch.replyTo = body.replyTo === null ? null : String(body.replyTo);
    if (body.venture !== undefined) patch.venture = body.venture === null ? null : String(body.venture);
    if (body.accountId !== undefined) patch.accountId = Number(body.accountId);
    return c.json({ item: updateIdentity(Number(c.req.param("id")), patch) });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.message }, f.status as 400);
  }
});

nurtureRoutes.post("/identities/:id/verify", requireOwner, async (c) => {
  try {
    const item = await verifyIdentity(Number(c.req.param("id")), "nurture_identity_verify_button");
    return c.json({
      item,
      note: "`verified` is Resend's own word for the domain, read just now. NULL means the question could not be asked, which is not the same as unverified.",
    });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.message }, f.status as 404);
  }
});

nurtureRoutes.post("/identities/:id/default", requireOwner, (c) => {
  try {
    return c.json({ item: makeDefault(Number(c.req.param("id"))) });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.message }, f.status as 404);
  }
});

nurtureRoutes.delete("/identities/:id", requireOwner, (c) => {
  try {
    deleteIdentity(Number(c.req.param("id")));
    return c.json({ deleted: Number(c.req.param("id")) });
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.message }, f.status as 409);
  }
});

/* ------------------------------------------------------------- the drafting */

/**
 * PREPARE ONE FACT-BACKED DRAFT, outside any sequence.
 *
 * The whole of the planner/facts/wording/validator split in one call, for a
 * person the owner (or the agent) names. What comes back is a DRAFT in the
 * outbox, with its plan, its facts and its validation stored beside it — and
 * the facts come back on the response too, because the point of the exercise is
 * that the reasons travel with the message.
 *
 * `dryRun` prepares everything and files nothing. It is how "what would you
 * say" is answered without spending a row against the per-address floor.
 */
nurtureRoutes.post("/prepare", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "The body is JSON." }, 400);
  const address = String(body.address ?? "").trim();
  const purpose = String(body.purpose ?? "").trim();
  if (!address) return c.json({ error: "Which address?" }, 400);
  if (!purpose)
    return c.json({ error: "A purpose — one sentence saying what this message is for. It becomes the wording model's whole brief." }, 400);

  const out = optedOut(address);
  if (out) return c.json({ error: `${address} asked not to be written to again (${out.at.slice(0, 10)}).` }, 409);

  try {
    const prepared = await planAndFacts({
      address,
      venture: body.venture ? String(body.venture).trim() : null,
      identityId: body.identityId ? Number(body.identityId) : null,
      purpose,
      whyNow: String(body.whyNow ?? "").trim() || "asked for by hand",
      origin: { kind: body.threadId ? "reply" : "manual", detail: viaSkills(c) ? "the agent asked for it" : "the owner asked for it" },
      threadId: body.threadId ? String(body.threadId) : null,
    });
    const wording = await word(prepared.plan, prepared.facts, prepared.cannotSay);
    const validation = {
      by: wording.by,
      why: wording.why,
      refusals: wording.refusals,
      model: wording.model,
      styleRules: wording.styleRules,
      cannotSay: prepared.cannotSay,
      at: now(),
    };

    if (body.dryRun === true)
      return c.json({
        dryRun: true,
        plan: prepared.plan,
        facts: prepared.facts,
        validation,
        subject: wording.subject,
        body: wording.body,
        note: "Nothing was written. This is what would have been filed as a draft.",
      });

    const accountId =
      prepared.transport.via === "gmail"
        ? prepared.transport.accountId
        : (firstGmailAccount() ?? prepared.transport.accountId);
    const made = prepareDraft({
      accountId,
      to: prepared.plan.address,
      subject: wording.subject,
      body: wording.body,
      generatedBody: wording.body,
      inReplyTo: prepared.plan.threadId,
      venture: prepared.plan.venture,
      identityId: prepared.plan.identityId,
      createdBy: viaSkills(c) ? "agent" : "owner",
      plan: prepared.plan,
      facts: prepared.facts,
      validation,
      sequenceId: null,
      sequenceStep: null,
    });
    if ("refused" in made) return c.json({ error: made.refused }, 409);
    return c.json(
      {
        outboxId: made.item.id,
        plan: prepared.plan,
        facts: prepared.facts,
        validation,
        subject: made.item.subject,
        body: made.item.body,
        note:
          "Written, not sent. It is a draft in the Outbox and it will stay one until you approve it there. " +
          (wording.by === "template"
            ? `The model's wording was not used: ${wording.why}`
            : "Every number, date, link and address in it was checked against the facts above."),
      },
      201,
    );
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.message }, f.status as 409);
  }
});

/** One draft's own reasons, for the Outbox card. Separate from
 *  `GET /api/outbox` because it is per-row and the listing is not the place to
 *  fan out a fact packet forty times. */
nurtureRoutes.get("/drafts/:id", (c) => {
  const r = outboxRow(Number(c.req.param("id")));
  if (!r) return c.json({ error: `There is no outbox row ${c.req.param("id")}.` }, 404);
  const parse = (v: string | null) => {
    if (!v) return null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  return c.json({
    id: r.id,
    plan: parse(r.plan),
    facts: parse(r.facts),
    validation: parse(r.validation),
    identity: r.identity_id ? (identityRow(r.identity_id) ?? null) : null,
    sequenceId: r.sequence_id,
    sequenceStep: r.sequence_step,
    sentVia: r.sent_via,
    /** Resend's own last event for a sent copy. NULL means NOT READ — never
     *  "not delivered". */
    deliveryEvent: r.delivery_event,
    deliveryReadAt: r.delivery_read_at,
    note:
      r.plan === null
        ? "This draft was typed by hand rather than planned, so it has no fact packet. That absence is the honest answer: nobody validated it against anything."
        : "These are the facts the wording was allowed to use. Every number, amount, date, link and address in the message was checked against them.",
  });
});

/* ---------------------------------------------------------------- the voice */

nurtureRoutes.get("/style", requireOwner, (c) =>
  c.json({
    on: learningOn(),
    rules: rules().map((r) => ({
      id: r.id,
      rule: r.rule,
      byOwner: r.by_owner === 1,
      evidence: ((): number[] => {
        try {
          const v = JSON.parse(r.evidence) as unknown;
          return Array.isArray(v) ? (v as number[]) : [];
        } catch {
          return [];
        }
      })(),
      model: r.model,
      derivedAt: r.derived_at,
      version: r.version,
    })),
    /* HOW MANY PAIRS, AND WHEN — NEVER THE PAIRS THEMSELVES. They quote whole
       email bodies, his and the machine's, and no route publishes one. */
    edits: {
      count: pairs().length,
      newest: pairs()[0]?.at ?? null,
      oldest: pairs().at(-1)?.at ?? null,
    },
    refusals: refusals(),
    note:
      "Rules are STYLE ONLY and are injected into the wording prompt and nowhere else. A rule carrying " +
      "a digit, an address, a link, a domain or a name is refused rather than stripped, and the fact " +
      "validator still reads every finished body against the packet afterwards. The stored pairs quote " +
      "real email bodies and are never published here.",
  }),
);

nurtureRoutes.post("/style/derive", requireOwner, async (c) => c.json(await derive()));

nurtureRoutes.post("/style/rules", requireOwner, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { rule?: string } | null;
  try {
    return c.json({ item: addOwnerRule(String(body?.rule ?? "")) }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

nurtureRoutes.delete("/style/rules/:id", requireOwner, (c) =>
  removeRule(Number(c.req.param("id")))
    ? c.json({ deleted: Number(c.req.param("id")) })
    : c.json({ error: `There is no rule ${c.req.param("id")}.` }, 404),
);

nurtureRoutes.post("/style/forget", requireOwner, (c) =>
  c.json({
    ...forgetVoice(),
    note: "Forgotten: every rule, every refusal and every stored before/after pair. Nothing about your writing is kept.",
  }),
);
