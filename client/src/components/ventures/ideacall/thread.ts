/**
 * THE FOCUS COLUMN, AS ARITHMETIC.
 *
 * The call has no scrollbar. Instead every message carries a natural height
 * (`--h`, measured once at full size) and a scale (`--s`) that falls off with
 * its distance from the focused turn, and the whole column is translated so the
 * focused turn lands on an anchor line just above the dock. Looking back is
 * therefore not scrolling — it is moving the focus, and an older turn GROWS
 * back to full size while the newer ones recede.
 *
 * THE MATH LIVES HERE, AWAY FROM THE DOM, for one reason: it is the part that
 * can be wrong in a way nobody sees until a long reply pushes the thread off
 * the top of the screen. The component writes styles and measures pixels; this
 * file only ever turns numbers into numbers, so it can be tested with
 * `node --test` and no browser at all.
 *
 * The heights that come in are the FULL-SIZE heights. Because each message's
 * inner box is sized in em, its rendered height is exactly `--h × --s`, which
 * is what lets the layout be computed in JS rather than read back out of the
 * document after every step.
 */

/** Scale by distance from the focused turn, clamped at four away. */
export const K = [1, 0.44, 0.34, 0.29, 0.26];
/** Opacity by the same distance. Anything further keeps the last value. */
export const O = [1, 0.34, 0.2, 0.13, 0.08];

/** Two extra pixels per message so a sub-pixel height never clips a descender. */
const PAD = 2;
/** The gap under a message: a constant, plus a part that shrinks with it. */
const GAP_FIXED = 10;
const GAP_SCALED = 24;
/** The anchor sits this far off the bottom of the column's viewport. */
const ANCHOR_INSET = 14;
/** How much of the viewport the turns AFTER the focused one may occupy. */
const TAIL_SHARE = 0.34;

const at = (table: number[], d: number): number =>
  table[Math.min(Math.max(d, 0), table.length - 1)] ?? 1;

export const scaleFor = (distance: number) => at(K, distance);
export const opacityFor = (distance: number) => at(O, distance);

export type ThreadLayout = {
  /** Clamped into range, so the caller can trust it as the new focus. */
  focus: number;
  scales: number[];
  opacities: number[];
  /** The translateY, in px, that puts the focused turn on the anchor line. */
  y: number;
  /** True when the focus is not the newest turn: the jump button shows. */
  behind: boolean;
};

/**
 * Where every message goes, given what they measure and which one is focused.
 *
 * The anchor is not a fixed line. It rises by however much the turns below the
 * focus need, capped at a third of the viewport — so stepping back one turn
 * lifts the column just enough to keep the newer ones in sight, and stepping
 * back ten does not lift it off the screen entirely.
 */
export function threadLayout(heights: number[], focus: number, viewportHeight: number): ThreadLayout {
  const n = heights.length;
  if (n === 0) return { focus: 0, scales: [], opacities: [], y: 0, behind: false };

  const f = Math.max(0, Math.min(Math.round(focus), n - 1));
  const scales: number[] = [];
  const opacities: number[] = [];

  let top = 0;
  let focusTop = 0;
  let focusHeight = 0;
  let tail = 0;

  for (let i = 0; i < n; i++) {
    const d = Math.abs(i - f);
    const s = scaleFor(d);
    scales.push(s);
    opacities.push(opacityFor(d));
    const h = (heights[i] ?? 0) * s + PAD;
    const m = GAP_FIXED + GAP_SCALED * s;
    if (i === f) {
      focusTop = top;
      focusHeight = h;
    }
    if (i > f) tail += h + m;
    top += h + m;
  }

  const anchor = viewportHeight - ANCHOR_INSET - Math.min(tail, viewportHeight * TAIL_SHARE);
  return {
    focus: f,
    scales,
    opacities,
    y: Math.round(anchor - (focusTop + focusHeight)),
    behind: f !== n - 1,
  };
}

/**
 * ONE REPLY, BROKEN INTO THE PARAGRAPHS THE CALL SPEAKS.
 *
 * The mockup's rhythm comes from a sequence of short `say()` calls, each
 * revealing its own words and pausing before the next. A model answers with one
 * blob, so the blob is cut back into that shape: whole sentences packed up to
 * `max` characters, never mid-word, and never an empty piece.
 *
 * A sentence longer than the budget is broken on a space rather than shortened,
 * because a hard line that reads badly is better than a line with a word missing
 * from it, and because the alternative — one enormous message — scales down to a
 * grey block the moment the next turn arrives.
 */
export function splitSay(text: string, max = 220): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean];
  const pieces: string[] = [];

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= max) {
      pieces.push(s);
      continue;
    }
    /* Too long to say in one breath: pack its words instead. */
    let line = "";
    for (const w of s.split(" ")) {
      if (line && line.length + 1 + w.length > max) {
        pieces.push(line);
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) pieces.push(line);
  }

  /* Join neighbours back up while they still fit: two short sentences read as
     one thought, and a lone "Right." on its own line looks like a mistake. */
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + 1 + p.length <= max) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

/**
 * Every turn reads as a sentence, typed or spoken — a capital at the front and
 * a full stop at the end, because dictation gives neither and the column is set
 * large enough that their absence is the first thing you see.
 */
export function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return t;
  const head = (t[0] ?? "").toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}

/**
 * The sentence an `updated` event turns into, under the orb.
 *
 * It names what moved rather than counting everything, because "Updated ·
 * Problem, First customer" tells the owner the call is writing their page and
 * "3 changes" does not. Empty in, null out: no caption for a turn that settled
 * nothing.
 */
export function updatedCaption(update: { fields: string[]; competitors: string[]; names: string[] }): string | null {
  const parts: string[] = [];
  if (update.fields.length) parts.push(`Updated · ${update.fields.join(", ")}`);
  if (update.competitors.length)
    parts.push(`Saved ${update.competitors.length} competitor${update.competitors.length === 1 ? "" : "s"}`);
  if (update.names.length)
    parts.push(`Shortlisted ${update.names.length} name${update.names.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : null;
}
