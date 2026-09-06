/**
 * THE RECOVERY QUEUE — the one list on this box sorted by a deadline rather
 * than by a figure.
 *
 * Every other revenue document here answers "how is it going". This one
 * answers "what runs out first", which is a different question with a
 * different failure mode: a queue that is merely wrong is annoying, and a
 * queue that is silently INCOMPLETE is worse than none, because the whole
 * value of it is that nothing falls off the end. So the document says how
 * far its own inputs reach and when they were last read, on every response.
 *
 * THE ADDRESS RULE, ENFORCED AT THE EDGE. `contact.address` is null unless
 * `customers.contact-access` is on AT READ TIME. The column may still hold a
 * value from a period when the setting was on — the next pass nulls it — and
 * this route does not publish one either way while the setting is off. The
 * domain and the fact that a hash exists are always published: they say a
 * person is identifiable without identifying them.
 *
 * PREPARE WRITES A DRAFT AND NOTHING ELSE. It composes from the case's own
 * fields (customers/draft.ts enumerates which), inserts a row into
 * mailflow_outbox with status `draft`, and links the outbox id back onto the
 * case. It cannot approve and it cannot send: the outbox's own header lists
 * the four structural properties that make `sendApproved` the only door out,
 * and this route is not one of the things allowed near it. The floors that
 * queue keeps — the per-address interval and the daily cap — are checked HERE
 * too, before anything is written, because a draft that could never be sent
 * is a row somebody has to clean up.
 */
import { Hono } from "hono";
import { db, now, ventureRow, ventureRows } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import {
  firstGmailAccount,
  floorBlocker,
  settings as outboxSettings,
} from "../mailflow/outbox.ts";
import { compose, whyNoDraft } from "./draft.ts";
import {
  CASE_KINDS,
  cases,
  caseRow,
  factsKey,
  LIVE_STATUSES,
  linkDraft,
  setCaseStatus,
  settings,
  type CaseKind,
  type CaseRecord,
  type CaseStatus,
} from "./store.ts";

export const recoveryRoutes = new Hono();

const MAX_NOTE = 400;

/** When the queue's own inputs were last read, so a reader never mistakes a
 *  quiet list for a stale one. */
