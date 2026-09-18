import { call } from "@/lib/api";
import { qs, seg } from "@/lib/qs";
/* The old sweep's `json competitors` block, cut out of a report the same way
   the cards are — see `stripCompetitorsFence` for why it is history that is
   still on disk. It lives in a leaf so it can be tested under node, which this
   file cannot be: it resolves the `@/` alias. */
import { stripCompetitorsFence } from "@/lib/competitors";

/**
 * THE RUNS ENGINE, FROM THIS SIDE — six apps, one route family.
 *
 * A RUN is one piece of long agent work: started from an app, executed on the
 * server, and still going after the tab is shut. That last clause is the whole
 * reason this file exists rather than the pages streaming a chat turn of their
 * own. A research report takes minutes; a page that held the stream would lose
 * the work to a refresh, and "the answer was lost because you reloaded" is not
 * a thing this box is allowed to say. So the server owns the run and this side
 * POLLS it — which is why every type below has a `status` and a `partial`, and
 * why nothing here is an EventSource.
 *
 * THE SIX KINDS ARE NOT HARD-CODED HERE. `GET /api/runs` answers with
 * `kinds: KindInfo[]` — the name, the sentence, whether a venture is needed and
 * which inputs to draw — and the shared `RunApp` builds itself out of that. A
 * kind that gains a field on the server gains it on the page without a client
 * release, and a kind this client has never heard of still renders. The slugs
 * in `pages/runs/` are the only place a kind string is written down twice, and
 * that is a routing fact rather than a description of the work.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. The types were
 * written against the contract in the runs brief and checked against the live
 * JSON. Where the server says null, this says null and the pages draw it: a
 * `model` of null is "no model was recorded", a `finishedAt` of null is "it has
 * not finished", `accurate: null` on a GEO answer is "nobody judged it" — never
 * a false, never a zero.
 */

/* -------------------------------------------------------------- the runs */

/* Where a run is, and the polling predicate over it, both from the repo-root
   `shared/runStatus.ts`. The union was declared five times — twice on the
   server, three times here — and five declarations of one five-member set is
   how `agent_runs` came to carry a sixth state that none of them knew about.
   Re-exported so the run pages keep importing their vocabulary from the module
   that describes their route. */
export { isLive, isRunStatus, isFinal, RUN_STATUSES } from "../../../../shared/runStatus";
export type { RunStatus } from "../../../../shared/runStatus";
import type { RunStatus } from "../../../../shared/runStatus";

/**
 * One tool call the agent made while it worked.
 *
 * The same four facts the chat transcript's tool lines carry, and for the same
 * reason: the stream says a call started and a call finished and says nothing
 * at all about what came back. `finishedAt` null is a call still in flight —
 * or one that was in flight when the process died, which keeps saying so.
 */
