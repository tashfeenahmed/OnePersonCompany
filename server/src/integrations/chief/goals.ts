/**
 * GOALS — the small document everything else is read through.
 *
 * WHY IT IS SMALL ON PURPOSE. The temptation with a goals feature is a
 * hierarchy: objectives, key results, quarters, owners, progress bars. All of
 * that is a project-management product, and the failure mode of one on a
 * one-person box is that the structure outlives the intention — a tree of
 * stale OKRs the owner stopped editing in March and the agent is still
 * steering by in September. So this is TWO TEXT FIELDS: what the owner is
 * doing with the whole estate, and what they are doing with one venture. Both
 * are markdown, both are the owner's own words, and both are short enough to
 * paste into a system turn without a budget conversation.
 *
 * "WHAT TO TAILOR ADVICE TO" IS DERIVED, NOT TYPED. Every venture already
 * carries a STAGE the owner picked off a form that explained it, and
 * routes/ventures.ts already publishes the sentence that stage means. Asking
 * the owner to also write "tailor advice to pre-launch" would be asking them to
 * restate a field they have already filled in, and the two would eventually
 * disagree. So the stage line is composed here from the venture record, and
 * what the owner writes is only the part no field holds.
 *
 * THE AGENT MAY READ THESE AND MAY WRITE THEM ONLY WHEN ASKED, which is a rule
 * and not a mechanism — there is a `set` action, because an owner saying "make
 * my goal for Example Support revenue not signups" should not have to go and type
 * it. What the skill's rules forbid is the thing an eager assistant does
 * otherwise: tidying the wording, merging two goals, or "updating" a goal to
 * match what it has just observed. A goal that the agent has quietly edited to
 * match reality is no longer a goal.
 */
import { db, now, ventureRow, ventureRowById, type VentureRow } from "../../db.ts";

/** The longest a goals document may be. Long enough for a page of markdown,
 *  short enough that twenty of them could not be a context budget on their
 *  own — and the injection only ever carries two of them. */
export const MAX_GOAL = 4_000;

export type GoalRow = {
  scope: string;
  venture_id: string;
  text: string;
  updated_at: string;
};

export type GoalDoc = {
  scope: "global" | "venture";
  ventureId: string | null;
  ventureName: string | null;
  ventureSlug: string | null;
  /** The owner's markdown. "" means nothing has been written, which is a real
   *  and ordinary state rather than a missing record. */
  text: string;
  /** Null where nothing has ever been written for this scope. */
  updatedAt: string | null;
  /** For a venture: the stage and what it means, which is the half of "what to
   *  tailor advice to" nobody should have to type twice. Null for global. */
  tailorTo: string | null;
};

/* ------------------------------------------------------------------ stages */

/**
 * WHAT EACH STAGE MEANS FOR ADVICE, in one line.
 *
 * routes/ventures.ts publishes a longer sentence per stage for the venture
 * document; this is deliberately a different, shorter sentence written for the
 * top of a system turn, because that turn also carries the roster, the team and
 * the memory and a paragraph per venture would crowd all of it out. An unknown
 * stage — one added by another area later — falls back to the bare word rather
 * than to a guess about what it means.
 */
const TAILOR: Record<string, string> = {
  idea:
    "nothing is built or sold yet, so advice is about evidence and the cheapest " +
    "test — never about optimisation, retention or scale.",
  "pre-launch":
    "it is being built and has no customers, so advice is about getting the " +
    "first ones and about what would make launching wrong — never about churn.",
  launched:
    "it is live and has users or revenue, so advice is about what the numbers " +
    "here actually say: retention, cost, and where the growth is coming from.",
};

export function tailorFor(stage: string): string {
  return TAILOR[stage] ?? `stage "${stage}", which this box has no guidance for.`;
}

/* ------------------------------------------------------------------- reads */

function row(scope: string, ventureId: string): GoalRow | undefined {
  return db
    .prepare("SELECT * FROM chief_goals WHERE scope = ? AND venture_id = ?")
    .get(scope, ventureId) as GoalRow | undefined;
}

export function globalGoal(): GoalDoc {
  const r = row("global", "");
  return {
    scope: "global",
    ventureId: null,
    ventureName: null,
    ventureSlug: null,
    text: r?.text ?? "",
    updatedAt: r?.updated_at ?? null,
    tailorTo: null,
  };
}

/** One venture's goals. Null when the key names no venture — a client holding
 *  a venture deleted in another tab is a stale page, not a bad request, and
 *  the caller decides which of those to say. */
export function ventureGoal(key: string): GoalDoc | null {
  const v = ventureRow(key);
  if (!v) return null;
  return ventureGoalFor(v);
}

function ventureGoalFor(v: VentureRow): GoalDoc {
  const r = row("venture", v.id);
  return {
    scope: "venture",
    ventureId: v.id,
    ventureName: v.name,
    ventureSlug: v.slug,
    text: r?.text ?? "",
    updatedAt: r?.updated_at ?? null,
    tailorTo: tailorFor(v.stage),
  };
}

/** Every venture's goals, in the owner's own order, whether or not anything
 *  has been written for them — a page that listed only the ones with text
 *  would hide the ones that need writing, which is the list that matters. */
