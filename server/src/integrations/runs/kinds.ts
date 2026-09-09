/**
 * THE SIX KINDS OF WORK, and the brief each one is given.
 *
 * A kind is three things: what the app calls it, what it needs before it can
 * start, and the system turn it puts in front of whatever is going to answer.
 * They are in one file because the six briefs are variations on one argument —
 * here is the business, here is what this box already measured about it, write
 * this shape of report — and six files would let those variations drift into
 * six different definitions of what a report is.
 *
 * THE REPORT SHAPE IS FIXED, AND IT IS THE SAME FOR EVERY KIND THAT REPORTS ON
 * A BUSINESS. `## Findings`, `## Evidence`, `## Recommendations`, and a fenced
 * json block named `cards`. That is not tidiness: the page renders the markdown
 * and offers the cards as board suggestions, and a report that invented its own
 * headings would be a report the page could only show as a wall of text.
 *
 * THE ONE KIND THAT IS NOT A REPORT ON A BUSINESS PASSES ITS OWN SHAPE IN.
 * A `dossier` is a profile of a PERSON — snapshot, what changed, what they are
 * building, sources — and it proposes no board cards, because "read about Jane
 * Doe" is not a task anybody ticks off. It says so through `systemBrief`'s
 * `shape` option rather than through a second briefing function, so the tools
 * fork and the honesty rules below stay the only copy of themselves.
 *
 * THE CARDS ARE SUGGESTIONS AND THE RUN NEVER FILES THEM. Nothing in this area
 * writes to the board. A run that quietly created eleven cards would be an
 * agent doing the owner's filing on the strength of one long completion; the
 * page shows them with checkboxes and the owner files what they want.
 *
 * THE RULES DIFFER ON EXACTLY ONE AXIS: whether something with TOOLS is
 * answering. An agent can go and look, so it is told what is worth looking at.
 * A raw provider cannot fetch anything at all, so it is told, in the strongest
 * terms available, that the brief is the whole of what it knows — because a
 * model asked to check something it cannot check does not say so, it writes
 * down what the answer would probably have been. That is the one failure this
 * whole feature exists to prevent.
 */
import { PORT } from "../../config.ts";
import type { RunKind } from "./store.ts";

export type InputSpec = {
  key: string;
  label: string;
  hint: string;
  /** `select` is drawn as a closed list of `options` and is otherwise a text
   *  field: the value on the wire is still a string and the SERVER is still
   *  the only judge of it. It exists because a kind with a `format` that is
   *  one of two words should not be a box somebody can misspell — and because
   *  a client that has never heard of `select` falls back to a text input and
   *  still works. */
  kind: "text" | "textarea" | "number" | "select";
  required: boolean;
  default: string;
  /** Only for `select`. `value` is what is sent; `label` is what is drawn. */
  options?: { value: string; label: string }[];
};

export type KindDef = {
  kind: RunKind;
  name: string;
  /** One sentence for the app card and the skill. What it does, and what it
   *  does NOT — the second half is the one that stops a page over-promising. */
  what: string;
  needsVenture: boolean;
  inputs: InputSpec[];
};

