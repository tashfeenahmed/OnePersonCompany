/**
 * THE SYNTHESIS PASS — one cross-source read of a venture, ending in at most
 * three concrete actions that survive a gate written in code.
 *
 * WHAT IT IS FOR. Every other scheduled thing on this box measures ONE source:
 * the SEO analyst reads Search Console, the alert engine reads one document per
 * rule, the round dispatches a specialist. Nothing looks at revenue, traffic,
 * alerts, the board, the goals, what the assistant remembers and what last
 * week's runs concluded AT THE SAME TIME and asks what the best next thing to
 * do is. That is the question the owner actually has, and it is the one
 * question none of the specialists can answer, because each of them can only
 * see its own instrument.
 *
 * THE MODEL RANKS; THE CODE DECIDES. This is the whole architecture, and it
 * is the previous system's `taskGate` argument restated: a model asked for
 * actions will always produce actions, including the one it produced last
 * night and the one already sitting on the owner's board. Whether a proposal
 * becomes a card is therefore not the model's call. `gate()` below is
 * deterministic, exported, and tested without a provider, a network or a
 * clock — a rule that can only be observed by running a nightly is a rule
 * nobody checks.
 *
 * NINE REFUSALS, IN THE ORDER THEY FIRE:
 *
 *   1. AN EMPTY OR ONE-WORD ACTION. "Improve marketing" is not an instruction.
 *   2. EVIDENCE THAT IS NOT MEASURED. The proposal names the packet key it
 *      rests on; if that key is null for this venture, the proposal is a guess
 *      wearing a citation and it is dropped by name. This is the rule the whole
 *      evidence packet exists to make enforceable.
 *   3. A TITLE THAT IS A VERB AND A SHRUG. "Analyze subscription data for
 *      growth opportunities" opens with a looking-at verb and names nothing the
 *      evidence line actually says. Refused unless what follows the verb shares
 *      a word with the finding — "Review the noindex tag on /manage" is a real
 *      instruction and survives.
 *   4. EVIDENCE THAT DISMISSES ITSELF. A finding that says "the noindex is
 *      defensible" or "this is by design" is the model telling the owner there
 *      is nothing to do; filing a card off it is filing his own caveat back at
 *      him. Read off the quoted line and the proposal's own rationale, by
 *      phrase list, with no second model call.
 *   5. ALREADY ON THE BOARD. Compared against the venture's OWN open cards by
 *      normalised title — figures stripped, stopwords dropped, 60% of the
 *      remaining words shared. Re-proposing a card the owner is already looking
 *      at is the fastest way to teach him to stop reading these.
 *   6. ALREADY PROPOSED RECENTLY, filed or dropped. A proposal he declined last
 *      Tuesday is not improved by being re-offered on Friday.
 *   7. THE SAME ACTION TWICE INSIDE ONE ANSWER. A model asked for three
 *      sometimes gives one of them in two wordings, and nothing above catches
 *      that because neither copy is on the board yet.
 *   8. EVIDENCE ALREADY SPENT. One finding buys ONE card. Three actions off one
 *      revenue line — analyse it, instrument it, alert on it — share about one
 *      word each, so every title rule above passes them and the owner gets
 *      three cards for one fact. Enforced against the proposals already
 *      accepted in this answer AND against the findings the venture's open
 *      cards are already resting on. It fires after the title rules rather than
 *      before them so that two wordings of ONE action are still reported as
 *      that, which is the more useful sentence of the two.
 *   9. OVER THE CAP, per venture and per night. Three good actions a night is a
 *      morning's work; thirty is a list nobody opens.
 *
 * EVERY REFUSAL IS RECORDED WITH ITS REASON. `synthesis_proposals` holds the
 * dropped rows beside the filed ones, because the owner cannot trust a pass
 * whose rejections are invisible: he cannot otherwise tell whether it
 * considered the obvious thing and rejected it, or never thought of it.
 *
 * COVERAGE ROTATES. Nineteen ventures and three passes a night means every
 * business gets looked at inside a week, in least-recently-covered order, and a
 * venture that produced NOTHING still counts as covered — otherwise the quiet
 * ones would be re-picked every night for ever.
 */
import { configValue, db, now, ventureRowById, ventureRows } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { fileCard } from "../../routes/board.ts";
import { measuredKeys, openCards, packetFor, type EvidencePacket } from "./evidence.ts";
import { registerStage, type StageResult } from "./registry.ts";

/** The pseudo-plugin the synthesis settings hang off. No credential: the model
 *  provider is elsewhere, and everything here is a decision. */
export const SYNTHESIS_PLUGIN = "synthesis";

export const DEFAULT_PER_NIGHT_VENTURES = 3;
export const DEFAULT_PER_VENTURE = 3;
export const DEFAULT_PER_NIGHT = 6;
export const DEFAULT_REPEAT_DAYS = 14;
/** How alike two actions have to be to count as the same one. 0.6 of the
 *  distinct words after the figures and the stopwords are gone, which in
 *  practice is the same verb and the same object. Deliberately on the
 *  permissive side: refusing a genuinely new action costs the owner one idea he
 *  can still have tomorrow, while accepting a duplicate costs him a line he has
 *  to read and delete every day it recurs. */
export const SIMILARITY = 0.6;

export type SynthesisSettings = {
  venturesPerNight: number;
  perVenture: number;
  perNight: number;
  repeatDays: number;
};

