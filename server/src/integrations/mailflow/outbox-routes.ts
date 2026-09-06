/**
 * /api/outbox — the queue, and the two routes on it that only a person may
 * call.
 *
 * WHO MAY DO WHAT, WRITTEN AS CODE RATHER THAN AS A CONVENTION.
 *
 *   draft, edit, dismiss   — anyone. The agent writes here; so does the owner
 *                            typing in the composer. Both produce a `draft`,
 *                            and a draft is inert.
 *   approve, send          — the OWNER, and the check has two walls. The
 *                            `outbox` skill publishes no approve and no send
 *                            action, so routes/skills.ts has no entry to
 *                            forward to and cannot compose one — that is the
 *                            structural wall. And every request the proxy
 *                            makes carries `x-opc-via: skills`, which these
 *                            two routes reject outright, so a future editor
 *                            who adds the action to the registry by accident
 *                            gets a 403 instead of a sent email.
 *
 * AN EDIT UNAPPROVES. Changing the words of an approved draft returns it to
 * `draft`, because the approval was of a document and the document is now a
 * different one. That is the only place in this file where a status moves
 * backwards, and it moves towards the state where somebody has to press the
 * button again.
 */
import { Hono } from "hono";
import { db, now, ventureRow, ventureRows } from "../../db.ts";
import { GmailError, NoMailbox } from "../../providers/gmail.ts";
import { requireOwner } from "../security/gate.ts";
import * as accounts from "../../accounts.ts";
import { validAddress } from "./gmail-send.ts";
import {
  SendRefused,
  approveDraft,
  approvalKey,
  STATUSES,
  firstGmailAccount,
  floorBlocker,
  fromAddress,
  preview,
  routeOrReason,
  row,
  rows,
  sendApproved,
  sentToday,
  settings,
  type OutboxRow,
} from "./outbox.ts";

export const outboxRoutes = new Hono();

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;

/**
 * THE HEADER THE SKILLS PROXY SENDS. routes/skills.ts sets it on every action
 * it forwards; nothing else on this box sets it. It is not authentication —
 * there is no auth on /api and this file does not pretend otherwise — it is a
 * PROVENANCE marker, and it exists so that "an agent may write but never send"
 * survives somebody carelessly adding an action to the registry.
 */
const VIA_SKILLS = "x-opc-via";

function viaSkills(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return (c.req.header(VIA_SKILLS) ?? "").trim().toLowerCase() === "skills";
}

/**
 * THE WALL THIS FILE'S HEADER HAS ALWAYS DESCRIBED, and which was not actually
 * here until the review found it.
 *
 * `viaSkills` was read in exactly one place — recording whether a draft's words
 * were the agent's or the owner's — and the approve and send routes were held
 * by `requireOwner` alone. That IS a real wall (the proxy carries no session
 * cookie), but three file headers assert that these two routes refuse the
 * proxy's own header outright, and an assertion nobody enforces is the kind
 * that quietly stops being true.
 *
 * IT RUNS BEFORE `requireOwner`, deliberately. Behind it the refusal would be
 * unreachable — the owner gate rejects a non-browser request first — and a
 * check that can never fire is not a second wall, it is a comment. In front,
 * the request gets the sentence that names what actually happened.
 */
async function refuseSkillsProxy(
  c: { req: { header: (n: string) => string | undefined }; json: (b: unknown, s?: number) => Response },
  next: () => Promise<void>,
) {
  if (viaSkills(c))
    return c.json(
      {
        error:
          "This is the owner's press, and this request came through the skills proxy. The outbox skill publishes no approve and no send action; there is nothing here for an agent to call.",
      },
      403,
    );
  return next();
}

function shape(r: OutboxRow, names: Map<string, string>) {
  const s = settings();
  /* The From line comes from the ROUTE now, not from the Gmail mailbox alone.
     A row with no identity resolves to exactly what it always did; a row with
     one resolves through the identity, and a route that REFUSES (a Resend key
     re-pointed at another domain) comes back as a sentence rather than as a
     failed listing — the card has to be readable in order to be fixed. */
  const { route, reason, warning } = routeOrReason(r);
  return {
    id: r.id,
    approvalKey: approvalKey(r),
    from: route?.address ?? fromAddress(r.account_id),
    fromName: route?.line !== route?.address ? (route?.line ?? null) : null,
    via: route?.via ?? null,
    replyTo: route?.replyTo ?? null,
    /** A refusal: there is no honest From line and the send is frozen against
     *  it. NULL when the route resolved. */
    fromError: reason,
    /** A resolved route Resend has something to say about — "pending", or never
     *  asked. It does NOT stop a send; it is what the owner needs to read
     *  before he approves rather than after Resend refuses. */
    fromWarning: warning,
    identityId: r.identity_id,
    /** Whether this draft carries a plan and a fact packet. The Outbox card
     *  fetches them from /api/nurture/drafts/:id on demand; fanning a packet
     *  out forty times in one listing would be most of the response. */
    hasReasons: r.plan !== null,
    sequenceId: r.sequence_id,
    sequenceStep: r.sequence_step,
    sentVia: r.sent_via,
    deliveryEvent: r.delivery_event,
    deliveryReadAt: r.delivery_read_at,
    accountId: r.account_id,
    to: r.to_address,
    subject: r.subject,
    /** The markdown as written. */
    body: r.body,
    /** The markdown WITH the signature setting under it — what the recipient
     *  would actually receive. The page renders this, so what is approved and
     *  what is sent are the same document. */
    preview: r.approved_content ? (JSON.parse(r.approved_content) as { text: string }).text : preview(r, s),
    inReplyTo: r.in_reply_to,
    venture: r.venture,
    ventureName: r.venture ? (names.get(r.venture) ?? null) : null,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    messageId: r.message_id,
    error: r.error,
  };
}

