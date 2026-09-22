/**
 * WORDING — the only part of a draft a model touches, and the narrowest job it
 * could be given.
 *
 * WHAT IT IS SHOWN: the plan (who, why now, which business, which step) and the
 * fact packet. Nothing else. No table, no document, no mail, no credential, no
 * memory of the last conversation. It is not asked to decide anything; it is
 * asked to put the facts into sentences.
 *
 * WHAT IT IS ALLOWED TO ADD: sentences. Not a number, not an amount of money,
 * not a date, not a link and not an address. Whatever it returns is read by
 * `ungrounded()` against the packet, and a body carrying anything the packet
 * does not have is REFUSED — not repaired. Repairing it would mean this code
 * deciding which invented figure was close enough to a real one, which is the
 * judgement the whole split exists to avoid making.
 *
 * TWO ATTEMPTS, THEN THE TEMPLATE. The first refusal is shown to the model with
 * the token it invented, because that is genuinely useful feedback and it
 * usually works. The second refusal ends it: the deterministic template below
 * is used instead, and the row records that the model's wording was refused and
 * why. A templated email is a perfectly good email — the facts ARE the email,
 * and the model only ever chose the sentences around them.
 *
 * THE TEMPLATE VALIDATES ITSELF. It is built out of the same packet, so it
 * cannot fail the gate — and it is run through the gate anyway. A template that
 * could not pass its own check is a bug worth surfacing on the card rather than
 * a message worth sending.
 *
 * NO PROVIDER IS NOT AN ERROR. With no model connected the template is the
 * wording, first time, and the card says so. A queue that could only produce
 * drafts when a remote endpoint was up would be a queue that stops working on
 * somebody else's bad afternoon.
 */
import { complete, NoProviderError } from "../../models/provider.ts";
import type { WireTurn } from "../../chat/wire.ts";
import { allowedFrom, ungrounded, type Fact } from "./validate.ts";
import type { DraftPlan } from "./planner.ts";
import { ruleLines } from "./style.ts";
import { PORTFOLIO_VENTURE } from "../../runtime/budgets.ts";

const MAX_BODY = 3000;

export type Wording = {
  subject: string;
  body: string;
  /** model | template. What actually produced the body on the row. */
  by: "model" | "template";
  /** Why the template was used, when it was. Null when the model's wording
   *  stood. */
  why: string | null;
  /** Every refusal, in order, with the token each one named. Stored on the row
   *  and shown on the card: a gate nobody can see working is a gate nobody can
   *  tell is broken. */
  refusals: string[];
  model: string | null;
  /** How many style rules were in the prompt. Zero is the normal state. */
  styleRules: number;
};

/* -------------------------------------------------------------- the prompt */

function factLines(facts: Fact[]): string {
  return facts
    .map(
      (f) =>
        `- ${f.key}: ${typeof f.value === "number" ? f.value : `"${String(f.value).slice(0, 400)}"`}` +
        `${f.unit ? ` (${f.unit})` : ""} — source: ${f.source}${f.observed_at ? `; observed ${f.observed_at}` : "; the source dated it"}`,
    )
    .join("\n");
}

export function systemPrompt(styleRules: string[]): string {
  const base = [
    "You write one short email. You are given a PLAN and a list of FACTS, and the facts are the",
    "only things you know. You have no other information about the recipient, the business, or",
    "anything else, and you must not behave as though you have.",
    "",
    "YOU MAY NOT WRITE: a number, an amount of money, a price, a date, a link, a domain or an",
    "email address that is not already in the FACTS. A validator reads what you return and",
    "throws the whole body away if it carries one, so an invented figure costs you the draft.",
    "Write counts as words — \"three\" and not \"3\". If a fact is not in the list, the email does",
    "not mention it; do not hedge around it, do not allude to it, leave it out.",
    "",
    "Do not claim to know what anybody said in a previous conversation, what they did inside a",
    "product, or anything about their payments. Nothing here measured those.",
    "",
    "Plain prose, no markdown headings, no bullet lists, no subject line inside the body. Four",
    "short paragraphs at most. Do not sign it — a signature is appended afterwards.",
    "",
    "Reply with exactly two lines and nothing else:",
    "SUBJECT: <the subject line>",
    "BODY:",
    "<the message>",
  ].join("\n");
  if (!styleRules.length) return base;
  return [
    base,
    "",
    "HOUSE STYLE — how the owner rewords these when he edits them. These are about WORDING ONLY.",
    "Where a style rule and the facts appear to disagree, the facts win and the rule is dropped;",
    "the validator described above still reads your body against the FACTS afterwards and throws",
    "it away if it carries a number, date, link or address the facts do not have.",
    ...styleRules.map((r) => `- ${r}`),
  ].join("\n");
}

