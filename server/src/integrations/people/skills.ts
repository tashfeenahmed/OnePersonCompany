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
 * `people` HAS NO ACTIONS. There is nothing to change: the contacts are a fold
 * of headers and the brief is a weekly record. `commitments` has three, and
 * none is destructive — done, dismiss and scan are all reversible, and marking
 * them destructive to be safe would train a client to ignore the field.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph.
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
      "new.",
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
        "Example App 1 contact”.",
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
    ],
    asks: [
      "Who have I stopped writing to?",
      "Which correspondences have gone quiet against their own rhythm?",
      "Who at this venture's domain do I actually talk to?",
    ],
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