export const KINDS: KindDef[] = [
  {
    kind: "research",
    name: "Research",
    what:
      "Deep research on the venture against the commercial web: investigates with the agent's own tools — web search and this dashboard's skills — and then writes a report. With no agent live it is a raw model reasoning over what this box already measured, and the report says so.",
    needsVenture: true,
    inputs: [
      {
        key: "focus",
        label: "What to look into",
        hint: "One or two lines. Empty asks the broad question: where this business actually stands and what to do next.",
        kind: "textarea",
        required: false,
        default: "",
      },
    ],
  },
  {
    kind: "competitors",
    name: "Competitors",
    what:
      "Sweeps the venture's market and accumulates: each run verifies the rivals already on file, deepens them, and adds the ones it found. A profile the run did not mention keeps its old verified date — silence is not verification.",
    needsVenture: true,
    inputs: [
      {
        key: "focus",
        label: "Where to look",
        hint: "A segment, a geography, a named rival to check. Empty sweeps the market the venture record describes.",
        kind: "textarea",
        required: false,
        default: "",
      },
    ],
  },
  {
    kind: "seo",
    name: "SEO review",
    what:
      "Reads the latest audit, Search Console, Bing, the backlink rows and the presence matrix, and writes what to change, ranked. It crawls nothing — the audit is the crawl, and it is run from the venture page.",
    needsVenture: true,
    inputs: [
      {
        key: "focus",
        label: "Anything to weight",
        hint: "A page, a query, a section of the site. Empty ranks by what the audit and Search Console say costs most.",
        kind: "textarea",
        required: false,
        default: "",
      },
    ],
  },
  {
    kind: "demand",
    name: "Demand",
    what:
      "Reads the demand signals already collected — Reddit, Hacker News, the search node — for the watch phrases, and writes what strangers are actually asking for. It searches nothing itself; the watch list is a setting the owner wrote.",
    needsVenture: true,
    inputs: [
      {
        key: "focus",
        label: "Which phrases matter",
        hint: "Empty reads the whole watch list. Naming phrases weights them; it does not add them to the list.",
        kind: "textarea",
        required: false,
        default: "",
      },
    ],
  },
  {
    kind: "geo",
    name: "AI visibility",
    what:
      "Asks the active model provider — no tools, no web — what it knows about the venture and its host, scores mention, accuracy and recommendation, and keeps every answer. This one deliberately never uses an agent: the measurement is what a model says unaided.",
    needsVenture: true,
    inputs: [
      {
        key: "category",
        label: "Category to be recommended in",
        hint: "The words a stranger would use: “support chatbot”, “planning permission search”. Empty takes them from the venture's own description.",
        kind: "text",
        required: false,
        default: "",
      },
      {
        key: "questions",
        label: "Extra questions",
        hint: "One per line. These are asked as well as the three standard ones, not instead of them.",
        kind: "textarea",
        required: false,
        default: "",
      },
    ],
  },
  {
    kind: "papers",
    name: "Papers",
    what:
      "Scouts OpenAlex and arXiv for the topic, builds a library, plans a contribution that is net-new against every paper written here before, draws its figures, and TYPESETS it with Typst: one or two columns, numbered headings and figures, and an IEEE bibliography generated from the library entries the body actually cites. With no typesetter on the box it falls back to markdown printed by the installed Chrome and says so on the paper.",
    needsVenture: false,
    inputs: [
      {
        key: "topic",
        label: "Topic",
        hint: "What the paper is about, in the words a literature search would use. With a venture chosen and this left empty, the venture's own subject is the topic.",
        kind: "text",
        required: false,
        default: "",
      },
    ],
  },
  {
    /* THE ONE KIND HERE THAT NO MODEL ANSWERS. Every other brief above is a
       question put to an agent; this is arithmetic over the venture
       screenshots — a PNG decoded in-process, two tables read, six heuristics
       with three verdicts each. It is a RUN because decoding a dozen images is
       seconds of CPU that must not sit inside a request, and because the queue,
       the ledger and the addressed report are worth having for it. See
       integrations/security/shotsqa.ts. */
    kind: "shotsqa",
    name: "Screenshot QA",
    what:
      "Audits the screenshot on every venture's card: dimensions, whether the picture is a flat rectangle rather than a page, error wording in the page title, what the latest audit says about http, and how stale the capture is. No model looks at the images — nothing on this box says whether a configured provider can accept one — so every verdict is arithmetic, and a check that could not be run is reported as unchecked rather than as a pass.",
    needsVenture: false,
    inputs: [],
  },
  {
    /* THE ONE KIND THAT PRODUCES A FILE RATHER THAN A DOCUMENT. Its `output`
       is a note ABOUT the video — the script, the credits, what could not be
       done — the way a paper run's is a note about its PDF. See
       integrations/video/. */
    kind: "video",
    name: "Video",
    what:
      "Makes a vertical video on this machine. `faceless` writes a script from the venture, finds stock footage on Pexels for every beat, burns captions in the venture's own colour and font, and adds an end card. `shorts` downloads a long video with yt-dlp and cuts two to four vertical clips out of it, choosing the windows from timed words and camera cuts where it can measure them and from even spacing where it cannot — which it says on every clip, and following the subject with the crop where there is something to follow. `reel` screenshots the venture's OWN pages and plays a two-voice walkthrough over them, scrolling. `motion` renders a scene list — a title card, a number, a before/after, a list, a call to action — as animated typography in the venture's own colours. `ugc` takes the venture's own reference pictures out of its asset library, puts the product into a scene with the image model, and animates that still with a Replicate image-to-video model — which is SKIPPED, with a sentence, when no such model is configured, so nothing is spent. `stewie` is the Peter & Stewie two-hander over mobile-game footage with cloned voices — rendered by Workdash's reel worker on the Dell through the Pi, so it needs a Workdash account under Integrations and a few minutes, and copies the mp4 back here. It publishes nothing anywhere: the file lands on this page.",
    needsVenture: false,
    inputs: [
      {
        key: "format",
        label: "What to make",
        hint: "faceless, shorts, ugc, reel, motion or stewie",
        kind: "select",
        required: true,
        default: "faceless",
        options: [
          { value: "faceless", label: "Faceless — script and stock footage" },
          { value: "shorts", label: "Shorts — cut up a long video" },
          { value: "ugc", label: "UGC — a product shot, animated" },
          { value: "reel", label: "Reel — two voices over your own pages" },
          { value: "motion", label: "Motion — animated typography from a scene list" },
          { value: "stewie", label: "Stewie — Peter & Stewie explain it over gameplay footage" },
        ],
      },
      {
        key: "spec",
        label: "Scene spec",
        hint:
          "Motion only. The id of a saved scene list (see the Motion page). Empty asks the model for one from the brief — which is a draft with claims in it, so read it before you publish the video.",
        kind: "text",
        required: false,
        default: "",
      },
      {
        key: "voiceover",
        label: "Speak the scene lines",
        hint:
          "Motion only. `true` speaks each scene's narration line through the voice plugin. Anything else is silent, which is the ordinary case — speech is off by default.",
        kind: "select",
        required: false,
        default: "false",
        options: [
          { value: "false", label: "Silent" },
          { value: "true", label: "Narrated — if the voice plugin has speech on" },
        ],
      },
      {
        key: "brief",
        label: "What it is about",
        hint: "One or two lines. For a faceless video this is the whole subject; for shorts it steers which moments are chosen. Empty makes the general case for the venture.",
        kind: "textarea",
        required: false,
        default: "",
      },
      {
        key: "url",
        label: "Source video",
        hint:
          "Shorts only, and required for it: a YouTube address or a direct link to a video file. For a REEL this is instead the venture's own page addresses to walk through, one per line — empty uses the venture's website.",
        kind: "text",
        required: false,
        default: "",
      },
      {
        key: "seconds",
        label: "Length in seconds",
        hint:
          "For faceless, how long the whole video is — 10 to 120, and the beats are shared out inside it. For shorts, the LONGEST a single clip may be — 15 to 90. For a reel, how long the whole thing is, which is what decides how many lines of dialogue there are. Motion takes its length from the scene list instead.",
        kind: "number",
        required: false,
        default: "30",
      },
      {
        key: "clips",
        label: "How many clips",
        hint: "Shorts only. Two to four.",
        kind: "number",
        required: false,
        default: "3",
      },
      {
        /* UGC only. Comma-separated asset ids out of the venture's own library;
           empty uses the library, up to four. Added with the `ugc` format —
           see integrations/socialfeed/ugc.ts. */
        key: "assets",
        label: "Reference pictures",
        hint: "UGC only. Asset ids from the venture's library, comma separated. Empty uses whatever is in the library, up to four.",
        kind: "text",
        required: false,
        default: "",
      },
      {
        /* Stewie only. A gameplay clip the Workdash render worker holds, by
           name; empty takes the worker's default. The names come from the
           worker's own health answer (GET /api/stewie). */
        key: "background",
        label: "Gameplay footage",
        hint: "Stewie only. The name of a background clip the render worker holds — see the Studio's Stewie tab for the list. Empty takes the worker's default.",
        kind: "text",
        required: false,
        default: "",
      },
      {
        key: "aspect",
        label: "Shape",
        hint: "9:16 unless you have a reason.",
        kind: "select",
        required: false,
        default: "9:16",
        options: [
          { value: "9:16", label: "9:16 — reels, shorts, TikTok" },
          { value: "1:1", label: "1:1 — a square feed post" },
          { value: "16:9", label: "16:9 — landscape" },
        ],
      },
      {
        key: "fit",
        label: "How the picture fits",
        hint: "Matters for shorts, where the source is usually landscape. Centre crop fills the frame and loses the edges; letterbox keeps the whole picture over a blurred copy of itself and is the face-safe one.",
        kind: "select",
        required: false,
        default: "cover",
        options: [
          { value: "cover", label: "Centre crop — fills the frame" },
          { value: "letterbox", label: "Letterbox — keeps the whole picture" },
        ],
      },
    ],
  },
  {
    kind: "serp",
    name: "SERP teardown",
    what:
      "Searches for a set of queries, reads the pages that outrank this venture in code — headings, word count, links, schema, FAQ and table markup — and compares them with our own page. Queries come from the form, else from Search Console's striking-distance rows, else derived from the venture record and labelled as derived. It ranks nothing itself: the order is whichever engines the search node had.",
    needsVenture: true,
    inputs: [
      {
        key: "queries",
        label: "Queries to tear down",
        hint: "One per line, up to five. Empty takes the venture's Search Console queries sitting between positions 5 and 20 — the ones where a page already exists and only the pages above it are in the way — and, with no Search Console property, derives one from the venture's own description and says so.",
        kind: "textarea",
        required: false,
        default: "",
      },
      {
        key: "results",
        label: "Competitor pages per query",
        hint: "How many of the pages above us to read. One page per registrable domain, so a rival's three subdomains do not eat the sample. Clamped to 3-8.",
        kind: "number",
        required: false,
        default: "5",
      },
    ],
  },
  {
    kind: "aso",
    name: "Store listing audit",
    what:
      "Reads this venture's App Store and Play listings the way a shopper does — title, description, screenshots, rating, how long since the last version — checks them against each store's own rules, and scores them on this app's rubric with the arithmetic printed. It cannot see Apple's subtitle or keyword field, and it says so rather than passing them by silence.",
    needsVenture: true,
    inputs: [
      {
        key: "store",
        label: "Which store",
        hint: "Empty audits every listing this venture has. `appstore` or `play` narrows it to one.",
        kind: "text",
        required: false,
        default: "",
      },
    ],
  },

  /* THE CAMPAIGN KIND, owned by integrations/publishing/. It is a run because
     the fan-out is minutes of model calls and image renders that must survive
     a tab closing, be cancellable and be queued behind everything else. */
  {
    kind: "campaign",
    name: "Campaign",
    what:
      "Plans a social campaign for the venture — a small number of non-overlapping concepts from one goal — and then writes each concept once per channel, as Studio drafts. Every variant becomes a DRAFT in the publishing queue; nothing is approved, scheduled or published by running it.",
    needsVenture: true,
    inputs: [
      {
        key: "goal",
        label: "What the campaign is for",
        hint: "One or two lines, in your own words. “Get the first ten beta users for the planning tool.”",
        kind: "textarea",
        required: true,
        default: "",
      },
      {
        key: "channels",
        label: "Channels",
        hint: "Comma separated. `page`, `ig`, `linkedin` and `tiktok` are the ones this box can publish to; any other name is written for and produces drafts with nowhere to go.",
        kind: "text",
        required: true,
        default: "page",
      },
      {
        key: "audience",
        label: "Who it is aimed at",
        hint: "Optional, in your own words. Empty lets the planner use the audience the venture record implies.",
        kind: "text",
        required: false,
        default: "",
      },
      {
        key: "concepts",
        label: "How many concepts",
        hint: "Each concept is a different argument, written once per channel — so this times the channel count is how many posts get made, and how many image renders get paid for. Clamped to 1-5.",
        kind: "number",
        required: false,
        default: "3",
      },
    ],
  },

  /* THE FIRST KIND THAT IS ABOUT A PERSON RATHER THAN A BUSINESS, owned by
     integrations/people/. Everything above is venture × role; this one
     belongs to NO venture, because a founder the owner is watching is not
     filed under one of his own companies and pretending otherwise would put
     the same person in eight places. See integrations/people/dossier.ts for
     the run and integrations/subagents/store.ts for the worker that has no
     business attached to it. */
  {
    kind: "dossier",
    name: "Dossier",
    what:
      "A sourced, dated profile of one person of interest — a founder, a customer, a correspondent — from a bounded web sweep and what this box already holds about them: who they are, what they are building, what changed since the last dossier, their recent public activity, the signals, the open questions, and the sources actually used.",
    needsVenture: false,
    inputs: [
      {
        /* EXACTLY ONE INPUT, and it is a textarea, because the dispatch door
           puts a brief into the first textarea a kind declares — see
           `briefField` in integrations/subagents/routes.ts. So for this kind
           the brief IS the person, and there is no second field for a worker
           or an agent to leave empty by mistake. */
        key: "person",
        label: "Who",
        hint: "A name, plus a company, a handle or a link so the right person is found — and anything in particular to look into.",
        kind: "textarea",
        required: true,
        default: "",
      },
    ],
  },

];