export function userPrompt(plan: DraftPlan, facts: Fact[], cannotSay: string[]): string {
  return [
    "PLAN",
    `- writing to: ${plan.name ? `${plan.name} <${plan.address}>` : plan.address}`,
    `- from: ${plan.from}`,
    plan.ventureName ? `- about: ${plan.ventureName}` : "- about: no particular business",
    `- purpose of this message: ${plan.purpose}`,
    `- why now: ${plan.whyNow}`,
    plan.step && plan.steps ? `- this is message ${plan.step} of ${plan.steps} in a sequence` : "",
    "",
    "FACTS — everything you are allowed to know:",
    factLines(facts),
    "",
    "THINGS NOBODY HERE MEASURED, so the email must not refer to them:",
    ...cannotSay.map((s) => `- ${s}`),
    "",
    "Write the email.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** SUBJECT: … / BODY: … , however the model decorated it. A reply with no
 *  SUBJECT line is not repaired with a guessed one — it is a malformed answer
 *  and is treated as a refusal, because a subject invented by this parser is
 *  a subject nobody wrote. */
export function parseReply(text: string): { subject: string; body: string } | null {
  const raw = String(text ?? "").replace(/^\s*```[a-z]*\s*|\s*```\s*$/g, "");
  const m = /SUBJECT:\s*(.+?)\s*\n+\s*BODY:\s*\n?([\s\S]+)$/i.exec(raw);
  if (!m) return null;
  const subject = m[1]!.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  const body = m[2]!.trim().slice(0, MAX_BODY);
  if (!subject || !body) return null;
  return { subject, body };
}

/* ------------------------------------------------------------ the template */

const factValue = (facts: Fact[], key: string): string | number | null =>
  facts.find((f) => f.key === key)?.value ?? null;

/**
 * The deterministic wording.
 *
 * Built from the plan and the packet, in the owner's absence of a model or in
 * the model's failure. It says what it knows and nothing else, which is exactly
 * the property the whole file is arguing for — the difference between this and
 * a good model's answer is fluency, not truth.
 *
 * It quotes the FIRST NAME only where the packet carries a display name the
 * person signed a message with. There is no name derived from an address here
 * and there must not be: "Hi Jane" to jane.smith@ who is actually Janet is a
 * worse opening than "Hi".
 */
export function template(plan: DraftPlan, facts: Fact[]): { subject: string; body: string } {
  const name = plan.name ? plan.name.split(/\s+/)[0]!.replace(/[^\p{L}'-]/gu, "") : "";
  const about = plan.ventureName ?? (factValue(facts, "product.name") as string | null) ?? null;
  const greeting = name ? `Hi ${name},` : "Hello,";

  const subject = about
    ? plan.step && plan.step > 1
      ? `Following up about ${about}`
      : `About ${about}`
    : plan.step && plan.step > 1
      ? "Following up"
      : "A quick note";

  const lines = [greeting, "", plan.purpose];
  const signedUp = factValue(facts, "product.signed_up");
  if (typeof signedUp === "string")
    lines.push("", `You set up an account${about ? ` on ${about}` : ""} on ${signedUp.slice(0, 10)}.`);
  const site = factValue(facts, "venture.website") ?? factValue(facts, "venture.host");
  if (typeof site === "string") lines.push("", site);
  lines.push(
    "",
    "If this is not useful, say so in a line and I will leave it there — a reply either way genuinely helps.",
  );
  return { subject, body: lines.join("\n") };
}

/* ---------------------------------------------------------------- the road */

/**
 * The one road from a plan and a packet to a body.
 *
 * Every exit from this function returns a `Wording` — there is no path that
 * throws, and no path that returns a body which has not been read by the gate.
 * That is the property to preserve if this is ever rewritten.
 */
export async function word(
  plan: DraftPlan,
  facts: Fact[],
  cannotSay: string[],
): Promise<Wording> {
  const styleRules = ruleLines();
  const templated = template(plan, facts);
  const allowed = allowedFrom(facts);
  const refusals: string[] = [];

  const fallback = (why: string, model: string | null): Wording => {
    const bad = ungrounded(templated.body, allowed);
    return {
      subject: templated.subject,
      body: templated.body,
      by: "template",
      why: bad
        ? `${why}. The deterministic wording ALSO failed its own fact check (${bad}), which is a bug in the template rather than in the model — read this draft carefully.`
        : why,
      refusals: bad ? [...refusals, `template: ${bad}`] : refusals,
      model,
      styleRules: styleRules.length,
    };
  };

  const turns: WireTurn[] = [
    { role: "system", content: systemPrompt(styleRules) },
    { role: "user", content: userPrompt(plan, facts, cannotSay) },
  ];

  let model: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    try {
      const reply = await complete(turns, { model: undefined, venture: plan.venture ?? PORTFOLIO_VENTURE });
      text = reply.text;
      model = reply.model;
    } catch (err) {
      if (err instanceof NoProviderError)
        return fallback(
          "no model provider is connected, so this is the deterministic wording — the facts are the email either way",
          null,
        );
      return fallback(
        `the model could not be reached (${err instanceof Error ? err.message : String(err)}), so this is the deterministic wording`,
        null,
      );
    }

    const parsed = parseReply(text);
    if (!parsed) {
      refusals.push(`attempt ${attempt}: the answer did not carry a SUBJECT and a BODY`);
      turns.push(
        { role: "assistant", content: text.slice(0, 2000) },
        {
          role: "user",
          content:
            "That was not the shape asked for. Reply with exactly `SUBJECT: <line>` then `BODY:` then the message, and nothing else.",
        },
      );
      continue;
    }

    const badBody = ungrounded(parsed.body, allowed);
    const badSubject = ungrounded(parsed.subject, allowed);
    const bad = badBody ?? badSubject;
    if (!bad)
      return {
        subject: parsed.subject,
        body: parsed.body,
        by: "model",
        why: null,
        refusals,
        model,
        styleRules: styleRules.length,
      };

    refusals.push(`attempt ${attempt}: ${bad}`);
    if (attempt === 2) break;
    turns.push(
      { role: "assistant", content: `SUBJECT: ${parsed.subject}\nBODY:\n${parsed.body}` },
      {
        role: "user",
        content:
          `Refused: ${bad}. Every number, amount, date, link and address must already be in the FACTS. ` +
          "Write it again without that, spelling any count as a word. Same shape as before.",
      },
    );
  }

  return fallback(
    `the model's wording was refused twice by the fact check (${refusals.join("; ")}), so this is the deterministic wording`,
    model,
  );
}
