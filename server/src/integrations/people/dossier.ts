/**
 * THE DOSSIER — a sourced, dated profile of one person of interest.
 *
 * THIS IS THE FIRST RUN ON THIS BOX THAT IS ABOUT A PERSON RATHER THAN A
 * BUSINESS, and it is the reason a whole seam of this codebase had to learn
 * about workers with no venture. Every other kind answers "how is Acme doing";
 * this one answers "who is Jane Doe and what is she building now", and the
 * answer is filed under nobody's company because it belongs to none of them.
 * See integrations/subagents/store.ts for the roster half of that.
 *
 * WHY IT LIVES IN THE PEOPLE AREA. The two things this box already knows about
 * a person — how the correspondence with them has actually gone, and what the
 * owner has promised them — are this directory's tables and nowhere else's. A
 * dossier writer in the runs area would have had to import both of them
 * anyway, and would then have been a second author of what "a person" means
 * here. The RUNS area lends four capabilities and learns nothing about people;
 * this file lends two tables and learns nothing about queues or sessions.
 *
 * WHAT IS ACTUALLY KNOWN HERE, AND WHAT IS NOT. The contact fold is derived
 * from mail HEADERS ONLY — no subject, no snippet, no body is stored anywhere
 * in this area, see contacts.ts — so this box can say "you two normally trade
 * mail every nine days and it has been thirty-one" and can never say what
 * either of you said. That sentence travels into the brief with the block,
 * because a model handed a cooling cadence and no warning will explain WHY the
 * correspondence cooled, and it has no way of knowing.
 *
 * EVERYTHING ELSE IN A DOSSIER COMES FROM THE OPEN WEB, AND THEREFORE FROM
 * THE AGENT'S TOOLS. With no agent live there is no sweep at all, and the run
 * still happens: it writes what the blocks below support and says in its own
 * first paragraph that it could not look anybody up. That is not a degraded
 * mode to be hidden — a profile of a stranger written by a model with no
 * internet is the single most confident-sounding wrong document this box could
 * produce, and the only defence is that the document says so at the top.
 *
 * MATCHING A NAME IS A GUESS AND IS PUBLISHED AS ONE. The brief is free text;
 * the contact table is addresses and display names. So the match is deliberate
 * and dumb — the tokens of the first line against the display name, plus any
 * email address typed into the brief — and the block SAYS how the rows were
 * chosen, so a wrong match is visible as a wrong match rather than absorbed
 * into the profile as fact. A name that matches several people is an open
 * question in the finished document, not a decision made here.
 */
import { db } from "../../db.ts";
import type { ChatTurn } from "../../chat/backend.ts";
import { renderBlocks, type Block } from "../runs/context.ts";
import { kindDef, systemBrief } from "../runs/kinds.ts";
import { runRow, type Step } from "../runs/store.ts";
import { people, type Person } from "./contacts.ts";
import { commitmentRows, type CommitmentRow } from "./commitments.ts";

/**
 * What the executor lends a run of this kind.
 *
 * DECLARED HERE RATHER THAN IMPORTED FROM THE EXECUTOR, for the reason
 * integrations/growth/runs.ts gives at length and measured rather than
 * theorised: `executor.ts` imports this file, and an import back the other way
 * for `turn()` and `Session` is a cycle through a module that reads
 * `integrations/index.ts` at import time, which does not start the process at
 * all. So the capabilities arrive as functions and this area never learns what
 * a Session is. It is the same four the growth kinds borrow, and the shape is
 * kept identical on purpose: two run seams that differ by a field are two
 * seams somebody has to compare before writing a third.
 */
export type RunTools = {
  /** Something this server did rather than something a model said. Flushed at
   *  once, so the page shows the run is alive while it is still reading. */
  say(text: string): void;
  startStep(tool: string, label: string | null): Step;
  endStep(step: Step, label?: string | null): void;
  /** One turn on whoever is answering — an agent when one is live, the raw
   *  provider when not. `toOutput` streams it into the report. */
  turn(turns: ChatTurn[], opts: { toOutput: boolean; forceProvider?: boolean }): Promise<{ text: string }>;
  /** Whether whatever is answering can go and look things up. It is the whole
   *  difference between a dossier and an essay, and the brief says so either
   *  way rather than letting the reader assume the good case. */
  hasTools: boolean;
};