export function kindDef(kind: string): KindDef | null {
  return KINDS.find((k) => k.kind === kind) ?? null;
}

/**
 * WHAT A DOSSIER RUN IS CALLED, and why it is one function rather than two
 * string templates.
 *
 * A dossier is written about the SAME PERSON again and again — that is the
 * whole of "What changed" — and the only thing tying this month's to last
 * month's is the title. Two doors start these runs, the run app's form and a
 * dispatch to the People Analyst, and if they titled the same brief two
 * different ways the second dossier would never find the first and would
 * quietly report a first meeting every time. So the title is derived here,
 * once, by both.
 *
 * The FIRST LINE only, AND ONLY THE PART OF IT THAT NAMES THEM: a brief's
 * second paragraph is what to look into, not who, and so is the clause after
 * a dash, a colon or a question mark on the first line — "Jane Doe, founder
 * of Acme — what is she building now?" is one person, and a title carrying
 * the question would be a title no two runs ever share. The comma is kept:
 * "Jane Doe, founder of Acme" is how a person is told apart from another Jane
 * Doe, and it is what the shelf groups by.
 */
export const DOSSIER_TITLE_CAP = 80;

export function dossierTitle(person: string): string {
  const first = person.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const named = (first.split(/\s+[—–-]\s+|[:;?]/)[0] ?? "").trim() || first;
  const who =
    named.length > DOSSIER_TITLE_CAP ? `${named.slice(0, DOSSIER_TITLE_CAP - 1).trimEnd()}…` : named;
  /* Never an empty tail. A run with no name in it is a run the ledger cannot
     be read for, and "someone unnamed" says which mistake was made. */
  return `Dossier — ${who || "someone unnamed"}`;
}

