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
import { looksLikeHtmlReport, textOfHtml } from "../runs/html.ts";
import { kindDef, systemBrief } from "../runs/kinds.ts";
import { runRow, type Step } from "../runs/store.ts";
import { people, type Person } from "./contacts.ts";
import { commitmentRows, type CommitmentRow } from "./commitments.ts";
/* READ-ONLY, AND THAT IS THE WHOLE OF THE RELATIONSHIP. The watchlist owns
   the public counters and the rule for deciding which run belongs to which
   person; this file borrows both and writes nothing back, so a dossier can be
   started on somebody who is not on the list at all and simply has no numbers
   in it. */
import { attaches, parseMetrics, watchRows } from "./watch.ts";

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
  turn(turns: ChatTurn[], opts: { toOutput: boolean; forceProvider?: boolean; document?: boolean }): Promise<{ text: string }>;
  /** The `opc` wrapper's path. See `systemBrief`'s `cli`. */
  cli?: string | null;
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

/* --------------------------------------------------------- tracked numbers */

/**
 * THE PUBLIC COUNTERS THIS BOX ALREADY WATCHES, AND THE CELLS THEY BECOME.
 *
 * A WATCHED PERSON HAS NUMBERS AND NOBODY ELSE DOES. The watchlist reads
 * GitHub, Bluesky and Hacker News on a twenty-hour timer — see watch.ts and
 * activity.ts — and stores what it read on the row. A dossier written about
 * somebody on that list can therefore put a real, dated figure in its fact
 * strip; a dossier about a stranger cannot, and must not invent one.
 *
 * MATCHED BY THE RUN'S TITLE, using the watchlist's own `attaches` rather than
 * a second rule written here. The person's card counts the dossiers that
 * attach to them; this counts the person a dossier attaches to. Two rules
 * would disagree the first time either was tightened, and the disagreement
 * would look like a card with the wrong numbers on it.
 *
 * THE CELLS ARE RETURNED AS WELL AS THE BLOCK, because the shape names them:
 * a model told "put any tracked numbers in the fact strip" puts in whichever
 * it remembers, and a model handed the four labels it actually has puts in
 * those four. `at` travels with them for the same reason every figure on this
 * box travels with its stamp — a follower count with no date is a claim about
 * today made out of a reading from last week.
 */
