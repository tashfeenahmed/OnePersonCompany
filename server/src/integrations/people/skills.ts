/**
 * The people area's skill entries.
 *
 * TWO ENTRIES BECAUSE THEY ARE TWO PROMISES. `people` is metadata: who, how
 * often, how long since — and it may never be asked what anybody said, because
 * nothing in its tables knows. `commitments` is the owner's own words, quoted
 * verbatim, and every rule on it is about not letting a paraphrase pass for
 * one. Folding them into one skill would put an entry on this box whose rules
 * contradict each other paragraph by paragraph.
 *
 * `people` HAS THREE ACTIONS AND ALL THREE ARE ABOUT THE WATCHLIST. Nothing
 * else in the entry can be written to: the contacts are a fold of headers and
 * the brief is a weekly record, so there is nothing there to change. The
 * watchlist is the opposite — it is typed, and adding to it is the only way a
 * row ever appears. `watch_add` is not destructive (a row the owner will find
 * and can edit or delete); `dossier` is, because it takes the run slot and
 * pays for a long completion, and cancelling the run does not refund it;
 * `pull` is NOT, and the distinction is worth defending rather than rounding
 * up. A pull makes at most six anonymous GETs against public APIs and writes
 * what they said onto the person's own row. It spends no run slot, no tokens
 * and no credential, and flagging it destructive “to be safe” would teach a
 * client to ignore the flag on `dossier`, which really does spend. It does
 * reach machines that are not this one, which is what `openWorld` says.
 * `commitments` has three actions and none is destructive — done, dismiss and
 * scan are all reversible, and marking them destructive to be safe would train
 * a client to ignore the field.
 *
 * Types only from skills/registry.ts: a value-level import would cycle.
 */
import type { Skill } from "../../skills/registry.ts";
import {
  COLD_RATIO,
  COOLING_RATIO,
  DEFAULT_MIN_EACH_WAY,
  DEFAULT_STALE_DAYS,
  DEFAULT_WINDOW_DAYS,
  MIN_GAPS,
  MIN_QUIET_DAYS,
} from "./contacts.ts";
import { DEFAULT_DAYS, MAX_MESSAGES } from "./commitments.ts";
import { DELTA_DAYS, MAX_EVENTS, MAX_HISTORY, NEW_FOR_DAYS } from "./watch.ts";