/* ------------------------------------------------------------ the briefing */

/** The four that are true of every document on this box, restated here for a
 *  reader that may never see the skills registry — a raw provider does not. */
const HONESTY = [
  "NEVER INVENT A FIGURE. Every number you write must appear in this brief or be one you computed from numbers that do. If you do not have a figure, say that it is not measured here.",
  "A SAMPLE IS NEVER A MEASUREMENT. If you quote three rows out of a list, say it is three rows out of that list, and never present them as the whole.",
  "ABSENT IS NOT ZERO AND BLOCKED IS NOT ABSENT. Where a block says a source was never asked, refused, or could not be read, report that it was not checked — not that it found nothing.",
  "MONEY IS NEVER ADDED ACROSS CURRENCIES, and a figure a source de-duplicated cannot be summed.",
  "NAME THE SOURCE OF EVERY CLAIM. Each block below is labelled with where it came from; quote that label when you use it.",
];

const REPORT_SHAPE = `Write ONE markdown document AS YOUR REPLY — not to a file — and nothing before or after it, with exactly these sections:

## Findings
What is true, worst or most important first. Every finding names the block it came from.

## Evidence
The URLs, rows and figures the findings rest on, so the owner can check them. If a finding has no evidence beyond your own reasoning, say so here rather than dressing it up as a source.

## Recommendations
What to do, ranked, each one a thing that can be started this week. Say what it costs and what it would change.

Then, at the end of the document, a fenced code block whose info string is exactly \`json cards\` containing an array of board-card suggestions:

\`\`\`json cards
[{"title": "…", "body": "…", "urgency": 2}]
\`\`\`

Between three and eight cards. \`urgency\` is 0 (whenever) to 3 (this week). A card is one action with a title somebody could tick off, and its body says why. Nothing files these — the owner picks which ones become cards — so suggest the real work rather than what is safe to suggest.`;