export type RunStep = {
  toolCallId: string;
  tool: string;
  label: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/**
 * A run as it appears in a list: everything but the report.
 *
 * `steps` is a COUNT here and an array on the detail — the list needs to say
 * "used 6 tools" and would otherwise carry every tool call of every run in the
 * history. `outputChars` is the same trade for the markdown.
 */
export type RunSummary = {
  paused: boolean;
  canResume: boolean;
  id: string;
  kind: string;
  ventureId: string | null;
  /** Resolved on the server, so a run whose venture this browser has not
   *  fetched still draws with a name. Null for a run with no venture. */
  ventureName: string | null;
  title: string;
  status: RunStatus;
  queuedAt: string;
  /** Null while it is still waiting its turn. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Wall clock, milliseconds. Null until it is over. */
  ms: number | null;
  /** `hermes`, `openclaw`, or `provider:<id>` when no live agent existed and
   *  the report came from a raw completion with no tools. The pages say which,
   *  because those two are not the same piece of work. */
  backend: string | null;
  model: string | null;
  steps: number;
  outputChars: number;
  error: string | null;
};

/** A run with its report. `partial` is true while the markdown is still being
 *  written — the page renders it anyway, which is the point of flushing it. */
export type RunDetail = RunSummary & {
  input: Record<string, string>;
  steps: RunStep[];
  output: string;
  partial: boolean;
  /** Where it sits in the queue, counting from one, or null when it is not
   *  waiting. The server counts this against the whole queue, which is the
   *  only place the whole queue is known — this client sees one kind at a
   *  time and could never work it out. */
  queuePosition: number | null;
  /**
   * The `cards` fence, already parsed by the server — and NOT what the panel
   * draws.
   *
   * It is here because it is on the wire and a type that omitted it would
   * quietly hide a field. The panel uses this client's own parse instead, for
   * one reason that decides it: the page has to REMOVE that block from the
   * markdown before rendering it, which needs the block's position in the
   * text, not its contents. Parsing once locally is better than parsing
   * locally for the offsets and remotely for the values and hoping the two
   * agree. The server's array is also unvalidated — it is whatever JSON the
   * model wrote — where `readCards` drops an entry with no title.
   *
   * Null means the run proposed none, which is not the same as an empty list.
   */
  cards: unknown[] | null;
  /** How many of those cards the server has already put in Backlog. A run
   *  finished since 2026-09-18 files its own; the panel draws those as a
   *  record. Zero on an older run, and the panel still offers the button. */
  cardsFiled: number;
  /**
   * THE PAPER THIS RUN WROTE, on the run that wrote it.
   *
   * Null for every kind but `papers`, and null for a paper run that has not
   * written one yet — which is not the same as a paper with no PDF. It is here
   * rather than being looked up in the shelf because the report panel has to
   * know, before it draws anything, whether there is a document to show and
   * which machine made it; fetching the whole shelf to answer that about one
   * run would be a second request per poll.
   */
  paper: Paper | null;
};

/** One field a kind asks for before it will start. `kind` is how to draw it,
 *  never what to validate — the server is the only judge of an input. */
export type RunInput = {
  key: string;
  label: string;
  /** Always a string, "" for none — the server's `InputSpec` has no null in
   *  it, so neither does this. Drawn as the placeholder. */
  hint: string;
  /** `select` is a closed list of `options`; the value is still a string and
   *  the server is still the only judge of it. A client that has never heard
   *  of the word falls through to a text input, which is why this is additive
   *  rather than a break. */
  kind: "text" | "textarea" | "number" | "select";
  required: boolean;
  /** What the field holds until somebody types over it. "" is the common
   *  case and is not the same as a field with no default. */
  default: string;
  /** Only on `select`. Absent everywhere else. */
  options?: { value: string; label: string }[];
};

/**
 * What a kind of run IS, as the server describes it.
 *
 * This is the whole configuration of an app: its title, the sentence under the
 * title, whether the venture picker is required or optional, the fields, and
 * the four counts the history header reads out.
 */
export type KindInfo = {
  kind: string;
  name: string;
  what: string;
  needsVenture: boolean;
  inputs: RunInput[];
  counts: { done: number; failed: number; running: number; queued: number };
};

/** The venture a document is about, as every runs route names it. Null on the
 *  portfolio-wide reads. */
export type VentureRef = { id: string; slug: string; name: string };

export type RunList = {
  runs: RunSummary[];
  /** The one run executing right now, across every kind — the queue is global
   *  and one-at-a-time, so this is not "the running run of this kind". */
  running: RunSummary | null;
  queued: number;
  kinds: KindInfo[];
};

/* ------------------------------------------------------- the accumulations */

/**
 * A rival, as the competitor sweeps have it so far.
 *
 * `lastVerified` IS THE INTERESTING FIELD and the reason profiles accumulate
 * rather than being rewritten: a sweep that does not mention a company leaves
 * its date alone, because silence is not verification. A profile whose date is
 * two months old is a profile nobody has confirmed in two months, which is a
 * different claim from a profile that is wrong.
 */
/** One recorded movement in a rival's story. `note` is the sentence the badge
 *  prints — "price moved, $14 → $19" — and it is written by the SERVER at
 *  merge time, because it compares against a value only the merge could see. */
export type CompetitorChange = {
  at: string;
  field: string;
  from: string | null;
  to: string;
  note: string;
};

export type CompetitorProfile = {
  ventureId: string;
  /** Resolved on the server, so a profile draws with its business's name even
   *  on the portfolio-wide read. */
  ventureName: string | null;
  name: string;
  /** The normalised host, which is what the sweep MERGES on — a company
   *  renames its product far more often than it moves house. Null on a row
   *  recorded before that column existed whose URL cannot be read. */
  domain: string | null;
  url: string | null;
  positioning: string | null;
  pricing: string | null;
  strengths: string[];
  weaknesses: string[];
  /** The pages the register rests on. A rival the sweep could not put one
   *  https URL against never reaches this table at all. */
  sources: string[];
  /** Oldest first, capped at twelve by the server. */
  changes: CompetitorChange[];
  lastVerified: string;
  /** Whole days since `lastVerified`, COUNTED ON THE SERVER. A browser with a
   *  skewed clock, or one that has just crossed midnight into another day,
   *  would answer this differently from the box that recorded the date — and
   *  the whole point of the column is that both agree about how stale a row
   *  is. Null only where the date cannot be read at all. */
  verifiedAgo: number | null;
  firstSeen: string;
  /** The run that last touched it. Null on a row the owner typed over. */
  runId: string | null;
};

/**
 * One "look at this next time" item, with whatever became of it.
 *
 * `done` IS FALSE FOR TWO DIFFERENT THINGS AND `note` TELLS THEM APART: an
 * item nothing has got to yet, and — no, only the first. An item that WAS
 * looked at and could not be established is CLOSED, with a note saying so,
 * because "we tried and could not find out" is a finding and leaving it open
 * asks the next three sweeps to try again. So `done` with a note is an answer,
 * and not-`done` means nobody has reached it.
 */
export type CompetitorFocus = {
  id: number;
  runId: string;
  title: string;
  detail: string;
  createdAt: string;
  done: boolean;
  doneAt: string | null;
  note: string | null;
};

export type CompetitorDoc = {
  venture: VentureRef | null;
  profiles: CompetitorProfile[];
  /**
   * The memory that makes a sweep a series rather than a set of unrelated
   * afternoons. `open` is everything still unanswered; `resolved` is the MOST
   * RECENT sweep's list with what became of each item.
   *
   * BOTH ARE EMPTY ON THE PORTFOLIO-WIDE READ, and that is the server's
   * decision rather than a missing feature: six ventures' open questions in
   * one array is a list nobody can act on.
   */
  focus: { open: CompetitorFocus[]; resolved: CompetitorFocus[] };
  /** How many sweeps this venture has had. A profile list of eight off one run
   *  and off six runs are worth different amounts of trust. */
  runs: number;
  lastRun: string | null;
  note: string;
};

/** A paper the scout found. Not a paper this box wrote — see `Paper`. */
export type LibraryEntry = {
  source: "openalex" | "arxiv";
  extId: string;
  ventureId: string | null;
  topic: string;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  url: string | null;
  abstract: string | null;
  seenAt: string;
};

/** The library route calls its rows `papers` too, which is the one name
 *  collision in this file: these are papers OTHER people wrote. */
export type LibraryDoc = {
  venture: VentureRef | null;
  topic: string | null;
  papers: LibraryEntry[];
  note: string;
};

/**
 * WHICH MACHINE SET THE PAPER.
 *
 * `typst` is a compiled document — columns, numbered headings and figures, an
 * IEEE bibliography built from the library entries the body actually cites.
 * `chrome` is markdown printed by a browser, which is a readable document and
 * is NOT a typeset paper. `null` is a paper that produced no PDF, or one
 * written before this server recorded the difference: it is not a third engine
 * and it is not a value to resolve into one of the other two.
 */
export type Typeset = "typst" | "chrome" | null;

/**
 * A paper this box wrote.
 *
 * `markdown`, `pdf` and `source` are URLS ON THIS SERVER, not paths on the
 * disk — the server deliberately does not hand a local path to a browser that
 * could not fetch it anyway.
 *
 * WHAT THE ARTEFACT IS DEPENDS ON `typeset`, and that is the whole reason the
 * field is on the wire. For a `typst` paper the artefact is the PDF and the
 * `source` it was set from; `markdown` is a note ABOUT the paper. For a
 * `chrome` paper the markdown IS the paper and the PDF is a rendering of it.
 * A page that drew the two the same way would be claiming something about the
 * second that is only true of the first.
 */
export type Paper = {
  runId: string;
  ventureId: string | null;
  ventureName: string | null;
  topic: string;
  title: string;
  thesis: string;
  contributions: string[];
  typeset: Typeset;
  /** One or two, as the plan chose. Null on a paper that was not typeset —
   *  a browser print has no column count and zero would read as one. */
  columns: number | null;
  /** Read off the finished PDF. Null when there is no PDF, or when the file
   *  could not be counted — never a guess. */
  pages: number | null;
  markdown: string;
  pdf: string | null;
  /** The Typst source. Null on a paper that was never typeset — there is
   *  nothing to show, which is different from a source that has gone missing. */
  source: string | null;
  /** Whether the printed file is still where the row says. False with a `pdf`
   *  url present means the link will 404 with the reason. */
  pdfOnDisk: boolean;
  /** The external ids it cited, which are keys into the library. */
  cited: string[];
  ts: string;
};

export type PapersDoc = {
  venture: VentureRef | null;
  papers: Paper[];
  note: string;
};

/**
 * One answer a model gave when asked about the venture with no tools and no
 * web — which is the only way to find out what it already believes.
 *
 * THE THREE SCORES ARE NOT ONE SCORE. `mentioned` is mechanical: the name or
 * the host appeared in the answer, decided by string presence and nothing
 * cleverer. `accurate` and `recommended` are a second model's judgement of the
 * first model's answer, and they are null when that judgement was not made —
 * which the page draws as "not judged" rather than as a no.
 */
export type GeoAnswer = {
  runId: string;
  ventureId: string;
  ventureName: string | null;
  provider: string;
  model: string | null;
  question: string;
  answer: string;
  mentioned: boolean;
  accurate: boolean | null;
  recommended: boolean | null;
  ts: string;
};

export type GeoDoc = {
  venture: VentureRef | null;
  answers: GeoAnswer[];
  /** The server's own tally per provider. Not drawn — the page counts what it
   *  is showing, which is the same arithmetic over the same rows — but typed
   *  because it is on the wire. */
  byProvider: Record<
    string,
    {
      asked: number;
      mentioned: number;
      accurate: number;
      recommended: number;
      judged: number;
    }
  >;
  /** Which provider and which agent are live NOW, which is not necessarily
   *  what answered the questions below. */
  live: { provider: string | null; agent: string | null };
  generatedAt: string;
  note: string;
};

/* ------------------------------------------------------------------ calls */

/** The href a file link points at. Not `call` — these three routes answer with
 *  a file rather than JSON, and a browser fetches them better than this client
 *  ever could. `markdown` is served as an attachment; `pdf` and `typ` are
 *  served inline, which is what lets the frame below show the paper instead of
 *  offering to download it. */
export const runFileUrl = (id: string, what: "markdown" | "pdf" | "typ") =>
  `/api/runs/${seg(id)}/${what}`;

export const runsApi = {
  retry: (id: string) => call<RunSummary>(`/runs/${seg(id)}/retry`, { method: "POST" }),
  resume: (id: string) => call<RunSummary>(`/runs/${seg(id)}/resume`, { method: "POST" }),
  /** `venture` is an id or a slug; `kind` narrows to one app's runs. Both left
   *  out is the portfolio-wide list the Sub-agents page draws. */
  list: (params: { kind?: string; venture?: string | null; limit?: number } = {}) =>
    call<RunList>(
      `/runs${qs({ kind: params.kind, venture: params.venture, limit: params.limit })}`,
    ),

  get: (id: string) => call<RunDetail>(`/runs/${seg(id)}`),

  /** Answers 201 with the run as it now is — queued, or running when nothing
   *  else was. The page does not have to guess which. */
  start: (body: {
    kind: string;
    ventureId?: string | null;
    input: Record<string, string>;
  }) =>
    call<RunSummary>("/runs", { method: "POST", body: JSON.stringify(body) }),

  /** `cancelling: true` means the run was RUNNING and has been asked to stop,
   *  so its status may still say running on the next poll; false means it was
   *  merely queued and is now cancelled outright. */
  cancel: (id: string) =>
    call<RunSummary & { cancelling: boolean }>(`/runs/${seg(id)}/cancel`, {
      method: "POST",
    }),

  /** Refused with 409 while it is running — a report being written is not a
   *  thing to delete out from under the process writing it. */
  remove: (id: string) =>
    call<{ id: string; deleted: boolean }>(`/runs/${seg(id)}`, {
      method: "DELETE",
    }),

  competitors: (venture: string) =>
    call<CompetitorDoc>(`/competitors${qs({ venture })}`),

  /** Answers with the ONE profile as it now is, not the whole document — so
   *  the caller splices rather than replaces. */
  editCompetitor: (
    venture: string,
    name: string,
    patch: {
      url?: string | null;
      positioning?: string | null;
      pricing?: string | null;
      strengths?: string[];
      weaknesses?: string[];
    },
  ) =>
    call<CompetitorProfile>(`/competitors/${seg(venture)}/${seg(name)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  removeCompetitor: (venture: string, name: string) =>
    call<{ ventureId: string; name: string; deleted: boolean; note: string }>(
      `/competitors/${seg(venture)}/${seg(name)}`,
      { method: "DELETE" },
    ),

  library: (params: { venture?: string | null; topic?: string | null } = {}) =>
    call<LibraryDoc>(`/papers/library${qs(params)}`),

  papers: (venture?: string | null) => call<PapersDoc>(`/papers${qs({ venture })}`),

  geo: (venture: string) => call<GeoDoc>(`/geo${qs({ venture })}`),
};

/* ------------------------------------------------------ the report's cards */

/**
 * A card a run SUGGESTED for the board.
 *
 * Every kind's brief ends by asking for a fenced json block of these, and
 * NOTHING ON THE SERVER FILES THEM. That is the decision this type encodes: a
 * board that fills itself is a different product than the one being built, so
 * the run proposes and the owner presses. The panel under a finished report is
 * the whole mechanism.
 */
export type RunCard = { title: string; body: string; urgency: number };

type Fence = { info: string; body: string; start: number; end: number };

/** Every fenced block in a markdown document, with its info string and where
 *  it sits — the offsets are what let the cards block be cut back out. Written
 *  by hand rather than reached for through the markdown parser because this
 *  runs on a document that is still being written, where half a fence is an
 *  ordinary state rather than a syntax error. */
function fences(md: string): Fence[] {
  const out: Fence[] = [];
  const re = /^[ \t]*```([^\n]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)))
    out.push({
      info: m[1]!.trim(),
      body: m[2]!,
      start: m.index,
      end: m.index + m[0].length,
    });
  return out;
}

