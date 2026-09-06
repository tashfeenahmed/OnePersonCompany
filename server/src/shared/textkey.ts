/**
 * IS THIS THE SAME SENTENCE WE ALREADY STORED.
 *
 * This is the identity half of every idempotent write on the box, and it has
 * to be ONE rule: a normalisation that folds digits in one store and keeps
 * them in another deduplicates the same statement here and files a second row
 * there. A fact restated in the same words is one fact everywhere, or it is
 * one fact nowhere.
 *
 * TWO NORMALISATIONS, AND THE DIFFERENCE BETWEEN THEM MATTERS
 *
 *   `textKey`      — strict. Case, punctuation and spacing removed, DIGITS
 *                    KEPT. Two statements that differ by a number are two
 *                    statements. Use it where the number is part of what was
 *                    said: a commitment ("I'll send the 3 files"), a note the
 *                    owner wrote, a promise extracted from a sent email.
 *
 *   `fingerprint`  — the IDENTITY of an observation, as opposed to its
 *                    wording. Everything `textKey` does, plus digits folded to
 *                    a marker and the result capped. "Listing has 4,100
 *                    installs" and "Listing has 4,180 installs" are ONE fact
 *                    read twice; a key that kept the digits would file the
 *                    second as new every morning and leave the store holding a
 *                    hundred readings of one sentence.
 *
 * Neither is a similarity measure. They answer "the same", not "alike" — a
 * caller wanting "alike" wants token overlap, which is a different question
 * with a different failure mode.
 *
 * WHAT WAS REJECTED: dropping stopwords. It makes "reply to the reviews" and
 * "reply to reviews" the same key — fine for clustering proposed actions,
 * wrong for a dedup key on something a person wrote, because it silently
 * discards a restatement a person would read as different. Stopword folding
 * belongs with the similarity code that wants it, not in the identity key.
 */

/**
 * The strict key: lower-cased, every run of non-alphanumerics collapsed to a
 * single space, trimmed. Deliberately blunt about punctuation — a model that
 * turned a curly apostrophe straight has not changed what was said.
 */
export function textKey(text: string | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How much of a fingerprint is kept.
 *
 * Long enough that two different paragraphs cannot collide on their opening
 * clause, short enough that the key stays an index-sized string. Statements
 * this box stores are sentences; anything past 200 characters is a document
 * that wanted its own stable id rather than a fingerprint.
 */
export const FINGERPRINT_MAX = 200;

/**
 * The digit-folded key. Numbers become `#`, so a figure that moves does not
 * create a new fact every time it is read.
 *
 * The digit pattern eats thousands separators and decimal points inside a
 * number (`4,180`, `12.5`, `1_000`) so those fold to one marker rather than to
 * three. `#` survives the punctuation strip on purpose — it is the marker.
 */
export function fingerprint(text: string | null | undefined, max: number = FINGERPRINT_MAX): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\d[\d,._]*/g, "#")
    .replace(/[^a-z0-9#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
