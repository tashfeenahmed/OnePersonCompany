/**
 * THE FACT PACKET — everything a draft to one person is allowed to say, and
 * where each piece of it was read.
 *
 * EVERY GATHERER READS A ROW THIS BOX ALREADY WROTE. Nothing here calls a
 * vendor, nothing here calls a model, and nothing here computes a figure that
 * is not already computed somewhere with its own honesty rules. The packet is
 * an assembly of existing measurements, each carrying the sentence that says
 * which table it came from and when that table observed it.
 *
 * WHAT IS DELIBERATELY NOT IN THE PACKET.
 *
 *   ANYTHING FROM THE BODY OF ANYBODY'S MAIL. `people/` reads Gmail with
 *   `format=metadata` and stores no subject, snippet or body; the triage table
 *   next door stores a judgement and never a line of the thread. So the packet
 *   can say "you two normally trade mail about every nine days and it has been
 *   thirty-one". It cannot say what either of you said, and a draft that
 *   referred to the contents of a conversation would be a draft inventing it.
 *
 *   ANYTHING ABOUT WHAT THEY DID INSIDE A PRODUCT. The users contract carries a
 *   signup date, a plan, a paid flag and a last-seen. It carries no sessions
 *   and no feature usage, so "I saw you tried the export" is not a sentence
 *   this area can produce, and the packet says so in its own `cannot_say` row
 *   rather than leaving the model to discover the silence.
 *
 *   A STRIPE FIGURE ABOUT THIS PERSON. Stripe's collector on this box stores no
 *   email address at all — see providers/stripe.ts, whose subscription rows
 *   carry an id, a status and money and nothing that names a human. There is
 *   therefore no join from an address to a Stripe customer here, and the packet
 *   does not pretend there is: whether somebody is paying is answered by the
 *   product's own users document or by nothing.
 *
 * THE ADDRESS → PRODUCT USER JOIN, and why it is honest. `activity_users` holds
 * a SALTED HASH of each address and never the address itself, deliberately, and
 * there is no route on this box that takes an address and returns a user. That
 * is not an obstacle here: the planner is already holding the address, so it
 * hashes it with the same install salt and looks the row up by hash. Nothing is
 * decrypted and nothing is widened — the capability that was declined (turning
 * a hash back into a person) is still declined; this is the direction that
 * always worked.
 *
 * PRODUCT KNOWLEDGE IS OPTIONAL AND GUARDED. If another area publishes an
 * evidence-tiered product knowledge store at `integrations/knowledge/` with a
 * `factsForPrompt` export, its rows join the packet. The import is dynamic and
 * inside a try/catch because that area may not exist on this install and a
 * missing directory must be one absent section of the packet rather than a
 * server that will not start.
 */
import { db, ventureRowById } from "../../db.ts";
import { lookupHash } from "../activity/users.ts";
import type { Fact } from "./validate.ts";

export type { Fact };

/** How many facts of one kind are gathered. A packet is READ BY A PERSON before
 *  a draft is approved; forty rows of the same shape is a packet nobody reads,
 *  and an unread packet is the same as no packet. */
const PER_KIND = 6;

const iso = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const dayCount = (fromIso: string | null, nowMs: number): number | null => {
  if (!fromIso) return null;
  const at = Date.parse(fromIso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 86_400_000));
};

/* ------------------------------------------------------------ the contact */

type ContactRow = {
  mailbox: string;
  address: string;
  name: string;
  domain: string;
  first_seen: string | null;
  last_received: string | null;
  last_sent: string | null;
  received: number;
  sent: number;
  threads: number;
  scanned_at: string;
};

