/**
 * THE STYLE GUIDE — the half of a brand nothing can measure.
 *
 * WHY THIS EXISTS AT ALL. Three generators on this box write words for a
 * business: the Studio's caption writer, the faceless video's script writer
 * and the reel's dialogue writer. All three are handed the same four facts —
 * the name, the sentence the owner typed into the venture form, the stage and
 * the address — and then asked to sound like the business. They cannot,
 * because none of those four says how it sounds. The palette does not help:
 * ventures/enrich.ts measures hexes and font stacks off the site, which tells
 * an image model what colour to paint and tells a WRITER nothing.
 *
 * So this is the owner's own guidance, typed once and read by all three. It is
 * OPINION and it is labelled as opinion everywhere it travels — see
 * `guidePrompt` — because the rest of a prompt on this box is evidence, and a
 * model that cannot tell the two apart will happily invent a fifth fact in the
 * same register as the four it was given.
 *
 * THE FIELDS ARE PROSE AND EVERY ONE OF THEM IS OPTIONAL. There is no schema
 * of allowed tones and no list of permitted audiences; a dropdown would be
 * this file deciding in advance what a one-person software business is allowed
 * to sound like. What IS enforced is a length per field, which is not style
 * policing: these strings go into a prompt beside the facts, and a
 * ten-thousand-word guide would push the evidence out of the context window it
 * was meant to constrain.
 *
 * NULL MEANS UNWRITTEN AND IS NEVER RENDERED AS AN EMPTY INSTRUCTION. A guide
 * with a tone and no audience produces a prompt block with a tone and no
 * audience line — not a line reading "Audience:" with nothing after it, which
 * a model reads as a question it should answer.
 *
 * WHY IT IS NOT A KEY INSIDE `ventures.brand`. That column is rewritten whole
 * by every successful site read, so a paragraph kept in it would be destroyed
 * on a schedule by a process that has no idea it was there. A measurement and
 * a judgement do not share a writer. See migrations.ts.
 */
import { db, now, ventureRowById } from "../../db.ts";

/**
 * The fields, and the ceiling on each.
 *
 * The numbers are budgets in a prompt rather than opinions about brevity.
 * `dos` and `donts` are the longest because they are lists in prose — one line
 * per rule is how people actually write them — and `language` is the shortest
 * because the answer is "English" or "English, with Arabic for the Gulf ads",
 * never a paragraph.
 */
export const GUIDE_LIMITS = {
  summary: 1_200,
  tone: 600,
  audience: 600,
  dos: 1_200,
  donts: 1_200,
  colours: 400,
  fonts: 400,
  language: 160,
  notes: 2_000,
} as const;

export type GuideField = keyof typeof GUIDE_LIMITS;

export const GUIDE_FIELDS = Object.keys(GUIDE_LIMITS) as GuideField[];

export type GuideRow = Record<GuideField, string | null> & {
  venture_id: string;
  updated_at: string;
};

export type Guide = Record<GuideField, string | null> & {
  ventureId: string;
  /** Whether anything has actually been written. A row of nine nulls is a row
   *  somebody saved a blank form into, and it is not a guide. */
  written: boolean;
  updatedAt: string | null;
};

export function guideRow(ventureId: string): GuideRow | undefined {
  return db.prepare("SELECT * FROM style_guides WHERE venture_id = ?").get(ventureId) as
    | GuideRow
    | undefined;
}

/** The shape every route answers with, INCLUDING for a venture that has no
 *  row: a page that has to draw an empty form should not have to invent the
 *  keys, and an agent asking about an unwritten guide should be told it is
 *  unwritten rather than handed a 404 it will read as "no such venture". */
export function shapeGuide(ventureId: string, row: GuideRow | undefined): Guide {
  const out = { ventureId, written: false, updatedAt: row?.updated_at ?? null } as Guide;
  for (const field of GUIDE_FIELDS) {
    const value = row?.[field] ?? null;
    out[field] = value;
    if (value) out.written = true;
  }
  return out;
}

/** Which ventures have written anything, as a set, for the overview. One
 *  statement rather than one per venture. */
export function writtenGuides(): Map<string, string> {
  const rows = db.prepare("SELECT * FROM style_guides").all() as unknown as GuideRow[];
  const out = new Map<string, string>();
  for (const row of rows)
    if (GUIDE_FIELDS.some((f) => (row[f] ?? "").trim())) out.set(row.venture_id, row.updated_at);
  return out;
}

export type SaveResult = { ok: true; guide: Guide } | { ok: false; error: string };