function whole(raw: string | null, fallback: number, min: number, max: number): number {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function settings(): SynthesisSettings {
  return {
    venturesPerNight: whole(configValue(SYNTHESIS_PLUGIN, "ventures-per-night"), DEFAULT_PER_NIGHT_VENTURES, 1, 50),
    perVenture: whole(configValue(SYNTHESIS_PLUGIN, "per-venture"), DEFAULT_PER_VENTURE, 1, 5),
    perNight: whole(configValue(SYNTHESIS_PLUGIN, "per-night"), DEFAULT_PER_NIGHT, 1, 30),
    repeatDays: whole(configValue(SYNTHESIS_PLUGIN, "repeat-days"), DEFAULT_REPEAT_DAYS, 0, 365),
  };
}

/* ------------------------------------------------------- per-venture switch */

export function proposalsOn(ventureId: string): boolean {
  const row = db
    .prepare("SELECT proposals FROM synthesis_venture_prefs WHERE venture_id = ?")
    .get(ventureId) as { proposals: number } | undefined;
  /* Absent row means ON, which is what a fresh install wants: a feature that
     has to be switched on venture by venture is a feature nobody switches on. */
  return row ? row.proposals === 1 : true;
}

export function setProposals(ventureId: string, on: boolean): void {
  db.prepare(
    `INSERT INTO synthesis_venture_prefs (venture_id, proposals, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(venture_id) DO UPDATE SET proposals = excluded.proposals, updated_at = excluded.updated_at`,
  ).run(ventureId, Number(on), now());
}

/* ---------------------------------------------------------------- the gate */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by", "with", "from",
  "is", "are", "be", "it", "its", "this", "that", "as", "into", "up", "out", "over", "more", "our",
]);

/**
 * Normalise an action for comparison: lowercase, figures gone, punctuation
 * gone, stopwords gone. Figures go because "reply to 12 reviews" and "reply to
 * 40 reviews" are the same job on two different days.
 *
 * NOT `shared/textkey.ts`, and deliberately. That module answers "is this the
 * same sentence" and keeps digits and stopwords for exactly that reason; this
 * one feeds a Jaccard similarity, where both are noise. Folding it into the
 * identity key would make every re-proposal with a different number read as a
 * new action — which is the duplicate this gate exists to catch.
 */
export function normalise(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\d]+([.,]\d+)?%?/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .join(" ");
}

export function tokens(text: string): Set<string> {
  return new Set(normalise(text).split(/\s+/).filter(Boolean));
}

/** How alike, 0 to 1. Jaccard over the distinct normalised words. */
export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

export type Proposal = {
  title: string;
  why: string;
  /** The packet key the action rests on: revenue | traffic | alerts | tasks |
   *  goals | memory | runs. */
  evidence: string;
  /** The figure or sentence, quoted from the packet. */
  evidenceLine: string;
};

/* ------------------------------------------------------ one finding, one card */

/**
 * THE FINDING A PROPOSAL RESTS ON, as one comparable string.
 *
 * NOT the packet key on its own. "revenue" is a section, and a venture's
 * revenue section holds several facts; refusing every second proposal that says
 * "revenue" would throw away a real second action about a real second figure.
 * NOT the quoted line verbatim either: two proposals off the same fact quote it
 * with different rounding and different punctuation, and a string compare would
 * call them different findings.
 *
 * So it is the section plus the line NORMALISED the way titles are — figures
 * out, punctuation out, stopwords out — which makes "MRR now $589.83 … change
 * $341.25" and "MRR now $589.83 across 372 active subscription(s)" the same
 * finding they plainly are, and a traffic line about a different site a
 * different one.
 *
 * A proposal that quoted nothing keys on its section alone, deliberately: an
 * uncited action is the case the cap most needs to catch, not least.
 */
export function evidenceKey(p: { evidence: string; evidenceLine?: string | null }): string {
  const section = String(p.evidence ?? "").trim().toLowerCase();
  const line = normalise(String(p.evidenceLine ?? ""));
  return line ? `${section}|${line}` : section;
}

/* ------------------------------------------------------ evidence that says no */

/**
 * THE PHRASES A FINDING USES TO DISMISS ITSELF.
 *
 * The case that produced this list: a run reported "…the noindex is
 * defensible, but…", the model quoted that sentence as its evidence, and a card
 * saying "Review the noindex tag on the /manage page" reached the board. The
 * analyst had already answered the question the card asks. Filing it is handing
 * the owner back his own caveat with a checkbox on it.
 *
 * ONE LIST, EXPORTED, AND NO MODEL CALL. The gate is deterministic on purpose —
 * asking a second model "does this evidence dismiss itself" would make the rule
 * unobservable except by running a night. The cost of a phrase list is that it
 * reads sentiment by keyword and will miss a caveat phrased a new way; the
 * benefit is that every miss and every false positive is a one-line diff to a
 * constant that has a test beside it.
 */
export const DISMISSALS = [
  "is defensible",
  "is expected",
  "by design",
  "intentional",
  "not a problem",
  "no action needed",
  "working as intended",
  "likely fine",
  "can be ignored",
] as const;

/** The dismissal a text contains, or null. Case-insensitive, and on word
 *  boundaries so "unintentional" is not read as "intentional". */
export function dismissal(...texts: (string | null | undefined)[]): string | null {
  const hay = texts.map((t) => String(t ?? "")).join(" \n ").toLowerCase();
  for (const phrase of DISMISSALS) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(hay)) return phrase;
  }
  return null;
}

/* ------------------------------------------------------------ a verb and a shrug */

/** Verbs that describe LOOKING AT something rather than doing anything to it.
 *  Fine in a real instruction — "Review the noindex tag on /manage" — and the
 *  whole of a useless one. */
export const VAGUE_VERBS = [
  "analyze",
  "analyse",
  "review",
  "explore",
  "investigate",
  "look into",
  "consider",
] as const;

/**
 * IS THIS TITLE A VERB AND A SHRUG?
 *
 * True when the title OPENS with one of the looking-at verbs and nothing after
 * the verb appears in the evidence line it cites. "Analyze subscription data
 * for growth opportunities" against a line about MRR names data, growth and
 * opportunities — three words the finding never uses — and is a card the owner
 * cannot start. "Review the noindex tag on /manage" against a line naming the
 * noindex and /manage is an instruction with a place in it, and passes.
 *
 * Only the LEADING verb counts. "Rewrite the pricing page and review the copy"
 * is doing something; a rule matching the verb anywhere would refuse it.
 */
