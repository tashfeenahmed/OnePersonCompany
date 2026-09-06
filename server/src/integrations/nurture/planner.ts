/**
 * THE RECIPIENT PLANNER — plain code, no model, and every decision it makes is
 * one somebody can argue with.
 *
 * A model that can write the email can also decide to write it to the wrong
 * person, about the wrong business, from the wrong address, for a reason it
 * invented on the spot. So none of those four is its decision. This file
 * produces a `DraftPlan` — who, why now, which venture, which identity — out of
 * rows this box already holds, and the plan is stored on the draft beside the
 * fact packet so that "why did this get written" has an answer on the page.
 *
 * WHY NOW IS A SENTENCE AND NOT A SCORE. "Step 2 of Welcome, due 2026-09-13,
 * seven days after they were enrolled on 2026-09-06" is checkable. A number
 * between zero and one is not, and a queue whose reasons cannot be checked is a
 * queue whose reasons stop being read.
 *
 * THE PLANNER REFUSES rather than guessing, in four cases, and each refusal
 * names the fix:
 *
 *   * an address that is not an address;
 *   * an address that has opted out — checked here as well as in the engine,
 *     because a manual draft goes through this file and not through the engine;
 *   * a venture id that does not exist;
 *   * no identity: no default for the venture and none named. A From line
 *     picked at random is a From line nobody chose, and Gmail or Resend would
 *     refuse it later and less clearly.
 */
import { db, ventureRowById } from "../../db.ts";
import { validAddress } from "../mailflow/gmail-send.ts";
import { contactFor, packetFor, type Fact } from "./facts.ts";
import {
  defaultIdentity,
  identityRow,
  transportFor,
  type IdentityRow,
  type Transport,
} from "./identities.ts";

export class PlanRefused extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "PlanRefused";
    this.status = status;
  }
}

export type DraftPlan = {
  address: string;
  /** The display name people_contacts last saw them sign with, or null. NEVER
   *  derived from the address: a "Jane Smith" invented out of `jane.smith@` is
   *  a name this dashboard made up. */
  name: string | null;
  venture: string | null;
  ventureName: string | null;
  identityId: number;
  /** The From line as it will go on the wire, and the transport that will carry
   *  it. Resolved at PLANNING time so a refusal ("that Resend key is for
   *  another domain") arrives while the draft is being written rather than at
   *  the moment somebody presses Send. */
  from: string;
  via: "gmail" | "resend";
  /** What this message is for, in one line. The wording model's whole brief. */
  purpose: string;
  /** Why this person, and why today. Checkable sentence, not a score. */
  whyNow: string;
  origin: { kind: "sequence" | "manual" | "reply"; detail: string };
  sequenceId: number | null;
  /** 1-based, for a person reading the card. */
  step: number | null;
  steps: number | null;
  /** A Gmail THREAD id this replies into, or null. */
  threadId: string | null;
};

export function optedOut(address: string): { at: string; reason: string | null } | null {
  return (
    (db
      .prepare("SELECT at, reason FROM nurture_optouts WHERE address = ?")
      .get(address.trim().toLowerCase()) as { at: string; reason: string | null } | undefined) ?? null
  );
}

export type PlanInput = {
  address: string;
  venture?: string | null;
  identityId?: number | null;
  purpose: string;
  whyNow: string;
  origin: DraftPlan["origin"];
  sequenceId?: number | null;
  step?: number | null;
  steps?: number | null;
  threadId?: string | null;
};

/**
 * The plan, and the transport it resolves to.
 *
 * The transport comes back beside the plan rather than being re-derived later,
 * because the two must agree: the plan's `from` is what the owner reads on the
 * card, and the transport is what actually carries it. Deriving them twice is
 * how they come apart.
 */
export function plan(input: PlanInput): { plan: DraftPlan; identity: IdentityRow; transport: Transport } {
  const address = input.address.trim().toLowerCase();
  if (!validAddress(address))
    throw new PlanRefused(`“${input.address}” is not an email address, so there is nobody to write to.`, 400);

  const out = optedOut(address);
  if (out)
    throw new PlanRefused(
      `${address} asked not to be written to again (recorded ${out.at.slice(0, 10)}${out.reason ? `: ${out.reason}` : ""}). Nothing was written.`,
    );

  const ventureId = input.venture?.trim() || null;
  const venture = ventureId ? ventureRowById(ventureId) : null;
  if (ventureId && !venture) throw new PlanRefused(`There is no venture “${ventureId}”.`, 400);

  const identity = input.identityId ? identityRow(input.identityId) : defaultIdentity(ventureId);
  if (!identity)
    throw new PlanRefused(
      ventureId
        ? `${venture!.name} has no sending identity, so there is no address this could honestly come from. Add one under Mail → Nurture → Identities.`
        : "There is no default sending identity. Add one under Mail → Nurture → Identities, or name one on the request.",
      400,
    );
  const transport = transportFor(identity);

  const contact = contactFor(address);

  return {
    plan: {
      address,
      name: contact?.name?.trim() || null,
      venture: ventureId,
      ventureName: venture?.name ?? null,
      identityId: identity.id,
      from: transport.from,
      via: transport.via,
      purpose: input.purpose.replace(/\s+/g, " ").trim().slice(0, 400),
      whyNow: input.whyNow.replace(/\s+/g, " ").trim().slice(0, 400),
      origin: input.origin,
      sequenceId: input.sequenceId ?? null,
      step: input.step ?? null,
      steps: input.steps ?? null,
      threadId: input.threadId ?? null,
    },
    identity,
    transport,
  };
}

/**
 * The plan and its packet together — the two documents a draft is built from,
 * and the two that are stored on it.
 *
 * THE PURPOSE JOINS THE PACKET AS A FACT, and this is the one place where the
 * owner's own typing becomes something the wording may quote. A step's purpose
 * is a sentence he wrote about what to say; refusing the figures in it would
 * mean he could not write "the beta closes at the end of the month" into his
 * own sequence and have the letter say it. So it is a fact, sourced as one —
 * "the sequence step, as the owner typed it" — which is exactly what it is, and
 * the card shows that source beside it.
 *
 * `whyNow` DELIBERATELY DOES NOT. It is this box's internal reason for writing
 * today — step counts, due dates, offsets — and a letter that quoted it would
 * be telling the recipient about the machinery.
 */
export async function planAndFacts(
  input: PlanInput,
): Promise<{ plan: DraftPlan; identity: IdentityRow; transport: Transport; facts: Fact[]; cannotSay: string[] }> {
  const made = plan(input);
  const packet = await packetFor(made.plan.address, made.plan.venture);
  const facts: Fact[] = [...packet.facts];
  if (made.plan.purpose)
    facts.push({
      key: "message.purpose",
      value: made.plan.purpose,
      source:
        made.plan.origin.kind === "sequence"
          ? "the sequence step, as the owner typed it"
          : "the request that asked for this draft",
      observed_at: null,
    });
  return { ...made, facts, cannotSay: packet.cannotSay };
}
