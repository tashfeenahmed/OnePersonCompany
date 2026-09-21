/**
 * COMMITMENTS — the promises the owner made in his own sent mail, and nothing
 * else.
 *
 * THE PRIVACY BARGAIN, WHICH IS THE FIRST THING TO KNOW. This is the only part
 * of this area that reads a message BODY. Bodies are transient by
 * construction: fetched in `gmail-sent.ts`, cleaned and scanned here, and gone
 * when `scan()` returns. Four things reach `people_commitments` — one sentence
 * of at most 200 characters that the owner himself typed AND that was judged a
 * promise, who it was to, when it was sent, and the thread it was in. No
 * subject body, no snippet, no second sentence for context, no draft of
 * anything.
 *
 * WHAT THE JUDGE SEES, WHICH IS MORE THAN THE OLD PASS SHOWED IT. It is shown
 * every sentence of his own writing in ONE message — never the quoted material
 * below it, never the subject, never the recipient, never a second message. It
 * has to be every sentence, because the thing being decided is WHICH of them
 * are promises, and a filter that answered that in advance is precisely the bug
 * described below. None of those sentences is stored. What is kept of a REFUSED
 * sentence is one row in `gate_verdicts`: a pointer of the form
 * `<gmail message id>#<nth sentence>`, the verdict, and the judge's own clause
 * of at most 300 characters saying why. The pointer is deliberately not the
 * sentence — it is enough to open the mail in his own client, and it is not a
 * copy of a line he promised nothing in. The clause is the one thing this table
 * holds that the old word lists did not, and it is the price of the rule being
 * observable at all rather than only by rerunning a scan.
 *
 * IT IS HIS OWN WORDS OR IT IS NOT HERE. Only `in:sent` is read, so nothing
 * anybody else promised can appear and nothing he was ASKED to do can either.
 * Inside his own message the same line is drawn again, by the judge rather than
 * by a pattern: "you'll send it over" is the recipient's business, and the
 * question text says so.
 *
 * THREE STAGES, AND ONLY THE MIDDLE ONE IS A JUDGMENT.
 *
 *   1. CODE PARSES THE MAIL CLIENT'S OUTPUT. Quoted text, forward markers,
 *      signatures, attributions and "Sent from my iPhone" are cut; soft wraps
 *      are healed; the remainder is split into sentences. Every one of those is
 *      a fact about how a mail client lays out a message, checkable by reading
 *      the message, so every one of them stays here in code.
 *   2. A MODEL DECIDES WHICH SENTENCES ARE PROMISES, in one call per message,
 *      answering `promise` or `not` for each. This is the gate, it is the only
 *      thing that decides recall, and it can go in BOTH directions.
 *   3. A MODEL IS THEN ASKED FOR THE SHORTEST CONTIGUOUS SPAN of each kept
 *      sentence that states the promise, plus the span that says when, if
 *      there is one. Anything it returns that is not a literal span of the
 *      message is thrown away and the untouched sentence is used instead.
 *
 * WHY THE GATE IS A MODEL AND NOT A WORD LIST. It used to be four lists: five
 * first-person-future markers, nine negations, eight closing pleasantries, and
 * fifty-nine doing verbs in one inline regex. The lists were not merely
 * incomplete, they were UNFIXABLE in one direction: a model ran afterwards and
 * was permitted only to REMOVE candidates, so every promise phrased outside
 * those fifty-nine verbs — "I'll have a think and come back with numbers",
 * "let me sort the Stripe side out" — was invisible and could never be
 * recovered by anything downstream. Recall was decided entirely by a regex
 * nobody could finish writing, which is the owner's rule (2026-09-21: a gate
 * deciding a matter of MEANING is an LLM judgment, never a word list) failing
 * in the most expensive way available: silently, on the side nobody can see.
 *
 * THE GROUNDING GATE ON STAGE 3 IS ABSOLUTE, and it is why a model is allowed
 * to touch the words at all: a model that "helpfully" tightened "I'll try to
 * look at it" into "I'll fix it" would have this dashboard telling the owner he
 * promised something he did not. THE RECIPIENT AND THE DATE NEVER COME FROM A
 * MODEL — they come from headers, which cannot hallucinate.
 *
 * FAILING OPEN HERE MEANS FILING NOTHING. Everywhere else in this codebase an
 * unreachable judge lets the content through, because the cost of a gate that
 * eats real work is higher than the noise it stops. This gate is the other way
 * round and the reason is `nurture/facts.ts`: these sentences become grounding
 * facts for OUTBOUND email drafts, so "let it through when unsure" means
 * putting a promise he never made into a real message to a customer. So an
 * unreachable model files nothing from that pass, and the `unjudged` rows in
 * `gate_verdicts` are how that is visible instead of silent.
 *
 * DEADLINES ARE NEVER INVENTED. `due_text` is the owner's own words, held to
 * the same verbatim test as the sentence; `due` is this box's reading of those
 * words as a date and is NULL whenever there were no such words. There is no
 * path here that produces a date from a message that did not contain one.
 *
 * NOTHING IS EVER DELETED. Done and dismissed are decisions, and the row keeps
 * them; a rescan of the same fortnight finds the same promises by their hash
 * and leaves the decisions alone.
 */
