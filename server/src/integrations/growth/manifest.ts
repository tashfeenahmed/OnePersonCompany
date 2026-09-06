/**
 * THE GROWTH AREA: whether anybody finds these businesses, and what happens
 * when they arrive.
 *
 * WHAT THE SIX HAVE IN COMMON. Every one of them reads rows some other
 * collector already wrote — Search Console, Bing, the backlink sources, the
 * audit, the app stores, Meta, Umami, Stripe, the product endpoints — and turns
 * them into a decision. Nothing here collects on a schedule and nothing here
 * has a credential of its own, which is why this area has ONE plugin and it is
 * a settings page:
 *
 *   serp        a run kind. Searches, reads the pages that outrank us, and
 *               compares them with ours in code.
 *   authority   an estimate computed on every read, with its arithmetic.
 *   cro         a static library of experiments, hung off the funnel stage
 *               that measurably leaks, plus the ledger of what is running.
 *   indexing    IndexNow submission, the key file that makes it work, and the
 *               honest account of what sitemap submission still does.
 *   aso         a run kind. Audits the store listing as a shopper reads it.
 *   adshealth   a score per Meta ad account, computed on read, with its parts.
 *
 * THE ONE PLUGIN HAS NO SECRET, AND THAT IS THE PROTOCOL'S DOING. IndexNow
 * authenticates by a key FILE on the site being submitted — there is no
 * account, no token and nothing to keep in a vault. So `indexing` is a settings
 * entry: a key this app generates for the owner, whether to submit
 * automatically after an audit, and where each host's sitemap is. `connected`
 * means the owner has configured something rather than that a key exists,
 * because a key exists the moment anything reads it.
 */
import type { IntegrationManifest } from "../manifest.ts";
import type { Skill } from "../../skills/registry.ts";
import { growthRoutes } from "./routes.ts";
import { PLUGIN, parseSitemaps, refreshConnected, startIndexingTimer } from "./indexing.ts";
import { STAGES } from "./cro-library.ts";

/* --------------------------------------------------------------- settings */

const indexingConfig = {
  keys: {
    key: {
      label: "IndexNow key",
      hint:
        "8 to 128 hexadecimal characters. LEAVE IT EMPTY and this app generates one the first time anything asks, then writes it back here so it is visible and stays the same tomorrow — the key file on each site is named after it, so a key that changed would break every site at once. Whatever is here, the site must serve a file at https://<host>/<key>.txt whose entire contents are that key. That file IS the credential: IndexNow fetches it to prove this box speaks for the host.",
      ph: "0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
      check(value: string) {
        if (!value) return null; // empty is a real answer: one will be generated
        return /^[a-f0-9]{8,128}$/i.test(value)
          ? null
          : "IndexNow keys are 8 to 128 hexadecimal characters (0-9, a-f) and nothing else. Clear the field to have one generated.";
      },
    },
    autoSubmit: {
      label: "Submit after every audit",
      hint:
        "on or off. With it on, a pass every fifteen minutes looks for a venture whose newest site audit has not been submitted yet and sends the URLs that are NEW or CHANGED against the audit before it — never the whole site, which is the thing IndexNow asks people not to do. Off is the default: submitting on somebody's behalf is a request made to other companies' servers in their name.",
      ph: "off",
      check(value: string) {
        if (!value) return null;
        return value === "on" || value === "off" ? null : "on or off.";
      },
    },
    sitemaps: {
      label: "Sitemaps",
      hint:
        "One per line as `host = url`, for hosts whose sitemap is not at the conventional place. A host with no line here is assumed to have https://<host>/sitemap.xml — which is an assumption, not a measurement, and the page says which of the two it used. These are read so their URLs can be submitted to IndexNow; Google's sitemap ping endpoint was retired in 2023 and this app does not call it.",
      ph: "example.com = https://example.com/sitemap-index.xml",
      check(value: string) {
        const lines = value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        const parsed = parseSitemaps(value);
        if (lines.length && !parsed.length)
          return "Each line is `host = https://…/sitemap.xml`, or a bare https:// URL.";
        if (parsed.length < lines.length)
          return `${lines.length - parsed.length} line${lines.length - parsed.length === 1 ? "" : "s"} did not carry an http(s) URL.`;
        return null;
      },
    },
  },
  /* CONNECTED MEANS THE OWNER CONFIGURED SOMETHING — backlinks' rule. */
  after() {
    refreshConnected();
  },
};