export function genericTitle(title: string, evidenceLine: string): boolean {
  const t = String(title ?? "").trim().toLowerCase();
  const verb = VAGUE_VERBS.find((v) => new RegExp(`^${v}(?![a-z])`).test(t));
  if (!verb) return false;
  const line = tokens(evidenceLine);
  for (const w of tokens(t.slice(verb.length))) if (line.has(w)) return false;
  return true;
}

export type Verdict =
  | { accept: true; proposal: Proposal }
  | { accept: false; proposal: Proposal; reason: string };

/**
 * SHOULD THIS PROPOSAL BECOME A CARD?
 *
 * Pure. No database, no clock of its own, no provider — everything it decides
 * on is passed in. That is what makes the nine refusals testable, and testing
 * them is the point: this function is the difference between a feature that
 * files three useful cards a week and one the owner switches off in a
 * fortnight.
 *
 * The reasons are written to be READ, twice over: by the owner on the proposals
 * page, and by the next pass, which is shown the recent ones so it does not
 * spend a turn rewording something already refused.
 */
export function gate(input: {
  proposals: Proposal[];
  measured: string[];
  openCardTitles: string[];
  /** The findings — `evidenceKey()` — the venture's OPEN cards already rest on.
   *  Absent means "none known", which is what a caller with no proposal history
   *  gets and what every row filed before the column existed reads as. */
  openEvidenceKeys?: string[];
  recentProposalTitles: { title: string; at: string; verdict: string }[];
  perVenture: number;
  /** How many the night has left across every venture. */
  remainingTonight: number;
  now?: number;
}): Verdict[] {
  const at = input.now ?? Date.now();
  const out: Verdict[] = [];
  /* The findings already spent: on the board before tonight, and on the
     proposals accepted so far in this same answer. Two collections rather than
     one because the refusal has to say WHICH, and "it is already a card" and
     "you said this two lines ago" send the owner to different places. */
  const onTheBoard = new Set((input.openEvidenceKeys ?? []).filter(Boolean));
  const takenHere = new Map<string, string>();
  let accepted = 0;

  for (const p of input.proposals) {
    const title = String(p.title ?? "").trim();

    if (!title || tokens(title).size < 2) {
      out.push({
        accept: false,
        proposal: p,
        reason: "too short to be an action — an action names a verb and a thing to do it to.",
      });
      continue;
    }

    if (!input.measured.includes(p.evidence)) {
      out.push({
        accept: false,
        proposal: p,
        reason:
          `it rests on "${p.evidence || "nothing"}", which is not measured for this venture. ` +
          `The measured evidence tonight is ${input.measured.join(", ") || "nothing at all"}.`,
      });
      continue;
    }

    /* A VERB AND A SHRUG. Before the board checks, because this one is about
       the proposal alone and costs nothing: a title that names nothing the
       evidence says is not improved by being new. */
    if (genericTitle(title, p.evidenceLine)) {
      out.push({
        accept: false,
        proposal: p,
        reason:
          `the title is generic — it opens with a looking-at verb and names nothing the evidence line says. ` +
          `The evidence is: "${String(p.evidenceLine ?? "").slice(0, 160)}". Name the thing to change and where it is.`,
      });
      continue;
    }

    /* THE FINDING ALREADY SAID THERE WAS NOTHING TO DO. Read off the quoted
       line and off the model's own rationale, because the caveat lands in
       either one. */
    const says = dismissal(p.evidenceLine, p.why);
    if (says) {
      out.push({
        accept: false,
        proposal: p,
        reason:
          `the evidence dismisses itself — it says "${says}" about the very finding this rests on. ` +
          `The line is: "${String(p.evidenceLine ?? "").slice(0, 160)}".`,
      });
      continue;
    }

    const clash = input.openCardTitles.find((t) => similarity(title, t) >= SIMILARITY);
    if (clash) {
      out.push({
        accept: false,
        proposal: p,
        reason: `already an open card: "${clash.slice(0, 120)}" — it is on the board, leave it there.`,
      });
      continue;
    }

    const repeat = input.recentProposalTitles.find((r) => similarity(title, r.title) >= SIMILARITY);
    if (repeat) {
      const days = Math.max(1, Math.round((at - Date.parse(repeat.at)) / 86_400_000));
      out.push({
        accept: false,
        proposal: p,
        reason:
          `proposed ${days} day${days === 1 ? "" : "s"} ago and ${repeat.verdict === "filed" ? "filed" : "dropped"} ` +
          `then: "${repeat.title.slice(0, 120)}" — not repeating it.`,
      });
      continue;
    }

    /* A DUPLICATE INSIDE ONE ANSWER. A model asked for three actions sometimes
       gives the same one twice in two wordings, and nothing above catches it
       because neither is on the board yet. */
    const twin = out.find((v) => v.accept && similarity(title, v.proposal.title) >= SIMILARITY);
    if (twin) {
      out.push({
        accept: false,
        proposal: p,
        reason: `the same action as "${twin.proposal.title.slice(0, 120)}", already accepted from this same answer.`,
      });
      continue;
    }

    /* ONE FINDING, ONE CARD.
       The 6 September pass for one venture filed three cards — analyse the
       subscription data, track price changes in the collector, alert on MRR
       milestones — all three resting on the SAME single revenue line. Every
       title rule above passed them: they share about one word, so the Jaccard
       is 0.09 and nothing keyed on the evidence at all. The owner got three
       morning cards for one fact he already knew. */
    const key = evidenceKey(p);
    if (onTheBoard.has(key)) {
      out.push({
        accept: false,
        proposal: p,
        reason:
          `evidence already carries an open card — the finding it rests on ("${String(p.evidenceLine ?? "").slice(0, 120)}") ` +
          `is already on the board as its own card. One finding is worth one action.`,
      });
      continue;
    }
    const alreadyHere = takenHere.get(key);
    if (alreadyHere) {
      out.push({
        accept: false,
        proposal: p,
        reason:
          `evidence already carries an accepted proposal from this same answer: "${alreadyHere.slice(0, 120)}" ` +
          `rests on the same finding. One finding is worth one action.`,
      });
      continue;
    }

    if (accepted >= input.perVenture) {
      out.push({
        accept: false,
        proposal: p,
        reason: `over this venture's cap of ${input.perVenture} proposal${input.perVenture === 1 ? "" : "s"} a pass.`,
      });
      continue;
    }
    if (accepted >= input.remainingTonight) {
      out.push({
        accept: false,
        proposal: p,
        reason: "the night's proposal budget was already spent on earlier ventures.",
      });
      continue;
    }

    accepted += 1;
    takenHere.set(key, title);
    out.push({ accept: true, proposal: p });
  }

  return out;
}