export function contactFor(address: string): ContactRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM people_contacts WHERE address = ?
          ORDER BY (received + sent) DESC LIMIT 1`,
      )
      .get(address.trim().toLowerCase()) as ContactRow | undefined) ?? null
  );
}

/**
 * The correspondence, as people/ measured it.
 *
 * `received` and `sent` are PER PERSON — a message addressed to five people
 * counts once for each of the five — so they are published here with that unit
 * spelled out and they must never be summed across facts to make "mail sent".
 * The packet's job is to carry the caveat with the number rather than to hope
 * the reader remembers it.
 */
function contactFacts(row: ContactRow, nowMs: number): Fact[] {
  const src = `people_contacts (mailbox ${row.mailbox})`;
  const at = iso(row.scanned_at);
  const out: Fact[] = [];
  if (row.name)
    out.push({ key: "person.name", value: row.name, source: `${src} — the display name they last signed a message with`, observed_at: at });
  out.push({ key: "person.address", value: row.address, source: src, observed_at: at });
  if (row.domain)
    out.push({ key: "person.domain", value: row.domain, source: src, observed_at: at });
  if (row.first_seen)
    out.push({ key: "person.first_seen", value: row.first_seen, source: `${src} — the oldest message in the scanned window`, observed_at: at });
  if (row.last_received)
    out.push({ key: "person.last_message_from_them", value: row.last_received, source: src, observed_at: at });
  if (row.last_sent)
    out.push({ key: "person.last_message_to_them", value: row.last_sent, source: src, observed_at: at });
  const quiet = dayCount(
    [row.last_received, row.last_sent].filter(Boolean).sort().at(-1) ?? null,
    nowMs,
  );
  if (quiet !== null)
    out.push({ key: "person.days_since_any_message", value: quiet, unit: "days", source: `${src} — measured from the later of the two dates above`, observed_at: at });
  out.push({ key: "person.messages_from_them", value: row.received, unit: "messages in the scanned window", source: `${src} — per person, never summed across people`, observed_at: at });
  out.push({ key: "person.messages_to_them", value: row.sent, unit: "messages in the scanned window", source: `${src} — per person, never summed across people`, observed_at: at });
  return out;
}

/* ------------------------------------------------------- the commitments */

/**
 * What the OWNER promised this person, in his own words.
 *
 * `sentence` is the verbatim line from his own sent mail, verified in the
 * message by people/commitments.ts; `what` is a model's one-line summary of it.
 * Both go in the packet, and the source says which is which — a draft that
 * quotes the summary as if it were the promise has changed what he said.
 */
function commitmentFacts(address: string, nowMs: number): Fact[] {
  const rows = db
    .prepare(
      `SELECT what, sentence, due, due_text, sent_at FROM people_commitments
        WHERE lower(to_address) = ? AND status = 'open'
        ORDER BY COALESCE(due, sent_at) LIMIT ?`,
    )
    .all(address.trim().toLowerCase(), PER_KIND) as unknown as {
    what: string;
    sentence: string;
    due: string | null;
    due_text: string | null;
    sent_at: string | null;
  }[];
  const out: Fact[] = [];
  rows.forEach((r, n) => {
    out.push({
      key: `commitment.${n + 1}.your_words`,
      value: r.sentence,
      source: "people_commitments — the owner's own sentence, verified verbatim in the message it was in",
      observed_at: iso(r.sent_at),
    });
    if (r.due)
      out.push({
        key: `commitment.${n + 1}.due`,
        value: r.due,
        source: `people_commitments — this box's reading of the words “${r.due_text ?? ""}”, which is a derivation and not a date anybody typed`,
        observed_at: iso(r.sent_at),
      });
  });
  void nowMs;
  return out;
}

/* ------------------------------------------------------------ last thread */

/**
 * The last thing this box WROTE to them, out of its own outbox.
 *
 * Not the last thing they wrote: no subject or body of incoming mail is stored
 * anywhere on this server, so there is nothing honest to put here from that
 * side. What the outbox holds is a document this box composed, which it is
 * entitled to quote back to itself.
 */
