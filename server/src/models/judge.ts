/**
 * ONE WAY TO ASK A MODEL A CLOSED QUESTION ABOUT A BATCH OF THINGS.
 *
 * WHY THIS EXISTS. The owner's rule, 2026-09-21: "never use word matching for
 * gates — it should be an LLM-based gate". An audit found nineteen gates across
 * this codebase deciding a matter of meaning with a list of words: does this
 * evidence dismiss itself, is this title a shrug, is this query somebody
 * navigating to us or describing a need, did the owner promise this in his own
 * sent mail, is this the same piece of work as last week's. Each one needs the
 * same five things around the judgment, and writing them five times is how they
 * drift:
 *
 *   1. ONE CALL FOR THE BATCH, not one per item. The items arrive together, a
 *      round trip costs the same whether it carries one or twenty, and a model
 *      shown the whole batch can answer "these two are the same" — which a
 *      per-item call cannot see at all.
 *   2. A CLOSED VOCABULARY, checked. A verdict outside the allowed set is not
 *      quietly read as the strict answer; it makes the whole reply unusable.
 *      Guessing a refusal is how a gate eats real work.
 *   3. ALL OR NOTHING. A reply that judges four of seven items is discarded.
 *      Applying half and defaulting the rest reads, downstream, exactly like a
 *      model that approved the rest.
 *   4. FAIL OPEN, VISIBLY. Unreachable, or unparseable twice, and every item
 *      comes back `unjudged`. Each caller decides what that means for it, and
 *      the honest default is to let the content through: a gate that silently
 *      drops real work because a GPU was busy costs more than the noise it was
 *      built to stop.
 *   5. EVERY VERDICT RECORDED. `pipeline/synthesis.ts` refused to use a model
 *      for exactly one stated reason — "asking a second model would make the
 *      rule unobservable except by running a night". That objection is right,
 *      and `gate_verdicts` answers it: what was judged, what the answer was,
 *      why, and by which model. "Why did that disappear" becomes a query.
 *
 * WHAT THIS IS NOT. It is not for facts. Whether a host equals a host, whether
 * a URL is in the sitemap, whether a fence parses, whether two ids match — all
 * of that stays code, because it is checkable and a model would only add
 * latency and doubt. This is for the questions where a competent person could
 * disagree with the answer.
 */
import { complete } from "./provider.ts";
import { db, now } from "../db.ts";

/**
 * What the judge was asked about.
 *
 * `key` is the caller's own identifier for the item — a card index, a GSC
 * query, a pointer to a sentence — and is how the caller finds the verdict back.
 * It must be unique within the batch.
 *
 * `subject` IS WHAT THE RECORD SHOWS, and it exists because those two jobs pull
 * in opposite directions. An index is a perfect key and a useless record: a
 * `gate_verdicts` row reading `subject: "0"` cannot answer "why was my proposal
 * dropped", which is the only question the table is for. Meanwhile a sentence
 * from the owner's own sent mail makes a readable record and a terrible one to
 * store, because the table would become a copy of everything he has written.
 * So the caller chooses each independently, and `subject` defaults to `key`.
 */
export type JudgeItem = { key: string; text: string; subject?: string };

export type JudgeVerdict<T extends string> = {
  key: string;
  /** One of the caller's words, or `unjudged` when no model answered. */
  verdict: T | "unjudged";
  why: string;
};

export type JudgeResult<T extends string> = {
  /** Every item, in the order given. Never shorter than the input. */
  verdicts: JudgeVerdict<T>[];
  by: Map<string, JudgeVerdict<T>>;
  model: string | null;
  /** Why nothing was judged, when that is the case. Null on a clean answer. */
  why: string | null;
};

/**
 * READ A REPLY. Pure and exported, because the fragile half of an LLM gate is
 * reading the answer and that half deserves tests without a provider.
 *
 * Tolerant in the three ways models actually stray: a fence around the object,
 * a bare array instead of the documented wrapper, and a verdict with odd case
 * or padding. Intolerant of everything else, on purpose.
 */
export function readJudgement<T extends string>(
  text: string,
  keys: string[],
  allowed: readonly T[],
): JudgeVerdict<T>[] | null {
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

  const words = new Set<string>(allowed);
  const seen = new Map<string, JudgeVerdict<T>>();
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const word = String(r.verdict ?? "").trim().toLowerCase();
    if (!words.has(word as T)) continue;
    /* A missing or unknown key means "the nth item you gave me", which is what
       a model that dropped the field meant and the order it answered in. */
    const given = r.key === undefined || r.key === null ? "" : String(r.key).trim();
    const key = keys.includes(given) ? given : (keys[i] ?? "");
    if (!key || seen.has(key)) continue;
    seen.set(key, { key, verdict: word as T, why: String(r.why ?? "").trim().slice(0, 300) });
  }

  if (seen.size !== keys.length) return null;
  return keys.map((k) => seen.get(k)!);
}