export const SKILLS: Skill[] = [
  {
    id: "people",
    title: "People — who he corresponds with, and how warm it is",
    plugins: ["gmail"],
    about:
      "Every person the owner exchanges mail with, folded out of Gmail " +
      "HEADERS over a rolling window (default " +
      `${DEFAULT_WINDOW_DAYS} days): the address, the display name they sign ` +
      "with, how many messages each way, how many threads, the day each side " +
      "last wrote, and a day-by-day series. From those, computed on every " +
      "read: the median gap between days on which mail passed (their " +
      "cadence), how long it has been since either of them wrote, and a " +
      "temperature — warm, cooling, cold — measured against THAT PAIR'S OWN " +
      "rhythm rather than against a fixed number of days. Also a weekly " +
      "relations brief: who he has stopped writing to, who went quiet, who is " +
      "new. And, separately, the WATCHLIST: people he keeps an eye on, typed " +
      "by hand rather than collected, each with the dossiers written about " +
      "them — and, on each one's file, tracked numbers and a public-activity " +
      "timeline pulled from KEYLESS sources (GitHub, Bluesky, Hacker News, " +
      "RSS), plus the mailbox's own side of the relationship where there is " +
      "one.",
    rules: [
      "THIS IS METADATA. No subject line, snippet or message body is anywhere " +
        "in these tables — the collector asks Gmail for headers only. So this " +
        "document cannot say what any two people talked about, why a " +
        "correspondence went quiet, or whether anybody meant anything by it, " +
        "and you must not guess. Say what it measures: counts, dates, gaps.",
      `Temperature is relative to the pair, never to the calendar: cooling at ` +
        `${COOLING_RATIO}× their median gap between contact days, cold at ` +
        `${COLD_RATIO}×, and nothing is called cooling before ` +
        `${MIN_QUIET_DAYS} days of silence. Somebody he mails every August is ` +
        `not cold in September.`,
      `\`temperature: null\` means there were fewer than ${MIN_GAPS} measurable ` +
        "gaps — no rhythm, so no claim. It is not cold and it is not warm. " +
        "Quote `why`, which states the arithmetic in words.",
      "`stale` is a DIFFERENT question and it is the owner's own: no mail " +
        `either way for the stale-after setting (default ${DEFAULT_STALE_DAYS} ` +
        "days). Cold is relative to the relationship; stale is relative to the " +
        "calendar. Do not use one word for the other.",
      "Every count is PER WINDOW and per contact. `sent` and `received` do NOT " +
        "sum to mail volume: a message addressed to five people counts once " +
        "for each of the five. Never total those columns.",
      "When `floors: true` the scan's message cap bit and it reached back only " +
        "to `scanFrom`. Counts and `firstSeen` are then floors — “no earlier " +
        "than” — never totals, and “first seen in March” must be said as " +
        "“the scan reached back to March”.",
      "A VENTURE LINK IS A GUESS AND IS LABELLED ONE. It is the contact's " +
        "domain matching a venture's host, it carries `derived: true` and its " +
        "own reason, and somebody at a venture's domain is usually connected " +
        "to it and sometimes is a stranger who bought a mailbox there. Say " +
        "“their address is at that venture's domain”, never “they are a " +
        "a contact at one of my ventures”.",
      "The list is ordered by `weight` — 10 × the smaller of the two " +
        "directions, plus the total. That orders a list and measures nothing " +
        "about a relationship; do not report it as importance.",
      "The brief's paragraph, where there is one, was written by a model from " +
        "the figures and nothing else, and was thrown away entirely if it " +
        "used a name, number or address the figures do not carry. Where " +
        "`markdown` carries no paragraph, the figures ARE the brief and that " +
        "is not a failure. `firstBrief: true` means there was nothing to " +
        "compare against, so nobody cooled “this week”.",
      "The same person seen through two connected mailboxes is two rows and " +
        "two relationships. They are shown side by side and are never added " +
        "together.",
      "THE WATCHLIST IS A DIFFERENT KIND OF THING FROM THE CONTACTS, AND IT " +
        "HAS TWO HALVES. The IDENTITY half \u2014 name, company, role, email, " +
        "note, links, tags \u2014 is typed by hand; nothing collects it, nothing " +
        "refreshes it, and a blank field means he did not write it down rather " +
        "than that nobody knows. The PUBLIC half \u2014 metrics and events \u2014 is " +
        "pulled from keyless public sources and never writes over anything he " +
        "typed. Most people on the list have never written to him, so an empty " +
        "contacts record for one of them means the mailbox has not seen them, " +
        "never that the entry is wrong.",
      "A person\u2019s `dossiers.count` is FINISHED dossiers. A failed or " +
        "running one is in `dossiers.last` with its status, and reporting " +
        "`last` as a written dossier without reading its status is reporting " +
        "a report that does not exist.",
      "EVERY TRACKED NUMBER IS NULLABLE AND null MEANS NOT KNOWN, NEVER ZERO. " +
        "There is no link of that kind on the card, or the public source did " +
        "not answer \u2014 and `warnings` says which. An account with genuinely " +
        "no followers reports 0, so “no followers” and “nobody here knows” " +
        "must not be said with the same word.",
      "`metrics.at` and `activityAt` are when the PULL RAN, not when anything " +
        "happened. `activityAt: null` is “never pulled”, which is different " +
        "from “pulled and quiet”. A source that failed leaves its last figure " +
        "standing rather than blanking it, so a number may be older than the " +
        "timestamp beside it whenever `warnings` is non-empty.",
      `\`newEvents\` counts events this box FIRST SAW in the last ` +
        `${NEW_FOR_DAYS} days \u2014 not events that happened in them. A person ` +
        "pulled for the first time has a whole timeline that is new to this " +
        "box, so the number reads high on the day they are added and must " +
        "never be reported as “they published that many things this week”.",
      "SIGNALS ARE WHAT THIS BOX NOTICED, NOT WHAT ANYBODY PUBLISHED. On the " +
        "timeline they carry source `watch` and kind `change`, and each one " +
        "is the result of comparing this pull with the last: a bio rewritten, " +
        "a follower count or karma score that moved by at least ten AND at " +
        "least one per cent, a new public repository. Nobody posted them. " +
        "Reporting a signal as something the person said or did is the one " +
        "way to misread this timeline, and `signals` on a list row counts " +
        `only the ones first seen in the last ${NEW_FOR_DAYS} days.`,
      `\`metrics.deltas\` is the ${DELTA_DAYS}-day movement of each figure, ` +
        "and A MISSING KEY IS NOT ZERO. It means there is no reading from a " +
        "week ago to subtract \u2014 somebody added on Tuesday, a link typed " +
        "yesterday \u2014 and saying “no change” about it would be a " +
        "measurement of somebody nothing is known about. `history` is the " +
        "series the deltas come from: one row per day the box LOOKED, oldest " +
        `first, at most ${MAX_HISTORY}. A short history is a short watch, ` +
        "never a quiet person.",
      "`sweep` on the watch view is about the LIST, not a row. `lastAt` is " +
        "the OLDEST pull stamp on it \u2014 the moment by which everybody had " +
        "been read \u2014 and is null unless `everyonePulled`; `nextDueAt` is " +
        "null when somebody is due already rather than a stamp in the past.",
      "The activity timeline is PUBLIC POSTS AND PUSHES, cached from sources " +
        "that need no credential. It is not everything they did, it is not " +
        "everything they published, and a quiet timeline is evidence about " +
        "four feeds and nothing else. X and LinkedIn are not read at all.",
      "The `contact` panel on a person\u2019s file is matched on their email " +
        "address first and otherwise on first-and-last name, accent- and " +
        "case-folded. `matchedBy: \"name\"` IS A GUESS, an ambiguous name match " +
        "returns null rather than a stranger\u2019s correspondence, and null is " +
        "the ordinary answer because most people on this list have never " +
        "written to him.",
    ],
    views: [
      {
        key: "default",
        path: "/api/people",
        about:
          "The contacts, ordered by weight, with the window state and the counts by temperature. Mutual contacts only unless all=1.",
        params: [
          {
            name: "stale",
            type: "string",
            required: false,
            about: "“1” to return only contacts with no mail either way inside the stale-after window.",
          },
          {
            name: "domain",
            type: "string",
            required: false,
            about: "Only contacts at this domain, or a subdomain of it.",
          },
          {
            name: "venture",
            type: "string",
            required: false,
            about:
              "A venture slug, id, name or host. Returns contacts whose DERIVED link points at it — a guess, see the rules.",
          },
          {
            name: "q",
            type: "string",
            required: false,
            about: "Substring of the address, display name or domain.",
          },
          {
            name: "all",
            type: "string",
            required: false,
            about:
              `“1” to include addresses below the minimum-each-way rule (default ${DEFAULT_MIN_EACH_WAY} messages in BOTH directions) — receipts, one-way senders and the like.`,
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 200,
            about: "How many contacts to return. Clamped to 1–1000.",
          },
        ],
      },
      {
        key: "contact",
        path: "/api/people/:address",
        about:
          "One person: every figure above plus their day-by-day series, once per mailbox they were seen through.",
        params: [
          {
            name: "address",
            type: "string",
            required: true,
            in: "path",
            about: "The full email address, lower-cased.",
          },
        ],
      },
      {
        key: "stale",
        /* The filter is FIXED IN THE PATH rather than offered as a parameter
           with a default. A `fallback` is documentation — the proxy sends only
           what the caller actually passed — so a "stale" view whose stale=1
           lived in a fallback would quietly answer with every contact. */
        path: "/api/people?stale=1",
        about:
          "The contacts with no mail either way inside the stale-after window — the “who have I not spoken to since spring” cut. Nothing else can turn this filter off.",
        params: [
          {
            name: "domain",
            type: "string",
            required: false,
            about: "Only contacts at this domain, or a subdomain of it.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 200,
            about: "How many to return. Clamped to 1–1000.",
          },
        ],
      },
      {
        key: "brief",
        path: "/api/people/brief",
        about:
          "The weekly relations brief: the markdown, and the figures it was written from.",
        params: [
          {
            name: "week",
            type: "string",
            required: false,
            about: "An ISO week, “2026-W36”. Absent means the most recent brief written.",
          },
        ],
      },
      {
        key: "watch",
        path: "/api/people/watch",
        about:
          "The owner’s hand-kept list of people of interest — name, company, role, email, links, tags and his own note — each with its tracked numbers and their " +
          `${DELTA_DAYS}-day movement in \`metrics.deltas\` (a MISSING key is “no reading a week old”, never 0), when its public sources were last read, how many events are new to this box, how many of those were \`signals\` (profile changes this box noticed rather than anything the person published), and its dossier record: how many have been written, whether one is running or queued, and how the last one ended. The document also carries \`sweep\` \u2014 \`lastAt\` (the OLDEST pull stamp, so it is the moment by which EVERYBODY had been read, and null unless \`everyonePulled\`), \`nextDueAt\` (null when somebody is due already) and \`everyMs\`. The IDENTITY half is TYPED, not collected: most of these people are not in the contacts document at all.`,
        params: [],
      },
      {
        key: "person",
        path: "/api/people/watch/:id",
        about:
          "The file on one watched person, in four separately-sourced parts: `person` (what he typed, plus the tracked numbers), `contact` (the mailbox’s side of the relationship, or null — usually null), `events` (their public activity, newest first, at most " +
          `${MAX_EVENTS} kept per person: GitHub pushes, releases and new repositories, Bluesky posts, Hacker News stories and comments, RSS items), and \`dossiers\` (every dossier run attaching to their name, newest first). \`history\` is the daily metric series, OLDEST FIRST \u2014 one row per day the box LOOKED, at most ${MAX_HISTORY} of them, and a row of nulls is a pull that reached nobody rather than figures that went to zero. \`warnings\` is what the LAST pull could not read. \`person.avatar\` is a RELATIVE URL ON THIS BOX \u2014 /api/people/watch/<id>/avatar \u2014 and never the address the picture came from: the bytes are fetched once by the pull and served from here, so that opening somebody\u2019s file tells no third party who was looked at. null means no picture was found \u2014 no GitHub or Bluesky avatar, no imported URL, or nobody has pulled them yet \u2014 and it is never a claim that they have no photograph.`,
        params: [
          {
            name: "id",
            type: "string",
            required: true,
            in: "path",
            about: "The watch entry’s id, from the watch view.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "watch_add",
        method: "POST",
        path: "/api/people/watch",
        about:
          "Put somebody on the watchlist. Adds a row he will find there later; nothing is collected, sent or spent, and the entry can be edited or removed from the page. A name already on the list is refused rather than duplicated.",
        params: [
          { name: "name", type: "string", required: true, about: "Who. The only required field, and what any dossier on them is titled after \u2014 so spell it the way he would." },
          { name: "company", type: "string", required: false, about: "Where they work, as he would write it. At most 120 characters." },
          { name: "role", type: "string", required: false, about: "What they do. At most 120 characters." },
          { name: "email", type: "string", required: false, about: "An address, if there is one. Trimmed and never format-checked \u2014 nothing here sends mail." },
          { name: "note", type: "string", required: false, about: "Why they are on the list, in his words. At most 4,000 characters." },
        ],
      },
      {
        key: "dossier",
        method: "POST",
        path: "/api/people/watch/:id/dossier",
        about:
          "Ask the People Analyst for a dossier on somebody already on the watchlist. The brief is composed from their row \u2014 name first, then only the identity lines that were typed \u2014 so the run joins the earlier dossiers on that person rather than starting a new pile. Answers 409 when the analyst is switched off.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The watch entry\u2019s id, from the watch view." },
          { name: "focus", type: "string", required: false, about: "What to look into this time, a line or two. Goes last in the brief, after the identity lines, and never into the title." },
          {
            name: "parentSessionId",
            type: "string",
            required: false,
            exampled: true,
            about: "The conversation this was asked in, so the run is filed under it. Send it whenever you have it.",
          },
        ],
        /* IT SPENDS. A dispatch takes the run slot and pays for a long
           completion on the owner\u2019s account, and cancelling the run does not
           refund it \u2014 see the four in skills/registry.ts. */
        destructive: true,
      },
      {
        key: "pull",
        method: "POST",
        path: "/api/people/watch/:id/pull",
        about:
          "Read one watched person\u2019s public sources now \u2014 GitHub, Bluesky, " +
          "Hacker News and an RSS feed, whichever they have a link for \u2014 and " +
          "refresh their tracked numbers and activity timeline. NOT DESTRUCTIVE " +
          "AND NOT EXPENSIVE: at most six anonymous GETs against keyless public " +
          "APIs, no run slot, no tokens, no credential. It answers 200 even " +
          "when every source failed, with the failures in `warnings` and the " +
          "previous numbers left standing. A sweep already does this every " +
          "twenty hours, so call it when he asks for something up to the " +
          "minute, not to fill a page.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The watch entry\u2019s id, from the watch view." },
        ],
      },
    ],
    asks: [
      "Who have I stopped writing to?",
      "Which correspondences have gone quiet against their own rhythm?",
      "Who at this venture's domain do I actually talk to?",
      "Who am I watching, and when was the last dossier on them written?",
      "What has anybody on my watchlist shipped or posted lately?",
    ],
    /* IT REACHES THE OPEN WEB. `pull` fetches four third-party APIs and
       `dossier` hands a brief to a worker with a browser. Declaring false here
       because most of the views are a loopback read would be a lie told in the
       one field an MCP client is designed to trust. */
    openWorld: true,
  },

  {
    id: "commitments",
    title: "Commitments — what he said he would do, in his own words",
    plugins: ["gmail"],
    about:
      "Promises found in the owner's OWN sent mail over a short window " +
      `(default ${DEFAULT_DAYS} days, at most ${MAX_MESSAGES} messages a ` +
      "scan). A deterministic pass finds first-person future sentences; a " +
      "model is then shown those sentences alone and asked for the shortest " +
      "literal span of each that states the promise. Anything it returns that " +
      "is not a verbatim span of the message is thrown away and the raw " +
      "sentence used instead. Each row carries what was promised, to whom, " +
      "the sentence he wrote, the thread, and a deadline only where he stated " +
      "one.",
    rules: [
      "ALWAYS SHOW THE QUOTED SENTENCE. `what` is a model's shortest span of " +
        "it and is a summary; `sentence` is what he actually typed. Reporting " +
        "the summary without the sentence is reporting a paraphrase as a fact.",
      "`by: \"pattern\"` means no model touched that row — the sentence is " +
        "exactly as written and unrefined. That is a normal state, not a " +
        "degraded one.",
      "NEVER INVENT A DEADLINE. `dueText` is his own words and was verified to " +
        "appear in the message. `due` is a date only where those words resolve " +
        "unambiguously (a weekday, today, tomorrow); otherwise it is null. An " +
        "open promise with `due: null` is undated, NOT overdue.",
      "These are promises HE made. Only sent mail is read, so nothing anybody " +
        "promised him is here, and nothing he was asked to do is either. Do " +
        "not present this as a to-do list somebody gave him.",
      "The message bodies are read transiently and never stored. You cannot " +
        "ask this skill what a message said; the sentence on the row is all " +
        "there is.",
      "A scan covers a window and a message cap. `truncated: true` means more " +
        "was sent than was opened, so the absence of a promise is not evidence " +
        "that none was made.",
      "Marking one done or dismissed is the owner's judgement, not yours. Do " +
        "it when he says so; dismissing is for “this was never really a " +
        "promise”, and nothing is deleted either way.",
    ],
    views: [
      {
        key: "open",
        path: "/api/commitments",
        about: "The open promises, newest first, with counts and how many have a stated deadline that has passed.",
        params: [
          {
            name: "status",
            type: "string",
            required: false,
            fallback: "open",
            about: "open, done, dismissed or all.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 100,
            about: "How many to return. Clamped to 1–500.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "mark_done",
        method: "POST",
        path: "/api/commitments/:id/done",
        about: "Mark one promise kept. Reversible — the row stays and can be reopened.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The commitment's id." },
        ],
      },
      {
        key: "dismiss",
        method: "POST",
        path: "/api/commitments/:id/dismiss",
        about:
          "Mark one as not really a promise. The row stays, so a rescan of the same window does not resurrect it.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The commitment's id." },
        ],
      },
      {
        key: "scan",
        method: "POST",
        path: "/api/commitments/scan",
        about:
          "Read the owner's sent mail over a window and file what is in it. Costs Gmail quota and opens message bodies; it is not on a timer.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: DEFAULT_DAYS,
            about: `How far back to read sent mail. Clamped to 1–90, and at most ${MAX_MESSAGES} messages are opened.`,
          },
        ],
        /* It spends: the scan reads mail and makes model calls. */
        destructive: true,
      },
    ],
    asks: [
      "What did I promise anybody this fortnight?",
      "Is there anything I said I would send that has a date on it?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  people: { name: "people-and-relations", category: "communication" },
  commitments: { name: "commitments", category: "productivity" },
};