/* -------------------------------------------------------------- the prompt */

/**
 * THE SYSTEM TURN, and the last paragraph of it is not decoration.
 *
 * Small models — and the free tiers this box is most likely to be pointed at —
 * answer a structured request by thinking out loud first and running out of
 * output tokens before the JSON arrives. That is the single commonest way this
 * pass produces nothing: not a refusal, not a bad idea, but a preamble that ate
 * the answer. The instruction is therefore explicit and last, where a model
 * weights it most, and `readActions` still refuses to guess when it is ignored.
 */
const SYSTEM =
  "You are the chief of staff for a one-person company, reading one business's " +
  "evidence and proposing what to do next. You are ranking, not deciding: a " +
  "deterministic gate downstream will refuse anything already on the owner's " +
  "board, anything proposed recently, and anything resting on evidence this box " +
  "does not measure. Your job is to be SPECIFIC and to be RIGHT about what the " +
  "evidence says.\n\n" +
  "Answer with a single JSON object and NOTHING else. No preamble, no reasoning, " +
  "no explanation of what you are about to do, no text after the JSON. Start your " +
  "reply with { and end it with }. An empty actions list is a complete answer.";

/** Render the packet for the model. Nulls are shown WITH their reason rather
 *  than omitted, because "traffic is not measured for this venture" is
 *  information the model needs in order not to propose a traffic action. */
export function renderPacket(p: EvidencePacket): string {
  const lines: string[] = [
    `# ${p.venture} (${p.slug})`,
    `Stage: ${p.stage}. Site: ${p.host ?? "none recorded"}.`,
    p.description ? `What it is: ${p.description}` : "",
    "",
  ];

  const section = (key: string, m: { measured: unknown; why: string | null }, body: () => string[]) => {
    lines.push(`## ${key}`);
    if (m.measured === null) lines.push(`NOT MEASURED — ${m.why}`);
    else lines.push(...body());
    lines.push("");
  };

  section("revenue", p.revenue, () => {
    const r = p.revenue.measured!;
    const one = r.oneOff;
    /* ONE-OFF CASH GETS ITS OWN LINE AND ITS OWN WORDS. It is settled money
       over a window, not a run rate, and a model that reads it next to MRR
       without the label will add the two and quote a monthly figure that was
       never billed monthly. Nothing is printed when the window found none —
       an empty line reading "0 purchases" invites "sales have stopped" about a
       business that never sold one-offs. */
    const oneOffLines = one.count
      ? [
          `One-off purchases (settled cash, NOT a run rate and not in MRR): ${one.count} in ` +
            `${one.days} days, ` +
            `${Object.entries(one.gross)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([c, n]) => `${n} ${c}`)
              .join("; ") || "no amount reported"}.`,
          ...one.byProduct.map(
            (b) => `- ${b.product}: ${b.count} purchase(s), ${b.gross} ${b.currency}.`,
          ),
        ]
      : [];
    return [
      `Window: ${r.window}.`,
      /* Per currency, each on its own line. One "MRR: $412" across a book
         holding euros too is a figure the model would quote and nobody could
         reproduce. */
      ...Object.keys(r.delta)
        .sort()
        .map(
          (c) =>
            `MRR now ${r.mrr[c] ?? 0} ${c}; ${r.previous[c] ?? 0} ${c} thirty days ago; ` +
            `change ${r.delta[c]} ${c}.`,
        ),
      ...oneOffLines,
      `Products: ${r.products.join(", ")}.`,
      r.note,
    ];
  });

  section("traffic", p.traffic, () => {
    const t = p.traffic.measured!;
    return [
      `Window: ${t.window}`,
      ...t.sites.map(
        (s) =>
          `- ${s.domain ?? s.entity}: ${s.pageviews ?? "null"} pageviews (was ${s.previousPageviews ?? "null"}, ` +
          `${s.deltaPct === null ? "no comparable window" : `${s.deltaPct > 0 ? "+" : ""}${s.deltaPct}%`}), ` +
          `${s.visitors ?? "null"} visitors.`,
      ),
    ];
  });

  section("alerts", p.alerts, () => {
    const a = p.alerts.measured!;
    /* WHAT IS WATCHING comes before WHAT HAS TRIPPED. "Nothing is open" means
       something quite different under a rule that watches this venture's MRR
       than under one that watches a domain's expiry date. */
    const watching = a.watching.length
      ? `${a.watching.length} rule(s) watch this venture: ${a.watching
          .map((r) => `“${r.name}” (${r.skill} ${r.path}${r.enabled ? "" : ", disabled"})`)
          .join("; ")}.`
      : "No alert rule watches this venture.";
    return a.open.length
      ? [
          `Window: ${a.window}.`,
          watching,
          ...a.open.map((e) => `- ${e.ts.slice(0, 10)} ${e.rule}: ${e.message}`),
        ]
      : [`Window: ${a.window}. Nothing is open.`, watching];
  });

  section("tasks", p.tasks, () => {
    const t = p.tasks.measured!;
    return t.open.length
      ? ["Open cards on the owner's board for this venture:", ...t.open.map((c) => `- [${c.column}] ${c.title}${c.due ? ` (due ${c.due})` : ""}`)]
      : ["The board holds no open card for this venture."];
  });

  section("goals", p.goals, () => [p.goals.measured!.text, p.goals.measured!.tailorTo ?? ""]);

  section("memory", p.memory, () =>
    p.memory.measured!.notes.map((n) => `- (${n.ageDays}d, ${n.source}) ${n.text}`),
  );

  section("runs", p.runs, () => {
    const r = p.runs.measured!;
    /* A headline is now several whole lines rather than one cut one, so the
       continuations are indented under their bullet: the model has to be able
       to tell which run a finding belongs to. */
    return [
      `Window: ${r.window}.`,
      ...r.finished.map((f) => `- ${f.kind} "${f.title}": ${f.headline.replace(/\n/g, "\n  ")}`),
    ];
  });

  return lines.filter((l) => l !== "").join("\n");
}

