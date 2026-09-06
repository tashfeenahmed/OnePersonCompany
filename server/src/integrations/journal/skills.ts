/**
 * The journal's skill entry.
 *
 * ONE ENTRY, AND ITS MOST IMPORTANT LINE IS A PROHIBITION. An agent with a
 * write onto a log of the owner's work will, unprompted, log its own: it ran a
 * research pass, so it files "did — researched competitors". That is a lie in
 * the one table on this box whose entire value is that a person vouched for
 * every row, and it is a lie that compounds, because a streak and a count of
 * shipped things are read as a record of what the OWNER has been doing. So the
 * rules say it twice, in the `about` and in the rules, and the route stamps
 * `source: "agent"` on anything that comes through here so a reader can always
 * tell.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph.
 */
import type { Skill } from "../../skills/registry.ts";
import { AGENT_BACKDATE_DAYS, KINDS, MAX_RESULT, MAX_TEXT, OWNER_SOURCES, TRACKABLE } from "./entries.ts";

export const SKILLS: Skill[] = [
  {
    id: "journal",
    title: "Journal — the work the owner did off this box",
    /* No credential: the journal is what somebody typed, so it is live on a
       box with nothing connected at all. */
    plugins: [],
    about:
      "A hand-written log of work that leaves no trace in any connected " +
      "service: calls taken, pages rewritten by hand, posts put somewhere with " +
      "no API, decisions made. Each entry has a kind (" +
      `${KINDS.join(", ")}), a sentence in the owner's own words, an optional ` +
      "venture, an optional link, a LOCAL DAY it happened on, and an optional " +
      "result written later. Also a streak: consecutive days with at least one " +
      "entry. Windows are in days and default to 90. You may FILE an entry for " +
      "the owner — and only ever what he told you he did.",
    rules: [
      "NEVER FILE YOUR OWN WORK HERE. This table records what the OWNER did " +
        "away from this dashboard. A run you executed, a document you read, a " +
        "search you made is not a journal entry — those are already in the run " +
        "ledger and the activity feed. File an entry only when the owner has " +
        "told you, in this conversation, that HE did something; quote his " +
        "sentence rather than improving it. Everything you file is stamped " +
        "`source: \"agent\"`, he can see it, and it does NOT count towards his " +
        "streak — so back-filling days cannot manufacture one.",
      "NOTHING HERE WAS MEASURED. Every row was typed by a person, so no count " +
        "over this table is evidence that anything worked — it is evidence " +
        "that somebody wrote a sentence. Never present entry counts beside " +
        "collected figures as if they were the same kind of number.",
      "`at` is a LOCAL DAY, not an instant, and it can be back-dated. " +
        "`backdated: true` means the row was written on a different day from " +
        "the one it is filed under. Quote the day, never a time.",
      "The streak counts consecutive days on which the OWNER filed at least " +
        `one entry — \`streak.sources\` is ${OWNER_SOURCES.join(" and ")}, and rows ` +
        "you filed are excluded and counted separately in `streak.agentFiled`. " +
        "It measures LOGGING, not work. Today being empty does not end it — " +
        "`streak.today: false` with a positive `current` means yesterday was " +
        "the last day and today is still open. Never congratulate a streak as " +
        "if it were productivity.",
      `\`venture: null\` is a real answer and not a gap: a tax return or a ` +
        `conference belongs to no venture. Do not attribute an unattributed ` +
        `entry to whichever venture is nearest.`,
      `Only a ${TRACKABLE.join(" or ")} entry WITH a link can be tracked as an ` +
        "outcome, and tracking it requires a metric address the owner chose " +
        "(skill + path). Do not choose one for him: a baseline against a field " +
        "nobody picked produces a verdict about it a month later. What an " +
        "outcome then reports is two numbers either side of a date — " +
        "correlation, never cause.",
      "`counts` and `count` are per the WINDOW and per kind, counted by the " +
        "database; `returned` is how many rows this response carries. They are " +
        "counts of ENTRIES and never of hours, of shipped features or of money.",
      `You may only file an entry dated within the last ${AGENT_BACKDATE_DAYS} ` +
        "days. Anything older is refused, and the answer is to tell the owner " +
        "to file it on the Journal page — never to move the date to one that " +
        "will be accepted.",
    ],
    views: [
      {
        key: "default",
        path: "/api/journal",
        about:
          "Entries newest first, with per-kind counts for the window and the " +
          "streak over the whole history (not over the window).",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id, slug, name or host. Absent returns every venture and the unattributed entries.",
          },
          {
            name: "kind",
            type: "string",
            required: false,
            about: `One of ${KINDS.join(", ")}. Absent returns every kind.`,
          },
          {
            name: "days",
            type: "string",
            required: false,
            fallback: "90",
            about:
              "How far back, in days, 1–3650, or “all” for everything. Default 90. The window is inclusive of today.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 200,
            about: "Rows to return, clamped to 2000. The newest are kept.",
          },
        ],
      },
      {
        key: "streak",
        path: "/api/journal/streak",
        about:
          "The streak alone: current run, longest run, the last day the owner filed something, how " +
          "many distinct days have one, which sources were counted, and how many rows the agent filed " +
          "that were left out.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id, slug, name or host. Absent counts every entry.",
          },
        ],
      },
      {
        key: "entry",
        path: "/api/journal/:id",
        about: "One entry by its id, with its venture and whether it can be tracked as an outcome.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The entry id, as returned by the list." },
        ],
      },
    ],
    actions: [
      {
        key: "add_entry",
        method: "POST",
        path: "/api/journal/agent",
        about:
          "File one entry ON THE OWNER'S BEHALF. Only for work HE told you he " +
          "did — see the rules. Stamped `source: \"agent\"`. Reversible: he can " +
          "delete it on the Journal page.",
        params: [
          { name: "kind", type: "string", required: true, about: `One of ${KINDS.join(", ")}.` },
          {
            name: "text",
            type: "string",
            required: true,
            about: `What he did, in his words, at most ${MAX_TEXT} characters (longer is trimmed, not refused).`,
          },
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id, slug, name or host. Leave it out when the work belongs to no venture.",
          },
          {
            name: "url",
            type: "string",
            required: false,
            exampled: true,
            about:
              "An http(s) link to the thing — the page shipped, the post made. Refused if it is not one. It is what makes a shipped or posted entry trackable later.",
          },
          {
            name: "at",
            type: "string",
            required: false,
            fallback: "today",
            about:
              `The day it happened, YYYY-MM-DD. Defaults to today. The future is refused, and so ` +
              `is anything more than ${AGENT_BACKDATE_DAYS} days ago — that is the owner's to file.`,
          },
          {
            name: "result",
            type: "string",
            required: false,
            about: `What came of it, if he has said, at most ${MAX_RESULT} characters. Usually written later.`,
          },
        ],
      },
      {
        key: "set_result",
        method: "PATCH",
        path: "/api/journal/:id",
        about:
          "Record what came of an entry, in the owner's words. This is the only field an update may change.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The entry id." },
          { name: "result", type: "string", required: true, about: `His sentence, at most ${MAX_RESULT} characters.` },
        ],
      },
    ],
    asks: [
      "What did I actually do last week?",
      "What have I shipped for this venture this month, and did any of it move anything?",
      "How many days in a row have I logged something?",
    ],
  },
];

export const PACKS = { journal: { name: "journal", category: "productivity" } };
