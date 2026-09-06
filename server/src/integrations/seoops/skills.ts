/**
 * THREE SKILLS, AND THE RULES ARE THE POINT.
 *
 * Each of the three publishes a measurement that is easy to quote wrongly, and
 * the wrong quotation is the same shape every time: an absence read as a zero.
 * A page Search Console has no row for is not a page with no traffic; a
 * directory row nobody has touched is not a directory that refused us; a
 * screenshot no model could look at is not a screenshot of a working page. So
 * every rules list below says which absences exist in that document and what
 * each one means, in the words the routes themselves use.
 */
import type { Skill } from "../../skills/registry.ts";
import { DIAGNOSES } from "./diagnose.ts";
import { LISTING_STATES } from "./listings.ts";
import { ISSUE_KINDS, VERDICTS } from "./vision.ts";
import { WINDOW_DAYS } from "./settings.ts";

export const skills: Skill[] = [
  {
    id: "seo-followup",
    title: "SEO follow-up — did the page move after the work",
    plugins: ["seoops"],
    about:
      `Per URL: Search Console clicks, impressions, CTR and average position over ` +
      `the trailing ${WINDOW_DAYS} days, captured when an SEO card was marked done ` +
      `and read again at the configured offsets (14, 28 and 56 days by default). ` +
      `Each follow-up carries the deltas, one verdict from {up, down, flat, thin, ` +
      `unmeasured} and one diagnosis from a closed list of nine: ` +
      `${DIAGNOSES.join(", ")}. Figures are per page, never per property, except ` +
      `the whole-property impressions carried beside them so a page that fell with ` +
      `everything else can be told from one that fell alone.`,
    rules: [
      "A PAGE ABSENT FROM A REPORT IS UNMEASURED AND NEVER ZERO. `measured: false` " +
        "on a reading means Search Console was asked and had no row for that exact " +
        "URL, or could not be asked at all. Report it as “not measured” with the " +
        "reason on the reading. Saying traffic fell to zero because a page dropped " +
        "off a capped report is the worst mistake available in this document.",
      "A reading whose `source` is `stored-capped` came from the collector's top-25 " +
        "page ranking, not from a filtered query. It is a FLOOR, it describes that " +
        "collection's window rather than this one, and it must be quoted with both " +
        "of those caveats. `live-filtered` is Google's own exact total for the URL.",
      "THE VERDICT IS ARITHMETIC AND THE DIAGNOSIS MAY BE A MODEL'S. `verdict` (up, " +
        "down, flat, thin, unmeasured) is subtraction against a 10% flat band and is " +
        "never decided by a model. `diagnosis` may be chosen by a model from the " +
        "same nine words with the same numbers in front of it; `decidedBy` says " +
        "which decided, and a model answer outside the nine was thrown away whole.",
      "`thin` means the before-window carried fewer than 30 impressions. A " +
        "percentage change on that is arithmetic on a rounding error and must not " +
        "be quoted as a movement.",
      "AVERAGE POSITION IS A RANK: a NEGATIVE position delta is an improvement. It " +
        "is null rather than zero wherever there were no impressions to average.",
      "The baseline was captured AFTER the work was marked done, so its window " +
        "already contains the change. Say so when quoting a before figure.",
      "Correlation, not causation. Two figures either side of a date are two " +
        "figures either side of a date; nothing here controls for anything else.",
    ],
    views: [
      {
        key: "default",
        path: "/api/seoops/followups",
        about:
          "Every tracked URL: its baseline, its follow-up readings, the deltas and the diagnosis at each offset.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id or slug. Absent means every venture, including URLs filed against none.",
          },
        ],
      },
      {
        key: "one",
        path: "/api/seoops/followups/:id",
        about: "One baseline, whole: every reading, every diagnosis, and what is still due.",
        params: [{ name: "id", type: "string", required: true, about: "The baseline id, like sb-….", in: "path" }],
      },
      {
        key: "candidates",
        path: "/api/seoops/followups/candidates",
        about:
          "Finished board cards that carry the SEO tag, the URLs on each, and whether each URL is already tracked.",
        params: [],
      },
      {
        key: "metric",
        path: "/api/seoops/metric",
        about:
          "One figure for one tracked URL, for the outcomes area to read. `value` is null whenever nothing was measured.",
        params: [
          { name: "baseline", type: "string", required: true, about: "The baseline id." },
          {
            name: "field",
            type: "string",
            required: false,
            fallback: "clicks",
            about: "clicks, impressions, ctr or position.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "sweep",
        method: "POST",
        path: "/api/seoops/sweep",
        about:
          "Look for finished SEO-tagged cards with a URL on them and capture a baseline for any that has none. " +
          "Idempotent — a card already tracked is skipped — and it spends one Search Console call per new URL.",
        params: [],
      },
      {
        key: "track",
        method: "POST",
        path: "/api/seoops/followups",
        about:
          "Start tracking a URL by hand, for work that never went through a card. Captures its baseline immediately.",
        params: [
          { name: "url", type: "string", required: true, about: "The page to measure, absolute.", in: "body" },
          { name: "venture", type: "string", required: false, about: "A venture id or slug.", in: "body" },
          { name: "title", type: "string", required: false, about: "What was done, in a few words.", in: "body" },
          {
            name: "actionAt",
            type: "string",
            required: false,
            about: "When the work was done — YYYY-MM-DD or an ISO instant. Defaults to now; a future date is refused.",
            in: "body",
          },
        ],
      },
      {
        key: "run_due",
        method: "POST",
        path: "/api/seoops/followups/run",
        about:
          "Take every follow-up reading that is due and diagnose it. Costs one Search Console call and at most one " +
          "model call per due reading.",
        params: [],
        /* DESTRUCTIVE BECAUSE IT SPENDS, not because it loses data. Every due
           reading is a model call the owner pays for, and a reading fills its
           slot permanently — it is never retaken. The claim here is about
           money and about a schedule that cannot be rewound, which is the same
           reading publishing/skills.ts gives the word. */
        destructive: true,
      },
    ],
    asks: [
      "Did the page I rewrote last month actually move?",
      "Which SEO changes are still waiting to be judged, and when are they due?",
    ],
  },

  {
    id: "listings",
    title: "Listings — the directory checklist, and who ticked each row",
    plugins: ["seoops"],
    about:
      `Per venture, one row per directory in a curated catalogue: its state from ` +
      `{${LISTING_STATES.join(", ")}}, the owner's note, the listing url, and when ` +
      `it was submitted, confirmed and last checked. The catalogue ships with the ` +
      `app and is editable as JSON in the plugin's settings. Only a handful of ` +
      `directories can be probed at all; the rest are worked through by hand.`,
    rules: [
      "`detected` IS EVIDENCE, NOT A TICK. It means a probe found a page carrying " +
        "the brand. Directories carry pages for products that never submitted, so " +
        "only `confirmed` means a person looked at that page and it is theirs.",
      "DETECTION MAY ONLY MOVE A ROW FORWARD, to `detected`, and only from " +
        "not_listed, pending or detected. It can never move a row back — a " +
        "directory behind a WAF or a listing under an unguessable slug would " +
        "otherwise un-tick work that was really done. `setBy` says whether the " +
        "owner or the crawler wrote the row last.",
      "`not_listed` IS THE DEFAULT FOR A ROW NOBODY HAS TOUCHED. It means “nobody " +
        "has looked” at least as often as it means “not there”. Never report it as " +
        "a rejection or an absence that was measured.",
      "`skipped` is a real answer and not a failure: most of the app tier does not " +
        "apply to a website and most of the code tier does not apply to a SaaS. " +
        "`donePct` is computed over the rows that are NOT skipped, and is null when " +
        "every row is skipped.",
      "NO BROAD SEARCH DETECTION IS PERFORMED, deliberately. Only directories whose " +
        "`detectableBy` names a presence source can be probed, and a `blocked` or " +
        "`error` cell from that collector is not a finding — it means the source " +
        "could not be asked.",
      "Nothing here submits anything. Every state past `detected` is the owner's " +
        "own record of work they did somewhere else.",
    ],
    views: [
      {
        key: "default",
        path: "/api/seoops/listings",
        about: "The venture × directory matrix with each row's state, note, url and dates.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture id or slug. Absent means all of them." },
        ],
      },
    ],
    actions: [
      {
        key: "set",
        method: "POST",
        path: "/api/seoops/listings/set",
        about:
          "Record a directory row as the owner. Any state is accepted, including back to not_listed; an unknown " +
          "state and a non-https url are refused rather than tidied.",
        params: [
          { name: "venture", type: "string", required: true, about: "A venture id or slug.", in: "body" },
          { name: "directory", type: "string", required: true, about: "The directory id from the catalogue.", in: "body" },
          {
            name: "state",
            type: "string",
            required: true,
            about: `One of ${LISTING_STATES.join(", ")}.`,
            in: "body",
          },
          { name: "note", type: "string", required: false, about: "The owner's note, up to 400 characters.", in: "body" },
          { name: "url", type: "string", required: false, about: "The listing's https url, or empty to clear it.", in: "body" },
        ],
      },
      {
        key: "detect",
        method: "POST",
        path: "/api/seoops/listings/detect",
        about:
          "Read the presence collector's rows and ratchet untouched directory rows forward to `detected`. Touches " +
          "nothing the owner has set and reaches no network of its own.",
        params: [],
      },
    ],
    asks: [
      "Which directories has this product not been submitted to yet?",
      "What did I mark as submitted and never confirm?",
    ],
  },

  {
    id: "visualqa",
    title: "Visual QA — what a model sees in the screenshot",
    plugins: ["seoops"],
    about:
      `Per venture, a model's verdict on the newest capture: one of ` +
      `${VERDICTS.join(", ")} plus up to five issues, each naming a kind from ` +
      `{${ISSUE_KINDS.join(", ")}}, where on the page it is, and a confidence ` +
      `between 0 and 1. Opt-in per venture and off by default. Whether the ` +
      `configured model accepts an image at all is probed once and reported.`,
    rules: [
      "THIS IS A MODEL'S OPINION OF A PICTURE AND IT IS NOT A MEASUREMENT. The " +
        "`shotsqa` skill's checks — blankness, dimensions, error wording in the " +
        "title, mixed content — are arithmetic over the PNG and two tables. Report " +
        "the two separately and never merge them into one verdict.",
      "`supportsImages: null` MEANS NOTHING IS KNOWN EITHER WAY. It is the probe " +
        "failing, not the model refusing. Only `false` means images were refused.",
      "`broken` always carries at least one issue. An answer that called a page " +
        "broken and pointed at nothing was thrown away whole and recorded as an " +
        "unreadable answer — never as a fault. A venture with `verdict: null` and " +
        "an `error` was NOT judged.",
      "`unsure` is a real verdict and means a screenshot could not settle it. It " +
        "is not a soft `broken`.",
      "A verdict is REUSED when the capture's bytes hash the same as one already " +
        "judged. A reused verdict is about that picture and says nothing about the " +
        "site since — check `shotTs`.",
      "The picture is the top of the page at 1280x800 after a few seconds of " +
        "loading. Nothing below the fold is in it, so nothing here can say anything " +
        "about the rest of the page.",
    ],
    views: [
      {
        key: "default",
        path: "/api/seoops/vision",
        about: "Every venture's latest visual verdict and issues, plus whether the active model accepts images.",
        params: [],
      },
    ],
    actions: [
      {
        key: "probe",
        method: "POST",
        path: "/api/seoops/vision/probe",
        about:
          "Send one 1x1 PNG to the active model to find out whether it accepts images at all. Costs one tiny call " +
          "and the answer is remembered per provider and model.",
        params: [],
        /* One call is still a call to a third party at the owner's expense. */
        destructive: true,
      },
      {
        key: "run",
        method: "POST",
        path: "/api/seoops/vision/run",
        about:
          "Ask the model to look at the newest capture of every opted-in venture. Unchanged pictures reuse their " +
          "stored verdict and cost nothing; a venture that is not opted in is refused rather than charged for.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id or slug. Absent means every opted-in venture.",
            in: "body",
          },
        ],
        /* THE MOST DESTRUCTIVE THING IN THIS AREA and the word is doing real
           work: this posts the SITE'S OWN SCREENSHOT — a full PNG — to whatever
           model provider is configured, once per changed picture, and bills it.
           An MCP client reading `destructiveHint` is entitled to ask a person
           first, and this is exactly the call where it should. */
        destructive: true,
      },
    ],
    asks: [
      "Does any of my sites look broken in its latest screenshot?",
      "Can the model I have connected even look at an image?",
    ],
    /* BOTH ACTIONS SEND A PICTURE TO SOMEBODY ELSE'S SERVER — `probe` a 1x1
       PNG, `run` the site's own full screenshot — so the annotation says so.
       `openWorldHint: false` is a claim a client may act on without asking a
       person, and here that would be a lie. */
    openWorld: true,
  },
];
