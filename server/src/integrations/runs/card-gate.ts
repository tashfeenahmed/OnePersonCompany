/**
 * WHAT A RUN IS ALLOWED TO PUT ON THE BOARD, DECIDED BY A MODEL.
 *
 * WHY THIS EXISTS. On 2026-09-21 the owner read the whole Backlog and found
 * thirty cards that were not work: "Read Natural Cycles' Plan Pregnancy page",
 * "Confirm Clue Plus pricing on helloclue.com", "Track SpeakBold and BoldSpeak
 * as new entrants", "Capture the full IAP prices of the mobile rivals". Fifteen
 * came from `competitors` runs and nine from `demand`. Every one is a sub-agent
 * assigning its own homework to a human: the thing asked for is another look at
 * the world, and nothing about the product is different when it is done. His
 * words for the class were "they don't say anything".
 *
 * WHY IT IS A MODEL AND NOT A WORD LIST. The first version of this file was a
 * list of opening verbs and a list of change verbs. It was wrong in principle
 * and it was wrong in practice, and the practice is the more convincing
 * argument: inside an hour of writing it, `move` refused nothing because a body
 * said "their prices move", `buy` kept a chore because a thread was posted by a
 * "buyer", `price` kept four chores because a chore about pricing contains the
 * word pricing, and `made` matched "a claim made by". Each fix narrowed the
 * list, and each narrowing was a guess about a sentence nobody had written yet.
 * "Is this card a change or is it homework" is a question about MEANING. The
 * owner's rule — no word matching for a gate — is the right one, so the
 * judgment is a model's and the vocabulary is gone.
 *
 * WHAT THE MODEL IS ASKED. One call per run, not per card: the cards arrive
 * together, judging them together costs one round trip, and a model that sees
 * the whole batch can also notice that two of them are the same suggestion. It
 * gets the title and body of each and answers with a verdict and a reason.
 *
 * OBSERVABILITY WAS THE REASON THE OLD GATE UPSTAIRS STAYED DETERMINISTIC.
 * `pipeline/synthesis.ts` says so in as many words: "asking a second model
 * 'does this evidence dismiss itself' would make the rule unobservable except by
 * running a night". That objection is answered here rather than dismissed —
 * every verdict is written to `run_card_verdicts` with the model that made it
 * and its reason, so the rule is inspectable after the fact by reading a table
 * instead of reproducing a nightly. The parser is pure and exported, so the half
 * that can be tested without a provider is.
 *
 * IT FAILS OPEN, AND THAT IS A CHOICE. If the model cannot be reached, or
 * answers something unparseable twice, every card is filed and recorded as
 * `unjudged`. A gate that silently drops a real defect because a GPU was busy
 * would cost more than the noise it was built to stop — and the owner can see
 * from the table which cards were never judged.
 *
 * WHAT HAPPENS TO THE REFUSED ONES. They stay in the report: the fence is still
 * in the document, the run page still draws it, and the finding is still written
 * where its reasoning is. They simply do not become a line on a board somebody
 * has to clear by hand. For `competitors` there is already a better home —
 * `focusNext`, whose whole purpose is "one thing the NEXT sweep should settle",
 * which is what a research chore actually is.
 */
import { complete } from "../../models/provider.ts";
import { db, now } from "../../db.ts";

export type CardVerdict = {
  /** The card's index in the report's fence, so a verdict can be matched back
   *  to the suggestion it judged even when earlier ones were refused. */
  index: number;
  verdict: "change" | "homework" | "unjudged";
  why: string;
};

/** A card as the gate sees it. */
export type JudgeableCard = { title: string; body: string };

/**
 * THE CARD CONTRACT, in the words every analyst kind is given.
 *
 * ONE STRING, FIVE CALLERS. competitors, research, demand, geo and the shared
 * REPORT_SHAPE in kinds.ts each used to word this themselves, and all five
 * said some version of "one action somebody could tick off" — which a research
 * chore satisfies. Said once, it can be tightened once. It describes the same
 * distinction the judge is asked to make, so a model that follows its brief is
 * never refused for doing so.
 */