export function allVentureGoals(): GoalDoc[] {
  pruneOrphans();
  return db
    .prepare("SELECT * FROM ventures ORDER BY position, id")
    .all()
    .map((v) => ventureGoalFor(v as unknown as VentureRow));
}

/** Rows whose venture is gone. Done on read rather than by a foreign key, for
 *  080_subagents' reason: the constraint would cross an area seam. */
function pruneOrphans(): void {
  db.prepare(
    "DELETE FROM chief_goals WHERE scope = 'venture' AND venture_id NOT IN (SELECT id FROM ventures)",
  ).run();
}

/* ------------------------------------------------------------------ writes */

export type GoalHistoryRow = {
  id: number;
  scope: string;
  venture_id: string;
  text: string;
  by: string;
  written_at: string;
};

export function goalHistory(scope: string, ventureId: string, limit = 20): GoalHistoryRow[] {
  return db
    .prepare(
      `SELECT * FROM chief_goal_history
        WHERE scope = ? AND venture_id = ?
        ORDER BY id DESC LIMIT ?`,
    )
    .all(scope, ventureId, Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as GoalHistoryRow[];
}

/**
 * Write a goals document, keeping what it replaced.
 *
 * THE HISTORY ROW HOLDS THE OLD TEXT AND NOT THE NEW ONE. A version list of
 * what things became is a list you have to read backwards to answer "what did
 * it say before I changed it", which is the only question anybody asks of it.
 *
 * AN IDENTICAL WRITE IS NOT A VERSION. Saving a form without changing it — the
 * page does this on every blur — would otherwise fill the history with
 * paragraphs identical to the one above them, and the one edit somebody wants
 * back would be forty rows down.
 */
export function setGoal(
  scope: "global" | "venture",
  ventureId: string,
  text: string,
  by: "owner" | "agent",
): GoalDoc {
  const existing = row(scope, ventureId);
  const ts = now();
  if (existing && existing.text !== text)
    db.prepare(
      `INSERT INTO chief_goal_history (scope, venture_id, text, by, written_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, ventureId, existing.text, by, ts);

  db.prepare(
    `INSERT INTO chief_goals (scope, venture_id, text, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, venture_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
  ).run(scope, ventureId, text, ts);

  if (scope === "global") return globalGoal();
  const v = ventureRowById(ventureId);
  return v ? ventureGoalFor(v) : globalGoal();
}

/* --------------------------------------------------- what routes/chat.ts asks */

/**
 * THE GOALS AS A SYSTEM TURN, capped.
 *
 * Written here rather than in routes/chat.ts on the rule `ventureContext` and
 * `ventureTeamLines` already keep: the prose about a thing has one author and
 * it is the file that owns the thing.
 *
 * TWO DOCUMENTS AT MOST — the global one, and the one for the venture this
 * conversation is filed under. Not every venture's: nineteen goal paragraphs
 * would be the whole system turn, and an agent given all nineteen has no way to
 * tell which one the question is about. An unscoped conversation gets the
 * global goals alone, which is the correct answer to "what am I trying to do".
 *
 * EMPTY IS SILENT. A turn that said "the owner has written no goals" would be
 * an instruction to go and ask for some, which is not what the owner wanted
 * when they left the box empty.
 */
export function goalLines(ventureId: string | null): string[] {
  const lines: string[] = [];
  const g = globalGoal();
  if (g.text.trim()) {
    lines.push(
      `THE OWNER'S GOALS FOR THE WHOLE BUSINESS, in their own words, last ` +
        `edited ${g.updatedAt?.slice(0, 10) ?? "at an unknown time"}. Read every ` +
        `answer through them; they are what "good" means here:`,
      clamp(g.text),
    );
  }
  const v = ventureId ? ventureGoal(ventureId) : null;
  if (v) {
    if (v.text.trim())
      lines.push(
        ``,
        `THE OWNER'S GOALS FOR ${v.ventureName}, last edited ` +
          `${v.updatedAt?.slice(0, 10) ?? "at an unknown time"}:`,
        clamp(v.text),
      );
    if (v.tailorTo) lines.push(``, `Tailor advice for ${v.ventureName} to: ${v.tailorTo}`);
  }
  if (lines.length)
    lines.push(
      ``,
      `These are the owner's words. Do not rewrite, tidy or "update" a goal ` +
        `unless you were asked to change it in that turn.`,
    );
  return lines;
}

/**
 * The venture's goals as the one line a run brief carries.
 *
 * A BRIEF IS NOT A CONVERSATION, so this is deliberately terser than the chat
 * turn: a sub-agent doing a demand study needs to know what the owner is trying
 * to achieve, not to be lectured about editing goals it has no way to edit.
 * Null when nothing is written, so `subagents/routes.ts` prepends nothing
 * rather than a heading with no body.
 */
export function goalBriefLine(ventureId: string): string | null {
  const v = ventureRowById(ventureId);
  if (!v) return null;
  const g = row("venture", v.id);
  const text = (g?.text ?? "").trim();
  if (!text) return null;
  return `The owner's goals for ${v.name}, in their own words: ${clamp(text, 1_200)}`;
}

/** A goals document is capped before it goes into a prompt. The cap is
 *  generous and the truncation is ANNOUNCED, because a goal cut off mid-clause
 *  and presented as complete is worse than one the reader knows is partial. */
function clamp(text: string, max = 1_800): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n… (goals truncated for this turn; the full text is on /workflows)`;
}
