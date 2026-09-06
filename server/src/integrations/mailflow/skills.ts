/**
 * The mailflow area's two skill entries, and the asymmetry between them is the
 * point.
 *
 * `triage` is a full set: three actions, all of them reversible, none of them
 * touching Gmail. Marking a thread done here changes a row in this box's own
 * database and nothing in anybody's mailbox — a thread marked done is still in
 * the inbox, still unread if it was.
 *
 * `outbox` DELIBERATELY OMITS TWO ACTIONS THAT EXIST AS ROUTES. There is a
 * `POST /api/outbox/:id/approve` and a `POST /api/outbox/:id/send`, and they
 * are not published here. That is not an oversight to be tidied up later: the
 * skills proxy composes no URL a registry entry does not name, so an action
 * that is absent from this list is a route an agent cannot reach. The rules
 * below say so in words as well, because a model that finds a route in a
 * document tends to try it.
 *
 * Types only from skills/registry.ts: a value-level import would cycle.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "triage",
    title: "Triage — which inbox threads need the owner today",
    plugins: ["gmail"],
    about:
      "The inbox over a short window (3 days by default, up to 14), with each " +
      "thread sorted into needs_reply, waiting_on_them, fyi or noise by a " +
      "model reading its subject line and Gmail's own snippet, plus a one-line " +
      "reason, an urgency and — where an address settles it — the venture the " +
      "thread concerns. The mail itself is fetched live from Gmail on every " +
      "read; only the judgement is stored.",
    rules: [
      "A CATEGORY IS A MODEL'S READING OF A SNIPPET, NOT A FACT. It saw a " +
        "subject line, a sender and roughly 180 characters of the latest " +
        "message — never the conversation. Quote the `reason` beside any " +
        "category you report, and never state as known anything the snippet " +
        "did not say.",
      "A THREAD WITH NO SCORE IS NOT NOISE. `groups.unscored` is mail the model " +
        "has not read — too new for the last pass, or a pass with no provider. " +
        "Report it as unscored and say how many; folding it into noise would be " +
        "hiding mail because nobody looked at it.",
      "`stale: true` means a reply has arrived since the score was made. The " +
        "category describes the conversation as it was, not as it is. Say so.",
      "`venture` with `ventureBy: \"host\"` is a FACT — a domain in the thread " +
        "matched that venture's own host. `ventureBy: \"model\"` is a guess. " +
        "`venture: null` means nothing settled it; it does not mean personal.",
      "NOTHING HERE READS OR STORES A MESSAGE BODY, and there is no route in " +
        "this skill that could. Subjects and snippets are shown live and never " +
        "written to the database.",
      "`done` and `snooze` change THIS BOX'S list and nothing in Gmail. A " +
        "thread you mark done is still in the inbox, still unread if it was. " +
        "Never tell the owner you have archived, read or filed anything.",
      "`window.threads` is how many the listing returned inside the cap, not " +
        "how much mail exists. A count at the cap is a floor.",
    ],
    views: [
      {
        key: "default",
        path: "/api/triage",
        about:
          "Today's inbox grouped into needs_reply, waiting_on_them, fyi, noise and unscored, with counts, the last pass, and per-thread reason, urgency and venture.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 3,
            about: "The window in days. Clamped to 1–14.",
          },
          {
            name: "max",
            type: "number",
            required: false,
            fallback: 50,
            about:
              "How many threads to fetch from Gmail for this read. Clamped to 1–200; each costs a round trip, so 200 takes about fourteen seconds.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about: "Which connected Gmail account. Absent means the first one.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "done",
        method: "POST",
        path: "/api/triage/:threadId/done",
        about:
          "Take a thread off this list. Changes nothing in Gmail — the thread stays in the inbox. Send undo: true to put it back.",
        params: [
          {
            name: "threadId",
            type: "string",
            required: true,
            in: "path",
            about: "The Gmail thread id, as it appears on a row of the default view.",
          },
          {
            name: "undo",
            type: "string",
            required: false,
            about: "true to un-mark it. Anything else marks it done.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about: "Which Gmail account the thread id belongs to. Absent means the first one.",
          },
        ],
      },
      {
        key: "snooze",
        method: "POST",
        path: "/api/triage/:threadId/snooze",
        about:
          "Hide a thread from this list for a number of days. Changes nothing in Gmail. A reply arriving cancels the snooze.",
        params: [
          {
            name: "threadId",
            type: "string",
            required: true,
            in: "path",
            about: "The Gmail thread id.",
          },
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 1,
            about: "How many days to hide it for. Clamped to 1–30.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about: "Which Gmail account. Absent means the first one.",
          },
        ],
      },
      {
        key: "run",
        method: "POST",
        path: "/api/triage/run",
        about:
          "Score the threads the last pass has not seen. Costs a Gmail round trip per thread and one model call per ten; the pass also runs on its own every half hour.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 3,
            about: "The window to scan, in days. Clamped to 1–14.",
          },
          {
            name: "max",
            type: "number",
            required: false,
            fallback: 200,
            about: "How many threads to list. Clamped to 1–200.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about: "Which Gmail account. Absent means the first one.",
          },
        ],
        /* It spends: the pass makes model calls, and it moves mail the owner will find moved. */
        destructive: true,
      },
    ],
    asks: [
      "What in my inbox actually needs me today, and why does it think so?",
      "Is anything from a customer waiting on me that I have not answered?",
    ],
  },

  {
    id: "outbox",
    title: "Outbox — mail written here, and never sent by anything but the owner",
    plugins: ["gmail"],
    about:
      "A queue of drafts. You may WRITE one, edit one and dismiss one. You may " +
      "not approve one and you may not send one: there is no action here for " +
      "either, and the routes that do it refuse any request that came through " +
      "the skills proxy. Every row carries who wrote it, its status, the " +
      "markdown body, and — once the owner has sent it — Gmail's own message id.",
    rules: [
      "YOU CANNOT SEND MAIL. Writing a draft puts words on a page in this " +
        "dashboard; it does not put a message in anybody's inbox. Never tell " +
        "the owner you have emailed someone, and never imply a draft will go " +
        "out on its own. It goes out when he presses a button beside it.",
      "THERE IS NO APPROVE ACTION AND NO SEND ACTION IN THIS SKILL, on purpose. " +
        "The routes exist and are the owner's; asking to call them, or " +
        "suggesting a way around it, is asking for something this API will " +
        "refuse with a 403.",
      "THE PER-ADDRESS FLOOR COUNTS EVERY ROW, INCLUDING DISMISSED ONES. A " +
        "second draft to an address inside the window (default 14 days, a " +
        "setting) is refused with a 409 naming the row that blocks it. A " +
        "dismissal is the owner saying “not this person, not now” — treat a " +
        "409 as an answer, not as an obstacle to route around with a different " +
        "spelling of the same address.",
      "There is also a daily cap on messages that actually leave (default 20). " +
        "It is enforced at send, which is not your press.",
      "`status` is the whole truth about a row: only `sent` has left, and only " +
        "a row with a `messageId` has proof of it. `failed` means it was " +
        "approved, attempted and refused by Gmail, with the reason in `error` " +
        "— it is not retried automatically and you must not describe it as " +
        "queued.",
      "`preview` is the body plus the owner's signature setting — what the " +
        "recipient would receive. `body` is the markdown alone. Quote " +
        "`preview` when you are describing what would go out.",
      "Editing an APPROVED draft returns it to `draft`, because the approval " +
        "was of the previous wording. Say so if you edit one.",
      "Write plainly and put nothing in a draft you cannot source. A figure in " +
        "an email is a promise made in the owner's name.",
    ],
    views: [
      {
        key: "default",
        path: "/api/outbox",
        about:
          "The queue, newest first: every row with its status, who wrote it, the markdown, the preview, and the send counts and floors in force.",
        params: [
          {
            name: "status",
            type: "string",
            required: false,
            about: "Filter to one of draft, approved, sent, dismissed, failed. Absent means all.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 100,
            about: "How many rows. Clamped to 1–500.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "draft",
        method: "POST",
        path: "/api/outbox",
        about:
          "Write a draft. It is created as `draft` and marked as written by the agent. It does not send and cannot be made to.",
        params: [
          {
            name: "to",
            type: "string",
            required: true,
            about: "One email address. Refused if the per-address floor blocks it.",
          },
          { name: "subject", type: "string", required: true, about: "The subject line, at most 300 characters." },
          {
            name: "body",
            type: "string",
            required: true,
            about:
              "The message, in markdown, at most 20000 characters. It is sent as plain text exactly as written, so write it as prose.",
          },
          {
            name: "inReplyTo",
            type: "string",
            required: false,
            about:
              "A Gmail THREAD id to reply into — the ids the triage skill lists. Threading headers are built at send time, not now.",
          },
          {
            name: "venture",
            type: "string",
            required: false,
            about: "Which venture this concerns: an id, a slug or the name. Refused if no venture matches.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about: "Which Gmail account to write from. Absent means the first one.",
          },
        ],
      },
      {
        key: "edit",
        method: "PATCH",
        path: "/api/outbox/:id",
        about:
          "Change a draft's recipient, subject, body or venture. An approved draft returns to draft. A sent one cannot be edited.",
        params: [
          { name: "id", type: "number", required: true, in: "path", about: "The row's id." },
          { name: "to", type: "string", required: false, about: "A new recipient. Re-checks the floor." },
          { name: "subject", type: "string", required: false, about: "A new subject." },
          { name: "body", type: "string", required: false, about: "New markdown." },
          { name: "venture", type: "string", required: false, about: "A venture id, slug or name." },
        ],
      },
      {
        key: "dismiss",
        method: "POST",
        path: "/api/outbox/:id/dismiss",
        about:
          "Take a draft out of the queue. The row STAYS and still counts against the per-address floor.",
        params: [{ name: "id", type: "number", required: true, in: "path", about: "The row's id." }],
      },
    ],
    asks: [
      "Draft a reply to that customer and leave it for me to read.",
      "What is sitting in the outbox waiting for me, and what has actually gone out?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  triage: { name: "inbox-triage", category: "communication" },
  outbox: { name: "outbox", category: "communication" },
};