function lastPass(): { at: string | null; ok: boolean | null; error: string | null } {
  const r = db
    .prepare(
      "SELECT finished_at, ok, error FROM runs WHERE plugin_id = 'customers' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get() as { finished_at: string; ok: number; error: string | null } | undefined;
  return r
    ? { at: r.finished_at, ok: r.ok === 1, error: r.error }
    : { at: null, ok: null, error: null };
}

function shape(r: CaseRecord, contactAccess: boolean, names: Map<string, string>) {
  let context: unknown = null;
  try {
    context = JSON.parse(r.context) as unknown;
  } catch {
    context = { unparsed: r.context };
  }
  const deadlineMs = r.deadline ? Date.parse(r.deadline) : Number.NaN;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    account: r.account_label,
    venture: r.venture_id,
    ventureName: r.venture_id ? (names.get(r.venture_id) ?? null) : null,
    /** The Stripe object this is about: sub_… , in_… or du_… . */
    subject: r.subject_ref,
    customer: r.customer,
    amount: r.amount,
    currency: r.currency,
    deadline: r.deadline,
    /** Which date that is, in Stripe's own terms. */
    deadlineIs: r.deadline_is,
    /** Whole days from now, negative once it has passed. Null where there is
     *  no deadline, which is a real state and never "overdue". */
    daysLeft: Number.isNaN(deadlineMs)
      ? null
      : Math.ceil((deadlineMs - Date.now()) / 86_400_000),
    contact: {
      /** True once an address has been read and hashed for this case. */
      known: Boolean(r.email_hash),
      domain: r.email_domain,
      /** NULL while contact access is off. Never an empty string, and never a
       *  masked form pretending to be an address. */
      address: contactAccess ? r.email_plain : null,
      why: contactAccess
        ? "customers.contact-access is on, so the address is published."
        : "customers.contact-access is off. Addresses are stored only as a salted hash and a domain.",
    },
    context,
    /** The digest of the facts. A draft written against a different one was
     *  written about a case that has since moved. */
    factsKey: factsKey(context),
    resolution: r.resolution,
    outboxId: r.outbox_id,
    openedAt: r.opened_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

/* ------------------------------------------------------------------ queue */

recoveryRoutes.get("/", (c) => {
  const s = settings();
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));

  const statusParam = (c.req.query("status") ?? "").trim();
  const statuses: CaseStatus[] =
    statusParam === "all"
      ? ["open", "drafted", "sent", "resolved", "dismissed"]
      : statusParam
        ? (statusParam.split(",").map((x) => x.trim()) as CaseStatus[])
        : LIVE_STATUSES;

  const kindParam = (c.req.query("kind") ?? "").trim();
  const kinds = kindParam
    ? (kindParam.split(",").map((x) => x.trim()).filter((k) =>
        (CASE_KINDS as readonly string[]).includes(k),
      ) as CaseKind[])
    : undefined;

  const ventureKey = (c.req.query("venture") ?? "").trim();
  const venture = ventureKey ? ventureRow(ventureKey) : undefined;
  if (ventureKey && !venture)
    return c.json({ error: `There is no venture called “${ventureKey}”.` }, 404);

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
  const rows = cases({ statuses, kinds, venture: venture?.id, limit });
  const live = cases({ statuses: LIVE_STATUSES, limit: 1000 });
  const pass = lastPass();

  const byKind = Object.fromEntries(
    CASE_KINDS.map((k) => [k, live.filter((r) => r.kind === k).length]),
  );

  return c.json({
    filter: {
      statuses,
      kinds: kinds ?? null,
      venture: venture ? { id: venture.id, name: venture.name } : null,
      limit,
    },
    counts: {
      open: live.filter((r) => r.status === "open").length,
      drafted: live.filter((r) => r.status === "drafted").length,
      sent: live.filter((r) => r.status === "sent").length,
      byKind,
      /** Live cases whose deadline has already passed. They stay in the queue:
       *  a missed deadline is not a resolved case. */
      overdue: live.filter(
        (r) => r.deadline && Date.parse(r.deadline) < Date.now(),
      ).length,
      /** Live cases with no deadline at all. Not urgent, not finished. */
      undated: live.filter((r) => !r.deadline).length,
    },
    items: rows.map((r) => shape(r, s.contactAccess, names)),
    contactAccess: s.contactAccess,
    /** When the inputs behind this list were last read. A queue is only as
     *  complete as its last pass and this is how a reader checks. */
    lastPass: pass,
    note:
      "Sorted by deadline, soonest first; cases with no deadline sit under the dated ones. " +
      "A case is derived from Stripe on every pass and closes by itself when Stripe shows " +
      "it fixed — see `resolution`. Nothing here has been sent to anybody.",
    cannot: [
      "change anything at Stripe — this integration is GET-only by construction, so no case here can be refunded, retried, cancelled or re-priced from this box.",
      "tell you whether a customer will pay. `deadline` on a payment_failed case is when STRIPE will retry the card, not a prediction.",
      "reach a customer for a dispute case. The counterparty is a bank and the remedy is evidence uploaded at Stripe before the cut-off.",
    ],
  });
});

recoveryRoutes.get("/:id", (c) => {
  const row = caseRow(c.req.param("id"));
  if (!row) return c.json({ error: `There is no case ${c.req.param("id")}.` }, 404);
  const s = settings();
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const draft = compose(row);
  return c.json({
    item: shape(row, s.contactAccess, names),
    /** What PREPARE would write, without writing it. Published so the owner
     *  and an agent can read the words before a row exists. */
    preview: draft
      ? { subject: draft.subject, body: draft.body, usedFacts: draft.usedFacts }
      : { subject: null, body: null, why: whyNoDraft(row) },
  });
});

/* ---------------------------------------------------------------- prepare */