/* --------------------------------------------------------------------- read */

outboxRoutes.get("/", (c) => {
  const status = (c.req.query("status") ?? "").trim();
  if (status && !(STATUSES as readonly string[]).includes(status))
    return c.json(
      { error: `There is no status “${status}”. They are: ${STATUSES.join(", ")}.` },
      400,
    );
  const limit = Number(c.req.query("limit") ?? 100);
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const list = rows({
    status: status || undefined,
    offset,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const s = settings();
  const accountId = firstGmailAccount();

  return c.json({
    settings: {
      gapDays: s.gapDays,
      dailyCap: s.dailyCap,
      requireApproval: s.requireApproval,
      /** Published so the page can show what will be appended. It is the
       *  owner's own text from the settings page, never a secret. */
      signature: s.signature,
    },
    mailbox: {
      accountId,
      /** The From line. Null means the Gmail plugin has never been collected,
       *  and nothing can be sent until it has. */
      address: accountId === null ? null : fromAddress(accountId),
    },
    today: { sent: sentToday(), cap: s.dailyCap },
    counts: Object.fromEntries(
      STATUSES.map((st) => [
        st,
        (db.prepare("SELECT COUNT(*) AS n FROM mailflow_outbox WHERE status = ?").get(st) as {
          n: number;
        }).n,
      ]),
    ),
    pagination: { offset, limit: Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 100)), total: Number((db.prepare(`SELECT COUNT(*) AS n FROM mailflow_outbox ${status ? "WHERE status = ?" : ""}`).get(...(status ? [status] : [])) as { n: number }).n) },
    accounts: accounts.list("gmail").filter(a => a.connected).map(a => ({ id: a.id, label: a.label, address: fromAddress(a.id) })),
    items: list.map((r) => shape(r, names)),
    note: "Drafts stay here until you approve and send them. A sent message has a Gmail message ID. Check uncertain deliveries in Gmail before retrying.",
  });
});

/* ------------------------------------------------------------------- draft */

outboxRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    to?: string;
    subject?: string;
    body?: string;
    inReplyTo?: string;
    venture?: string;
    account?: number;
  } | null;
  if (!body) return c.json({ error: "The body of a draft is JSON." }, 400);

  const to = String(body.to ?? "").trim();
  if (!validAddress(to))
    return c.json({ error: `“${to}” is not an email address, so there is no draft.` }, 400);

  const subject = String(body.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!subject) return c.json({ error: "A draft needs a subject." }, 400);
  if (subject.length > MAX_SUBJECT)
    return c.json({ error: `A subject is at most ${MAX_SUBJECT} characters.` }, 400);

  const markdown = String(body.body ?? "").trim();
  if (!markdown) return c.json({ error: "A draft needs a body — markdown." }, 400);
  if (markdown.length > MAX_BODY)
    return c.json({ error: `A body is at most ${MAX_BODY} characters.` }, 400);

  const inReplyTo = String(body.inReplyTo ?? "").trim() || null;
  if (inReplyTo && !/^[A-Za-z0-9_-]{1,128}$/.test(inReplyTo))
    return c.json({ error: "inReplyTo is a Gmail THREAD id, and that is not one." }, 400);

  const venture = String(body.venture ?? "").trim();
  const ventureId = venture ? (ventureRow(venture)?.id ?? null) : null;
  if (venture && !ventureId)
    return c.json({ error: `There is no venture called “${venture}”.` }, 400);

  const accountId = body.account === undefined ? firstGmailAccount() : Number(body.account);
  if (accountId && !accounts.list("gmail").some(a => a.id === accountId && a.connected))
    return c.json({ error: "Choose a connected Gmail account." }, 400);
  if (!accountId)
    return c.json(
      { error: "No Gmail account is connected, so there is no mailbox to write from." },
      404,
    );

  const s = settings();
  const blocker = floorBlocker(to, s.gapDays);
  if (blocker)
    return c.json(
      {
        error:
          `There is already a message to ${to} from ${blocker.created_at.slice(0, 10)} ` +
          `(${blocker.status}), inside the ${s.gapDays}-day floor this queue keeps. ` +
          "Dismissed rows count — a dismissal is “not this person, not now”. " +
          "Nothing was written.",
        blocker: { id: blocker.id, status: blocker.status, createdAt: blocker.created_at },
      },
      409,
    );

  /* WHO WROTE IT. The proxy's own header is authoritative: a caller cannot
     claim to be the owner by sending `createdBy`, because this route does not
     read such a field. It only ever says "agent" or "owner", and it is a
     record rather than a permission — both are drafts and both wait. */
  const createdBy = viaSkills(c) ? "agent" : "owner";

  const info = db
    .prepare(
      `INSERT INTO mailflow_outbox
         (account_id, to_address, subject, body, in_reply_to, venture, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(accountId, to, subject, markdown, inReplyTo, ventureId, createdBy, now());

  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  return c.json(
    {
      item: shape(row(Number(info.lastInsertRowid))!, names),
      note:
        "Written, not sent. It is a draft and it will stay one until the owner " +
        "approves it in the Outbox app.",
    },
    201,
  );
});

/* -------------------------------------------------------------------- edit */

outboxRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const r = row(id);
  if (!r) return c.json({ error: `There is no outbox row ${id}.` }, 404);
  if (["sent", "sending", "uncertain"].includes(r.status))
    return c.json(
      { error: `Row ${id} has been sent. A sent message cannot be edited — it is gone.` },
      409,
    );

  const body = (await c.req.json().catch(() => null)) as {
    to?: string;
    subject?: string;
    body?: string;
    venture?: string | null;
  } | null;
  if (!body) return c.json({ error: "The body of an edit is JSON." }, 400);

  const sets: string[] = [];
  const args: (string | null)[] = [];

  if (body.to !== undefined) {
    const to = String(body.to).trim();
    if (!validAddress(to)) return c.json({ error: `“${to}” is not an email address.` }, 400);
    const blocker = floorBlocker(to, settings().gapDays, id);
    if (blocker)
      return c.json(
        {
          error:
            `There is already a message to ${to} from ${blocker.created_at.slice(0, 10)} ` +
            `(${blocker.status}), inside the ${settings().gapDays}-day floor.`,
        },
        409,
      );
    sets.push("to_address = ?");
    args.push(to);
  }
  if (body.subject !== undefined) {
    const subject = String(body.subject).replace(/[\r\n]+/g, " ").trim();
    if (!subject) return c.json({ error: "A subject cannot be emptied." }, 400);
    if (subject.length > MAX_SUBJECT)
      return c.json({ error: `A subject is at most ${MAX_SUBJECT} characters.` }, 400);
    sets.push("subject = ?");
    args.push(subject);
  }
  if (body.body !== undefined) {
    const markdown = String(body.body).trim();
    if (!markdown) return c.json({ error: "A body cannot be emptied." }, 400);
    if (markdown.length > MAX_BODY)
      return c.json({ error: `A body is at most ${MAX_BODY} characters.` }, 400);
    sets.push("body = ?");
    args.push(markdown);
  }
  if (body.venture !== undefined) {
    const v = body.venture === null ? "" : String(body.venture).trim();
    const ventureId = v ? (ventureRow(v)?.id ?? null) : null;
    if (v && !ventureId) return c.json({ error: `There is no venture called “${v}”.` }, 400);
    sets.push("venture = ?");
    args.push(ventureId);
  }

  if (!sets.length)
    return c.json({ error: "Nothing to change. Send to, subject, body or venture." }, 400);

  /* AN EDIT UNAPPROVES — see the file header. Also clears a previous failure's
     error, because the error described the words that are no longer there. */
  const unapproved = r.status === "approved" || r.status === "failed";
  if (unapproved) {
    sets.push("status = 'draft'", "approved_at = NULL", "approved_content = NULL", "error = NULL");
  }
  const changed = db.prepare(`UPDATE mailflow_outbox SET ${sets.join(", ")}, approved_content = NULL, approved_at = NULL, status = 'draft' WHERE id = ? AND status NOT IN ('sent','sending','uncertain')`).run(...args, id);
  if (!changed.changes) return c.json({ error: "Delivery has started; this message cannot be edited." }, 409);

  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  return c.json({
    item: shape(row(id)!, names),
    note: unapproved
      ? "Edited, and returned to draft: the approval was of the previous wording."
      : "Edited. Still a draft.",
  });
});

/* ----------------------------------------------------------------- approve */

outboxRoutes.post("/:id/approve", refuseSkillsProxy, requireOwner, async (c) => {
  const request = await c.req.json().catch(() => null) as { approvalKey?: string } | null;
  const id = Number(c.req.param("id"));
  const r = row(id);
  if (!r) return c.json({ error: `There is no outbox row ${id}.` }, 404);
  if (["sent", "sending", "uncertain"].includes(r.status)) return c.json({ error: `Row ${id} has already been sent.` }, 409);
  if (r.status === "dismissed")
    return c.json(
      { error: `Row ${id} was dismissed. Re-approving a dismissed draft is not a thing this queue does; write a new one.` },
      409,
    );
  if (r.status === "approved")
    return c.json({ error: `Row ${id} is already approved and waiting to be sent.` }, 409);

  if (request?.approvalKey !== approvalKey(r)) return c.json({ error: "This draft changed since you opened it. Refresh and review the latest preview." }, 409);
  try { approveDraft(id); } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  return c.json({
    item: shape(row(id)!, names),
    note: "Approved. STILL NOT SENT — approving and sending are two presses on purpose.",
  });
});

/* -------------------------------------------------------------------- send */

outboxRoutes.post("/:id/send", refuseSkillsProxy, requireOwner, async (c) => {
  const request = await c.req.json().catch(() => null) as { approvalKey?: string } | null;
  const id = Number(c.req.param("id"));
  const r = row(id);
  if (!r) return c.json({ error: `There is no outbox row ${id}.` }, 404);

  /* THE ONE THING THE APPROVAL SETTING CHANGES. With it off, the owner's own
     Send is allowed to approve on the way past — one press instead of two, for
     a person who is already reading the draft. It changes nothing about the
     agent: the skill has no send action and this route refuses the proxy's
     header whatever the setting says. */
  if (request?.approvalKey !== approvalKey(r)) return c.json({ error: "This draft changed. Refresh and review it before sending." }, 409);
  if (r.status === "draft" && !settings().requireApproval) approveDraft(id);

  try {
    const sent = await sendApproved(id);
    const names = new Map(ventureRows().map((v) => [v.id, v.name]));
    /* THE CONFIRMATION NAMES THE DOOR IT ACTUALLY LEFT BY. It used to say
       "Gmail's own message id … it is in the Sent folder" for every send,
       including a Resend one, where both halves are false — there is no copy in
       anybody's Sent folder and the id is Resend's. The row already knows
       (`sent_via`), so the sentence reads it rather than assuming. */
    return c.json({
      item: shape(sent, names),
      note:
        sent.sent_via === "resend"
          ? `Sent through Resend from ${shape(sent, names).from}. Resend's own id is ${sent.message_id}; there is no copy in a Gmail Sent folder, and the delivery event is read back onto the card.`
          : `Sent. Gmail's own message id is ${sent.message_id}; it is in the Sent folder.`,
    });
  } catch (err) {
    if (err instanceof SendRefused) return c.json({ error: err.message }, err.status as 409);
    if (err instanceof NoMailbox) return c.json({ error: err.message }, 404);
    if (err instanceof GmailError) return c.json({ error: err.body }, 502);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/* ----------------------------------------------------------------- dismiss */

outboxRoutes.post("/:id/dismiss", (c) => {
  const id = Number(c.req.param("id"));
  const r = row(id);
  if (!r) return c.json({ error: `There is no outbox row ${id}.` }, 404);
  if (["sent", "sending", "uncertain"].includes(r.status))
    return c.json({ error: `Row ${id} has been sent. There is nothing to dismiss.` }, 409);

  db.prepare("UPDATE mailflow_outbox SET status = 'dismissed', approved_at = NULL WHERE id = ?").run(id);
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  return c.json({
    item: shape(row(id)!, names),
    note:
      "Dismissed. THE ROW STAYS, and it still counts against the per-address " +
      "floor — a dismissal is “not this person, not now”, so nothing will " +
      `offer to write to ${r.to_address} again for ${settings().gapDays} days.`,
  });
});

outboxRoutes.post("/:id/resolve", requireOwner, async c => {
  const body = await c.req.json().catch(() => null) as { checkedNotSent?: boolean } | null;
  if (body?.checkedNotSent !== true) return c.json({ error: "Check Gmail Sent and confirm that this message was not sent before unlocking it." }, 400);
  const result = db.prepare("UPDATE mailflow_outbox SET status = 'failed', approved_at = NULL, approved_content = NULL, delivery_checked_at = ?, error = 'Owner checked Gmail Sent and confirmed no delivery. Review and approve before retrying.' WHERE id = ? AND status = 'uncertain'").run(now(), Number(c.req.param("id")));
  if (!result.changes) return c.json({ error: "Only an uncertain delivery can be resolved." }, 409);
  return c.json({ item: shape(row(Number(c.req.param("id")))!, new Map(ventureRows().map(v => [v.id, v.name]))) });
});