function ask(p: EvidencePacket, s: SynthesisSettings, recent: { title: string }[]): string {
  return [
    renderPacket(p),
    "",
    "---",
    "",
    recent.length
      ? `Already proposed for this venture recently — do not propose these again in any wording:\n${recent.map((r) => `- ${r.title}`).join("\n")}`
      : "Nothing has been proposed for this venture recently.",
    "",
    `Propose AT MOST ${s.perVenture} actions, best first. Each must:`,
    `- be one concrete thing the owner can start this week, naming what and where;`,
    `- rest on ONE of the measured sections above — name it in "evidence" using exactly one of: ` +
      `${measuredKeys(p).join(", ") || "(nothing is measured, so propose nothing)"};`,
    `- quote the figure or sentence it rests on in "evidenceLine", copied from above rather than recalled;`,
    `- rest on a DIFFERENT quoted line from every other action here — one finding buys one action, so ` +
      `three actions off one revenue figure will be refused down to one;`,
    `- not rest on a line that already says the thing is fine — "defensible", "by design", "expected", ` +
      `"no action needed" — that is the evidence telling you there is nothing to do;`,
    `- name what to change and where. A title that opens with analyse, review, explore, investigate or ` +
      `consider and then names nothing the quoted line says will be refused as generic;`,
    `- not repeat anything already on the board or in the recent list.`,
    "",
    "If the honest answer is that nothing is worth doing this week, return an empty list. That is a valid and useful answer.",
    "",
    "Answer with JSON and nothing else:",
    `{"actions":[{"title":"…","why":"…","evidence":"traffic","evidenceLine":"…"}]}`,
  ].join("\n");
}

/**
 * Read the model's answer, or nothing.
 *
 * THREE FORMATTING HABITS ARE ACCOMMODATED and no refusals are. A model that
 * wrapped its JSON in a fence, buried it in a sentence, or answered with a bare
 * array instead of the object it was shown has still answered the question; a
 * model that wrote a paragraph saying it has nothing to add has not answered in
 * the shape the gate can act on, and guessing that the paragraph means "no
 * actions" would be inventing an answer. So that case returns null and the
 * caller records what was actually said.
 */
export function readActions(raw: string): Proposal[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;

  const slice = (open: string, close: string): unknown => {
    const start = body.indexOf(open);
    const end = body.lastIndexOf(close);
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  };

  const asObject = slice("{", "}");
  const list = Array.isArray((asObject as { actions?: unknown })?.actions)
    ? (asObject as { actions: unknown[] }).actions
    : Array.isArray(asObject)
      ? (asObject as unknown[])
      : /* A bare array, which some models answer with however the shape was
           asked for. It is only tried when the object read found nothing, so a
           well-formed answer is never re-parsed. */
        (() => {
          const arr = slice("[", "]");
          return Array.isArray(arr) ? arr : null;
        })();
  if (!Array.isArray(list)) return null;
  return list.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    if (typeof o.title !== "string" || !o.title.trim()) return [];
    return [
      {
        title: o.title.trim().slice(0, 200),
        why: typeof o.why === "string" ? o.why.trim().slice(0, 1_000) : "",
        evidence: typeof o.evidence === "string" ? o.evidence.trim().toLowerCase() : "",
        evidenceLine: typeof o.evidenceLine === "string" ? o.evidenceLine.trim().slice(0, 400) : "",
      },
    ];
  });
}

/* ---------------------------------------------------------------- one venture */

export type VenturePass = {
  ventureId: string;
  venture: string;
  ran: boolean;
  /** A failed model/evidence read, rather than an intentional skip. */
  failed?: boolean;
  /** Why nothing was asked. Null when the model was asked. */
  why: string | null;
  filed: number;
  dropped: number;
  model: string | null;
  verdicts: { title: string; verdict: "filed" | "dropped"; reason: string | null; evidence: string }[];
  packet: EvidencePacket | null;
};