export const CARD_CONTRACT = `Between three and eight \`cards\`, and FEWER IS BETTER — three real ones beat eight padded out. \`urgency\` is 0 (whenever) to 3 (this week). These are FILED STRAIGHT INTO THE BOARD'S BACKLOG when the run finishes, so the bar is high.

A CARD IS A CHANGE. Its title names something that will be different when the card is ticked: a bug fixed, a page or a price or a piece of copy changed, a feature shipped, a setting corrected, something broken put right, an experiment run. The body says why, with the figure or the quote it rests on.

A CARD IS NOT HOMEWORK. Do not file a card whose whole content is going and looking at something — reading a rival's page, confirming a price, tracking a competitor, capturing figures, re-checking a register. A card that would leave the product exactly as it is when finished is not a card. Each card is judged on this before it reaches the board, and one judged as homework is dropped.

IF THE HONEST NEXT STEP IS ANOTHER LOOK, SAY SO IN THE REPORT — in Findings or Recommendations, where your reasoning is — and not on the owner's board.`;

const SYSTEM = `You are the gate on one person's work board. You decide which suggested cards are allowed onto it.

For each card, answer "change" or "homework".

"change" — doing this card makes something different: code, a page, copy, a price, a setting, a store listing, a monitor, a reply somebody is waiting for, an experiment that ships. A card can be small and still be a change.

"homework" — the whole card is going and looking: reading a competitor's page, confirming or capturing a price, tracking or watching a rival, compiling a list, re-checking something already on file, re-running a measurement to see what it says. Nothing about the product is different when it is done.

Judge what the card would actually have somebody DO, not the words it opens with. "Verify the site in Bing Webmaster Tools" adds a property and is a change. "Verify the rival's pricing" is homework. If a card looks at something AND changes something, it is a change. If two cards in the batch ask for the same thing, the clearest one is a change and the rest are homework.

When you genuinely cannot tell, answer "change" — the owner would rather see a borderline card than lose a real one.

Answer with ONLY a JSON object: {"verdicts":[{"index":0,"verdict":"change","why":"one short clause"}]} — one entry for every card you were given, in the order given, and no prose outside the object.`;

/** The nudge when the first answer was not the object. Same shape as the one
 *  synthesis uses, and for the same failure: a model that explains instead of
 *  answering. */
const AGAIN =
  "STOP. That was not the JSON object. Do not explain — answer again with ONLY " +
  'the object: {"verdicts":[{"index":0,"verdict":"change"|"homework","why":"…"}]}';

/**
 * The verdicts in a model's reply, or null when it did not answer the question.
 *
 * PURE AND EXPORTED, so the fragile half of an LLM gate — reading the answer —
 * is tested without a provider. Tolerant in the three ways models actually
 * stray: a fenced block around the object, a bare array instead of the wrapper,
 * and a verdict in the wrong case or with surrounding whitespace. Not tolerant
 * about the verdict VOCABULARY: an unrecognised word is not quietly read as a
 * refusal, because guessing a refusal is how a gate eats real work.
 */