function outboxFacts(address: string): Fact[] {
  const rows = db
    .prepare(
      `SELECT subject, status, created_at, sent_at FROM mailflow_outbox
        WHERE lower(to_address) = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(address.trim().toLowerCase(), 2) as unknown as {
    subject: string;
    status: string;
    created_at: string;
    sent_at: string | null;
  }[];
  return rows.flatMap((r, n) => {
    const when = r.sent_at ?? r.created_at;
    const what = r.sent_at ? "was sent to them" : `was written and is ${r.status}`;
    return [
      {
        key: `outbox.${n + 1}.subject`,
        value: r.subject,
        source: `mailflow_outbox — a message this dashboard ${what}`,
        observed_at: iso(when),
      } satisfies Fact,
    ];
  });
}

/* ---------------------------------------------------------- the venture */

function ventureFacts(ventureId: string | null): Fact[] {
  if (!ventureId) return [];
  const v = ventureRowById(ventureId);
  if (!v) return [];
  const src = "the ventures table — what the owner typed about his own business";
  const out: Fact[] = [
    { key: "venture.name", value: v.name, source: src, observed_at: iso(v.updated_at) },
    { key: "venture.stage", value: v.stage, source: `${src}; one of idea, pre-launch, launched`, observed_at: iso(v.updated_at) },
  ];
  if (v.website) out.push({ key: "venture.website", value: v.website, source: src, observed_at: iso(v.updated_at) });
  else if (v.host) out.push({ key: "venture.host", value: v.host, source: src, observed_at: iso(v.updated_at) });
  if (v.description)
    out.push({
      key: "venture.description",
      value: v.description.slice(0, 600),
      source: src,
      observed_at: iso(v.updated_at),
    });
  return out;
}

/* ------------------------------------------------- the product's own user */

export type ProductUser = {
  product: string;
  createdAt: string;
  plan: string | null;
  paid: number | null;
  lastSeen: string | null;
  seenAt: string;
};

/**
 * The product user behind an address, or null.
 *
 * NULL HAS TWO MEANINGS AND THE CALLER IS TOLD WHICH: `reason` is
 * "no product publishes a users document here" when nothing is connected, and
 * "no product's users document carries this address" when one is. The first is
 * a gap in what this box can see; the second is a fact about the person. A
 * caller that folded them together would report a stranger as a churned
 * customer.
 */
export function productUser(address: string): { user: ProductUser | null; reason: string | null } {
  /* READ-ONLY BY CONSTRUCTION. `lookupHash` returns null rather than minting a
     salt, which is what keeps the two nulls above distinguishable: a salt
     minted here would make every address hash to something no row can carry
     and turn "nothing is connected" into "this person is a stranger". */
  const hash = lookupHash(address);
  if (hash === null)
    return {
      user: null,
      reason:
        "no product on this install publishes a users document (the `users` plugin is not connected), so nothing here knows who signed up or who is paying",
    };
  const row = db
    .prepare(
      `SELECT product, created_at, plan, paid, last_seen, seen_at FROM activity_users
        WHERE email_hash = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(hash) as
    | { product: string; created_at: string; plan: string | null; paid: number | null; last_seen: string | null; seen_at: string }
    | undefined;
  if (!row)
    return { user: null, reason: "no connected product's users document carries this address" };
  return {
    user: {
      product: row.product,
      createdAt: row.created_at,
      plan: row.plan,
      paid: row.paid,
      lastSeen: row.last_seen,
      seenAt: row.seen_at,
    },
    reason: null,
  };
}

function productFacts(address: string, nowMs: number): Fact[] {
  const { user, reason } = productUser(address);
  if (!user) return reason ? [{ key: "product.unknown", value: reason, source: "activity_users", observed_at: null }] : [];
  const src = `activity_users — the ${user.product} product's own users document, matched on a salted hash of the address`;
  const out: Fact[] = [
    { key: "product.name", value: user.product, source: src, observed_at: iso(user.seenAt) },
    { key: "product.signed_up", value: user.createdAt, source: src, observed_at: iso(user.seenAt) },
  ];
  const age = dayCount(user.createdAt, nowMs);
  if (age !== null)
    out.push({ key: "product.days_since_signup", value: age, unit: "days", source: `${src}, measured against now`, observed_at: iso(user.seenAt) });
  if (user.plan) out.push({ key: "product.plan", value: user.plan, source: src, observed_at: iso(user.seenAt) });
  out.push({
    key: "product.paying",
    value: user.paid === null ? "the product did not say" : user.paid ? "yes" : "no",
    source: `${src}; “the product did not say” is not “no”`,
    observed_at: iso(user.seenAt),
  });
  if (user.lastSeen)
    out.push({ key: "product.last_seen", value: user.lastSeen, source: src, observed_at: iso(user.seenAt) });
  return out;
}

/* ------------------------------------------------- optional product knowledge */

/**
 * Product knowledge, if another area publishes any.
 *
 * DYNAMIC AND GUARDED, and both halves matter. Dynamic because
 * `integrations/knowledge/` may not exist on this install — it is another
 * area's build and this one must not depend on it landing. Guarded because a
 * module that exists and throws on import (a half-finished edit, on a server
 * that restarts on every save) must cost this area one absent section of a
 * packet rather than a draft that could not be prepared at all.
 */
export async function knowledgeFacts(ventureId: string | null): Promise<Fact[]> {
  if (!ventureId) return [];
  try {
    const mod = (await import("../knowledge/store.ts")) as {
      factsForPrompt?: (venture: string, kinds?: unknown, maxChars?: number) => string | null;
      facts?: (q: { ventureId?: string; limit?: number }) => unknown[];
    };
    if (typeof mod.factsForPrompt !== "function") return [];
    /* THE PRESENCE CHECK IS `factsForPrompt` AND THE ROWS COME FROM `facts`.
       The prompt block is one string with the tiers and dates folded into its
       prose, which is right for a chat turn and wrong for a packet whose whole
       point is one source per row. So the block's existence is what says "this
       area is here and has something for this venture", and the structured
       rows are what is actually carried — with the block itself as the
       fallback when only it is exported. */
    const block = mod.factsForPrompt(ventureId, null, 1200);
    if (!block) return [];
    if (typeof mod.facts !== "function")
      return [
        {
          key: "knowledge.block",
          value: block.slice(0, 1500),
          source: "integrations/knowledge — the product knowledge block, tiers and dates inside it",
          observed_at: null,
        },
      ];
    const rows = mod.facts({ ventureId, limit: 200 }) as {
      kind?: string;
      statement?: string;
      tier?: string;
      observedAt?: string;
      stale?: boolean;
      source?: { type?: string; ref?: string };
    }[];
    return rows
      .filter((f) => typeof f.statement === "string" && f.tier !== "proposed")
      .slice(0, PER_KIND)
      .map((f, n) => ({
        key: `knowledge.${f.kind ?? "fact"}.${n + 1}`,
        value: f.statement!.slice(0, 400),
        source:
          `integrations/knowledge — tier “${f.tier ?? "unknown"}”` +
          (f.source?.type ? `, read from ${f.source.type}${f.source.ref ? ` ${f.source.ref}` : ""}` : "") +
          (f.stale ? "; this fact is past its refresh date and may have moved" : ""),
        observed_at: typeof f.observedAt === "string" ? f.observedAt : null,
      }));
  } catch {
    /* No such area on this install, or it is mid-save. Either way: no rows. A
       missing product-knowledge store must cost this packet one absent section
       and never a draft that could not be prepared. */
    return [];
  }
}

/* ------------------------------------------------------------ the packet */

export type Packet = {
  facts: Fact[];
  /** The sentences the wording is told it MAY NOT say, because nothing here
   *  measured them. Published beside the facts so the owner sees the shape of
   *  the silence rather than having to notice it. */
  cannotSay: string[];
};

/**
 * The whole packet for one address.
 *
 * Order is stable — person, commitments, outbox history, venture, product,
 * knowledge — so two packets for the same person read the same way twice, and
 * a diff between them is a change in the data rather than in the assembly.
 */
export async function packetFor(
  address: string,
  ventureId: string | null,
  nowMs = Date.now(),
): Promise<Packet> {
  const contact = contactFor(address);
  const facts: Fact[] = [
    ...(contact
      ? contactFacts(contact, nowMs)
      : [
          {
            key: "person.address",
            value: address.trim().toLowerCase(),
            source: "the enrolment or the caller — this address is not in people_contacts, so nothing here has measured a correspondence with them",
            observed_at: null,
          } satisfies Fact,
        ]),
    ...commitmentFacts(address, nowMs),
    ...outboxFacts(address),
    ...ventureFacts(ventureId),
    ...productFacts(address, nowMs),
    ...(await knowledgeFacts(ventureId)),
  ];

  const cannotSay = [
    "What either of you actually WROTE. No subject, snippet or body of anybody's mail is stored on this box, so nothing may be said about the contents of a conversation.",
    "What they did inside a product. There are no sessions, no feature usage and no in-app events here — only that an account exists, when it was made, and what the product says about its plan.",
    "Anything about their payments. This box stores no email address against a Stripe customer, so no charge, refund, invoice or renewal date can be attributed to this person.",
  ];
  if (!contact)
    cannotSay.push(
      "Any history of correspondence. This address is not in people_contacts, so how often you two write and when you last did are unmeasured here.",
    );

  return { facts, cannotSay };
}