function recentProposals(ventureId: string, days: number): { title: string; at: string; verdict: string }[] {
  if (days <= 0) return [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare(
      "SELECT title, at, verdict FROM synthesis_proposals WHERE venture_id = ? AND at >= ? ORDER BY at DESC LIMIT 60",
    )
    .all(ventureId, since) as unknown as { title: string; at: string; verdict: string }[];
}

/**
 * THE FINDINGS THE VENTURE'S OPEN CARDS ARE ALREADY RESTING ON.
 *
 * Joined through `card_origin`, which is the board's own idempotency key and
 * the only honest link between a proposal and the card it became: a card the
 * owner has since archived, finished or deleted stops counting the moment he
 * moves it, which is right — once it is off his board the finding is free to
 * buy another action.
 *
 * ROWS FILED BEFORE `evidence_key` EXISTED HAVE NULL AND ARE SKIPPED. The
 * column cannot be backfilled honestly — the fingerprint is computed from the
 * quoted line by the same normaliser the gate uses, and inventing it in SQL
 * would key old rows differently from new ones. So the rule fails OPEN on
 * history and closed on everything filed from now on, which costs at most one
 * repeat per old card and never refuses a good action.
 */
export function openEvidenceKeys(ventureId: string): string[] {
  try {
    return (
      db
        .prepare(
          `SELECT DISTINCT p.evidence_key AS key
             FROM synthesis_proposals p
             JOIN board_cards c ON c.origin = p.card_origin
             JOIN board_columns col ON col.id = c.column_id
            WHERE p.venture_id = ? AND p.verdict = 'filed'
              AND p.evidence_key IS NOT NULL AND p.evidence_key <> ''
              AND c.archived_at IS NULL AND col.key <> 'done'`,
        )
        .all(ventureId) as unknown as { key: string }[]
    ).map((r) => r.key);
  } catch {
    return [];
  }
}

/**
 * ONE VENTURE'S PASS.
 *
 * `dry` asks the model NOTHING and files NOTHING. It builds the packet — which
 * is free, all of it comes out of tables this box already holds — and reports
 * what is measured. That is the useful half of a planned night: the owner can
 * see that six ventures would be looked at and that four of them have no
 * measured traffic, which tells him to go and link a website rather than to
 * wait for better proposals.
 */
export async function passForVenture(
  ventureId: string,
  opts: { runId?: string | null; dry?: boolean; remainingTonight?: number; signal?: AbortSignal } = {},
): Promise<VenturePass> {
  const v = ventureRowById(ventureId);
  if (!v)
    return { ventureId, venture: ventureId, ran: false, why: "No venture by that id.", filed: 0, dropped: 0, model: null, verdicts: [], packet: null };

  const base = { ventureId: v.id, venture: v.name, filed: 0, dropped: 0, model: null, verdicts: [], packet: null };

  if (!proposalsOn(v.id))
    return { ...base, ran: false, why: "proposals are switched off for this venture." };

  const packet = await packetFor(v.id, opts.signal);
  if (!packet) return { ...base, ran: false, failed: true, why: "the evidence packet could not be built." };
  if (packet.nothingMeasured)
    return {
      ...base,
      packet,
      ran: false,
      why:
        "nothing substantive about this venture is measured: no linked Stripe product, no linked " +
        "Umami website, no alert rule naming it, no open board card, no goal, no note and no recent " +
        "run. There is no honest question to ask, so nothing was asked and nothing was spent. " +
        "Linking a product or a website on the connections page is what changes this.",
    };

  const s = settings();
  const recent = recentProposals(v.id, s.repeatDays);

  if (opts.dry)
    return {
      ...base,
      packet,
      ran: false,
      why: `planned only — measured evidence would be ${measuredKeys(packet).join(", ")}; nothing was asked and nothing was filed.`,
    };

  /*
    ONE RETRY, AND EXACTLY ONE.

    The commonest failure of this pass is not a bad idea — it is a REASONING
    model answering a structured request by thinking out loud and running out of
    output tokens before the JSON arrives. It was seen repeatedly against the
    free tier this box is currently pointed at, on the same packet that had
    answered correctly minutes earlier, so it is a coin toss rather than a
    capability limit. A second ask with the instruction alone in front of it
    converts most of them.

    It is capped at one because the cost of this pass IS model calls, and a loop
    that retried until it got JSON would spend a night's whole budget on one
    venture with a model that is never going to produce any. Both attempts are
    counted; if the second also fails, the pass reports what was actually said.
  */
  const turns = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: ask(packet, s, recent) },
  ];
  const NUDGE =
    "Your previous reply was prose rather than JSON. Reply with ONLY the JSON object — " +
    "start with { and end with }, no reasoning before it and no text after it.";

  let text = "";
  let model: string | null = null;
  let proposals: Proposal[] | null = null;
  let attempts = 0;

  for (const attempt of [0, 1]) {
    attempts += 1;
    try {
      const reply = await complete(
        attempt === 0 ? turns : [...turns, { role: "system" as const, content: NUDGE }],
        { signal: opts.signal },
      );
      text = reply.text;
      model = reply.model;
    } catch (err) {
      return {
        ...base,
        packet,
        model,
        ran: false,
        failed: true,
        why: err instanceof Error ? err.message.slice(0, 300) : "the model could not be reached.",
      };
    }
    proposals = readActions(text);
    if (proposals !== null) break;
  }

  if (proposals === null)
    return {
      ...base,
      packet,
      model,
      ran: false,
      failed: true,
      /* WHAT IT ACTUALLY SAID, trimmed. A bare "could not be read" is a dead
         end for the owner: the commonest cause is a model answering in prose
         that it has nothing to add, which is a useful answer wearing the wrong
         clothes, and the second commonest is a model too small for the packet.
         Those want different fixes and only the text tells them apart. */
      why:
        `the model's answer could not be read as the JSON asked for, in ${attempts} attempt` +
        `${attempts === 1 ? "" : "s"}. It said: "${text.replace(/\s+/g, " ").trim().slice(0, 300)}"`,
    };
  if (!proposals.length)
    return { ...base, packet, model, ran: true, why: "the model proposed nothing, which is a valid answer." };

  const verdicts = gate({
    proposals,
    measured: measuredKeys(packet),
    /* THE WHOLE OPEN BOARD FOR THIS VENTURE, not the slice the packet showed
       the model. The packet is capped for prompt size; the GATE is the thing
       that must not miss an old card, because a card the owner cannot see at
       the top of his board is exactly the one he has forgotten and would be
       most annoyed to be offered again. */
    openCardTitles: openCards(v.id, { all: true }).map((c) => c.title),
    openEvidenceKeys: openEvidenceKeys(v.id),
    recentProposalTitles: recent,
    perVenture: s.perVenture,
    remainingTonight: opts.remainingTonight ?? s.perNight,
  });

  let filed = 0;
  let dropped = 0;
  const shaped: VenturePass["verdicts"] = [];
  const at = now();

  for (const [i, verdict] of verdicts.entries()) {
    const p = verdict.proposal;
    if (verdict.accept) {
      /* `origin` IS THE BOARD'S OWN IDEMPOTENCY KEY, and it is namespaced with
         the RUN — or, for a pass started by hand, with the moment it ran.
         "manual" was the first spelling and it was wrong in a way that took a
         live run to find: the second pass by hand collided with the first on
         `:0` and `:1`, the board silently filed nothing, and two perfectly good
         proposals were recorded as "the board refused the card". The dedupe
         that stops repetition is the GATE above, deliberately; a collision in a
         unique index would hide a gate failure behind a database constraint. */
      const origin = `synthesis:${opts.runId ?? at}:${v.id}:${i}`;
      let ok = false;
      try {
        ok = fileCard({
          origin,
          title: p.title,
          body: [
            p.why,
            "",
            `**Evidence (${p.evidence})**: ${p.evidenceLine}`,
            "",
            `Proposed by the synthesis pass on ${at.slice(0, 10)}. It is a PROPOSAL: nothing has been done.`,
          ].join("\n"),
          ventureId: v.id,
          urgency: 1,
        }).filed;
      } catch {
        ok = false;
      }
      db.prepare(
        `INSERT INTO synthesis_proposals (run_id, at, venture_id, rank, title, rationale, evidence_line, evidence, evidence_key, verdict, reason, card_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        opts.runId ?? null,
        at,
        v.id,
        i,
        p.title,
        p.why,
        p.evidenceLine,
        JSON.stringify({ key: p.evidence, packet }),
        evidenceKey(p),
        ok ? "filed" : "dropped",
        ok ? null : "the board refused the card (no Backlog column, or the origin already existed).",
        ok ? origin : null,
      );
      if (ok) filed += 1;
      else dropped += 1;
      shaped.push({
        title: p.title,
        verdict: ok ? "filed" : "dropped",
        reason: ok ? null : "the board refused the card.",
        evidence: p.evidence,
      });
    } else {
      dropped += 1;
      db.prepare(
        `INSERT INTO synthesis_proposals (run_id, at, venture_id, rank, title, rationale, evidence_line, evidence, evidence_key, verdict, reason, card_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', ?, NULL)`,
      ).run(
        opts.runId ?? null,
        at,
        v.id,
        i,
        p.title,
        p.why,
        p.evidenceLine,
        JSON.stringify({ key: p.evidence, packet }),
        evidenceKey(p),
        verdict.reason,
      );
      shaped.push({ title: p.title, verdict: "dropped", reason: verdict.reason, evidence: p.evidence });
    }
  }

  return { ventureId: v.id, venture: v.name, ran: true, why: null, filed, dropped, model, verdicts: shaped, packet };
}