/**
 * The `cards` block out of a report, and the report without it.
 *
 * TOLERANT ABOUT THE FENCE, STRICT ABOUT THE CONTENT. Models label that block
 * ```json cards, ```cards and plain ```json depending on the day, so the info
 * string is a hint and not a gate: any fence that parses to an array of
 * objects with a title is a candidate, and a fence whose info says `cards`
 * beats one that does not. What it will not do is accept a shape that is
 * nearly right — a card with no title is a line nobody can read on the board,
 * so the entry is dropped rather than filled in with something invented here.
 *
 * THE BLOCK IS CUT OUT OF THE MARKDOWN because it is drawn as the panel
 * instead. Leaving it in would show the same six cards twice, once as JSON —
 * and raw JSON at the foot of a report reads as the report having gone wrong.
 *
 * IT RUNS ON A PARTIAL DOCUMENT TOO, which is why the closing fence is
 * required: a half-written block matches nothing, stays in the markdown as the
 * unterminated fence it is, and becomes a panel the moment it closes.
 */
export function readCards(md: string): { cards: RunCard[]; body: string } {
  let best: { fence: Fence; cards: RunCard[] } | null = null;

  for (const fence of fences(md)) {
    if (!/^(json\s+)?cards$/i.test(fence.info) && !/^json$/i.test(fence.info))
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fence.body);
    } catch {
      continue;
    }
    /* `{"cards": [...]}` as often as a bare array, so the wrapper is unwrapped
       rather than rejected — the same tolerance `fencedJson` applies on the
       server, and for the same reason: this is a label problem, not a content
       problem. */
    const rows =
      Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" &&
            Array.isArray((parsed as { cards?: unknown }).cards)
          ? ((parsed as { cards: unknown[] }).cards)
          : null;
    if (!rows) continue;
    const cards = rows.flatMap((row): RunCard[] => {
      if (!row || typeof row !== "object") return [];
      const r = row as Record<string, unknown>;
      if (typeof r.title !== "string" || !r.title.trim()) return [];
      const urgency = Number(r.urgency);
      return [
        {
          title: r.title.trim(),
          body: typeof r.body === "string" ? r.body.trim() : "",
          urgency:
            Number.isInteger(urgency) && urgency >= 0 && urgency <= 3
              ? urgency
              : 1,
        },
      ];
    });
    if (!cards.length) continue;
    /* A labelled block beats an unlabelled one; between two of the same kind
       the later wins, because the brief asks for the cards at the END. */
    const labelled = /cards/i.test(fence.info);
    if (!best || labelled || !/cards/i.test(best.fence.info))
      best = { fence, cards };
  }

  if (!best) return { cards: [], body: stripCompetitorsFence(md) };
  const body = (md.slice(0, best.fence.start) + md.slice(best.fence.end)).trimEnd();
  return { cards: best.cards, body: stripCompetitorsFence(body) };
}