/**
 * ASK. Never throws — a gate that can break its caller is a gate that will
 * eventually lose somebody's work.
 *
 * `question` is the whole system turn: what is being decided, what each verdict
 * word means, and which way to lean when it is genuinely unclear. Leaning is
 * the caller's decision to state, because "when unsure, let it through" is
 * right for a board card and wrong for an outbound email.
 */
export async function judge<T extends string>(opts: {
  /** Names the gate in `gate_verdicts` and in the log. Stable, lowercase. */
  gate: string;
  question: string;
  items: JudgeItem[];
  allowed: readonly T[];
  /** Extra context above the list — the venture, the open cards, the figures. */
  context?: string;
  signal?: AbortSignal;
  /** Skip the recording table. For a gate asked on a very hot path. */
  record?: boolean;
  /** The venture the verdict is for, in the budget ledger. See
   *  `CompleteOptions.venture`. */
  venture?: string | null;
}): Promise<JudgeResult<T>> {
  const keys = opts.items.map((i) => i.key);
  /* RECORDED ON THE WAY OUT, INCLUDING THIS PATH. An unreachable model is the
     most important thing this table can tell the owner — a gate that quietly
     stopped judging looks, from every other angle, exactly like a gate that
     approves everything. The first version of this function returned the
     unreachable case without writing a row, and its own test caught it. */
  const subjects = new Map(opts.items.map((i) => [i.key, i.subject?.trim() || i.key]));
  /** The same verdict, recorded under what a person would recognise. */
  const named = <V extends JudgeVerdict<T>>(v: V): V => ({ ...v, key: subjects.get(v.key) ?? v.key });
  const blank = (why: string): JudgeResult<T> => {
    const verdicts = keys.map((key) => ({ key, verdict: "unjudged" as const, why }));
    if (opts.record !== false) recordJudgement(opts.gate, verdicts.map(named), null);
    return { verdicts, by: new Map(verdicts.map((v) => [v.key, v])), model: null, why };
  };
  if (!opts.items.length) return { verdicts: [], by: new Map(), model: null, why: null };

  const shape =
    `Answer with ONLY a JSON object: {"verdicts":[{"key":"…","verdict":"${opts.allowed[0]}","why":"one short clause"}]} — ` +
    `one entry for every item, its \`key\` copied exactly, \`verdict\` one of ${opts.allowed.map((a) => `"${a}"`).join(" or ")}. No prose outside the object.`;
  const list = opts.items
    .map((i) => `key: ${i.key}\n${i.text.replace(/\s+/g, " ").slice(0, 700)}`)
    .join("\n\n");
  const turns = [
    { role: "system" as const, content: `${opts.question}\n\n${shape}` },
    {
      role: "user" as const,
      content: `${opts.context ? `${opts.context}\n\n` : ""}${list}\n\nJudge all ${opts.items.length}.`,
    },
  ];

  let model: string | null = null;
  for (const attempt of [0, 1]) {
    let text: string;
    try {
      const reply = await complete(
        attempt === 0 ? turns : [...turns, { role: "system" as const, content: `STOP. ${shape}` }],
        { jsonObject: true, signal: opts.signal, venture: opts.venture },
      );
      text = reply.text;
      model = reply.model;
    } catch (err) {
      return blank(err instanceof Error ? err.message.slice(0, 200) : "the model could not be reached.");
    }
    const verdicts = readJudgement(text, keys, opts.allowed);
    if (verdicts) {
      if (opts.record !== false) recordJudgement(opts.gate, verdicts.map(named), model);
      return { verdicts, by: new Map(verdicts.map((v) => [v.key, v])), model, why: null };
    }
  }
  return blank("the model did not answer with a verdict for every item.");
}

/** Write a batch of verdicts down. Swallows its own failure: a gate that cannot
 *  log is still a gate, and the caller has already made its decision. */
export function recordJudgement<T extends string>(
  gate: string,
  verdicts: JudgeVerdict<T>[],
  model: string | null,
): void {
  try {
    const at = now();
    const stmt = db.prepare(
      `INSERT INTO gate_verdicts (gate, subject, verdict, why, model, at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const v of verdicts) stmt.run(gate, v.key.slice(0, 400), v.verdict, v.why || null, model, at);
  } catch (err) {
    console.error(`[judge] ${gate} could not record its verdicts: ${String(err)}`);
  }
}

/** What a gate has been deciding lately, newest first. The answer to "why did
 *  that card/query/promise disappear". */
export function recentVerdicts(gate: string, limit = 100): {
  subject: string;
  verdict: string;
  why: string;
  model: string | null;
  at: string;
}[] {
  return db
    .prepare(
      "SELECT subject, verdict, why, model, at FROM gate_verdicts WHERE gate = ? ORDER BY at DESC, rowid DESC LIMIT ?",
    )
    .all(gate, Math.max(1, Math.min(1000, limit)))
    .map((r) => {
      const row = r as { subject: string; verdict: string; why: string | null; model: string | null; at: string };
      return { ...row, why: row.why ?? "" };
    });
}
