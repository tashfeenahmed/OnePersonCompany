/**
 * ANOMALY NARRATION — three sentences about what else was true, and not one
 * figure that was not read.
 *
 * WHAT PROBLEM THIS SOLVES. A trip on its own says "failed payments are 27,
 * and your rule trips over 10". That is true and it is not enough to act on:
 * the owner's next question is always "compared with what, and what else moved
 * this morning". Answering it by hand means opening six pages.
 *
 * HOW IT ANSWERS WITHOUT INVENTING ANYTHING. It does not ask a model to
 * investigate. It assembles the evidence itself — the rule, its reading, its
 * comparison, and the figures that MOVED between the previous evaluation's
 * snapshots and this one — and asks the model to do the one thing a model is
 * better at than a template: put those figures into three sentences that read
 * like an explanation. Every number in the prompt is a number this box read
 * out of a document minutes earlier, and the instruction is explicit that no
 * other number may appear.
 *
 * THAT IS A MITIGATION AND NOT A GUARANTEE, and it is worth saying so plainly:
 * a model can still write a wrong sentence about right numbers. What the
 * design buys is that the numbers are checkable — the event carries `observed`
 * and `previous`, the snapshots are on disk, and the page shows the movements
 * beside the prose. The narration is never the only record of anything.
 *
 * NO PROVIDER MEANS NO NARRATION, and the event says so in words. This is the
 * one behaviour that must not be softened: a box with nothing to write the
 * prose is a box with nothing to write the prose, and a template pretending to
 * be one would be exactly the confident-sounding invention the whole product
 * is arranged against.
 */
import { complete, NoProviderError } from "../../models/provider.ts";
import { flattenNumbers, movements, type Movement } from "./movement.ts";
import { NARRATION_SKILLS, snapshotSkills } from "./catalogue.ts";
import { setNarration, snapshots, type RuleRow } from "./store.ts";

/** How many movements from any one skill, and in total, reach the prompt. */
const PER_SKILL = 6;
const TOTAL = 20;

export type Context = {
  skill: string;
  from: string;
  to: string;
  movements: Movement[];
};

/**
 * WHAT ELSE CHANGED, out of the snapshots taken this cycle and last.
 *
 * Only skills with TWO snapshots contribute. One snapshot is a photograph with
 * nothing to compare it to, and reporting its figures as context would put
 * absolute numbers next to movements and invite the reader to treat them the
 * same way.
 */
export function gatherContext(skillIds: string[]): { contexts: Context[]; compared: string[] } {
  const out: Context[] = [];
  /* Which skills COULD be compared — two snapshots exist — as opposed to which
     had something to report. The difference is the whole of the fallback
     sentence below: "nothing has a second reading yet" and "nothing moved" are
     different findings and only one of them is about the business. */
  const compared: string[] = [];
  let budget = TOTAL;
  for (const skill of skillIds.slice(0, NARRATION_SKILLS)) {
    if (budget <= 0) break;
    const shots = snapshots(skill, 2);
    if (shots.length < 2) continue;
    compared.push(skill);
    const [now, before] = shots as [{ ts: string; doc: unknown }, { ts: string; doc: unknown }];
    const moved = movements(
      flattenNumbers(before.doc),
      flattenNumbers(now.doc),
      Math.min(PER_SKILL, budget),
    );
    if (!moved.length) continue;
    budget -= moved.length;
    out.push({ skill, from: before.ts, to: now.ts, movements: moved });
  }
  return { contexts: out, compared };
}

function line(m: Movement): string {
  const pct = m.changePct === null ? "" : ` (${m.changePct > 0 ? "+" : ""}${m.changePct}%)`;
  return `  ${m.path}: ${m.before} → ${m.after}${pct}`;
}

export function buildPrompt(
  r: Pick<RuleRow, "name" | "skill" | "view" | "path" | "op" | "threshold" | "venture_id">,
  observed: number,
  against: number | null,
  context: Context[],
  compared: string[],
): string {
  const lines: string[] = [];
  lines.push(`ALERT: ${r.name}`);
  lines.push(
    `The owner's own rule: read ${r.path} from the "${r.skill}" document (view: ${r.view}) and ` +
      `trip when it is ${r.op}${r.threshold === null ? "" : ` ${r.threshold}`}.`,
  );
  lines.push(`It read ${observed}${against === null ? "" : `, compared against ${against}`}.`);
  if (r.venture_id) lines.push(`The owner filed this rule under venture ${r.venture_id}.`);
  lines.push("");
  if (context.length) {
    lines.push("WHAT ELSE MOVED between the previous reading and this one:");
    for (const c of context) {
      lines.push(`${c.skill} (${c.from} → ${c.to}):`);
      for (const m of c.movements) lines.push(line(m));
    }
  } else if (compared.length) {
    lines.push(
      `NOTHING ELSE MOVED. These documents were compared between the two ` +
        `readings and every figure in them was unchanged: ${compared.join(", ")}.`,
    );
  } else {
    lines.push(
      "NOTHING ELSE COULD BE COMPARED: no other document has two readings on " +
        "this box yet, so there is no context to give. Say so rather than " +
        "implying nothing changed.",
    );
  }
  return lines.join("\n");
}

const SYSTEM =
  "You are writing three sentences for the owner of a small software business, " +
  "beside an alert their own rule just raised.\n\n" +
  "RULES, and they are absolute:\n" +
  "- Use ONLY the figures printed below. Do not introduce a number that is not " +
  "on this page — not a percentage you computed from two of them, not a total, " +
  "not a rate, not a figure you remember about businesses like this one.\n" +
  "- A trip is a comparison the owner configured, not a judgement. Do not call " +
  "it a problem, an incident or a failure unless the figures say so.\n" +
  "- If the other movements have nothing to do with the alert, say that. " +
  "\"Nothing else moved that looks related\" is a good sentence and a correct one.\n" +
  "- Do not recommend an action, do not speculate about a cause you cannot see " +
  "in the figures, and do not apologise.\n" +
  "- Exactly three sentences. Plain prose, no markdown, no bullet list, no heading.";

/**
 * Narrate one event, in place.
 *
 * IT RETURNS NOTHING AND THROWS NOTHING. It is called from a timer, after the
 * event has already been written, and every failure it can have — no provider,
 * a provider that is down, a model that answered with nothing — is a null
 * narration and a sentence saying which. An alerting system whose alerts fail
 * because the optional paragraph failed would be worse than one with no
 * paragraphs.
 */
export async function narrate(
  eventId: number,
  r: Pick<RuleRow, "name" | "skill" | "view" | "path" | "op" | "threshold" | "venture_id">,
  observed: number,
  against: number | null,
  signal?: AbortSignal,
): Promise<void> {
  let context: Context[] = [];
  let compared: string[] = [];
  try {
    /* The rule's own skill first: whatever else moved, the document the rule
       read is the one the owner will ask about. */
    const ids = [r.skill, ...(await snapshotSkills(signal))].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    const got = gatherContext(ids);
    context = got.contexts;
    compared = got.compared;
  } catch {
    context = [];
    compared = [];
  }

  try {
    const reply = await complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(r, observed, against, context, compared) },
      ],
      { signal },
    );
    const text = reply.text.trim();
    if (!text) {
      setNarration(eventId, null, "The model answered with an empty message.");
      return;
    }
    setNarration(eventId, text, null);
  } catch (err) {
    if (err instanceof NoProviderError) {
      setNarration(eventId, null, err.message);
      return;
    }
    setNarration(
      eventId,
      null,
      `No narration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
