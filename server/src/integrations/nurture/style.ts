/**
 * THE VOICE — what the owner's edits teach, and the fence around it.
 *
 * The wording step writes in a voice this area DESCRIBED for it, in a string
 * constant written by somebody who has never read his mail. The only real
 * evidence about how he writes is what he does to a draft before pressing
 * approve: every deletion is a sentence he would not have sent, and every
 * rewrite is the sentence he would. That evidence was being thrown away.
 *
 * So: when a body the machine wrote is EDITED and then APPROVED, the (before,
 * after) pair is kept. The pairs are read once by the model and become a
 * handful of short imperative rules — "shorter greeting", "no exclamation
 * marks", "sign off with the first name and nothing else" — which are appended
 * to the wording prompt from then on.
 *
 * THE FOUR THINGS THIS MUST NEVER BECOME, AND HOW EACH IS PREVENTED.
 *
 *   A SECOND SOURCE OF FACTS. A rule is style and only style. The derivation
 *   prompt says so, and `notAStyleRule()` in validate.ts then refuses any rule
 *   carrying a digit, an address, a link, a domain or a person's name —
 *   refuses, does not strip, because a sanitised rule is a rule nobody wrote.
 *   And even a rule that got through all of that could not put a fact in an
 *   email: `ungrounded()` still reads the finished body against the packet
 *   afterwards, exactly as it did before this feature existed. The rules move
 *   words; the facts remain the only things that can be said.
 *
 *   SOMETHING THAT HAPPENS WITHOUT BEING ASKED FOR. The setting is OFF by
 *   default. With it off nothing is stored, nothing is derived, and the wording
 *   prompt is the constant it always was.
 *
 *   A RECORD HE CANNOT GET RID OF. "Forget the voice" empties the pairs, the
 *   rules and the refusals. It is one POST and it is on the page.
 *
 *   A LEAK. The pairs quote whole email bodies, his and the machine's. No route
 *   in this area publishes a pair's text: the document carries the rules, the
 *   refusals, and how many edits they came from.
 *
 *   THE ONE PLACE THOSE BODIES DO LEAVE THIS BOX is the derivation itself — up
 *   to twelve pairs, trimmed, go to the connected model provider on `derive()`,
 *   because there is no way to read a voice out of writing without showing the
 *   writing. That is stated here, in the setting's own hint and on the page,
 *   rather than left to be discovered: it is an opt-in feature about the
 *   owner's own mail, and "we keep the pairs private" would be a half-truth
 *   while a remote endpoint is being shown them.
 *
 * A DISMISSED DRAFT TEACHES NOTHING, on purpose. A dismissal is "not this
 * person, not now" — a judgement about whether to write at all — and reading it
 * as a verdict on the prose would learn the wrong lesson from the one signal
 * here that is definitely not about wording.
 */
import { configValue, db, now } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { notAStyleRule, STYLE_RULE_MAX } from "./validate.ts";
import { PORTFOLIO_VENTURE } from "../../runtime/budgets.ts";

export const PLUGIN = "nurture";

/** Below this, an "edit" is one afternoon's mood rather than a voice. */
export const MIN_PAIRS = 2;
/** Pairs shown to the model in one derivation, newest first, and how much of
 *  each body. A prompt that grew with the table would eventually blow the
 *  context and the symptom would be a voice that silently stopped updating. */
export const PAIRS_IN_PROMPT = 12;
export const PROMPT_BODY_CHARS = 1200;
export const MAX_RULES = 10;
/** A cap on the table, not a target. It quotes real email bodies, so it is the
 *  smallest number that still shows a pattern rather than an accident. */
export const MAX_PAIRS = 40;
const PAIR_MAX_CHARS = 4000;

export function learningOn(): boolean {
  const v = (configValue(PLUGIN, "style-learning") ?? "").trim().toLowerCase();
  /* OFF unless explicitly switched on. The opposite of the outbox's approval
     setting, and for the same reason: each fails towards the state that needs
     nobody's trust. */
  return v === "yes" || v === "on" || v === "true";
}

export type EditPair = {
  id: number;
  outbox_id: number;
  venture: string | null;
  before: string;
  after: string;
  at: string;
};

export type StyleRule = {
  id: number;
  rule: string;
  evidence: string;
  by_owner: number;
  model: string | null;
  derived_at: string;
  version: number;
};

/* ------------------------------------------------------------- the capture */

/**
 * An approve turned an edit into evidence.
 *
 * Called from the outbox's approve, and it is a no-op in every case that is not
 * exactly "the machine wrote this, a person changed it, and the person is now
 * standing behind the changed version":
 *
 *   * learning off                      — nothing is stored at all;
 *   * no `generated_body`               — the owner typed this draft himself,
 *                                         so there is no machine wording to
 *                                         compare his against;
 *   * generated_body === body           — he approved it unchanged, which is
 *                                         evidence about the draft and not
 *                                         about his voice;
 *   * a pair already exists for the row — approving a failed send again retries
 *                                         the transport, it does not teach the
 *                                         same lesson twice.
 *
 * It never throws. A style learner that could refuse an approval would be a
 * feature that can stop the owner sending his own mail.
 */