import { createHash } from "node:crypto";
import { db, finishRun, now, startRun } from "../../db.ts";
import { textKey as normalise } from "../../shared/textkey.ts";
import * as accounts from "../../accounts.ts";
import { open as openMailbox } from "../../providers/gmail.ts";
import { complete } from "../../models/provider.ts";
import { judge } from "../../models/judge.ts";
import { profileAddress } from "./gmail-meta.ts";
import { reason } from "./contacts.ts";
import { readSent, sentIds, type SentMessage } from "./gmail-sent.ts";

/** The default window a scan covers when the caller names none. Short on
 *  purpose: a promise from four months ago is either done or forgotten, and
 *  the scan reads BODIES, which is the expensive and the sensitive half. */
export const DEFAULT_DAYS = 14;
/** How many sent messages one scan will open. A ceiling on the reading, on the
 *  quota and on the model calls, all at once. */
export const MAX_MESSAGES = 120;
/** Candidate sentences per completion. Twelve keeps the reply inside a
 *  sensible token budget and keeps one bad message from poisoning a batch. */
const REFINE_BATCH = 12;
/**
 * How many sentences of one message are put to the judge.
 *
 * A CEILING ON THE JUDGMENT, not a filter on it — the old pass sent the model
 * only its own pattern hits, so a pasted log or a forty-paragraph proposal cost
 * nothing; now every sentence he wrote goes, and one message has to have a
 * bound. Sixty is far above a real email and well inside one call. Anything
 * past it is counted as `unshown` in the scan result, because a sentence nobody
 * judged must be a number on the page rather than a silence.
 */
export const MAX_CANDIDATES = 60;
/** The quoted sentence's cap. A clipped promise is still a promise. */
export const MAX_SENTENCE = 200;

/* ------------------------------------------------------------ the body pass */

const FORWARD_MARK = /^[-\s]*forwarded message[-\s]*$/i;
const SIG_MARK = /^--\s*$/;
const ATTRIBUTION = /^on\b.{0,300}\bwrote:\s*$/i;
const OUTLOOK_FROM = /^from:\s/i;
const FOOTER_LINE = /^(sent from my |get outlook for |unsubscribe\b)/i;

/**
 * Everything below a quote line is somebody else's writing.
 *
 * STOPPING RATHER THAN SKIPPING, for the forward, the signature and the
 * attribution. A mail client that puts the reply BELOW the quote loses its new
 * text here, and that is the trade taken knowingly: a missed promise is a task
 * nobody sees, whereas a promise lifted out of a customer's own quoted mail
 * and filed under the owner's name is a false accusation with his name on it.
 */