recoveryRoutes.post("/:id/prepare", async (c) => {
  const id = c.req.param("id");
  const row = caseRow(id);
  if (!row) return c.json({ error: `There is no case ${id}.` }, 404);
  if (!LIVE_STATUSES.includes(row.status))
    return c.json(
      { error: `Case ${id} is ${row.status}. A resolved or dismissed case is not drafted for.` },
      409,
    );
  if (row.outbox_id)
    return c.json(
      {
        error: `Case ${id} already has outbox draft ${row.outbox_id}. Edit it there, or dismiss it, rather than writing a second message to the same person.`,
        outboxId: row.outbox_id,
      },
      409,
    );

  const s = settings();
  if (!s.contactAccess)
    return c.json(
      {
        error:
          "Contact access is off, so this box holds no address to write to — only a salted " +
          "hash. Turn on customers.contact-access in the Customers integration settings if " +
          "you want the recovery queue to be able to address a follow-up.",
      },
      409,
    );

  const to = (row.email_plain ?? "").trim();
  if (!to)
    return c.json(
      {
        error:
          "No address has been read for this case yet. The pass fetches a bounded number of " +
          "customers per run; try again after the next collection, or check that the case " +
          "carries a Stripe customer id at all.",
      },
      409,
    );

  const composed = compose(row);
  if (!composed) return c.json({ error: whyNoDraft(row) }, 409);

  const accountId = firstGmailAccount();
  if (!accountId)
    return c.json(
      { error: "No Gmail account is connected, so there is no mailbox to write from." },
      404,
    );
  if (!accounts.list("gmail").some((a) => a.id === accountId && a.connected))
    return c.json({ error: "The Gmail account this would be written from is not connected." }, 409);

  /* THE OUTBOX'S OWN FLOOR, CHECKED BEFORE ANYTHING IS WRITTEN. Its route
     would refuse the row anyway; refusing here means the case is not left
     pointing at a draft that was never created. */
  const os = outboxSettings();
  const blocker = floorBlocker(to, os.gapDays);
  if (blocker)
    return c.json(
      {
        error:
          `There is already a message to this address from ${blocker.created_at.slice(0, 10)} ` +
          `(${blocker.status}), inside the ${os.gapDays}-day floor the outbox keeps. Dismissed ` +
          "rows count. Nothing was written.",
        blocker: { id: blocker.id, status: blocker.status, createdAt: blocker.created_at },
      },
      409,
    );

  const info = db
    .prepare(
      `INSERT INTO mailflow_outbox
         (account_id, to_address, subject, body, in_reply_to, venture, status, created_by, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'draft', ?, ?)`,
    )
    .run(
      accountId,
      to,
      composed.subject,
      composed.body,
      row.venture_id,
      /* WHO WROTE IT. The words are this file's template rather than a
         person's, and "agent" is the outbox's word for that. It is a record,
         not a permission: both wait for the same button. */
      "agent",
      now(),
    );

  const outboxId = Number(info.lastInsertRowid);
  linkDraft(id, outboxId);

  return c.json(
    {
      outboxId,
      case: shape(caseRow(id)!, s.contactAccess, new Map(ventureRows().map((v) => [v.id, v.name]))),
      draft: { subject: composed.subject, body: composed.body, usedFacts: composed.usedFacts },
      note:
        "Written into the Outbox as a DRAFT. It will stay one until you approve and send it " +
        "there. Every sentence in it was assembled from the fields listed in usedFacts; " +
        "nothing about a refund, a charge or a discount is claimed anywhere in it.",
    },
    201,
  );
});

/* ------------------------------------------------------- resolve / dismiss */

async function note(c: { req: { json: () => Promise<unknown> } }): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as { note?: string } | null;
  const text = String(body?.note ?? "").trim();
  if (!text) return null;
  return text.slice(0, MAX_NOTE);
}

recoveryRoutes.post("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const row = caseRow(id);
  if (!row) return c.json({ error: `There is no case ${id}.` }, 404);
  if (!LIVE_STATUSES.includes(row.status))
    return c.json({ error: `Case ${id} is already ${row.status}.` }, 409);
  const text = await note(c);
  const updated = setCaseStatus(
    id,
    "resolved",
    text ?? "Closed by hand. No reason was given.",
  );
  return c.json({
    item: shape(updated!, settings().contactAccess, new Map(ventureRows().map((v) => [v.id, v.name]))),
    note:
      "Closed. The pass will not re-open it, and nothing at Stripe changed — resolving a case " +
      "is a note about this queue, not an action on the account.",
  });
});

recoveryRoutes.post("/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  const row = caseRow(id);
  if (!row) return c.json({ error: `There is no case ${id}.` }, 404);
  if (!LIVE_STATUSES.includes(row.status))
    return c.json({ error: `Case ${id} is already ${row.status}.` }, 409);
  const text = await note(c);
  const updated = setCaseStatus(id, "dismissed", text ?? "Dismissed by hand.");
  return c.json({
    item: shape(updated!, settings().contactAccess, new Map(ventureRows().map((v) => [v.id, v.name]))),
    note:
      "Dismissed. A dismissal is permanent for this case — the pass never re-opens one, which " +
      "is the whole reason it is a different word from resolved.",
  });
});