export function captureEdit(row: {
  id: number;
  body: string;
  generated_body: string | null;
  venture: string | null;
}): EditPair | null {
  try {
    if (!learningOn()) return null;
    const before = (row.generated_body ?? "").trim().slice(0, PAIR_MAX_CHARS);
    const after = (row.body ?? "").trim().slice(0, PAIR_MAX_CHARS);
    if (!before || !after || before === after) return null;
    const info = db
      .prepare(
        "INSERT OR IGNORE INTO nurture_edits (outbox_id, venture, before, after, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.venture, before, after, now());
    if (!info.changes) return null;
    /* The cap is applied here rather than by a sweep, so the table cannot grow
       between passes. Oldest first out: the newest edits are the ones that
       describe how he writes now. */
    db.prepare(
      `DELETE FROM nurture_edits WHERE id IN (
         SELECT id FROM nurture_edits ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`,
    ).run(MAX_PAIRS);
    return db.prepare("SELECT * FROM nurture_edits WHERE id = ?").get(Number(info.lastInsertRowid)) as EditPair;
  } catch (err) {
    console.error("[nurture] could not store a style pair:", err instanceof Error ? err.message : err);
    return null;
  }
}

export function pairs(): EditPair[] {
  return db.prepare("SELECT * FROM nurture_edits ORDER BY at DESC, id DESC").all() as unknown as EditPair[];
}

export function rules(): StyleRule[] {
  return db
    .prepare("SELECT * FROM nurture_style_rules ORDER BY by_owner DESC, id")
    .all() as unknown as StyleRule[];
}

export function refusals(): { id: number; rule: string; why: string; at: string }[] {
  return db
    .prepare("SELECT * FROM nurture_style_refusals ORDER BY at DESC LIMIT 20")
    .all() as unknown as { id: number; rule: string; why: string; at: string }[];
}

/** The lines the wording prompt is given, or an empty list. Empty is the
 *  normal state and produces exactly the prompt this area had before the
 *  feature existed. */
export function ruleLines(): string[] {
  if (!learningOn()) return [];
  return rules().map((r) => r.rule);
}

/* ---------------------------------------------------------- the derivation */

const SYSTEM =
  "You are reading pairs of short emails. In each pair, DRAFT is what a machine wrote and " +
  "SENT is what the owner actually sent after editing it by hand. Your only job is to describe " +
  "HOW HE REWORDS THINGS, so the next draft needs less editing.\n\n" +
  `Write at most ${MAX_RULES} rules. Each rule is ONE short imperative line, under ` +
  `${STYLE_RULE_MAX} characters, about WORDING ONLY: the greeting, the sign-off, sentence ` +
  "length, register, punctuation, phrases he deletes, words he prefers, how he asks for a " +
  "reply, what he cuts entirely. Prefer few strong rules to many weak ones — only write a rule " +
  "for something you can see in more than one pair.\n\n" +
  "FORBIDDEN, and a validator throws away any rule that breaks this before it is ever used: no " +
  "digits of any kind, no prices, no dates, no counts, no email addresses, no links, no domain " +
  "names, no customer or company names, no product names, no claim about the business or its " +
  "numbers. Spell a count as a word (\"four sentences\", never \"4\"). Write quoted example " +
  "phrases in lowercase. You are describing STYLE, never CONTENT — the content of every future " +
  "email comes from a fact packet you cannot see, and a rule that touches it is discarded.\n\n" +
  "Reply with the rules, one per line, each line starting with \"- \". No preamble, no " +
  "numbering, no explanation, no blank rules.";

/** The pairs, newest first, trimmed. NOTHING ELSE GOES OVER THE WIRE — not the
 *  recipient, not the subject, not the fact packet. The model is being asked
 *  about sentences, so it is shown sentences. */
export function derivationPrompt(list: EditPair[]): string {
  return `${list
    .slice(0, PAIRS_IN_PROMPT)
    .map((p, n) =>
      [
        `--- PAIR ${n + 1} ---`,
        "DRAFT (what the machine wrote):",
        p.before.slice(0, PROMPT_BODY_CHARS),
        "",
        "SENT (what he actually sent):",
        p.after.slice(0, PROMPT_BODY_CHARS),
      ].join("\n"),
    )
    .join("\n\n")}\n\nWrite the rules.`;
}

/**
 * One rule per line, however the model chose to decorate them. A WRAPPING pair
 * of quotes comes off; a quote at only one end does NOT, because a rule that
 * ends in a quoted phrase — `never write "i hope this finds you well"` — is the
 * most useful shape a rule here can have, and stripping its closing quote would
 * mangle exactly the rules worth keeping.
 */
export function parseRules(text: string): string[] {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .map((line) => {
      const wrapped = /^(["'`])(.*)\1$/.exec(line);
      return (wrapped ? wrapped[2]! : line).trim();
    })
    .filter(Boolean);
}

export type Derivation = {
  derived: boolean;
  rules: StyleRule[];
  refused: { rule: string; why: string }[];
  error: string | null;
  model: string | null;
};

/**
 * Read the pairs, write the rules.
 *
 * NEVER THROWS, and a failed derivation LEAVES THE OLD RULES IN PLACE. The last
 * set that worked is better than none and much better than an empty set
 * silently replacing a good one — a voice that quietly reset itself would look
 * exactly like a voice that had learned the owner writes like the machine.
 *
 * Rules the owner typed himself are kept: a derivation replaces what a previous
 * derivation wrote, not what a person decided.
 */
export async function derive(): Promise<Derivation> {
  const current = rules();
  if (!learningOn())
    return { derived: false, rules: current, refused: [], error: "Style learning is switched off in Settings → Nurture.", model: null };
  const list = pairs();
  if (list.length < MIN_PAIRS)
    return {
      derived: false,
      rules: current,
      refused: [],
      error: `only ${list.length} edited draft${list.length === 1 ? "" : "s"} on file — the voice is read from at least ${MIN_PAIRS}`,
      model: null,
    };

  let text = "";
  let model: string | null = null;
  try {
    const reply = await complete([
      { role: "system", content: SYSTEM },
      { role: "user", content: derivationPrompt(list) },
    ], { venture: PORTFOLIO_VENTURE });
    text = reply.text;
    model = reply.model;
  } catch (err) {
    return {
      derived: false,
      rules: current,
      refused: [],
      error: err instanceof Error ? err.message : String(err),
      model: null,
    };
  }

  const accepted: string[] = [];
  const refused: { rule: string; why: string }[] = [];
  for (const candidate of parseRules(text)) {
    if (accepted.length >= MAX_RULES) break;
    const why = notAStyleRule(candidate);
    if (why) refused.push({ rule: candidate.slice(0, 200), why });
    else accepted.push(candidate);
  }

  if (!accepted.length) {
    for (const r of refused)
      db.prepare("INSERT INTO nurture_style_refusals (rule, why, at) VALUES (?, ?, ?)").run(r.rule, r.why, now());
    return {
      derived: false,
      rules: current,
      refused,
      error: "every rule the model wrote was refused by the style-rule check, so the previous rules stand",
      model,
    };
  }

  const at = now();
  const version =
    Number(
      (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM nurture_style_rules").get() as { v: number }).v,
    ) + 1;
  const evidence = JSON.stringify(list.slice(0, PAIRS_IN_PROMPT).map((p) => p.id));
  /* THE HEADER SAYS THIS NEVER THROWS, so the transaction is caught here rather
     than rethrown. It used to rethrow a database error out of this function,
     which made the sentence above false for the one failure that would actually
     reach it. A rolled-back derivation leaves the PREVIOUS rules in place and
     says why — which is the same outcome as a model that could not be reached,
     and the same argument: the last set of rules that worked is better than
     none, and much better than an empty set silently replacing a good one. */
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM nurture_style_rules WHERE by_owner = 0").run();
      const insert = db.prepare(
        "INSERT INTO nurture_style_rules (rule, evidence, by_owner, model, derived_at, version) VALUES (?, ?, 0, ?, ?, ?)",
      );
      for (const rule of accepted) insert.run(rule, evidence, model, at, version);
      for (const r of refused)
        db.prepare("INSERT INTO nurture_style_refusals (rule, why, at) VALUES (?, ?, ?)").run(r.rule, r.why, at);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } catch (err) {
    return {
      derived: false,
      rules: current,
      refused,
      error: `the rules could not be stored (${err instanceof Error ? err.message : String(err)}), so the previous ones stand`,
      model,
    };
  }
  return { derived: true, rules: rules(), refused, error: null, model };
}

/** The owner's own rule. It goes through the same check the model's does: the
 *  table is hand-editable and a rule that would be refused if a machine wrote
 *  it is refused if a person did. */
export function addOwnerRule(rule: string): StyleRule {
  const why = notAStyleRule(rule);
  if (why) throw new Error(`That is not a style rule: ${why}.`);
  const info = db
    .prepare(
      "INSERT INTO nurture_style_rules (rule, evidence, by_owner, model, derived_at, version) VALUES (?, '[]', 1, NULL, ?, 1)",
    )
    .run(rule.trim(), now());
  return db.prepare("SELECT * FROM nurture_style_rules WHERE id = ?").get(Number(info.lastInsertRowid)) as StyleRule;
}

export function removeRule(id: number): boolean {
  return db.prepare("DELETE FROM nurture_style_rules WHERE id = ?").run(id).changes > 0;
}

/** Forget everything: the rules, the refusals and every stored pair. */
export function forgetVoice(): { rules: number; pairs: number; refusals: number } {
  return {
    rules: Number(db.prepare("DELETE FROM nurture_style_rules").run().changes),
    pairs: Number(db.prepare("DELETE FROM nurture_edits").run().changes),
    refusals: Number(db.prepare("DELETE FROM nurture_style_refusals").run().changes),
  };
}