export function cleanBody(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (FORWARD_MARK.test(trimmed) || SIG_MARK.test(trimmed)) break;
    if (ATTRIBUTION.test(trimmed) || ATTRIBUTION.test(`${trimmed} ${(lines[i + 1] ?? "").trim()}`))
      break;
    if (OUTLOOK_FROM.test(trimmed) && /^(sent|to|date):/i.test((lines[i + 1] ?? "").trim())) break;
    if (trimmed.startsWith(">")) continue;
    if (FOOTER_LINE.test(trimmed)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Sentences, with soft wraps healed first.
 *
 * A blank line is a paragraph break; a single newline INSIDE a paragraph is a
 * 78-column hard wrap, and splitting on it cuts a promise in half and files a
 * task quoting the owner mid-sentence. A line that begins a bullet is not a
 * wrap and keeps its break.
 */
export function sentences(body: string): string[] {
  const out: string[] = [];
  for (const para of body.split(/\n\s*\n/)) {
    const lines = para.split("\n");
    let joined = "";
    for (const line of lines) {
      if (!joined) joined = line.trim();
      else if (/^(?:[-*•·]|\d+[.)])\s+/.test(line.trim())) joined += `\n${line.trim()}`;
      else joined += ` ${line.trim()}`;
    }
    for (const chunk of joined.split("\n"))
      for (const s of chunk.split(/(?<=[.!?])\s+(?=["'“(\p{Lu}\d])/u))
        if (s.trim()) out.push(s.trim());
  }
  return out;
}

/** When, in the owner's own words. LIFTED VERBATIM, never parsed into a date
 *  here: "by end of week" is what he wrote and what the recipient read. */
const DUE =
  /\b(?:by|before|on|this|next|end of)\s+(?:the\s+)?(?:end of (?:the\s+)?(?:day|week|month)|cob|eod|eow|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|week|month|\d{1,2}(?:st|nd|rd|th)?(?:\s+\w+)?|\w+day)\b/i;

/** Cut at a word boundary when the boundary is not miserly. */
export function clip(text: string, max = MAX_SENTENCE): { text: string; clipped: boolean } {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return { text: t, clipped: false };
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: (space > max * 0.6 ? cut.slice(0, space) : cut).trim(), clipped: true };
}

export type Candidate = { sentence: string; dueText: string | null; clipped: boolean };

/**
 * EVERY SENTENCE HE WROTE IN ONE MESSAGE, in order, ready to be judged.
 *
 * THIS FUNCTION NO LONGER DECIDES ANYTHING. It used to be the gate — a
 * first-person-future marker, a doing verb from a list of fifty-nine, a
 * negation window, a closing-pleasantry list — and that is exactly what made a
 * promise worded any other way unfindable forever, because the model that ran
 * afterwards was only allowed to remove. What is left is the part that is a
 * fact rather than a judgment: how long a fragment has to be before there is
 * anything in it, that the same sentence twice in one mail is one promise, and
 * the deadline words he typed.
 *
 * THE QUESTION MARK WENT WITH THE WORD LISTS, and it is worth saying why,
 * because it looks like punctuation rather than meaning. "Can you confirm I'll
 * get the file by Friday?" is him asking — but "I'll have this with you
 * tomorrow, does that work?" is him promising, and one sentence cannot be told
 * from the other by looking for a `?`. It is the same class of decision as the
 * verb list and it now sits with the judge, whose question text names it.
 */
export function candidatesIn(body: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const raw of sentences(body)) {
    /* A FLOOR, NOT A FILTER. Under twelve characters there is no sentence to
       judge — "Thanks.", "Will do." — and `grounded()` could not check a span
       of one either. It is the same number for the same reason. */
    if (raw.length < 12) continue;
    const key = normalise(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const clipped = clip(raw);
    out.push({
      sentence: clipped.text,
      dueText: DUE.exec(raw)?.[0]?.replace(/\s+/g, " ").trim().slice(0, 60) ?? null,
      clipped: clipped.clipped,
    });
  }
  return out;
}

/* ------------------------------------------------- the gate: is it a promise */

/**
 * THE TWO WORDS. `promise` is an undertaking HE gave in that sentence; `not` is
 * everything else, and everything else is most sentences in most emails.
 *
 * Two words rather than three on purpose. A `maybe` would have to be resolved
 * by this file, and the only defensible resolution is the lean below — so the
 * lean is stated in the question instead, where the model can apply it with the
 * sentence in front of it.
 */
export const PROMISE_WORDS = ["promise", "not"] as const;
export type PromiseWord = (typeof PROMISE_WORDS)[number];

/** This gate's name in `gate_verdicts` — the one the 406 migration's own
 *  comment uses as its example. Stable, because it is what a query joins on
 *  when somebody asks in November why a promise never appeared. */
export const PROMISE_GATE = "people.commitment";

/**
 * WHAT THE JUDGE IS ASKED, in full, and exported so a test can read it.
 *
 * THE LEAN IS AGAINST CALLING IT A PROMISE, and it is written into the question
 * rather than left to the model's temperament because of where these sentences
 * end up. `nurture/facts.ts` hands them to the drafter of OUTBOUND email as
 * grounding facts, and `routes/actionInbox.ts` turns them into a board card
 * with a priority. A sentence wrongly called a promise therefore does not just
 * add a line to a list — it can put an undertaking he never gave into a real
 * message to a real customer. A sentence wrongly called `not` costs him a
 * reminder he would have liked. Those are not the same mistake and the question
 * says which one to make.
 *
 * IT NAMES THE CASES THE FOUR DELETED WORD LISTS USED TO COVER — the closing
 * pleasantry, the negation, the recipient's undertaking, the question he is
 * asking — because those cases were real. The lists were wrong about how to
 * recognise them, not about what they were.
 */
export const QUESTION = `You are reading sentences a person wrote in his OWN sent email. For each one, decide whether that sentence is a promise HE made.

"promise" — in this sentence he commits himself, or his business, to doing something: sending, writing, paying, fixing, calling, looking into, coming back on it. It counts however it is phrased, with or without a deadline, hedged or firm, and whatever verb he happened to use. "I'll get the numbers over tonight", "let me sort the Stripe side out", "we'll have a think and come back to you with options" are all promises.

"not" — everything else, which is most sentences. Something the person he is writing to will do. Something already finished. A question he is asking, even when it mentions something getting done. A fact, an opinion, a hope, a compliment, a piece of context, a price, a link. A refusal or an inability — "I won't be able to look at it this week" is the opposite of a promise. A closing pleasantry that undertakes nothing in particular: "let me know if you need anything", "I'll be around all week", "looking forward to it".

Judge the sentence ALONE. You are not shown the message it came from, the subject or the recipient, and you should not imagine them. If a sentence would only be a promise given surrounding context you cannot see, it is "not".

WHEN YOU ARE GENUINELY UNSURE, ANSWER "not". A sentence you call a promise is quoted back to him as something he owes somebody, and is given to a drafter as a fact when his next email to that person is written — so a wrong "promise" can put an undertaking he never gave into a real message. A wrong "not" only costs him a reminder. Lean that way deliberately.`;

/** One candidate with the judge's answer to it. */
export type Judged = {
  candidate: Candidate;
  verdict: PromiseWord | "unjudged";
  why: string;
};

/**
 * ONE CALL PER MESSAGE, which is the unit the sentences arrive in.
 *
 * NOT ONE CALL PER SCAN: a scan opens up to 120 messages, so a scan-wide batch
 * would be one prompt of a thousand sentences from thirty different
 * conversations, where one unparseable reply loses the whole fortnight and a
 * retry costs the whole fortnight again. Per message the blast radius of a bad
 * answer is one message, and the sentences of one message are the only ones
 * that could ever have needed to be seen together.
 *
 * THE SUBJECT KEY IS A POINTER, NOT THE SENTENCE — `<message id>#<nth>`. It
 * finds the mail in his own client and it keeps `gate_verdicts` from becoming a
 * copy of every line he has written, which is the privacy bargain at the top of
 * this file. It is also why the key is the sentence's position in the message
 * and not a hash: a hash identifies nothing a person can open.
 */
export async function judgePromises(
  candidates: Candidate[],
  messageId: string,
  signal?: AbortSignal,
): Promise<{ judged: Judged[]; model: string | null; why: string | null }> {
  if (!candidates.length) return { judged: [], model: null, why: null };
  const result = await judge({
    gate: PROMISE_GATE,
    question: QUESTION,
    allowed: PROMISE_WORDS,
    items: candidates.map((c, i) => ({ key: `${messageId}#${i + 1}`, text: c.sentence })),
    signal,
  });
  return {
    judged: candidates.map((candidate, i) => {
      const v = result.verdicts[i];
      return { candidate, verdict: v?.verdict ?? "unjudged", why: v?.why ?? (result.why ?? "") };
    }),
    model: result.model,
    why: result.why,
  };
}

/**
 * THE ONES THAT GET FILED, and nothing else.
 *
 * `unjudged` IS NOT A PASS. A batch nobody judged — no provider configured, a
 * model that answered prose twice — files nothing at all, and the rows are in
 * `gate_verdicts` saying so. The alternative, filing the sentences and letting
 * the page mark them unjudged, was rejected: the page is not the only consumer.
 * `facts.ts` reads the same table with no idea of how a row got there, so an
 * unjudged sentence would reach a draft as "you promised this" on the strength
 * of nothing but a pattern nobody ran any more.
 */
export function keep(judged: Judged[]): Candidate[] {
  return judged.filter((j) => j.verdict === "promise").map((j) => j.candidate);
}

/* ------------------------------------------------------------- the span pass */

/**
 * One normalisation for three jobs — the dedup key, the grounding test and the
 * in-body duplicate test. `shared/textkey.ts`'s STRICT key (digits kept, not
 * its digit-folding `fingerprint`), under this area's name for it: "I'll send
 * the 3 files" and "I'll send the 4 files" must stay two different promises.
 */
export { normalise };

/** Is this span actually in the message? Under twelve characters nothing is
 *  claimed — a two-word "span" matches almost any body. */
export function grounded(span: string, bodyNorm: string, min = 12): boolean {
  const n = normalise(span);
  return n.length >= min && bodyNorm.includes(n);
}

/**
 * IT IS NO LONGER ALLOWED TO OMIT ANYTHING.
 *
 * The old version of this prompt ended "omit an item entirely if it is not
 * actually a promise", and an omission was read as a refusal — which was the
 * ONE judgment the old design let a model make, and only ever in the direction
 * of removal. That judgment now belongs to the gate above, where it works in
 * both directions and is written down in `gate_verdicts`. Leaving it here as
 * well would mean a sentence could be refused twice by two different calls with
 * only one of the refusals recorded, and "why did that promise disappear" would
 * have an answer the table does not contain.
 */
const SYSTEM =
  "You tidy up promise sentences taken from a person's own sent email. Each " +
  "one has already been judged to be a promise he made; your only job is to " +
  "quote the part of it that says what he promised. For each numbered " +
  "candidate return the shortest CONTIGUOUS SPAN of that candidate which " +
  "states what he promised to do, and the span that says when, if the " +
  "candidate contains one. COPY THE WORDS. Do not paraphrase, do not fix " +
  "grammar, do not add a subject, do not merge two candidates, and do not omit " +
  "an item — return one for every number you were given. Anything you write " +
  "that is not a literal span of the candidate will be thrown away and the " +
  "untouched candidate used instead. Answer with JSON only: " +
  '{"items":[{"i":1,"promise":"…","dueHint":"…"|null}]}.';

type Item = { i?: unknown; promise?: unknown; dueHint?: unknown };

function parseItems(text: string, count: number): Map<number, { promise: string; dueHint: string | null }> {
  const out = new Map<number, { promise: string; dueHint: string | null }>();
  const body = text.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let doc: { items?: unknown };
  try {
    doc = JSON.parse(body.slice(start, end + 1)) as { items?: unknown };
  } catch {
    return out;
  }
  if (!Array.isArray(doc.items)) return out;
  for (const raw of doc.items as Item[]) {
    const i = Math.round(Number(raw?.i));
    if (!Number.isInteger(i) || i < 1 || i > count) continue;
    if (typeof raw.promise !== "string" || !raw.promise.trim()) continue;
    out.set(i, {
      promise: raw.promise.trim(),
      dueHint: typeof raw.dueHint === "string" && raw.dueHint.trim() ? raw.dueHint.trim() : null,
    });
  }
  return out;
}

/**
 * One judged promise after the span pass has (or has not) touched it.
 *
 * BOTH STRINGS ARE KEPT. `sentence` is what the owner typed, clipped and
 * otherwise untouched — the evidence, shown with every row. `what` is the
 * shortest span of it that states the promise, which is what a list reads well
 * and is the title `actionInbox.ts` puts on a board card. When no span came
 * back they are the same string, and `by` says which.
 */
export type Refined = {
  what: string;
  sentence: string;
  dueText: string | null;
  clipped: boolean;
  by: "model" | "verbatim";
};

/**
 * TIGHTEN EACH KEPT SENTENCE TO THE SPAN THAT STATES THE PROMISE.
 *
 * WHY THIS SURVIVED THE GATE REWRITE. It is not a second gate and it does not
 * decide anything: the question it asks is "which contiguous run of words in
 * THIS sentence is the undertaking", which has a right answer checkable against
 * the message itself, and `grounded()` checks it. The thing it produces is the
 * `what` column — the one line that becomes a board card's title and the inbox
 * row a person reads first — and a full sentence there reads badly: "Thanks for
 * sending those over, and I'll have the revised contract with you Thursday and
 * copy Jane in" is a worse card than "I'll have the revised contract with you
 * Thursday". Deleting it would have cost that and saved nothing but one call on
 * the sentences that were already kept.
 *
 * EVERY FAILURE PATH ENDS AT THE WHOLE SENTENCE — an unparseable reply, a
 * missing item, a reworded promise, an invented hint, a provider that is not
 * connected. The row still arrives, labelled `by: "verbatim"`, because a
 * promise with an untidy title is still a promise; this is the one half of the
 * model pass where being unreachable costs nothing at all.
 */
export async function refine(
  candidates: Candidate[],
  bodyNorm: string,
): Promise<{ items: Refined[]; model: string | null; refused: number; error: string | null }> {
  const asIs = (c: Candidate): Refined => ({
    what: c.sentence,
    sentence: c.sentence,
    dueText: c.dueText,
    clipped: c.clipped,
    by: "verbatim",
  });
  const fallback = candidates.map(asIs);
  if (!candidates.length) return { items: [], model: null, refused: 0, error: null };

  let model: string | null = null;
  let refused = 0;
  const items: Refined[] = [];

  for (let at = 0; at < candidates.length; at += REFINE_BATCH) {
    const batch = candidates.slice(at, at + REFINE_BATCH);
    try {
      const reply = await complete([
        { role: "system", content: SYSTEM },
        { role: "user", content: batch.map((c, i) => `${i + 1}. ${c.sentence}`).join("\n") },
      ]);
      model = `${reply.provider}${reply.model ? `:${reply.model}` : ""}`;
      const parsed = parseItems(reply.text, batch.length);
      batch.forEach((c, i) => {
        const got = parsed.get(i + 1);
        /* AN OMITTED ITEM IS NOT A REFUSAL ANY MORE. It used to mean "that is
           not a promise" and the candidate was dropped; the gate above owns that
           decision now, so an omission here is just a model that answered
           short, and the sentence keeps its own words. */
        if (!got) {
          items.push(asIs(c));
          return;
        }
        if (!grounded(got.promise, bodyNorm)) {
          refused += 1;
          items.push(asIs(c));
          return;
        }
        const hint =
          got.dueHint && grounded(got.dueHint, bodyNorm, 3) ? got.dueHint.slice(0, 60) : c.dueText;
        items.push({
          what: clip(got.promise).text,
          sentence: c.sentence,
          dueText: hint,
          clipped: c.clipped,
          by: "model",
        });
      });
    } catch (e) {
      /* The whole batch falls back. A provider that is not connected is the
         ordinary case on a fresh install, not an error worth failing on. */
      for (const c of batch) items.push(asIs(c));
      if (at === 0)
        return {
          items: fallback,
          model: null,
          refused: 0,
          error: e instanceof Error ? e.message : String(e),
        };
    }
  }
  return { items, model, refused, error: null };
}

/* ----------------------------------------------------------------- storage */

export type CommitmentRow = {
  id: string;
  mailbox: string;
  thread_id: string;
  message_id: string;
  to_address: string;
  to_name: string;
  subject: string;
  what: string;
  sentence: string;
  due_text: string | null;
  due: string | null;
  sent_at: string | null;
  status: string;
  found_at: string;
  decided_at: string | null;
};

export const idFor = (mailbox: string, threadId: string, sentence: string) =>
  createHash("sha256").update(`${mailbox}|${threadId}|${normalise(sentence)}`).digest("hex").slice(0, 24);

export function commitmentRows(status?: string): CommitmentRow[] {
  return (
    status
      ? db
          .prepare(
            "SELECT * FROM people_commitments WHERE status = ? ORDER BY sent_at DESC, found_at DESC",
          )
          .all(status)
      : db
          .prepare("SELECT * FROM people_commitments ORDER BY sent_at DESC, found_at DESC")
          .all()
  ) as unknown as CommitmentRow[];
}

export function commitmentRow(id: string): CommitmentRow | undefined {
  return db.prepare("SELECT * FROM people_commitments WHERE id = ?").get(id) as
    | CommitmentRow
    | undefined;
}

/** open → done | dismissed, and back. Nothing is deleted: a dismissal is a
 *  decision and losing the row loses the decision with it. */
export function decide(id: string, status: "open" | "done" | "dismissed"): CommitmentRow | undefined {
  db.prepare("UPDATE people_commitments SET status = ?, decided_at = ? WHERE id = ?").run(
    status,
    status === "open" ? null : now(),
    id,
  );
  return commitmentRow(id);
}

/* -------------------------------------------------------------- resolving */

/**
 * The owner's own words, read as a date — and only ever as one this box can
 * defend.
 *
 * A weekday name resolves to the NEXT such day after the message was sent;
 * "today"/"tomorrow" to the day of and the day after. Anything vaguer — "end
 * of the week", "next month" — resolves to nothing at all, because deciding
 * which Friday he meant is a decision this dashboard is not entitled to make.
 * The words are always kept; the date is a convenience beside them.
 */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function resolveDue(dueText: string | null, sentAtMs: number | null): string | null {
  if (!dueText || sentAtMs === null) return null;
  const t = dueText.toLowerCase();
  const base = new Date(sentAtMs);
  const day = (offset: number) =>
    new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  if (/\btoday\b|\btonight\b/.test(t)) return day(0);
  if (/\btomorrow\b/.test(t)) return day(1);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (!new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) continue;
    const ahead = (i - base.getUTCDay() + 7) % 7 || 7;
    return day(ahead);
  }
  return null;
}

/* ------------------------------------------------------------------ the scan */

export type ScanResult = {
  ok: boolean;
  runId: number;
  days: number;
  /** How many sent messages were LISTED, and how many were actually opened. */
  listed: number;
  scanned: number;
  truncated: boolean;
  /** Sentences of his own that were PUT TO THE JUDGE. Not pattern hits: since
   *  the word lists went, this is every sentence he wrote in the messages that
   *  were opened. */
  candidates: number;
  /** Judged `not` — the sentence was his own writing and was not a promise. */
  notPromise: number;
  /** Judged by nobody, because no model answered. These file NOTHING, which is
   *  this gate's fail-open direction, and the same rows are in `gate_verdicts`.
   *  A non-zero figure here means the scan under-reports. */
  unjudged: number;
  /** Sentences past the per-message ceiling, never shown to the judge. */
  unshown: number;
  /** Model spans that were not literal spans of the message. */
  refusedSpans: number;
  /** Sentences in messages whose recipient could not be read, and which were
   *  therefore never judged at all. Since the word lists went this counts every
   *  sentence of such a message rather than a handful of pattern hits, so it is
   *  a larger number than it used to be and means something slightly different:
   *  mail that could not be filed, measured in sentences. */
  noRecipient: number;
  alreadyKnown: number;
  filed: number;
  /** Who judged, and who tightened the spans. Two different calls and often two
   *  different models, and the first is the one that decided what was filed. */
  judgeModel: string | null;
  model: string | null;
  modelError: string | null;
  mailboxes: { accountId: number; mailbox: string | null; ok: boolean; error: string | null }[];
  error?: string | null;
};

/**
 * One scan of the owner's sent mail.
 *
 * IT IS NOT A COLLECTOR AND IT IS NOT ON A TIMER. Reading bodies is the one
 * thing in this area that would be a surprise if it happened by itself, so it
 * happens when the owner presses a button or an agent is asked to look —
 * never every half hour because the scheduler exists.
 */
export async function scan(days = DEFAULT_DAYS): Promise<ScanResult> {
  const window = Math.min(90, Math.max(1, Math.round(days) || DEFAULT_DAYS));
  /* THE SAME RUN LEDGER AS THE CONTACTS COLLECTOR, on purpose: both are this
     area reading the same mailbox with the same credential, and two plugin ids
     for one integration would put a second "connected/disconnected" state on
     the Integrations page for something the owner never connected. The note
     each run finishes with says which of the two it was. */
  const runId = startRun("people");
  const result: ScanResult = {
    ok: false,
    runId,
    days: window,
    listed: 0,
    scanned: 0,
    truncated: false,
    candidates: 0,
    notPromise: 0,
    unjudged: 0,
    unshown: 0,
    refusedSpans: 0,
    noRecipient: 0,
    alreadyKnown: 0,
    filed: 0,
    judgeModel: null,
    model: null,
    modelError: null,
    mailboxes: [],
  };

  const pairs = accounts.credentialed(
    "gmail",
    ["client-id", "client-secret", "refresh-token"],
    "scan_commitments",
  ).ready;
  if (!pairs.length) {
    result.error = "No Gmail account is connected, so there is no sent mail to read.";
    finishRun(runId, false, undefined, result.error);
    return result;
  }

  const known = new Set(commitmentRows().map((r) => r.id));

  for (const pair of pairs) {
    const box = {
      accountId: pair.account.id,
      mailbox: null as string | null,
      ok: false,
      error: null as string | null,
    };
    result.mailboxes.push(box);
    try {
      const session = await openMailbox("scan_commitments", pair.account.id);
      const mailbox = await profileAddress(session);
      box.mailbox = mailbox;

      const listing = await sentIds(session, window, MAX_MESSAGES);
      result.listed += listing.listed;
      result.truncated ||= listing.truncated;
      const read = await readSent(session, listing.ids);
      result.scanned += read.messages.length;

      for (const message of read.messages) await fileOne(message, mailbox, known, result);
      box.ok = true;
    } catch (e) {
      box.error = reason(e);
    }
  }

  result.ok = result.mailboxes.some((m) => m.ok);
  const note =
    `${result.scanned} sent messages over ${window}d, ` +
    `${result.candidates} sentences judged, ${result.filed} filed` +
    /* THE UNJUDGED COUNT IS IN THE RUN NOTE, not only in the JSON. The run
       ledger is where somebody looks when a fortnight came back empty, and "no
       model answered" is a different answer from "he promised nothing". */
    (result.unjudged ? `, ${result.unjudged} unjudged` : "");
  finishRun(
    runId,
    result.ok,
    note,
    result.ok ? undefined : (result.mailboxes.find((m) => m.error)?.error ?? "No mailbox answered."),
  );
  if (!result.ok) result.error = result.mailboxes.find((m) => m.error)?.error ?? "No mailbox answered.";
  return result;
}

/** One message, scanned and forgotten. The body never leaves this function. */
async function fileOne(
  message: SentMessage,
  mailbox: string,
  known: Set<string>,
  result: ScanResult,
) {
  const body = cleanBody(message.text);
  if (!body.trim()) return;
  const all = candidatesIn(body);
  if (!all.length) return;

  /* NO RECIPIENT, NO PROMISE — AND NO JUDGE CALL EITHER. A promise this box
     cannot say who was made to is a task with nobody's name on it, so nothing
     here could be filed whatever a model said; asking anyway would spend a call
     and show a model sentences for no possible outcome. The count is reported so
     the figure is comparable with the others. */
  if (!message.to) {
    result.noRecipient += all.length;
    return;
  }

  const candidates = all.slice(0, MAX_CANDIDATES);
  result.candidates += candidates.length;
  result.unshown += all.length - candidates.length;

  /* THE GATE. One call, every sentence of this message, both directions. */
  const gate = await judgePromises(candidates, message.id);
  if (gate.model) result.judgeModel = gate.model;
  if (gate.why && !result.modelError) result.modelError = gate.why;
  result.notPromise += gate.judged.filter((j) => j.verdict === "not").length;
  result.unjudged += gate.judged.filter((j) => j.verdict === "unjudged").length;

  const promises = keep(gate.judged);
  if (!promises.length) return;

  const refined = await refine(promises, normalise(body));
  if (refined.model) result.model = refined.model;
  if (refined.error && !result.modelError) result.modelError = refined.error;
  result.refusedSpans += refined.refused;

  const insert = db.prepare(
    `INSERT INTO people_commitments
       (id, mailbox, thread_id, message_id, to_address, to_name, subject, what,
        sentence, due_text, due, sent_at, status, found_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const item of refined.items) {
    const id = idFor(mailbox, message.threadId, item.sentence);
    if (known.has(id)) {
      result.alreadyKnown += 1;
      continue;
    }
    known.add(id);
    insert.run(
      id,
      mailbox,
      message.threadId,
      message.id,
      message.to,
      message.toName,
      /* The subject is a header the owner wrote himself and is what makes a
         row findable in his own mail client. It is the one piece of a message
         other than his sentence that is kept, and it is his own words. */
      message.subject.slice(0, 200),
      item.what,
      item.sentence,
      item.dueText,
      resolveDue(item.dueText, message.at),
      message.at === null ? null : new Date(message.at).toISOString(),
      now(),
    );
    result.filed += 1;
  }
}