/**
 * Write the fields that were sent, and leave the rest alone.
 *
 * A FIELD THAT IS ABSENT IS NOT A FIELD THAT WAS CLEARED. The page sends all
 * nine and an agent sends the one it was asked to change, and the difference
 * has to survive: an agent told "add a note about not saying 'users'" must not
 * silently erase the tone of voice because it did not have one to send.
 * Clearing is still possible and is still explicit — send the field as an
 * empty string.
 *
 * VALIDATED BEFORE ANYTHING IS WRITTEN, so a guide is never half-saved. The
 * error names the field and its ceiling, because "too long" without a number
 * is a message somebody has to guess at.
 */
export function saveGuide(
  ventureId: string,
  patch: Partial<Record<GuideField, unknown>>,
): SaveResult {
  if (!ventureRowById(ventureId)) return { ok: false, error: `There is no venture ${ventureId}.` };

  const clean: Partial<Record<GuideField, string | null>> = {};
  for (const field of GUIDE_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const raw = patch[field];
    if (raw === null) {
      clean[field] = null;
      continue;
    }
    if (typeof raw !== "string")
      return { ok: false, error: `\`${field}\` is text — send a string, or null to clear it.` };
    const trimmed = raw.trim();
    if (trimmed.length > GUIDE_LIMITS[field])
      return {
        ok: false,
        error:
          `\`${field}\` is ${trimmed.length} characters; the ceiling is ${GUIDE_LIMITS[field]}. ` +
          "It is a budget in a prompt rather than a rule about writing: a guide longer than this " +
          "pushes the facts it was meant to constrain out of the model's context.",
      };
    clean[field] = trimmed || null;
  }

  const fields = Object.keys(clean) as GuideField[];
  if (!fields.length)
    return { ok: false, error: `Send at least one of: ${GUIDE_FIELDS.join(", ")}.` };

  const ts = now();
  const existing = guideRow(ventureId);
  if (!existing) {
    db.prepare(
      `INSERT INTO style_guides (venture_id, ${GUIDE_FIELDS.join(", ")}, updated_at)
       VALUES (?, ${GUIDE_FIELDS.map(() => "?").join(", ")}, ?)`,
    ).run(ventureId, ...GUIDE_FIELDS.map((f) => clean[f] ?? null), ts);
  } else {
    db.prepare(
      `UPDATE style_guides SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ?
        WHERE venture_id = ?`,
    ).run(...fields.map((f) => clean[f] ?? null), ts, ventureId);
  }
  return { ok: true, guide: shapeGuide(ventureId, guideRow(ventureId)) };
}

/* ------------------------------------------------------ into a prompt */

/** How the block is introduced wherever it lands. One sentence, and it does
 *  two jobs: it says whose words these are, and it says what happens when they
 *  disagree with the measurements above them. */
const HEADER =
  "THE OWNER'S OWN STYLE GUIDE FOR THIS BUSINESS. He wrote it himself: it is " +
  "instruction, not evidence, and it does not license a claim. Where it " +
  "disagrees with anything else about register, audience or wording, it wins. " +
  "It never permits a fact that was not given above.";

/**
 * The five things a writer needs, as a block, or null when nothing is written.
 *
 * NULL RATHER THAN AN EMPTY STRING, so every caller's `if` reads the same and
 * an unwritten guide costs a prompt nothing at all — not a header over a blank
 * space, which is the version a model tries to fill in.
 *
 * `colours` AND `fonts` ARE DELIBERATELY NOT HERE. A caption writer cannot act
 * on a hex, and a line about navy in a text prompt is a line the model will
 * find a way to mention. They go to the image prompt instead, through
 * `guideVisuals`.
 */
export function guidePrompt(ventureId: string | null | undefined): string | null {
  if (!ventureId) return null;
  let row: GuideRow | undefined;
  try {
    row = guideRow(ventureId);
  } catch {
    /* A prompt is not the place to discover the table is missing. A guide that
       cannot be read costs the prompt its guidance, not the generation. */
    return null;
  }
  if (!row) return null;
  const lines: string[] = [];
  const add = (label: string, value: string | null) => {
    if (value?.trim()) lines.push(`- ${label}: ${value.trim()}`);
  };
  add("What this business is, in his words", row.summary);
  add("Tone of voice", row.tone);
  add("Who it is for", row.audience);
  add("Do", row.dos);
  add("Never", row.donts);
  add("Language", row.language);
  if (!lines.length) return null;
  return [HEADER, ...lines].join("\n");
}

/** The two visual fields, for an image prompt. Prose, because "the green on
 *  the site is the old logo, use the navy" has no column shape. */
export function guideVisuals(ventureId: string | null | undefined): {
  colours: string | null;
  fonts: string | null;
} {
  if (!ventureId) return { colours: null, fonts: null };
  try {
    const row = guideRow(ventureId);
    return { colours: row?.colours?.trim() || null, fonts: row?.fonts?.trim() || null };
  } catch {
    return { colours: null, fonts: null };
  }
}
