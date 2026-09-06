/**
 * The nurture area's one skill entry, and what it deliberately omits.
 *
 * `sequences` publishes reads, enrolments, stops, opt-outs, a pass and a
 * fact-backed draft. It publishes NO approve and NO send — for the reason the
 * `outbox` skill next door publishes neither: the skills proxy composes no URL
 * a registry entry does not name, so an action absent from this list is a route
 * an agent cannot reach. Those two routes live on `/api/outbox` and refuse any
 * request carrying the proxy's own header on top of that.
 *
 * It also publishes no identity write and no sequence write. An identity is
 * "which domain may this box claim to be" and a sequence is "who gets written
 * to automatically, forever"; both are behind `requireOwner`, so even if an
 * action for them appeared here by accident the proxy would get a 401 rather
 * than a new sending domain.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "sequences",
    title: "Nurture — scheduled sequences that write drafts and never send them",
    plugins: [],
    about:
      "Sequences of messages for one venture: who is enrolled, which step each " +
      "person is on, when the next one is due, and why anybody was stopped. A " +
      "step that comes due becomes a DRAFT in the outbox — planned by code, " +
      "worded from a fact packet, and validated against it — and waits there " +
      "for the owner. This skill can also prepare one such draft for a named " +
      "person outside any sequence, and can record that somebody asked not to " +
      "be written to again.",
    rules: [
      "YOU CANNOT SEND MAIL AND NEITHER CAN THIS SCHEDULE. Every step a " +
        "sequence produces is a draft in the outbox. There is no approve action " +
        "and no send action in this skill, the daily pass has no path to one, " +
        "and the routes that do it refuse anything arriving through this proxy. " +
        "Never tell the owner a sequence has emailed anybody.",
      "A DRAFT'S WORDS ARE BOUNDED BY ITS FACTS. `prepare_draft` runs a " +
        "deterministic planner, gathers a fact packet from rows this box " +
        "already holds, asks a model for WORDING ONLY, and then refuses any " +
        "body carrying a number, amount, date, link or address the packet does " +
        "not have. `validation.by` is `model` when the model's wording stood " +
        "and `template` when it was refused — `validation.why` says which token " +
        "it invented. Report that, do not paper over it.",
      "`enrolKind` signup, trial and churned are answered ONLY from a product's " +
        "own users document (the `users` plugin). With none connected they " +
        "enrol nobody, and `problems` on the sequence says so. They are never " +
        "approximated from mail headers: “this address wrote to me” is not " +
        "“this person signed up”.",
      "`churned` IS A LAPSE READING, NOT AN OBSERVED CANCELLATION. This box " +
        "holds no cancellation event and no email address against a Stripe " +
        "customer, so it means exactly “the product says they are not paying " +
        "and has not seen them for longer than the quiet window”. Quote the " +
        "enrolment's own reason rather than the word.",
      "`blocked` IS NOT `stopped`. A blocked enrolment is one whose stop " +
        "condition could not be checked today — Gmail refused, no account is " +
        "connected — and NOTHING was written for that person. It resumes on its " +
        "own. Reporting it as stopped would claim a decision nobody made.",
      "`stopReason` NAMES THE CONDITION AND THE EVIDENCE: replied, purchased, " +
        "dismissed, unsubscribed. Quote it whole when you say why somebody is " +
        "no longer being written to.",
      "THE PER-ADDRESS FLOOR AND THE OUTBOX'S DAILY CAP STILL APPLY. A due step " +
        "that would break the floor is SKIPPED with a reason and is not " +
        "retried by spelling the address differently.",
      "An opt-out is permanent and covers every sequence, including ones " +
        "written later. Use `opt_out` when somebody asks to be left alone; " +
        "never enrol them again afterwards.",
    ],
    views: [
      {
        key: "default",
        path: "/api/nurture",
        about:
          "Every sequence with its steps, enrolment kind, stop conditions, counts and problems; every sending identity with the status Resend gave its domain; the last fourteen daily passes; and the opt-out list.",
        params: [],
      },
      {
        key: "enrollments",
        path: "/api/nurture/enrollments",
        about:
          "Who is in which sequence, which step they are on, when the next one is due, and — for a stopped one — which condition fired and what the evidence was.",
        params: [
          { name: "sequence", type: "number", required: false, about: "Only this sequence's enrolments." },
          {
            name: "status",
            type: "string",
            required: false,
            about: "active, stopped or done. Absent means all three.",
          },
          { name: "limit", type: "number", required: false, fallback: 200, about: "How many rows. Clamped to 1–1000." },
        ],
      },
      {
        key: "candidates",
        path: "/api/nurture/sequences/:id/candidates",
        about:
          "Who the next pass WOULD enrol, without enrolling anybody. The answer to “why is this sequence not doing anything”.",
        params: [{ name: "id", type: "number", required: true, in: "path", about: "The sequence's id." }],
      },
      {
        key: "draft",
        path: "/api/nurture/drafts/:id",
        about:
          "One outbox draft's plan, fact packet and validation — the reasons behind the words. A draft the owner typed himself has none, and says so.",
        params: [{ name: "id", type: "number", required: true, in: "path", about: "The outbox row's id." }],
      },
    ],
    actions: [
      {
        key: "prepare_draft",
        method: "POST",
        path: "/api/nurture/prepare",
        about:
          "Plan, gather facts, word and validate ONE message to one person, and file it as a draft in the outbox. It does not send and cannot be made to.",
        params: [
          { name: "address", type: "string", required: true, about: "One email address. Refused if they have opted out or the per-address floor blocks it." },
          {
            name: "purpose",
            type: "string",
            required: true,
            about:
              "One sentence saying what this message is for. It is the wording model's whole brief AND it joins the fact packet as the owner's own words, so a figure you put here is a figure the letter may repeat — put nothing here you cannot source.",
          },
          { name: "venture", type: "string", required: false, about: "Which venture this concerns: an id, a slug or the name. Decides the default sending identity." },
          { name: "identityId", type: "number", required: false, about: "Which sending identity to write from. Absent means the venture's default." },
          { name: "whyNow", type: "string", required: false, about: "Why this person today. Stored on the plan; never quoted in the letter." },
          { name: "threadId", type: "string", required: false, about: "A Gmail THREAD id to reply into." },
          {
            name: "dryRun",
            type: "string",
            required: false,
            about: "Pass true to prepare everything and file nothing — what would be said, without spending a row against the floor.",
          },
        ],
      },
      {
        key: "enrol",
        method: "POST",
        path: "/api/nurture/sequences/:id/enrol",
        about: "Put one person into one sequence. Their first step is drafted when it comes due.",
        params: [
          { name: "id", type: "number", required: true, in: "path", about: "The sequence's id." },
          { name: "address", type: "string", required: true, about: "One email address." },
          { name: "why", type: "string", required: false, about: "Why them. Kept on the enrolment's history." },
        ],
      },
      {
        key: "stop",
        method: "POST",
        path: "/api/nurture/enrollments/:id/stop",
        about:
          "Take one person out of one sequence. Any draft that sequence had written for them is dismissed too.",
        params: [
          { name: "id", type: "number", required: true, in: "path", about: "The enrolment's id." },
          { name: "reason", type: "string", required: false, about: "Why, in a few words. Kept forever." },
        ],
      },
      {
        key: "opt_out",
        method: "POST",
        path: "/api/nurture/optout",
        about:
          "Record that somebody asked not to be written to again. Every live enrolment for them stops now, their outstanding drafts are dismissed, and no sequence will ever enrol them again.",
        destructive: true,
        params: [
          { name: "address", type: "string", required: true, about: "One email address." },
          { name: "reason", type: "string", required: false, about: "What they said, in a few words." },
        ],
      },
      {
        key: "run_pass",
        method: "POST",
        path: "/api/nurture/run",
        about:
          "Run the daily pass now: stop what should stop, enrol what should enrol, draft what is due. Once a day unless force is passed. It writes drafts and nothing else.",
        params: [
          {
            name: "force",
            type: "string",
            required: false,
            about: "Pass true to run a second pass on a day that has already had one.",
          },
        ],
      },
    ],
    asks: [
      "Who is in a nurture sequence right now, and who got stopped and why?",
      "Draft a note to that customer with the facts behind it, and leave it for me to read.",
      "Why has the welcome sequence not written to anybody this week?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  sequences: { name: "nurture-sequences", category: "marketing" },
};