function metricsBlock(title: string): { block: Block; cells: string[] } {
  const source = "This box's own watch of their public accounts (people area — public APIs, read on a timer)";
  const nothing = (why: string) => ({ block: { source, text: why }, cells: [] });

  let row;
  try {
    row = watchRows().find((r) => attaches(title, r.name));
  } catch {
    return nothing("The watchlist table is not on this box, so no public counters were read. That is 'not checked', not 'they have no following'.");
  }
  if (!row)
    return nothing(
      `Nobody on this box's watchlist matches "${title}", so no public counters have ever been pulled for this person. ` +
        `Do NOT put a numbers cell in the fact strip and do NOT estimate a follower count from anything you read on the web — a figure in a fact strip reads as measured, and this box measured nothing.`,
    );

  const m = parseMetrics(row.metrics);
  const cells: string[] = [];
  const lines: string[] = [];
  const cell = (label: string, value: number | null, unit: string) => {
    if (value === null) return;
    cells.push(`${label} ${value.toLocaleString("en-GB")}`);
    lines.push(`- ${label}: ${value.toLocaleString("en-GB")} ${unit}`);
  };
  cell("GITHUB FOLLOWERS", m.ghFollowers, "followers");
  cell("GITHUB REPOS", m.ghRepos, "public repositories");
  cell("BLUESKY FOLLOWERS", m.bskyFollowers, "followers");
  cell("BLUESKY POSTS", m.bskyPosts, "posts");
  cell("HN KARMA", m.hnKarma, "karma");

  if (!cells.length)
    return nothing(
      `"${row.name}" is on this box's watchlist, but no public counter has come back for them — no GitHub, Bluesky or Hacker News figure at all. ` +
        `Say nothing about their following: leave the numbers out of the fact strip rather than filling it with something you read on a page.`,
    );

  return {
    cells,
    block: {
      source,
      text: [
        `Read from the public APIs on ${m.at ?? "an unknown date"} and NOT since. Every one of these is a count of a public account and nothing more — it is not reach, not influence and not growth.`,
        ``,
        ...lines,
        ``,
        `These are the only numbers this box has measured about this person. Put each of them in the fact strip as its own cell, exactly as given, and put NO other number there.`,
      ].join("\n"),
    },
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
  /* AS PROSE, NEVER AS MARKUP. A dossier is an HTML document now, and quoting
     one back whole would spend most of PREVIOUS_CAP on the stylesheet — the
     analyst would be handed nine hundred characters of CSS and three hundred
     of last month's findings, and would learn nothing from either. So an HTML
     previous dossier is flattened to its words first and the cap is applied to
     THOSE. An older markdown one is quoted as it is; both shapes are on this
     box and will be for as long as the runs table keeps its history. */
  const raw = row.output.trim();
  const prose = looksLikeHtmlReport(raw) ? textOfHtml(raw) : raw;
  const body =
    prose.length > PREVIOUS_CAP
      ? `${prose.slice(0, PREVIOUS_CAP)}\n… trimmed here: ${prose.length - PREVIOUS_CAP} more characters of that dossier were not included, so its later sections are unknown to you rather than empty.`
      : prose;
  return {
    had: true,
    block: {
      source,
      text: `Written on ${row.finished_at ? row.finished_at.slice(0, 10) : "an unknown date"} (run ${row.id}). Quote that date as a date, never as a timestamp. Everything below is what was BELIEVED THEN, and some of it may since have become wrong — that is what "What changed" is for.\n\n${body}`,
    },
  };
}

/* ---------------------------------------------------------------- the shape */

/**
 * THE DOSSIER IS AN HTML DOCUMENT, AND THIS IS THE BRIEF THAT ASKS FOR ONE.
 *
 * ---------------------------------------------------------------------------
 * IT USED TO BE MARKDOWN — seven `##` headings, rendered by the same component
 * that renders a research report and a growth sweep — and that was the right
 * default for six kinds of run and the wrong one for this one. Every other
 * report on this box is a briefing the owner skims for the one number that
 * changed. A dossier is READ: it is a profile of a person, it is opened weeks
 * later, and it is the one document here somebody might print and take into a
 * meeting. The markdown pipeline gives it the same nine typographic decisions
 * as everything else, and no way to say that the follower count and the role
 * belong side by side at the top rather than in a sentence.
 *
 * SO THE MODEL WRITES THE WHOLE DOCUMENT, DESIGN AND ALL. Workdash's people
 * analyst has done this for a year and the arrangement is ported rather than
 * reinvented: one self-contained HTML document, one inline stylesheet, nothing
 * fetched from anywhere, rendered in a sandboxed frame the client sizes to the
 * document. See runs/html.ts for what is stripped out of the answer on the way
 * into the row, and components/runs/ReportFrame.tsx for the frame.
 *
 * NOTHING FETCHED IS A HARD RULE AND IT IS STATED AS ONE. The frame carries a
 * Content-Security-Policy that allows inline styles and nothing else, so a
 * document that pulled a web font or a logo would render with a missing font
 * and a broken image and no error anywhere. A model told "prefer inline" will
 * link a stylesheet about a third of the time; a model told the fetch does not
 * arrive does not.
 *
 * THE SECTIONS ARE THE SAME SEVEN, AND THERE IS STILL NO `json cards` BLOCK.
 * A dossier proposes no board cards, and that is a decision rather than an
 * omission: every other kind of run ends by suggesting work, because it was
 * asked about a business the owner runs and there is always something to do
 * about one. "Read about Jane Doe" is not a task somebody ticks off, and a
 * document that ended with eight suggested actions about a private individual
 * would be inviting the owner to do something to a person on the strength of
 * one long completion.
 *
 * `What changed` IS CONDITIONAL AND THE CONDITION IS STATED TWICE — here in
 * the shape, and in the block itself. A model given a fixed list of headings
 * writes all of them, and the first dossier on a person would otherwise carry
 * a "What changed" section invented out of nothing at all, which is the worst
 * possible place for an invention: it would read as history.
 *
 * THE FACT STRIP NAMES ITS OWN CELLS. `cells` is whatever the watchlist has
 * actually measured about this person — see `metricsBlock` — and it is spelled
 * into the instruction rather than left as "any tracked numbers you were
 * given", because the second phrasing produces a strip with a plausible
 * follower count in it on a person this box has never pulled.
 */
function dossierShape(opts: { hadPrevious: boolean; today: string; cells: string[] }): string {
  const { hadPrevious, today, cells } = opts;
  return `Write ONE SELF-CONTAINED HTML DOCUMENT AS YOUR REPLY — not to a file, not with a tool, not as a note about where you saved one — and nothing before it and nothing after it. The first character of your reply is "<" and the last is ">". No markdown, no \`\`\` fence, no sentence introducing the document.

SELF-CONTAINED IS A HARD RULE, not a preference. The document is rendered in a sandbox that fetches nothing and runs nothing:
- ONE inline <style> block in the <head>, and no other styling. No <link>, no external stylesheet, no web font, no image file, no icon file — anything from off this box does not arrive, and leaves a missing font or a broken image with no error anywhere.
- NO <script>, of any kind, for any reason. It will be stripped before anybody sees the document.
- A diagram, if you want one, is inline <svg>. There is no other way to draw one here.
- HTML is the format and it changes nothing about what may be claimed. Every rule you were given above applies to this document exactly as it would to a memo.

MAKE IT LOOK DESIGNED, NOT TYPED. Near-black text on white, one grey, one calm accent colour (#4f63d2 unless you have a reason to pick another), the accent used consistently for the header rule, the section markers and the links:
- a centred column about 46rem wide, system-ui, 14px/1.6 body text, generous whitespace;
- A HEADER BLOCK: an <h1> of the person's name at about 26px and 650 weight, under it a muted dateline reading ${today} with their role and company beside it, and a 3px accent-coloured rule beneath the whole block;
- A FACT STRIP immediately under the header: a single row of small label-over-value cells — 10px uppercase muted labels above 15px semibold values, thin borders between the cells. The cells are ROLE, COMPANY, LOCATION${
    cells.length
      ? `, and then one cell for each of these tracked numbers, with exactly these labels and exactly these values: ${cells.join("; ")}`
      : `, and nothing else — this box has measured no numbers about this person, so the strip carries no follower count, no karma and no repository count`
  }. A cell whose value you could not establish reads "not found" rather than being left out;
- <h2>s at 15px and 600 weight, each with a short accent-coloured left border and space above it;
- the activity section as A TIMELINE rather than a bullet list: each item one row with the date at the left in 11px monospace and muted, the event text beside it, a thin rule between rows, no bullet markers;
- every source link showing its HOSTNAME ONLY — <a href="https://example.com/2026/a/long/path">example.com</a> — accent-coloured, underlined only on hover;
- a muted 12px footer line at the end naming the date the document was written and how many sources it used.

THE SECTIONS, IN THIS ORDER, each opened by an <h2> with exactly this wording:

<h2>Snapshot</h2>
One paragraph: who this person is, the role and company they hold now, and where they are based. If any of those three is not in a block below and not on a page you actually read, say so in the sentence rather than leaving it out.

${
    hadPrevious
      ? `<h2>What changed</h2>
What is different since the previous dossier, which is in a block below, and nothing else. Each line names what it was and what it is now. This is the section the reader opened the re-run for, so be concrete and dated. If nothing you can verify has changed, say that — an empty comparison is a finding.`
      : `DO NOT WRITE A "What changed" SECTION. There is no previous dossier on this person, so there is nothing this document could compare against, and a section under that heading would be invented history.`
  }

<h2>What they're building</h2>
The products, companies and projects, one each, with the STAGE of each — idea, building, launched, shut down — and how you know the stage. A project whose stage you cannot establish is listed with its stage as unknown.

<h2>Recent public activity</h2>
The timeline described above, newest first. Every row carries a date and a link to the source it came from. A thing you cannot date does not go in this list — put it under Signals instead and say it is undated.

<h2>Signals &amp; notable</h2>
Momentum, hiring, fundraising chatter, a pivot, anything a reader would want flagged. Say which of these is reported fact and which is chatter, in the line itself.

<h2>Open questions</h2>
What the public record does not answer. This section is expected to have things in it; a dossier with no open questions is a dossier that guessed.

<h2>Sources</h2>
Every link you actually used, one per row, with what it gave you. A link you did not open does not belong here.

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
  /* TODAY, ONCE, AT THE TOP OF THE BRIEF AND AGAIN IN THE DATELINE. A model
     with no clock dates a "recent" ship to whenever its training stopped, and
     a dossier's whole claim is that it is a picture of a person ON A DAY. */
  const today = new Date().toISOString().slice(0, 10);

  /* ------------------------------------------------------------- context */
  const gather = tools.startStep("context", "reading what this box already holds about them");
  const contacts = contactBlock(who, people());
  const commitments = commitmentBlock(who, contacts.matched);
  const previous = previousBlock(runId, title);
  const metrics = metricsBlock(title);
  const blocks: Block[] = [
    {
      source: "The clock on this box",
      text: `TODAY IS ${today}. Every date you write must be consistent with it, and the dateline under the person's name is this date.`,
    },
    {
      source: "The brief, as the owner typed it",
      text: brief,
    },
    contacts.block,
    commitments,
    metrics.block,
    previous.block,
  ];
  tools.endStep(
    gather,
    `${contacts.matched.length} matching correspondent(s), ${metrics.cells.length} tracked number(s), ${previous.had ? "one previous dossier" : "no previous dossier"}`,
  );

  /* --------------------------------------------------------------- write */
  const system = systemBrief({
    def,
    /* NO VENTURE, and it is null rather than a placeholder. This worker
       belongs to none, and a made-up business name in the job line would be
       the first invented fact in a document about not inventing facts. */
    ventureName: null,
    hasTools: tools.hasTools,
    cli: tools.cli,
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
            "SAY IN THE FIRST SENTENCE OF THE `Snapshot` SECTION THAT NO SEARCH WAS POSSIBLE, in those words, and then write only what the blocks above support. `Recent public activity` and `Sources` will then be nearly empty, and that is the correct answer — a list of plausible recent activity for somebody you could not look up is the worst thing you can produce here.",
          ]),
    ],
    shape: dossierShape({ hadPrevious: previous.had, today, cells: metrics.cells }),
  });

  const write = tools.startStep("write", title || "dossier");
  const res = await tools.turn(
    [
      { role: "system", content: system },
      { role: "user", content: brief },
    ],
    /* A whole designed page: thinking off and the output ceiling when a raw
       provider writes it — see CompleteOptions.document. */
    { toOutput: true, document: true },
  );
  tools.endStep(write, `${res.text.length} characters`);
}