/* --------------------------------------------------- who the brief is about */

/** How many matched correspondents are quoted. A handful: the brief is about
 *  ONE person, and a list of thirty near-matches is a list that invites the
 *  model to pick whichever supports the paragraph it was going to write. */
const MAX_CONTACTS = 5;

/** How many open promises are quoted. Same argument, and the list is the
 *  owner's own words, so it is the expensive part of the brief per row. */
const MAX_COMMITMENTS = 10;

/** How much of the previous dossier is carried. Enough for "what changed" to
 *  be a real comparison — the snapshot, what they were building and the dated
 *  activity all fit — and capped because a run that quoted the whole of every
 *  previous dossier would grow without bound over a year of monthly ones. */
const PREVIOUS_CAP = 3_500;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * WHO THE BRIEF NAMES, as far as a string can be read.
 *
 * THE FIRST SEGMENT OF THE FIRST LINE IS THE NAME. A brief is written the way
 * a person writes one — "Jane Doe, founder of Acme — what is she building
 * now?" — so the name ends at the first comma, dash, pipe or bracket, and
 * everything after it is context for the sweep rather than more of the name.
 * This is not parsing and does not pretend to be: it produces CANDIDATE tokens
 * to match rows with, and every row it matches is published beside the reason
 * it matched.
 */
