/**
 * THE FOUR SKILLS, AND THE RULES THAT ARE THE POINT OF THEM.
 *
 * Every one of these documents is a set of counts that LOOK addable and are
 * not, and an agent handed the tool without the rule will add them. So each
 * entry below restates its route's own header at the length a model can act
 * on: shorter than the route's argument, never weaker than it.
 *
 * The four failures these rules exist to prevent, in the order they would
 * happen:
 *
 *   1. Reporting event OCCURRENCES as people. The connected instance has an
 *      event that fired 5,978 times in 4,434 sessions.
 *   2. Presenting an adjusted figure as the traffic. The adjusted figure is a
 *      heuristic's opinion; the raw one is what Umami counted.
 *   3. Calling a blended ratio "ROAS". Nothing here attributes revenue to an
 *      advertisement.
 *   4. Reading a set of independent event counts as a user journey.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "segments",
    title: "Web audience segments, and the bot heuristics beside them",
    plugins: ["umami"],
    about:
      "Per website: the country, device, browser, operating system, language, screen and referrer " +
      "distributions over 30 complete days and over the last 7, with the 7 before those as the " +
      "comparison; plus a named set of bot heuristics that produce an ADJUSTED visitor figure " +
      "sitting beside the raw one. Shares, changes and the adjusted figure are all computed on the " +
      "read. Websites are read on a rotation, so a site's rows carry the hour they were read.",
    rules: [
      "`raw` IS WHAT UMAMI COUNTED AND `adjusted` IS A HEURISTIC'S OPINION. Quote the raw figure by default; quote an adjusted one only with the heuristic id, the excluded population and the date it was first seen. Nothing stored on this box has ever been reduced.",
      "THE ADJUSTED FIGURE SUBTRACTS THE LARGEST SINGLE FINDING, never the sum of them: the excluded populations overlap by an amount this API cannot measure. It is a floor on the reduction, not the reduction.",
      "A SHARE IS OF THE DIMENSION'S OWN ROWS, not of the site's visitors. `unattributed` is the gap — sessions Umami had no value for — and a share must never be restated as a share of the site.",
      "VISITORS ARE DE-DUPLICATED PER WINDOW. Two windows' visitor counts cannot be subtracted from each other, which is why the 30-day view offers no week-on-week change and why visitors are never summed across websites.",
      "COUNTRY, DEVICE, BROWSER, OS, LANGUAGE AND SCREEN COUNT VISITORS. REFERRER COUNTS VIEWS. Each row says which in `counts`; never put the two on one axis.",
      "A FINDING IS NOT A VERDICT. Every heuristic publishes how it can be wrong, and `flat-single-view` excludes nothing at all by design.",
      "DAYS ARE THE UMAMI INSTANCE'S DAYS in its own timezone, which this box does not know. Never join one to a dated figure from another integration.",
      "`readAt: null` on a website means it has not had its turn in the rotation yet. That is not a site with no traffic.",
    ],
    views: [
      {
        key: "default",
        path: "/api/webanalytics/sites",
        about: "Every website with deep rows, how stale each is, and which ventures it is linked to.",
        params: [],
      },
      {
        key: "site",
        path: "/api/webanalytics/segments/:websiteId",
        about:
          "One website's distributions, its raw and adjusted figures, every bot finding with its " +
          "evidence, and the whole heuristic rubric.",
        params: [
          {
            name: "websiteId",
            type: "string",
            required: true,
            in: "path",
            about: "The Umami website id, from the default view.",
            exampled: true,
          },
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "30 for the audience distribution, 7 for the week with a week-on-week change. Anything else is read as 30.",
          },
        ],
      },
    ],
    asks: [
      "Which audience changed on that site this week?",
      "Does that traffic spike look automated, and what would the heuristic take off?",
    ],
  },

  {
    /* NOT `events`: the customers area already publishes a skill with that id
       ("Business events — what Stripe said happened"). Two entries sharing an
       id means `opc events` is ambiguous and `/api/skills/events` resolves to
       whichever the registry saw first, which is a silent wrong answer rather
       than an error. */
    id: "webevents",
    title: "Web events — participants, occurrences and the numbers they carried",
    plugins: ["umami"],
    about:
      "Per website over 30 complete days: every custom event with its occurrence count AND its " +
      "participant count read from a different endpoint, plus each event's properties — the exact " +
      "count, sum, mean and range of numeric ones and a capped ranking of the rest. Also a " +
      "per-venture view of the conversion events the owner named, shaped as inputs to conversion " +
      "work rather than as a funnel.",
    rules: [
      "OCCURRENCES AND PARTICIPANTS ARE TWO DIFFERENT COUNTS FROM TWO DIFFERENT ENDPOINTS. Never report an occurrence count as a number of people: on the connected instance one event fired 5,978 times in 4,434 sessions.",
      "A PARTICIPANT IS A SESSION IDENTITY, NOT A PERSON. Umami hashes the site, the address and the user agent: one person on a phone and a laptop is two sessions, and one office behind one address may be one.",
      "`participants: null` WITH A `participantsError` MEANS NOT MEASURED. It is not nought and it is not the occurrence count. Events past the per-site detail limit deliberately carry one.",
      "A NUMERIC PROPERTY'S SUM AND MEAN ARE EXACT unless `truncated` is true, in which case the aggregate is refused rather than published short. Never reconstruct one from `topValues`.",
      "`unit: null` MEANS NOBODY SAID WHAT IT IS IN. A property called `revenue` may be cents, dollars or credits. Quote the figure with \"unit not stated\" rather than assuming a currency.",
      "`topValues` IS A RANKING and sums to less than `records`. It is never a total.",
      "STEP COUNTS ARE NOT A USER JOURNEY. The funnel-inputs view is a list of independent per-event participant counts over one window; nothing establishes that the sessions at one step are a subset of the sessions at another, and a ratio between two of them may never be called a drop-off or a conversion rate.",
      "THE STEP ORDER IS THE OWNER'S, typed into a setting. It is not evidence of an order in which anything happened.",
    ],
    views: [
      {
        key: "default",
        path: "/api/webanalytics/events",
        about: "Every website's events with participants, occurrences and properties.",
        params: [
          {
            name: "website",
            type: "string",
            required: false,
            about: "One Umami website id. Omitted, every collected website is returned.",
          },
        ],
      },
      {
        key: "funnel-inputs",
        path: "/api/webanalytics/events/funnel-inputs",
        about:
          "The conversion events named for each venture, with their participants — inputs to " +
          "conversion analysis, explicitly not a funnel.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's slug or id. Omitted, every venture is returned.",
            exampled: true,
          },
        ],
      },
    ],
    asks: [
      "How many people actually completed that signup event last month, as opposed to how many times it fired?",
      "What did the revenue property on that checkout event add up to, and in what unit?",
    ],
  },

  {
    id: "attribution",
    title: "Campaign to site to venture — a blended efficiency view, not ROAS",
    plugins: ["meta", "umami"],
    about:
      "Which advertising campaigns belong to which business, and what that mapping makes joinable: " +
      "ad spend, impressions and clicks summed by campaign id; the site traffic that arrived " +
      "carrying that campaign's name in a utm_campaign tag; the conversion events the owner named; " +
      "and a blended efficiency ratio of venture revenue over ad spend. Suggestions for unmapped " +
      "campaigns are recomputed on every read from URLs in the campaign, its ad sets, its " +
      "advertisements and its creatives.",
    rules: [
      "SPEND, IMPRESSIONS AND CLICKS ARE JOINED BY CAMPAIGN ID and are exact sums of daily rows Meta issued.",
      "TAGGED VIEWS ARE JOINED BY NAME — the campaign's name against the utm_campaign text the site saw. Umami has never heard of a Meta campaign id. The join is as good as the tagging was.",
      "A CAMPAIGN WITH SPEND AND NO TAGGED VIEWS MEANS THE LINKS WERE NOT TAGGED, not that nobody arrived. Say which.",
      "`views` ON A TAGGED ROW IS UMAMI'S COUNT FOR A PAGEVIEW-KEYED METRIC. It is not sessions and it is not people, and it must never be called visits.",
      "THE EFFICIENCY RATIO IS BLENDED AND MUST NEVER BE CALLED ROAS. It is everything the business earned over what it spent on advertising, with no attribution of any kind. Meta reports no purchase_roas for these accounts and this box computes none.",
      "THE TWO WINDOWS DO NOT LINE UP. Revenue is a calendar month from the finance area; spend is a number of complete days. Quote both spans.",
      "NOTHING IS ADDED ACROSS CURRENCIES and a ratio exists only where revenue and spend are in the same one. This box fetches no exchange rate.",
      "REACH AND FREQUENCY ARE ABSENT FROM THIS DOCUMENT ON PURPOSE: both are de-duplicated per row and summing them over a venture's campaigns would count the same person once per campaign.",
      "A SUGGESTION IS NOT A LINK. Nothing is filed until somebody presses something, and a campaign that matched two ventures is in `contested` with nothing applied.",
      "A SITE-REPORTED REVENUE PROPERTY AND THE LEDGER REVENUE ARE TWO MEASUREMENTS OF OVERLAPPING MONEY and are never summed.",
    ],
    views: [
      {
        key: "default",
        path: "/api/webanalytics/campaigns",
        about: "The campaign-to-venture map, the fresh suggestions, and the contested ones.",
        params: [],
      },
      {
        key: "venture",
        path: "/api/webanalytics/campaigns/:ventureKey",
        about:
          "One venture's joined performance: mapped campaigns with spend and clicks, tagged site " +
          "traffic, named conversions, and the blended efficiency line.",
        params: [
          {
            name: "ventureKey",
            type: "string",
            required: true,
            in: "path",
            about: "The venture's slug or id.",
            exampled: true,
          },
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "The ad-spend window in complete days. Clamped to 1–90. The tagged views come from a 7- or 30-day window and the answer says which.",
          },
          {
            name: "month",
            type: "string",
            required: false,
            about: "The revenue month as YYYY-MM. Defaults to the current one, which is INCOMPLETE — say so if you quote it.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "link_campaign",
        method: "POST",
        path: "/api/webanalytics/campaigns/link",
        about:
          "File one campaign to one venture. Accepting a suggestion keeps its evidence sentence and " +
          "records the source as auto-by-link; anything else is recorded as manual. Reversible by " +
          "unlink_campaign.",
        params: [
          { name: "campaignId", type: "string", required: true, about: "The platform's campaign id.", exampled: true },
          { name: "venture", type: "string", required: true, about: "The venture's slug or id.", exampled: true },
          { name: "platform", type: "string", required: false, fallback: "meta", about: "The advertising platform. Only meta has rows today." },
          { name: "evidence", type: "string", required: false, about: "Why, in one sentence, where this is not an accepted suggestion." },
        ],
      },
      {
        key: "unlink_campaign",
        method: "POST",
        path: "/api/webanalytics/campaigns/unlink",
        about: "Remove one campaign's venture mapping. The campaign and its figures are untouched.",
        params: [
          { name: "campaignId", type: "string", required: true, about: "The platform's campaign id.", exampled: true },
          { name: "platform", type: "string", required: false, fallback: "meta", about: "The advertising platform." },
        ],
      },
    ],
    asks: [
      "Which campaigns are bringing people to that business, and what did they cost?",
      "What is the blended efficiency of the advertising on that venture this month?",
    ],
  },

  {
    id: "creatives",
    title: "Ad creatives — fatigue over two matched weeks, and delivery status",
    plugins: ["meta"],
    about:
      "Every advertisement in every active ad account with its creative text, image, effective " +
      "status and ad set; a fatigue verdict per advertisement computed from Meta's own figures for " +
      "the last 7 complete days against the 7 before, with the arithmetic on every row; and the " +
      "advertisements that carry a Meta issue or read as live where they were set up while not " +
      "delivering.",
    rules: [
      "FATIGUE IS ONE SHAPE: frequency rising while click-through falls, over two matched weeks. A rising frequency alone is a small audience; a falling click-through alone is an auction or a season. Never call either one fatigue.",
      "UNDER THE IMPRESSION FLOOR THERE IS NO VERDICT — not a cautious one, none — and `why` says which week was short. Meta's percentages on a few hundred impressions are a rounding error wearing a percentage sign.",
      "REACH AND FREQUENCY ARE META'S OWN ANSWERS FOR THOSE EXACT WINDOWS and were never derived from daily rows. They are de-duplicated per window and may not be summed or averaged, across days or across advertisements.",
      "AN AD SET ID DOES NOT ESTABLISH LEARNING STATUS AND DOES NOT ESTABLISH AUDIENCE OVERLAP. This box reads neither the delivery-insights call nor the targeting specification, so neither claim may be made from these rows.",
      "A HIGH FREQUENCY IS ITS OWN FINDING, never evidence of overlap.",
      "`issues` IS META'S OWN TEXT, UNEDITED. Quote it; do not paraphrase a policy. An advertisement with no issue is one Meta chose to report nothing about — which is not the same as one in good standing.",
      "`mismatched` MEANS CONFIGURED ACTIVE AND EFFECTIVELY NOT DELIVERING. It is the state worth acting on because it looks live in Ads Manager.",
      "BUDGETS ARE IN MINOR UNITS of the account's own currency, as Meta sends them, and nothing is added across accounts.",
      "IMAGE URLS ARE SIGNED AND EXPIRE within days. Never cache one or treat a 403 as a deleted advertisement.",
    ],
    views: [
      {
        key: "default",
        path: "/api/webanalytics/creatives",
        about:
          "Ad sets, advertisements with fatigue verdicts and evidence, and the issue/status list.",
        params: [
          {
            name: "account",
            type: "string",
            required: false,
            about: "One ad account id (act_…). Omitted, every collected account is returned.",
          },
        ],
      },
    ],
    asks: [
      "Which advertisements are wearing out, and what is the evidence?",
      "Is anything disapproved or set live and not actually delivering?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  segments: { name: "web-audience", category: "marketing" },
  webevents: { name: "web-events", category: "marketing" },
  attribution: { name: "campaign-attribution", category: "marketing" },
  creatives: { name: "ad-creatives", category: "marketing" },
};