export function readVerdicts(text: string, count: number): CardVerdict[] | null {
  const raw = String(text ?? "");
  const fenced = raw.match(/```(?:json[^\n]*)?\n([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.search(/[[{]/);
  if (start === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start));
  } catch {
    return null;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { verdicts?: unknown })?.verdicts)
      ? (parsed as { verdicts: unknown[] }).verdicts
      : null;
  if (!rows) return null;

  const byIndex = new Map<number, CardVerdict>();
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const word = String(r.verdict ?? "").trim().toLowerCase();
    if (word !== "change" && word !== "homework") continue;
    /* A missing index means "the nth one you gave me", which is what a model
       that dropped the field meant and the order it answered in. */
    const idx = Number.isInteger(Number(r.index)) ? Number(r.index) : i;
    if (idx < 0 || idx >= count || byIndex.has(idx)) continue;
    byIndex.set(idx, {
      index: idx,
      verdict: word,
      why: String(r.why ?? "").trim().slice(0, 300),
    });
  }

  /* A partial answer is not an answer. Half a batch judged would file the
     unjudged half under whatever the caller's default is, which reads as the
     model having approved them. */
  if (byIndex.size !== count) return null;
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** The prompt turn for a batch — built here so a test can read what the model
 *  is actually shown. */
export function judgePrompt(cards: JudgeableCard[], context?: { kind?: string; venture?: string }): string {
  const where = [context?.kind && `a ${context.kind} run`, context?.venture && `for ${context.venture}`]
    .filter(Boolean)
    .join(" ");
  const list = cards
    .map((c, i) => `${i}. ${c.title}\n   ${(c.body || "(no body)").replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n\n");
  return `${where ? `These cards were suggested by ${where}.\n\n` : ""}${list}\n\nJudge all ${cards.length}.`;
}

/**
 * JUDGE A BATCH. Never throws: a gate that can break a finished run is a gate
 * that will eventually lose one.
 */
export async function judgeCards(
  cards: JudgeableCard[],
  opts: { kind?: string; venture?: string; signal?: AbortSignal } = {},
): Promise<{ verdicts: CardVerdict[]; model: string | null; why: string | null }> {
  const unjudged = (why: string) => ({
    verdicts: cards.map((_, index) => ({ index, verdict: "unjudged" as const, why })),
    model: null,
    why,
  });
  if (!cards.length) return { verdicts: [], model: null, why: null };

  const turns = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: judgePrompt(cards, opts) },
  ];

  let model: string | null = null;
  for (const attempt of [0, 1]) {
    let text: string;
    try {
      const reply = await complete(attempt === 0 ? turns : [...turns, { role: "system" as const, content: AGAIN }], {
        jsonObject: true,
        signal: opts.signal,
      });
      text = reply.text;
      model = reply.model;
    } catch (err) {
      return unjudged(err instanceof Error ? err.message.slice(0, 200) : "the model could not be reached.");
    }
    const verdicts = readVerdicts(text, cards.length);
    if (verdicts) return { verdicts, model, why: null };
  }
  return unjudged("the model did not answer with verdicts for every card.");
}

/**
 * EVERY JUDGMENT, KEPT. This is the table that makes an LLM gate answerable to
 * the owner: it holds what was suggested, what the judge said and why, and which
 * model said it, so "why did my card disappear" is a query rather than a guess.
 * Written for refused AND filed cards, because a gate you can only see the
 * refusals of cannot be shown to be working.
 */
export function recordVerdicts(
  runId: string,
  cards: JudgeableCard[],
  verdicts: CardVerdict[],
  model: string | null,
): void {
  const at = now();
  const stmt = db.prepare(
    `INSERT INTO run_card_verdicts (run_id, idx, title, verdict, why, model, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, idx) DO UPDATE SET
       verdict = excluded.verdict, why = excluded.why, model = excluded.model, at = excluded.at`,
  );
  for (const v of verdicts)
    stmt.run(runId, v.index, cards[v.index]?.title ?? "", v.verdict, v.why || null, model, at);
}

/** What the judge said about one run, newest write wins. For the run page and
 *  for answering "where did that card go". */
export function verdictsFor(runId: string): (CardVerdict & { title: string; model: string | null })[] {
  return db
    .prepare(
      "SELECT idx, title, verdict, why, model FROM run_card_verdicts WHERE run_id = ? ORDER BY idx",
    )
    .all(runId)
    .map((r) => {
      const row = r as { idx: number; title: string; verdict: string; why: string | null; model: string | null };
      return {
        index: row.idx,
        title: row.title,
        verdict: row.verdict as CardVerdict["verdict"],
        why: row.why ?? "",
        model: row.model,
      };
    });
}