/* ------------------------------------------------------------------ skills */

const skills: Skill[] = [
  {
    id: "serp",
    title: "SERP teardown — what the pages that beat us actually have",
    plugins: ["searxng"],
    about:
      "Per QUERY rather than per competitor: the stored rows of every teardown run — where this site came in the search results, and the structure of each page above it read out of its own HTML (title, headings, word count, internal and external links, images, schema.org types, whether it carries an FAQ, a table or comparison framing), plus the median of those pages against ours.",
    rules: [
      "THERE ARE TWO POSITIONS AND THEY ARE NOT THE SAME NUMBER. `ourRank` is where this host came in the SearXNG result list on ONE request from whichever engines answered it. `gscPosition` is Google's own average position over Search Console's own window. Never merge them, and always say which one a claim is about.",
      "`ourRank: null` MEANS OUR HOST WAS NOT IN THOSE RESULTS. It is a measurement, not a missing figure, and it is not position 100.",
      "`degraded: true` MEANS THE SEARCH ANSWERED A DIFFERENT QUESTION — under 30% of the query's own words came back in the titles and snippets. NO conclusion may be drawn from a degraded query and no gap list was computed for it.",
      "A COMPETITOR PAGE WITH `error` OR `thin: true` WAS NOT READ. A 403 from a firewall is not a short page, and such pages are out of every median.",
      "`source: \"description\"` MEANS THIS APP DERIVED THE QUERY from the venture record because there was no Search Console property. Nothing says anybody searches for it.",
      "The medians are MEDIANS of the pages that were read, never means and never a claim about the whole web.",
    ],
    views: [
      {
        key: "default",
        path: "/api/growth/serp",
        about: "Every stored teardown row for one venture, newest first.",
        params: [
          { name: "venture", type: "string", required: true, about: "The venture's slug or id.", exampled: true },
          { name: "limit", type: "number", required: false, fallback: 20, about: "Rows returned. Clamped to 1–200." },
        ],
      },
      {
        key: "run",
        path: "/api/growth/serp/:runId",
        about: "The rows one teardown run produced.",
        params: [{ name: "runId", type: "string", required: true, in: "path", about: "The run's id, from /api/runs." }],
      },
    ],
    asks: [
      "What do the pages outranking us for that query have that our page does not?",
      "Which of the queries in the last teardown were degraded and should be ignored?",
    ],
  },

  {
    id: "authority",
    title: "Authority — this app's own estimate, and what it puts out of reach",
    plugins: ["backlinks", "gsc", "bing-webmaster"],
    about:
      "Per host, computed on every read from three parts this box already collects: referring domains from the backlinks area, how much site there is from the latest audit, and Search Console impressions. Each part is log-scaled to 0–100, the estimate is the mean of the parts that could be read, and a coarse keyword-difficulty ceiling follows from it. Every step of the arithmetic is on the answer.",
    rules: [
      "THIS IS NOT A DOMAIN RATING AND NOT DOMAIN AUTHORITY. It is this app's own estimate from this box's own figures. Never call it a DA, a DR, or anybody's score, and never compare it with one.",
      "NEVER COMPARE TWO HOSTS WHOSE `basis` DIFFERS. The estimate is the mean of whichever parts could be read, so a host measured on links and pages and a host measured on pages alone are two different measurements wearing one word. There is no league table and the route deliberately does not sort by estimate.",
      "A MISSING PART IS DROPPED, NEVER ZEROED, and `missing` names it. `estimate: null` means nothing about the host could be read — it is not a low estimate.",
      "REFERRING DOMAINS ARE NEVER SUMMED ACROSS SOURCES. The best single source is used and named; Common Crawl, Bing and the verification crawler overlap by an unknown amount.",
      "THE CEILING IS ADVICE ABOUT WHERE TO SPEND EFFORT, not a prediction and not anybody's published difficulty scale. `ceiling: null` above 60 means difficulty is not the binding constraint at this size, NOT that there is no limit.",
    ],
    views: [
      { key: "default", path: "/api/growth/authority", about: "Every venture's host with its estimate, listed and never ranked.", params: [] },
      {
        key: "host",
        path: "/api/growth/authority/:host",
        about: "One host: the estimate, the ceiling, every part with its own arithmetic, and the link sources behind it.",
        params: [{ name: "host", type: "string", required: true, in: "path", about: "The hostname, without www.", exampled: true }],
      },
    ],
    asks: [
      "How hard a keyword is worth going after for this site, and why?",
      "What is the authority estimate for one of my hosts built from?",
    ],
  },

  {
    id: "cro",
    title: "CRO — where the funnel leaks, and the experiments for that stage",
    plugins: [],
    about:
      `A hand-written library of conversion experiments in ${STAGES.length} funnel stages, plus the leaking stage measured for a venture from its product endpoint's own funnel counters, or from Umami events and Stripe subscriptions, or not at all. Each experiment carries a hypothesis, the one change that would settle it, how to measure it in figures the owner already has, and roughly what it costs. The ledger records which are planned, running, done or dropped.`,
    rules: [
      "THE LIBRARY IS STATIC AND HAND-WRITTEN. No model wrote a line of it and none may add one — the point is that the same leaking stage produces the same shortlist twice.",
      "NOTHING HERE IS A PROMISE THAT A TEST WILL WIN. Most tests lose. An experiment is a hypothesis and the change that would settle it.",
      "`funnel.stage: null` MEANS NOTHING COULD NAME A STAGE, and then the owner is the one to pick. Do not guess one: sending somebody to rewrite a pricing page when the problem is that nobody arrives is the failure this refuses to make.",
      "COUNTERS ARE NEVER SUMMED WITHIN A STAGE. A site firing both `checkout-started` and `checkout-requested` has two names for one step; the largest single counter is used and its key is named.",
      "THE LEAK IS A TRANSITION AND THE STAGE REPORTED IS ITS LATER HALF — the step people failed to reach is the one whose page is worth changing. Both halves are on the answer.",
      "A TRANSITION UNDER 30 AT THE TOP IS NOT COMPUTED. Below that the ratio moves by a fifth every time one more person acts.",
      "THE STRIPE JOIN IS BY PRODUCT NAME, not by any id — a subscription counts for a venture when its product name contains the venture's name. Say so when quoting it.",
      "`dropped` IS NOT `done`. An experiment abandoned before it had a result is not a finding.",
      "The `refusals` list is what this library will never suggest. Do not suggest them either.",
    ],
    views: [
      {
        key: "default",
        path: "/api/growth/cro/:ventureId",
        about: "One venture: the measured funnel, the leaking stage, that stage's shortlist, the whole library, and the experiment ledger.",
        params: [
          { name: "ventureId", type: "string", required: true, in: "path", about: "The venture's slug or id.", exampled: true },
          {
            name: "stage",
            type: "string",
            required: false,
            about: `Override the measured stage and read another one's bucket: ${STAGES.map((s) => s.id).join(", ")}. The answer says the stage came from the owner rather than from a measurement.`,
          },
        ],
      },
    ],
    actions: [
      {
        key: "start",
        method: "POST",
        path: "/api/growth/cro/:ventureId/start",
        about: "Mark a library experiment as running for this venture, from today.",
        params: [
          { name: "ventureId", type: "string", required: true, in: "path", about: "The venture's slug or id." },
          { name: "experiment", type: "string", required: true, in: "body", about: "The library id, like `pri-cta-01`." },
          { name: "stage", type: "string", required: false, in: "body", about: "The stage it is being run for. Defaults to the experiment's own." },
        ],
      },
      {
        key: "finish",
        method: "POST",
        path: "/api/growth/cro/:ventureId/finish",
        about: "Close a running experiment as done or dropped, with what happened.",
        params: [
          { name: "ventureId", type: "string", required: true, in: "path", about: "The venture's slug or id." },
          { name: "experiment", type: "string", required: true, in: "body", about: "The library id." },
          {
            name: "outcome",
            type: "string",
            required: false,
            fallback: "done",
            in: "body",
            about: "`done` when it ran and produced a reading, `dropped` when it was abandoned. They are not the same thing.",
          },
          { name: "result", type: "string", required: false, in: "body", about: "What happened, in the owner's own words." },
          { name: "outcomeLink", type: "string", required: false, in: "body", about: "A link to where the outcome is recorded, if there is one." },
        ],
      },
    ],
    asks: [
      "Where is the funnel leaking for Acme, and what should I test first?",
      "Start the pricing call-to-action experiment for that venture.",
    ],
  },

  {
    id: "indexing",
    title: "Indexing — IndexNow submissions, and what sitemap submission still does",
    plugins: [],
    about:
      "Per host: the IndexNow key this app generated, where its key file must live, whether the file is actually there when asked to check, the sitemaps configured or assumed, what the last two site audits say is new or changed, and every submission this box has made with the status that came back.",
    rules: [
      "A 200 OR 202 FROM INDEXNOW MEANS RECEIVED. It is not a crawl and it is not an indexing, and it must never be reported as either.",
      "GOOGLE IS NOT PART OF INDEXNOW and never has been. Bing, Yandex, Seznam and Naver are; a submission tells Google nothing.",
      "GOOGLE'S SITEMAP PING ENDPOINT WAS RETIRED IN 2023 and this box does not call it. The Search Console API could submit a sitemap, but this box's credential is read-only on purpose and Google refuses a submit to it. What works for Google is robots.txt and a one-off submission by hand.",
      "WITHOUT THE KEY FILE NOTHING IS SENT. A submission for a host whose key file is missing is recorded as `dry-run` with the instruction, and `outcome: \"dry-run\"` never means anything was submitted.",
      "\"CHANGED\" MEANS THE TITLE, DESCRIPTION OR WORD COUNT MOVED between the last two audits. It is not a content hash and does not mean the page was rewritten.",
      "ONE SUBMISSION IS ONE HOST. A URL on another host is refused before anything is sent, because IndexNow answers 422 for a mixed batch.",
    ],
    views: [
      {
        key: "default",
        path: "/api/growth/indexing/:host",
        about: "One host: the key, the key file's location and instruction, the sitemaps, the audit delta, and the submission log.",
        params: [
          { name: "host", type: "string", required: true, in: "path", about: "The hostname, without www.", exampled: true },
          {
            name: "check",
            type: "number",
            required: false,
            about: "1 to fetch the key file and report whether it is really there. Off by default because it is a request to somebody else's server.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "submit",
        method: "POST",
        path: "/api/growth/indexing/submit",
        about:
          "Tell IndexNow that URLs on one host have changed. Either name the URLs, or ask for the ones the last two audits show as new or changed, or the ones in the sitemap.",
        params: [
          { name: "host", type: "string", required: true, in: "body", about: "The host being claimed. Every URL must be on it." },
          { name: "urls", type: "string", required: false, in: "body", about: "The URLs, as a JSON array. Capped at 200 per submission." },
          { name: "audit", type: "number", required: false, in: "body", about: "1 to submit what the last two audits show as new or changed." },
          { name: "sitemap", type: "number", required: false, in: "body", about: "1 to submit the URLs listed in the host's sitemap." },
          { name: "dryRun", type: "number", required: false, in: "body", about: "1 to resolve and log the batch without sending it." },
        ],
        /* A MESSAGE IT SENDS — the third of the four. The URLs go to Bing,
           Yandex, Seznam and Naver, who keep them; nothing here can ask them
           to forget one, and the local log surviving is not the point. */
        destructive: true,
      },
    ],
    /* Reaches off this box: the submission, and the view's `check` fetch. */
    openWorld: true,
    asks: [
      "Have the pages that changed on this site been submitted, and did IndexNow accept them?",
      "What do I have to put on the site before IndexNow will work?",
    ],
  },

  {
    id: "aso",
    title: "ASO — the store listing as a shopper reads it",
    plugins: ["appstore", "playstore"],
    about:
      "The stored audits of every store-listing run: the listing as it was read (title, description length, screenshot count, rating, current version's date), each check with what it was computed from, the weighted dimensions, and a score with its arithmetic. Competitor listings found through search are read the same way where the store publishes them.",
    rules: [
      "THE SCORE IS THIS APP'S OWN RUBRIC. It is not an industry grade, it is not Apple's or Google's, and two apps' scores are comparable only in that they came from the same rubric.",
      "A CHECK WITH `result: null` WAS NOT ANSWERED. It is not a pass and not a failure, and it is out of the denominator entirely. `refusal` on a listing means fewer than three dimensions could be scored and no grade was given.",
      "APPLE'S SUBTITLE AND ITS 100-BYTE KEYWORD FIELD ARE NOT READABLE FROM HERE — they live in App Store Connect's version localisations, which this box does not fetch. Never say they are empty.",
      "PLAY'S STORE PAGE IS A JAVASCRIPT SHELL. Only the title is read from it; the screenshot count, descriptions and update date are null, and the rating comes from the Play Console export instead.",
      "PLAY INDEXES THE FULL DESCRIPTION AND APPLE DOES NOT. Never give the same description advice for both stores.",
      "A RATING OF 0 MEANS NOBODY HAS RATED IT on both stores, not that it is rated zero.",
      "REVIEW RECENCY IS NOT MEASURED — no review text or dates are collected. Freshness is the CURRENT VERSION'S release date.",
    ],
    views: [
      {
        key: "default",
        path: "/api/growth/aso",
        about: "Every stored listing audit for one venture, newest first, with the rubric.",
        params: [
          { name: "venture", type: "string", required: true, about: "The venture's slug or id.", exampled: true },
          { name: "limit", type: "number", required: false, fallback: 20, about: "Rows returned. Clamped to 1–200." },
        ],
      },
      {
        key: "run",
        path: "/api/growth/aso/:runId",
        about: "The listings one audit run produced.",
        params: [{ name: "runId", type: "string", required: true, in: "path", about: "The run's id, from /api/runs." }],
      },
    ],
    asks: [
      "What is wrong with this app's store listing, and what would fix it first?",
      "How does our screenshot count compare with the listings beside us?",
    ],
  },

  {
    id: "adshealth",
    title: "Ads health — a score per ad account, with its parts",
    plugins: ["meta"],
    about:
      "Per Meta ad account, computed on every read from the account, campaign and daily rows the collector already wrote: frequency, the week-on-week click-through and cost-per-thousand trends, campaigns under the account's own median click-through, whether leads report at all, spend with nothing to show, daily budgets against the account's own cost per lead, and objectives that do not match what the account buys. Scored by severity-weighted categories with the arithmetic printed.",
    rules: [
      "THE SCORE IS THIS APP'S RUBRIC, computed by arithmetic that is printed beside it. It is not a Meta figure and not an industry grade.",
      "NO FIGURE IS COMPARED ACROSS ACCOUNTS. Each account's money is in its own currency and every band is measured against THAT account's own history. There is no total and no ranking.",
      "THE TARGET COST PER LEAD IS THE ACCOUNT'S OWN and no benchmark is ever substituted. Where the account has none, every check needing one is null.",
      "A CHECK WITH `result: null` WAS NOT EVALUATED and is out of the denominator. `refusal` means fewer than two categories could be scored and no grade was given.",
      "THE KILL TABLE GATES THE VERDICTS: under 7 days and 20 clicks nothing is judged, and under 1,000 impressions nothing may be called dead.",
      "LEARNING-LIMITED AD SETS AND DISAPPROVED ADS CANNOT BE SEEN FROM HERE — there is no ad set or ad row in what the collector stores. Those checks are null and `limitations` says so; never report them as passing.",
      "REACH AND FREQUENCY ARE DE-DUPLICATED BY META over the window on the row and can never be summed or averaged with another window's.",
    ],
    views: [
      { key: "default", path: "/api/growth/ads", about: "Every collected ad account with its score, listed and never ranked.", params: [] },
      {
        key: "account",
        path: "/api/growth/ads/:accountId",
        about: "One account: the score, every category with its coverage, every check with what it was computed from, the campaigns, and what cannot be seen.",
        params: [{ name: "accountId", type: "string", required: true, in: "path", about: "The Meta ad account id, like act_123456.", exampled: true }],
      },
    ],
    asks: [
      "Is this ad account healthy, and what is the worst thing wrong with it?",
      "Why did the score drop — which check changed?",
    ],
  },
];

/* ---------------------------------------------------------------- manifest */

export const manifest: IntegrationManifest = {
  id: "growth",

  config: {
    [PLUGIN]: indexingConfig,
  },

  routes: [{ path: "/api/growth", app: growthRoutes }],

  skills,

  packs: {
    serp: { name: "serp-teardown", category: "marketing" },
    authority: { name: "authority-estimate", category: "marketing" },
    cro: { name: "cro-library", category: "marketing" },
    indexing: { name: "indexnow-and-sitemaps", category: "marketing" },
    aso: { name: "store-listing-audit", category: "marketing" },
    adshealth: { name: "ads-health", category: "marketing" },
  },

  /* The plugin row has to exist for its settings page to be reachable, and the
     auto-submit pass has to be running for the setting to mean anything. Both
     are one call and neither throws. */
  onStart() {
    startIndexingTimer();
  },
};