/**
 * The system turn.
 *
 * `hasTools` IS THE ONE FORK. See the file header: an agent is told what is
 * worth going and looking at, a raw provider is told that this brief is
 * everything it will ever know about this business and that it must not
 * pretend otherwise.
 */
export function systemBrief(opts: {
  def: KindDef;
  ventureName: string | null;
  hasTools: boolean;
  data: string;
  extra?: string[];
  /**
   * A REPLACEMENT for the report shape, not an addition to it.
   *
   * Added for the dossier, which is the first document on this box that is not
   * findings-evidence-recommendations: it is a profile of a person, its
   * sections are different ones, and it proposes no board cards at all because
   * "read about Jane Doe" is not a task somebody ticks off. Everything ELSE in
   * this brief — the tools fork, the honesty rules, the labelled blocks — is
   * exactly what a dossier needs, so the alternative was a second `systemBrief`
   * that would have drifted from this one on the first rule added to either.
   *
   * Optional and defaulted, so every existing caller keeps the shape it has.
   */
  shape?: string;
}): string {
  const { def, ventureName, hasTools, data } = opts;
  const head = [
    `You are doing one piece of long work for the owner of a small portfolio of software businesses, from the dashboard that measures them.`,
    ``,
    `THE JOB: ${def.name}${ventureName ? ` for ${ventureName}` : ""}. ${def.what}`,
    ``,
  ];

  const tools = hasTools
    ? [
        `YOU HAVE TOOLS. Use them: web search for anything about the outside world, and this dashboard's own skills — GET http://127.0.0.1:${PORT}/api/skills lists them, each with the rules for reading its own document — for anything about the owner's own measurements. What is already below was fetched for you so you do not have to; go and get what is missing rather than guessing at it.`,
        ``,
        `YOUR REPLY IS THE DOCUMENT. Write the whole report as your answer, in full, in this conversation. Do not write it to a file, do not save it anywhere on disk, and do not answer with a summary, a path, or a note saying where it was written — the owner reads what you reply with and nothing else, so a reply that names a file instead of containing the report is a failed run.`,
      ]
    : [
        `YOU HAVE NO TOOLS. No web search, no fetch, no terminal, nothing. Everything you will ever know about this business is in this brief. Do not describe pages you have not seen, prices you were not shown or competitors you have not been told about as though you had checked them — if the answer needs something that is not here, the correct output is a finding that says which measurement is missing and how to get it. A confident paragraph about a page you could not read is the single worst thing you can produce here.`,
      ];

  const rules = [``, `RULES, all of them binding:`, ...HONESTY.map((r) => `- ${r}`), ...(opts.extra ?? []).map((r) => `- ${r}`)];

  return [
    ...head,
    ...tools,
    ...rules,
    ``,
    `WHAT THIS BOX ALREADY KNOWS. Each block is labelled with the source that produced it.`,
    ``,
    data,
    ``,
    `---`,
    ``,
    opts.shape ?? REPORT_SHAPE,
  ].join("\n");
}