/* ------------------------------------------------------------- the rotation */

/**
 * WHOSE TURN IT IS TONIGHT.
 *
 * Least recently covered first, ventures never covered first of all, ties
 * broken by the owner's own venture order so two nights with the same coverage
 * pick the same list. Ventures with proposals switched off are dropped here
 * rather than picked and then refused — otherwise a portfolio with four parked
 * businesses would spend its whole nightly quota on them.
 */
export function rotation(limit: number, priorityIds: readonly string[] = []): { id: string; name: string; lastPassAt: string | null }[] {
  const priority = new Set(priorityIds);
  const covered = new Map(
    (db.prepare("SELECT venture_id, last_pass_at FROM synthesis_coverage").all() as unknown as {
      venture_id: string;
      last_pass_at: string;
    }[]).map((r) => [r.venture_id, r.last_pass_at]),
  );
  return ventureRows()
    .filter((v) => proposalsOn(v.id))
    .map((v, i) => ({ id: v.id, name: v.name, lastPassAt: covered.get(v.id) ?? null, i }))
    .sort((a, b) => {
      const fresh = Number(priority.has(b.id)) - Number(priority.has(a.id));
      if (fresh) return fresh;
      if (a.lastPassAt === b.lastPassAt) return a.i - b.i;
      if (a.lastPassAt === null) return -1;
      if (b.lastPassAt === null) return 1;
      return a.lastPassAt.localeCompare(b.lastPassAt);
    })
    .slice(0, Math.max(1, limit))
    .map(({ id, name, lastPassAt }) => ({ id, name, lastPassAt }));
}

function markCovered(ventureId: string, runId: string | null): void {
  db.prepare(
    `INSERT INTO synthesis_coverage (venture_id, last_pass_at, passes, last_run_id) VALUES (?, ?, 1, ?)
     ON CONFLICT(venture_id) DO UPDATE SET
       last_pass_at = excluded.last_pass_at, passes = synthesis_coverage.passes + 1, last_run_id = excluded.last_run_id`,
  ).run(ventureId, now(), runId);
}

/* ------------------------------------------------------------- the stage */

