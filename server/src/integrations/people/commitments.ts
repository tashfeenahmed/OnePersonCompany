/**
 * COMMITMENTS — the promises the owner made in his own sent mail, and nothing
 * else.
 *
 * THE PRIVACY BARGAIN, WHICH IS THE FIRST THING TO KNOW. This is the only part
 * of this area that reads a message BODY. Bodies are transient by
 * construction: fetched in `gmail-sent.ts`, cleaned and scanned here, and gone
 * when `scan()` returns. Four things reach the database — one sentence of at
 * most 200 characters that the owner himself typed, who it was to, when it was
 * sent, and the thread it was in. No subject body, no snippet, no second
 * sentence for context, no draft of anything.
 *
 * IT IS HIS OWN WORDS OR IT IS NOT HERE. Only `in:sent` is read, so nothing
 * anybody else promised can appear and nothing he was ASKED to do can either.
 * A promise is a first-person future: "I'll", "we will", "let me". "You'll
 * send it over" is somebody else's business and never appears.
 *
 * TWO STAGES, AND THE MODEL IS NEVER THE ONLY GATE.
 *
 *   1. A DETERMINISTIC PASS finds candidate sentences — a first-person future
 *      marker, a doing verb after it, no negation within the next 48
 *      characters, no question mark, and not one of the closing pleasantries
 *      ("let me know if you need anything") that are furniture rather than
 *      promises. This pass alone can put a row on the page.
 *   2. THE MODEL IS SHOWN ONLY THOSE CANDIDATE SENTENCES — never the body,
 *      never the subject, never the recipient — and asked for the shortest
 *      CONTIGUOUS SPAN of each that states the promise, plus the span that
 *      says when, if there is one. Anything it returns that is not a literal
 *      span of the message is thrown away and the untouched candidate is used
 *      instead.
 *
 * That grounding gate is absolute and it is why a model is allowed near this
 * at all: a model that "helpfully" tightened "I'll try to look at it" into
 * "I'll fix it" would have this dashboard telling the owner he promised
 * something he did not. THE RECIPIENT AND THE DATE NEVER COME FROM THE MODEL —
 * they come from headers, which cannot hallucinate.
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

/** First-person futures. `we` is included because the owner writes as the
 *  business; "you'll" and "they will" are deliberately absent. */