export function whoIsThis(brief: string): { name: string; tokens: string[]; emails: string[] } {
  const emails = [...brief.matchAll(EMAIL)].map((m) => m[0].toLowerCase());
  const first = brief.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const name = (first.split(/[,—–|(<]/)[0] ?? "").trim();
  const tokens = fold(name)
    .split(/[^a-z0-9'’-]+/)
    .map((t) => t.trim())
    /* Two characters or more, so "de" and initials do not match half the
       mailbox; no honorifics, because a mailbox stores "Ana-María O'Brien"
       and a brief says "Dr. Ana-María O'Brien" and requiring EVERY token
       would then match nobody; and no more than four tokens — a first line
       that is a whole sentence is not a name and must not be turned into
       one. */
    .filter((t) => t.length >= 2 && !HONORIFICS.has(t))
    .slice(0, 4);
  return { name, tokens, emails: [...new Set(emails)] };
}

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "sir", "dame", "rev"]);

/** Lower-cased and stripped of accents, because the brief and the mail header
 *  are written by two different people and "María" and "Maria" are the same
 *  person. Applied to BOTH sides of every comparison, so the folding cannot
 *  make a match that would not have been one the other way round. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Whether one folded contact is plausibly the person the brief names. An
 *  address typed into the brief is a match by identity; a name is a match only
 *  when EVERY token of the candidate name appears in the display name, because
 *  "Jane" alone matches every Jane in the mailbox. */
function matches(p: Person, who: { tokens: string[]; emails: string[] }): string | null {
  const address = p.address.toLowerCase();
  if (who.emails.includes(address)) return "the address is written in the brief";
  const name = fold(p.name ?? "");
  if (!who.tokens.length || !name) return null;
  return who.tokens.every((t) => name.includes(t))
    ? `the display name on the mail contains ${who.tokens.map((t) => `"${t}"`).join(" and ")}`
    : null;
}

/* -------------------------------------------------------------- the blocks */

/**
 * THE CORRESPONDENCE, and the sentence that has to travel with it.
 *
 * THREE DIFFERENT EMPTIES, said differently, because they mean three different
 * things and a single "no contacts found" would let all three be read as the
 * fourth thing they are not — that the person does not exist. The collector
 * never having run, the mailbox holding nothing that matches, and the brief
 * naming nobody matchable are separate facts, and the model is told which.
 */
function contactBlock(
  who: { name: string; tokens: string[]; emails: string[] },
  all: Person[],
): { block: Block; matched: Person[] } {
  const source = "This box's own mail-header fold (people area — headers only, never a subject or a body)";
  const caveat =
    "EVERY FIGURE HERE COMES FROM A From/To/Cc/Date HEADER AND NOTHING ELSE. No " +
    "subject line, snippet or body is stored anywhere in this box for these " +
    "people, so you may report that a correspondence has gone quiet and you may " +
    "NEVER say what was said in it or why it went quiet.";

  if (!all.length)
    return {
      matched: [],
      block: {
        source,
        text: `${caveat}\n\nThe mail collector has never run on this box, or it stored nothing. So there is no correspondence to match this person against at all — this is "not checked", not "the owner has never written to them".`,
      },
    };

  if (!who.tokens.length && !who.emails.length)
    return {
      matched: [],
      block: {
        source,
        text: `${caveat}\n\nThe brief's first line did not yield a name or an address to match on, so no contact was looked up. ${all.length} correspondents are on file and none of them was ruled out.`,
      },
    };

  const hits = all
    .map((p) => ({ p, why: matches(p, who) }))
    .filter((h): h is { p: Person; why: string } => h.why !== null)
    /* By weight — 10 × the smaller side plus the total, see contacts.ts — so
       the correspondence that actually went both ways is quoted first. It
       orders a list and measures nothing. */
    .sort((a, b) => b.p.weight - a.p.weight);

  if (!hits.length)
    return {
      matched: [],
      block: {
        source,
        text:
          `${caveat}\n\nNo correspondent on file matches "${who.name || "the brief"}". ` +
          `There are ${all.length} on file. That means the owner has not exchanged mail with this person from this ` +
          `mailbox inside the collector's window — it does not mean the person does not exist, and it is not evidence about them.`,
      },
    };

  const shown = hits.slice(0, MAX_CONTACTS);
  const lines = shown.map(({ p, why }) =>
    [
      `- ${p.name ?? "(no display name)"} <${p.address}> — matched because ${why}.`,
      `  ${p.received} received, ${p.sent} sent, ${p.threads} threads. Last mail either way ${p.lastAt ?? "never"}.`,
      `  Rhythm: ${
        p.cadenceDays === null
          ? `not measurable (${p.cadenceGaps} gaps, fewer than the minimum) — so there is NO temperature for them`
          : `normally about every ${p.cadenceDays} days, quiet for ${p.quietDays ?? "?"} — ${p.temperature ?? "no verdict"} (${p.why})`
      }`,
      p.link ? `  Linked to the venture ${p.link.ventureId}${p.link.derived ? " — a GUESS from a subject line, not a fact" : ""}.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const more = hits.length > shown.length ? [`… and ${hits.length - shown.length} more addresses matched the same way and are not shown.`] : [];
  const ambiguous =
    hits.length > 1
      ? [
          ``,
          `MORE THAN ONE ADDRESS MATCHED. That is ${hits.length} people or ${hits.length} addresses for one person, and this box cannot tell which. Treat it as an open question in the document rather than picking one.`,
        ]
      : [];
  return { matched: shown.map((h) => h.p), block: { source, text: [caveat, ``, ...lines, ...more, ...ambiguous].join("\n") } };
}

/**
 * WHAT THE OWNER HAS PROMISED THIS PERSON AND NOT YET DONE.
 *
 * Only `open` rows, and only the ones addressed to an address or a name the
 * brief matched. A dossier that listed every open promise on the box would be
 * leaking the owner's other correspondence into a profile of a stranger, and
 * `done` and `dismissed` are decisions the owner has already made.
 */
function commitmentBlock(
  who: { tokens: string[]; emails: string[] },
  matched: Person[],
): Block {
  const source = "Open commitments the owner made to this person (people area — the owner's own sent mail)";
  const addresses = new Set([...who.emails, ...matched.map((p) => p.address.toLowerCase())]);
  let rows: CommitmentRow[] = [];
  try {
    rows = commitmentRows("open");
  } catch {
    /* The table is another feature's and may not have been scanned. A missing
       scan is "not checked" and is reported as such — never as "he has
       promised them nothing". */
    return { source, text: "The commitment scan has not run on this box, so this was not checked." };
  }
  const hits = rows.filter((r) => {
    if (addresses.has(r.to_address.toLowerCase())) return true;
    const name = fold(r.to_name ?? "");
    return who.tokens.length > 0 && !!name && who.tokens.every((t) => name.includes(t));
  });
  if (!rows.length) return { source, text: "There are no open commitments on this box at all." };
  if (!hits.length)
    return {
      source,
      text: `None of the ${rows.length} open commitments on this box is addressed to this person. That is a fact about the owner's outbox, not about the person.`,
    };
  return {
    source,
    text: hits
      .slice(0, MAX_COMMITMENTS)
      .map(
        (r) =>
          `- to ${r.to_name || r.to_address} <${r.to_address}> — "${r.what}"${r.due ? ` (due ${r.due})` : r.due_text ? ` (they were told "${r.due_text}", which resolved to no date)` : ""}, said ${r.sent_at ?? "at an unknown time"}.`,
      )
      .join("\n"),
  };
}

/**
 * THE LAST DOSSIER ON THE SAME PERSON, which is the whole of "What changed".
 *
 * FOUND BY TITLE, and that is why the title is derived by one function for
 * both doors that start these runs — see `dossierTitle` in runs/kinds.ts. Only
 * `done` rows: a failed run's output is half a document or an error, and
 * "what changed since the run that broke" is not a question.
 */
function previousBlock(runId: string, title: string): { block: Block; had: boolean } {
  const source = "The previous dossier on this same person, written on this box";
  const row = db
    .prepare(
      `SELECT id, finished_at, output FROM agent_runs
        WHERE kind = 'dossier' AND venture_id IS NULL AND status = 'done'
          AND title = ? AND id <> ?
        ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get(title, runId) as { id: string; finished_at: string | null; output: string } | undefined;
  if (!row || !row.output.trim())
    return {
      had: false,
      block: {
        source,
        text: `None. No finished dossier on this box carries the title "${title}", so this is the first one. There is nothing to compare against and you must not write a "What changed" section.`,
      },
    };
  const body =
    row.output.length > PREVIOUS_CAP
      ? `${row.output.slice(0, PREVIOUS_CAP)}\n… trimmed here: ${row.output.length - PREVIOUS_CAP} more characters of that dossier were not included, so its later sections are unknown to you rather than empty.`
      : row.output;
  return {
    had: true,
    block: {
      source,
      text: `Written ${row.finished_at ?? "at an unknown time"} (run ${row.id}). Everything below is what was BELIEVED THEN, and some of it may since have become wrong — that is what "What changed" is for.\n\n${body}`,
    },
  };
}

/* ---------------------------------------------------------------- the shape */

/**
 * THE SECTIONS, IN ORDER, AND NO `json cards` BLOCK.
 *
 * A dossier proposes no board cards, and that is a decision rather than an
 * omission: every other kind of run ends by suggesting work, because it was
 * asked about a business the owner runs and there is always something to do
 * about one. "Read about Jane Doe" is not a task somebody ticks off, and a
 * document that ended with eight suggested actions about a private individual
 * would be inviting the owner to do something to a person on the strength of
 * one long completion.
 *
 * `## What changed` IS CONDITIONAL AND THE CONDITION IS STATED TWICE — here in
 * the shape, and in the block itself. A model given a fixed list of headings
 * writes all of them, and the first dossier on a person would otherwise carry
 * a "What changed" section invented out of nothing at all, which is the worst
 * possible place for an invention: it would read as history.
 */
function dossierShape(hadPrevious: boolean): string {
  return `Write ONE markdown document, and nothing before or after it, with exactly these sections in this order:

## Snapshot
One paragraph: who this person is, the role and company they hold now, and where they are based. If any of those three is not in a block and not on a page you actually read, say so in the sentence rather than leaving it out.

${
    hadPrevious
      ? `## What changed
What is different since the previous dossier, which is in a block below, and nothing else. Each line names what it was and what it is now. If nothing you can verify has changed, say that — an empty comparison is a finding.`
      : `DO NOT WRITE A "## What changed" SECTION. There is no previous dossier on this person, so there is nothing this document could compare against, and a section under that heading would be invented history.`
  }

## What they're building
The products, companies and projects, one each, with the STAGE of each — idea, building, launched, shut down — and how you know the stage. A project whose stage you cannot establish is listed with its stage as unknown.

## Recent public activity
A dated bullet list, newest first. Every bullet carries a date and a link to the source it came from. A thing you cannot date does not go in this list — put it under Signals instead and say it is undated.

## Signals & notable
Momentum, hiring, fundraising chatter, a pivot, anything a reader would want flagged. Say which of these is reported fact and which is chatter, in the bullet itself.

## Open questions
What the public record does not answer. This section is expected to have things in it; a dossier with no open questions is a dossier that guessed.

## Sources
Every link you actually used, one per line, with what it gave you. A link you did not open does not belong here.

There is NO \`json cards\` block on this document and you must not write one. A dossier proposes no work.`;
}

/* ------------------------------------------------------------------ the run */

export async function dossierRun(opts: {
  runId: string;
  input: Record<string, string>;
  tools: RunTools;
}): Promise<void> {
  const { runId, input, tools } = opts;
  const def = kindDef("dossier");
  if (!def) throw new Error("The dossier kind is not registered, so there is no brief to write.");

  const brief = (input.person ?? "").trim();
  if (!brief) throw new Error("A dossier needs somebody to be about: the brief is empty.");

  const row = runRow(runId);
  const title = row?.title ?? "";
  const who = whoIsThis(brief);

  /* ------------------------------------------------------------- context */
  const gather = tools.startStep("context", "reading what this box already holds about them");
  const contacts = contactBlock(who, people());
  const commitments = commitmentBlock(who, contacts.matched);
  const previous = previousBlock(runId, title);
  const blocks: Block[] = [
    {
      source: "The brief, as the owner typed it",
      text: brief,
    },
    contacts.block,
    commitments,
    previous.block,
  ];
  tools.endStep(
    gather,
    `${contacts.matched.length} matching correspondent(s), ${previous.had ? "one previous dossier" : "no previous dossier"}`,
  );

  /* --------------------------------------------------------------- write */
  const system = systemBrief({
    def,
    /* NO VENTURE, and it is null rather than a placeholder. This worker
       belongs to none, and a made-up business name in the job line would be
       the first invented fact in a document about not inventing facts. */
    ventureName: null,
    hasTools: tools.hasTools,
    data: renderBlocks(blocks),
    extra: [
      "NEVER STATE A FACT ABOUT THIS PERSON THAT IS NOT IN A BLOCK ABOVE OR ON A PAGE YOU ACTUALLY READ. Not their employer, not their title, not their location, not what they founded. This is a profile of a real person and a plausible sentence about them is a false one.",
      "A NAME THAT MATCHES SEVERAL PEOPLE IS AN OPEN QUESTION, NOT A GUESS. If the pages you find are about more than one person of that name, say which is which and say that you could not tell them apart — do not merge them into one profile, and do not silently pick the more interesting one.",
      "THE CORRESPONDENCE BLOCK IS HEADERS ONLY. You may say how often they write and when they last did; you may never say what was discussed or why anything went quiet, because nothing on this box knows.",
      ...(tools.hasTools
        ? [
            "THE WEB SWEEP IS BOUNDED. Look this person up, follow what you find, and stop when the sections below are answered — this is a profile, not an investigation, and a page that is about somebody else of the same name is not evidence about them.",
          ]
        : [
            "SAY IN THE FIRST SENTENCE OF `## Snapshot` THAT NO SEARCH WAS POSSIBLE, in those words, and then write only what the blocks above support. `## Recent public activity` and `## Sources` will then be nearly empty, and that is the correct answer — a list of plausible recent activity for somebody you could not look up is the worst thing you can produce here.",
          ]),
    ],
    shape: dossierShape(previous.had),
  });

  const write = tools.startStep("write", title || "dossier");
  const res = await tools.turn(
    [
      { role: "system", content: system },
      { role: "user", content: brief },
    ],
    { toOutput: true },
  );
  tools.endStep(write, `${res.text.length} characters`);
}