export function registerSynthesisStage(): void {
  registerStage({
    id: "synthesis",
    area: "pipeline",
    title: "Synthesis — the next action per venture",
    about:
      "One cross-source read per venture — revenue, traffic, alerts, the board, " +
      "the goals, the assistant's memory and last week's runs — ending in at most " +
      "three ranked actions that survive a deterministic gate. Coverage rotates, " +
      "so every venture gets a pass inside a handful of nights.",
    /* AFTER THE ROUNDS. The rounds dispatch the specialists whose reports this
       pass reads; run it first and it would synthesise last week's evidence. */
    deps: ["collect", "rounds"],
    defaultEnabled: true,
    defaultCadence: "daily",
    defaultWindow: null,
    budget: { maxMinutes: 20 },
    async run(ctx): Promise<StageResult> {
      const s = settings();
      const finished = db.prepare(`SELECT DISTINCT j.venture_id FROM pipeline_block_jobs j
        JOIN agent_runs r ON r.id=j.agent_run_id WHERE j.run_id=? AND r.status='done'`).all(ctx.runId) as {venture_id:string}[];
      const picked = rotation(s.venturesPerNight, finished.map(r => r.venture_id));
      if (!picked.length)
        return {
          outcome: "skipped",
          reason: "every venture has proposals switched off, or there are no ventures.",
        };

      let filed = 0;
      let dropped = 0;
      let asked = 0;
      let failed = 0;
      const notes: string[] = [];

      for (const v of picked) {
        if (ctx.signal.aborted) break;
        if (Date.now() > ctx.deadline) {
          notes.push(`${v.name} was not reached — the stage's own budget ran out.`);
          break;
        }
        const pass = await passForVenture(v.id, {
          runId: ctx.runId,
          dry: ctx.dry,
          remainingTonight: Math.max(0, s.perNight - filed),
          signal: ctx.signal,
        });
        if (!ctx.dry) markCovered(v.id, ctx.runId);
        filed += pass.filed;
        dropped += pass.dropped;
        if (pass.ran) asked += 1;
        if (pass.failed) failed += 1;
        notes.push(
          pass.ran
            ? `${pass.venture}: ${pass.filed} filed, ${pass.dropped} dropped`
            : `${pass.venture}: ${pass.why}`,
        );
      }

      return {
        outcome: failed ? "failed" : "completed",
        error: failed ? `${failed} venture synthesis pass${failed === 1 ? "" : "es"} could not be completed. See the per-venture notes.` : null,
        note: ctx.dry
          ? `Would look at ${picked.map((p) => p.name).join(", ")}. ${notes.join("; ")}`
          : `${filed} proposal${filed === 1 ? "" : "s"} filed, ${dropped} dropped, across ${picked.length} venture${picked.length === 1 ? "" : "s"}. ${notes.join("; ")}`,
        counts: { ventures: picked.length, asked, filed, dropped, failed },
      };
    },
  });
}

/* ------------------------------------------------------------------- reads */

export type ProposalRow = {
  id: number;
  run_id: string | null;
  at: string;
  venture_id: string;
  rank: number;
  title: string;
  rationale: string;
  evidence_line: string | null;
  evidence: string;
  /** The finding fingerprint — see `evidenceKey()`. NULL on rows filed before
   *  the column existed. */
  evidence_key: string | null;
  verdict: string;
  reason: string | null;
  card_origin: string | null;
};

export function proposalRows(opts: { ventureId?: string | null; verdict?: string | null; limit?: number } = {}): ProposalRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  if (opts.verdict) {
    where.push("verdict = ?");
    args.push(opts.verdict);
  }
  args.push(Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50))));
  return db
    .prepare(
      `SELECT * FROM synthesis_proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY at DESC, rank ASC LIMIT ?`,
    )
    .all(...args) as unknown as ProposalRow[];
}

/**
 * One proposal for the wire.
 *
 * `opts.packet` IS OFF BY DEFAULT and that is a size decision with a reason.
 * The stored packet is the whole evidence document the model saw; the venture
 * Overview asks for twelve rows on every render, and shipping twelve of them
 * put kilobytes of JSON on a page that draws one line from each. The evidence
 * LINE is always here, because that is the half a reader acts on.
 */
export function shapeProposal(r: ProposalRow, opts: { packet?: boolean } = {}) {
  let evidence: unknown = {};
  try {
    evidence = JSON.parse(r.evidence);
  } catch {
    evidence = {};
  }
  const v = ventureRowById(r.venture_id);
  return {
    id: r.id,
    runId: r.run_id,
    at: r.at,
    ventureId: r.venture_id,
    /** Null when the venture has since been deleted. The proposal is kept. */
    venture: v?.name ?? null,
    rank: r.rank,
    title: r.title,
    why: r.rationale,
    /** The packet SECTION, as the page has always shown it. Not the finding
     *  fingerprint below, which is an internal identity and not a label. */
    evidenceKey: (evidence as { key?: string })?.key ?? null,
    evidenceLine: r.evidence_line,
    /** Section plus normalised line: what the one-finding-one-card rule keys
     *  on. Null on rows filed before the column existed. */
    evidenceFingerprint: r.evidence_key ?? null,
    verdict: r.verdict as "filed" | "dropped",
    reason: r.reason,
    cardOrigin: r.card_origin,
    /** The whole packet the model saw, so a proposal can be re-read against the
     *  evidence that produced it rather than against today's numbers. Null
     *  unless it was asked for — the row is not claiming there was none. */
    packet: opts.packet ? ((evidence as { packet?: unknown })?.packet ?? null) : null,
    /** Whether `packet` above was withheld for size rather than absent. */
    packetOmitted: !opts.packet,
  };
}

export function coverage(): { ventureId: string; venture: string | null; lastPassAt: string | null; passes: number; proposalsOn: boolean }[] {
  const rows = new Map(
    (db.prepare("SELECT * FROM synthesis_coverage").all() as unknown as {
      venture_id: string;
      last_pass_at: string;
      passes: number;
    }[]).map((r) => [r.venture_id, r]),
  );
  return ventureRows().map((v) => ({
    ventureId: v.id,
    venture: v.name,
    lastPassAt: rows.get(v.id)?.last_pass_at ?? null,
    passes: rows.get(v.id)?.passes ?? 0,
    proposalsOn: proposalsOn(v.id),
  }));
}