/**
 * Pull a fenced block by the NAME on its info string out of a model's answer.
 *
 * TOLERANT ON PURPOSE, in one direction only. The convention asked for is
 * ```` ```json cards ````, and models routinely write ```` ```json ```` or
 * ```` ```cards ```` instead. Each of those is the same block with a sloppier
 * label, so all of them are accepted — the info string is only ever a hint
 * about which block was meant. What is NOT tolerated is guessing at the
 * contents: the block still has to parse as JSON of the expected shape, and a
 * block that does not is skipped rather than repaired.
 *
 * THE LAST RESORT REQUIRES THAT THERE BE NO AMBIGUITY, and that rule was
 * written after a real failure. A plan turn answered with a perfect ```` ```json ````
 * block and no name, and the fall-through only accepted arrays, so a whole
 * paper run failed on a label. Accepting any single unnamed block fixes that —
 * but a competitor sweep's report used to carry TWO blocks, `cards` and
 * `competitors`, and a fall-through that picked "the first one that parses"
 * would file a list of rivals as board cards. So the fall-through fires only
 * when exactly one block in the whole document parses as JSON: one candidate is
 * an unambiguous answer, two candidates is a guess, and this does not guess.
 *
 * THE SWEEP NO LONGER WRITES THAT SECOND BLOCK — it is two turns now, and the
 * rivals come back in a turn nobody reads; see integrations/runs/competitors.ts
 * — but every sweep run before that is still on disk and still read back
 * through here, so the rule stays.
 */
export function fencedJson(markdown: string, name: string): unknown | null {
  const fences = [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)].map((m) => ({
    info: (m[1] ?? "").toLowerCase(),
    body: m[2] ?? "",
  }));
  const parse = (body: string): unknown | null => {
    try {
      return JSON.parse(body.trim()) as unknown;
    } catch {
      return null;
    }
  };
  /* Named first, then any JSON block that carries the key, then — last — any
     block at all that parses to an array. The order is confidence order. */
  for (const f of fences) if (f.info.includes(name)) {
    const v = parse(f.body);
    if (v !== null) return unwrap(v, name);
  }
  for (const f of fences) {
    const v = parse(f.body);
    if (v !== null && typeof v === "object" && v !== null && !Array.isArray(v) && name in (v as Record<string, unknown>))
      return (v as Record<string, unknown>)[name];
  }
  const parsed = fences.map((f) => parse(f.body)).filter((v) => v !== null);
  return parsed.length === 1 ? unwrap(parsed[0], name) : null;
}

function unwrap(v: unknown, name: string): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && name in (v as Record<string, unknown>))
    return (v as Record<string, unknown>)[name];
  return v;
}