const FUTURE = [
  /\b(?:i|we)['’]ll\b/gi,
  /\b(?:i|we)\s+(?:will|shall)\b/gi,
  /\b(?:i['’]m|i am|we['’]re|we are)\s+going to\b/gi,
  /\b(?:i|we)\s+(?:plan|intend|aim)\s+to\b/gi,
  /\blet me\b/gi,
];

const NEGATION = /\b(?:not|won['’]t|can['’]t|cannot|never|unable|no longer|don['’]t|doesn['’]t)\b/i;

/**
 * A doing verb after the marker.
 *
 * `have` is narrowed to "have it/that/this/them/the …" on purpose: bare `have`
 * turned "let me know if you have any questions" into a task, which is the
 * kind of false catch that teaches somebody to stop reading the list.
 */
const VERBS =
  /\b(?:send|sent|share|write|draft|prepare|put together|get|grab|make|build|fix|check|look|review|read|call|ring|email|reply|respond|follow up|update|confirm|book|schedule|set up|sort|arrange|add|remove|deploy|ship|publish|push|upload|invoice|pay|refund|introduce|forward|circle back|come back|revert|deliver|finish|complete|start|begin|do|handle|take care|have\s+(?:it|that|this|them|those|your|the\s+\w+))\b/i;

/** Closing pleasantries. "Let me know if you need anything" is furniture. */
const CLOSERS = [
  /let me know if (?:you|there)/i,
  /let me know (?:what|when|how|whether|if)/i,
  /let me know\s*[.!]/i,
  /i['’]?ll be (?:here|around|in touch)/i,
  /i['’]?ll look forward/i,
  /we['’]?ll speak soon/i,
  /i['’]?ll leave (?:it|that) with you/i,
  /let me know your thoughts/i,
];

/** How far from a marker a closer still counts as owning it. */
const CLOSER_REACH = 25;

function closerSpans(sentence: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const re of CLOSERS) {
    const m = re.exec(sentence);
    if (m && m.index >= 0) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** Every qualifying marker position — not the first. "Let me know what you
 *  need and I'll get it sorted" carries two, and the second is the promise. */
export function qualifyingMarks(sentence: string): number[] {
  const marks: number[] = [];
  for (const re of FUTURE) {
    re.lastIndex = 0;
    for (const m of sentence.matchAll(re)) {
      const i = m.index ?? -1;
      if (i < 0) continue;
      /* The negation window is SHORT on purpose: "I won't have time" must die
         at the marker, while "I'll send it Friday, though I can't promise the
         rest" is still a promise about the first thing. */
      if (NEGATION.test(sentence.slice(i, i + 48))) continue;
      if (!VERBS.test(sentence.slice(i))) continue;
      marks.push(i);
    }
  }
  return [...new Set(marks)].sort((a, b) => a - b);
}

/** Refuse only when EVERY qualifying marker belongs to a closing pleasantry. */
export function isCloser(sentence: string): boolean {
  const spans = closerSpans(sentence);
  if (!spans.length) return false;
  const marks = qualifyingMarks(sentence);
  if (!marks.length) return true;
  return marks.every((i) =>
    spans.some(([a, b]) => (i >= a && i < b) || (a >= i && a <= i + CLOSER_REACH)),
  );
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

/** The deterministic pass over one cleaned body. */
export function candidatesIn(body: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const raw of sentences(body)) {
    if (raw.length < 12) continue;
    /* The question mark is tested against the WHOLE sentence: "Can you confirm
       I'll get the file by Friday?" is him asking, not him promising. */
    if (raw.includes("?")) continue;
    if (!qualifyingMarks(raw).length) continue;
    if (isCloser(raw)) continue;
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

/* ------------------------------------------------------------ the model pass */

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

const SYSTEM =
  "You tidy up promise sentences taken from a person's own sent email. For " +
  "each numbered candidate return the shortest CONTIGUOUS SPAN of that " +
  "candidate which states what he promised to do, and the span that says " +
  "when, if the candidate contains one. COPY THE WORDS. Do not paraphrase, do " +
  "not fix grammar, do not add a subject, do not merge two candidates. " +
  "Anything you write that is not a literal span of the candidate will be " +
  "thrown away and the untouched candidate used instead. Answer with JSON " +
  'only: {"items":[{"i":1,"promise":"…","dueHint":"…"|null}]}. Omit an item ' +
  "entirely if it is not actually a promise to do something.";

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
 * One candidate after the model has (or has not) touched it.
 *
 * BOTH STRINGS ARE KEPT. `sentence` is what the owner typed, clipped and
 * otherwise untouched — the evidence, shown with every row. `what` is the
 * shortest span of it that states the promise, which is what a list reads
 * well. On a pattern-only row they are the same string, and the page says
 * which by showing `by`.
 */
export type Refined = {
  what: string;
  sentence: string;
  dueText: string | null;
  clipped: boolean;
  by: "model" | "pattern";
  dropped: boolean;
};

/**
 * Hand a batch of candidate sentences to the model.
 *
 * EVERY FAILURE PATH ENDS AT THE RAW CANDIDATE — an unparseable reply, a
 * missing item, a reworded promise, an invented hint, a provider that is not
 * connected. Without a model nothing is lost and nothing is invented; the rows
 * arrive labelled `by: "pattern"`, which the page and the skill both say out
 * loud. A feature whose whole value is remembering what you owe somebody
 * cannot go silent because a model endpoint is down.
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
    by: "pattern",
    dropped: false,
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
        /* An OMITTED item is the model saying "that is not a promise", which is
           the one judgement it is allowed to make — it can only remove, never
           add. */
        if (!got) {
          items.push({ ...asIs(c), by: "model", dropped: true });
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
          dropped: false,
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
  candidates: number;
  /** Dropped by the model as "not actually a promise". */
  droppedByModel: number;
  /** Model spans that were not literal spans of the message. */
  refusedSpans: number;
  noRecipient: number;
  alreadyKnown: number;
  filed: number;
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
    droppedByModel: 0,
    refusedSpans: 0,
    noRecipient: 0,
    alreadyKnown: 0,
    filed: 0,
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
    `${result.candidates} candidates, ${result.filed} filed`;
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
  const candidates = candidatesIn(body);
  if (!candidates.length) return;
  result.candidates += candidates.length;

  /* NO RECIPIENT, NO PROMISE. A promise this box cannot say who was made to is
     a task with nobody's name on it, and the count is reported so the figure
     is comparable with the others. */
  if (!message.to) {
    result.noRecipient += candidates.length;
    return;
  }

  const refined = await refine(candidates, normalise(body));
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
    if (item.dropped) {
      result.droppedByModel += 1;
      continue;
    }
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
