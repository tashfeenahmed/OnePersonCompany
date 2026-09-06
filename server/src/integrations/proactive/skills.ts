/**
 * The proactive area's skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph, and its header says why
 * that must not happen.
 *
 * BOTH ENTRIES HAVE `plugins: []`, which the registry reads as "always live".
 * That is right for both and for the same reason: neither needs a credential.
 * An alert rule is a comparison the owner typed, and a briefing is an assembly
 * of documents that are themselves gated by their own plugins. What an owner
 * with nothing connected gets from these is an empty rules list and a briefing
 * that says every section had nothing in it — which is the true state of that
 * box, not a failure.
 *
 * `alerts` WRITES AND `briefing` WRITES, and the destructive one is named. The
 * registry's rule is that `destructive` means the change cannot be undone from
 * here: deleting a rule takes its whole event history with it, which archiving
 * a board card does not, so `delete_rule` carries the flag and the other three
 * do not.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "alerts",
    title: "Alerts — the comparisons the owner asked to be told about",
    plugins: [],
    about:
      "Rules the owner wrote against this box's own documents, and the events " +
      "they raised. A rule names a skill, a view, that view's parameters, a " +
      "dot path into the JSON it returns, an operator and a threshold; the " +
      "engine reads that document over loopback every evaluation — about every " +
      "thirty minutes, a minute after each collection — and records an event " +
      "when the comparison comes out true. Events carry the value observed, " +
      "the value compared against, and where a model provider is configured a " +
      "three-sentence narration of what else moved in the same window.",
    rules: [
      "A TRIP IS A COMPARISON THE OWNER CONFIGURED, NOT A JUDGEMENT. It means " +
        "a figure crossed a line somebody drew by hand. It is not an incident, " +
        "not a diagnosis and not evidence that anything is wrong — report what " +
        "crossed what, and let the owner decide what it means.",
      "`kind: \"unreadable\"` IS NOT A TRIP. It means the document could not be " +
        "read or the path resolved to nothing — a disconnected plugin, a renamed " +
        "field, a route that answered 500. It must never be reported as a figure " +
        "falling to zero. A business with a broken watchdog is not a business " +
        "with no revenue.",
      "`kind: \"test\"` is the owner pressing Test on a rule. It never trips " +
        "anything, is never acknowledged, and is not an alert.",
      "`observed` and `previous` are the figures AS READ AT THE TIME and are " +
        "not recomputed. Quote them with the event's own timestamp; the same " +
        "path read now may answer differently and that is not a contradiction.",
      "Acknowledging an event says the owner saw it. It does NOT silence the " +
        "rule: the same condition raises the next event once the cooldown has " +
        "passed. Only disabling or deleting the rule stops it.",
      "A rule marked `seeded: true` was suggested by this box on first start " +
        "for a plugin that was connected. It is not something the owner chose, " +
        "and its threshold is a starting point rather than a considered limit.",
      "`dropped_by_pct` and `rose_by_pct` compare against a reading THIS BOX " +
        "recorded at the start of the window, not against a figure the source " +
        "computed. A rule with no reading old enough says so and does not trip.",
      "`narration` is a model's prose about figures that were read. Where it is " +
        "null, `narrationNote` says why — usually that no model provider is " +
        "connected. A null narration is never filled in from memory.",
    ],
    views: [
      {
        key: "rules",
        path: "/api/alerts/rules",
        about:
          "Every rule: what it reads, the path, the operator and threshold, its cooldown, whether it is enabled, the last value read and the last error. Plus the operator vocabulary.",
        params: [],
      },
      {
        key: "events",
        path: "/api/alerts/events",
        about:
          "What has been raised: trips, unreadables and tests, newest first, with narration and acknowledgement.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 14,
            about: "How far back to look. Clamped to 1–400.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 100,
            about: "How many events to return. Clamped to 1–500.",
          },
          {
            name: "open",
            type: "string",
            required: false,
            about: "\"1\" for unacknowledged events only. Anything else returns all of them.",
          },
          {
            name: "kind",
            type: "string",
            required: false,
            about: "One of trip, unreadable, test. Left out, all three are returned.",
          },
        ],
      },
      {
        key: "summary",
        path: "/api/alerts",
        about: "Counts: rules total and enabled, open trips and unreadables, and when a rule was last evaluated.",
        params: [],
      },
    ],
    actions: [
      {
        key: "create_rule",
        method: "POST",
        path: "/api/alerts/rules",
        about:
          "Write a new rule. The skill, view and parameters are checked against GET /api/skills, and the path against the document's own shape — read the document first and name a path you have seen.",
        params: [
          { name: "name", type: "string", required: true, about: "One line saying what it watches. Shown on every event." },
          { name: "skill", type: "string", required: true, about: "The skill id whose document is read — the ids GET /api/skills lists." },
          { name: "view", type: "string", required: false, about: "The view key. Left out, the skill's first view is used." },
          { name: "params", type: "string", required: false, about: "A JSON object of that view's own parameters, for example {\"days\": 1}." },
          {
            name: "path",
            type: "string",
            required: true,
            about:
              "A dot path into the document — charges[0].failed — with [0] for an array index and @count(list) for the length of a list.",
            exampled: true,
          },
          {
            name: "op",
            type: "string",
            required: true,
            about:
              "One of <, <=, >, >=, ==, !=, changed, dropped_by_pct, rose_by_pct.",
          },
          { name: "threshold", type: "number", required: false, about: "The number compared against, or the percentage for the two windowed operators. Omitted only for `changed`." },
          { name: "windowMinutes", type: "number", required: false, about: "Required by dropped_by_pct and rose_by_pct: how far back the earlier reading is taken from. 10080 is a week." },
          { name: "ventureId", type: "string", required: false, about: "The venture this rule is about, or left out for the whole business. It labels the finding; it does not narrow the document." },
          { name: "enabled", type: "string", required: false, about: "true or false. Defaults to true." },
          { name: "cooldownMinutes", type: "number", required: false, about: "How long before the same rule may raise another trip. Defaults to 360." },
        ],
      },
      {
        key: "update_rule",
        method: "PATCH",
        path: "/api/alerts/rules/:id",
        about:
          "Change a rule. A field left out is untouched; a field sent as null is cleared. Use it to disable a noisy rule rather than deleting it.",
        params: [
          { name: "id", type: "number", required: true, in: "path", about: "The rule's id." },
          { name: "name", type: "string", required: false, about: "A new name." },
          { name: "skill", type: "string", required: false, about: "A different document to read." },
          { name: "view", type: "string", required: false, about: "A different view of it." },
          { name: "params", type: "string", required: false, about: "A JSON object of that view's parameters." },
          { name: "path", type: "string", required: false, about: "A different path into the document." },
          { name: "op", type: "string", required: false, about: "A different operator." },
          { name: "threshold", type: "number", required: false, about: "A different threshold." },
          { name: "windowMinutes", type: "number", required: false, about: "A different window." },
          { name: "ventureId", type: "string", required: false, about: "A venture id, or null to unfile it." },
          { name: "enabled", type: "string", required: false, about: "true or false." },
          { name: "cooldownMinutes", type: "number", required: false, about: "A different cooldown." },
        ],
      },
      {
        key: "delete_rule",
        method: "DELETE",
        path: "/api/alerts/rules/:id",
        about:
          "Remove a rule AND every event it ever raised. There is no way back. To stop a rule firing without losing its history, update it with enabled false.",
        destructive: true,
        params: [{ name: "id", type: "number", required: true, in: "path", about: "The rule's id." }],
      },
      {
        key: "ack",
        method: "POST",
        path: "/api/alerts/events/:id/ack",
        about:
          "Mark one event as seen. It does not change the rule and does not stop it raising the same thing again after its cooldown.",
        params: [{ name: "id", type: "number", required: true, in: "path", about: "The event's id." }],
      },
    ],
    asks: [
      "What has been alerting, and has anything been failing to read for days?",
      "Watch failed Stripe payments and tell me when there is more than one in a day.",
    ],
  },

  {
    id: "briefing",
    title: "Briefing — the day assembled, then written up",
    plugins: [],
    about:
      "One document a day, built at an hour the owner sets in their own time " +
      "zone: alerts raised since the last one, figures that moved over 24 " +
      "hours, agent runs that finished, board cards due and overdue, and a " +
      "line per venture. The facts are assembled from this box's own skills " +
      "over loopback and STORED beside the prose a model wrote from them, so " +
      "every sentence has something checkable behind it.",
    rules: [
      "THE FACTS AND THE PROSE ARE DIFFERENT THINGS AND THE FACTS ARE THE REAL " +
        "ONE. `facts` was read from documents; `markdown` is a model's write-up " +
        "of `facts`. Where they disagree, the facts are right. Quote figures " +
        "from `facts`.",
      "A section with `included: false` was switched off by the owner. It is " +
        "not empty and it is not zero — nobody asked.",
      "Empty `markdown` with a `note` beside it is a briefing whose facts are " +
        "real and whose write-up did not happen, usually because no model " +
        "provider is connected. It is not a failed briefing.",
      "`movement` is a diff of two SNAPSHOTS of the same document taken 24 " +
        "hours apart by this box. The paths are the document's own; do not " +
        "translate one into a business claim it does not make.",
      "`since` is when the previous briefing was built, not midnight. A box " +
        "that missed three days reports three days.",
      "Delivery flags say where it went. `telegram: false` usually means no " +
        "bot is paired or the push is switched off, not that a send failed — " +
        "`delivered.note` says which.",
    ],
    views: [
      {
        key: "latest",
        path: "/api/briefing/latest",
        about: "The most recent briefing: its prose, its facts, its model and where it was delivered.",
        params: [],
      },
      {
        key: "history",
        path: "/api/briefing",
        about: "Recent briefings, newest first, each with its facts.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 14,
            about: "How many briefings to return. Clamped to 1–90.",
          },
        ],
      },
      {
        key: "settings",
        path: "/api/briefing/settings",
        about: "The hour, the time zone, whether Telegram is pushed to, and which sections are on.",
        params: [],
      },
    ],
    actions: [
      {
        key: "send_now",
        method: "POST",
        path: "/api/briefing/now",
        about:
          "Build today's briefing now and deliver it — into the briefing chat, and to Telegram when that is switched on and a bot is paired. Rebuilds today rather than making a second one.",
        params: [],
      },
    ],
    asks: [
      "What does this morning's briefing say, and what was it built from?",
      "Build the briefing now and send it to my phone.",
    ],
  },
];

/** Where these land in Hermes' skill directory. Filed by subject, like every
 *  other pack — see skills/hermes.ts on why the categories are not vendors. */
export const PACKS: Record<string, { name: string; category: string }> = {
  alerts: { name: "alert-rules", category: "productivity" },
  briefing: { name: "daily-briefing", category: "productivity" },
};
