/**
 * The mobilehealth area's skill entries.
 *
 * FOUR ENTRIES AND NOT ONE, because they are four questions with four
 * different honesty problems. `android` is about segments and units — devices
 * against users against events. `stability` is about a count that must never be
 * read as a rate and a rate that must never be read as today's. `reviews` is
 * about a seven-day API window that looks like an all-time total. `ios` is
 * about a pipeline where four reports with the same permission answer four
 * different ways. One entry carrying all of that would have twenty rules and
 * an agent would use the tool anyway.
 *
 * `mobile` IS NOT REPLACED AND IS NOT TOUCHED. It answers what the apps EARN
 * from a different credential path; these answer what they DO. Both can be
 * live at once and neither takes the other's rows away.
 *
 * TWO OF THEM WRITE, AND BOTH WRITES ARE NAMED. `reviews` can file a board
 * card carrying review ids — the owner asked for an agent that can work his
 * board — and `ios` can ask Apple to start generating analytics for an app.
 * Neither is destructive: a card is archivable and an ongoing analytics
 * request is idempotent and reversible in Apple's own console. There is NO
 * action that replies to a review, and there is no route on this box that
 * could be proxied into one.
 */
import type { Skill } from "../../skills/registry.ts";

const DAYS_PARAM = {
  name: "days",
  type: "number" as const,
  required: false,
  fallback: 30,
  about: "Window in days. Clamped to 1–60, which is as far back as this area ingests.",
};

export const SKILLS: Skill[] = [
  {
    id: "android",
    title: "Android acquisition — segments, listing conversion and retention",
    plugins: ["playstore"],
    about:
      "The Google Play Console's SLICED exports, which /api/mobile does not " +
      "read: installs, uninstalls and active devices by country, device, " +
      "Android OS version, carrier, language and app version code; store " +
      "listing visitors and acquisitions by country and by traffic source, " +
      "with the conversion rate computed over the window; and the retained-" +
      "installer curve where the bucket carries one. Windows in days, default " +
      "30, clamped to 60.",
    rules: [
      "UNITS DIFFER INSIDE ONE REPORT. Google's install columns count DEVICES; " +
        "the user columns beside them count USERS; the event columns count " +
        "EVENTS. Every series carries its `unit` — quote it, and never add two " +
        "series with different units.",
      "A `metricKind` of `level` (active devices, total user installs, ratings) " +
        "is a state of the world on a day and is NEVER summed over days — thirty " +
        "days of active devices added counts the same phone thirty times. Its " +
        "total is one reading per slice, from that slice's newest day.",
      "Listing conversion is acquisitions divided by visitors OVER THE WINDOW, " +
        "computed on the read. It is never the mean of the daily rates in " +
        "Google's file, and a rate is never averaged across days.",
      "`by.country` and `by.traffic_source` are two cuts of the SAME visitors. " +
        "Never add them together, and never present their sum as a total.",
      "A retention curve with `measured: false` means the bucket has no " +
        "stats/retained_installers/ report for that app — the reason is in " +
        "`reason` and in the readiness view. It is not a retention of zero, and " +
        "nothing on this box can create that report.",
      "A slice absent from an event metric contributed nothing that day. Only " +
        "non-zero event rows are stored, deliberately; levels keep their zeroes.",
      "None of this is added to iOS. A Play device install and an App Store " +
        "download event are different counts of different things.",
    ],
    views: [
      {
        key: "default",
        path: "/api/mobilehealth/segments",
        about:
          "Ranked slices per app per dimension per metric, with each slice's share and the remainder named.",
        params: [
          DAYS_PARAM,
          {
            name: "dimension",
            type: "string",
            required: false,
            about:
              "One of country, device, os_version, carrier, language, app_version. Omit for every dimension that was ingested.",
          },
          { name: "app", type: "string", required: false, about: "One package id. Omit for all." },
          {
            name: "store",
            type: "string",
            required: false,
            about:
              "Pass `play` for the Android rows alone. OMITTED, THIS VIEW RETURNS BOTH STORES — the App Store analytics rows live in the same table — and they must never be added across, so pass it unless you want both.",
            exampled: true,
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 12,
            about: "Slices published per group, biggest first. Clamped to 1–100; the rest are in `other`.",
          },
        ],
      },
      {
        key: "conversion",
        path: "/api/mobilehealth/conversion",
        about:
          "Store listing visitors, acquisitions and the window's conversion rate, per app, per day and per slice.",
        params: [DAYS_PARAM, { name: "app", type: "string", required: false, about: "One package id." }],
      },
      {
        key: "retention",
        path: "/api/mobilehealth/retention",
        about:
          "The retained-installer curve per app, with the rate computed against the cohort from the same file.",
        params: [DAYS_PARAM, { name: "app", type: "string", required: false, about: "One package id." }],
      },
      {
        key: "readiness",
        path: "/api/mobilehealth/readiness",
        about:
          "Which reports were asked for, what each store said, and which grants the credential actually carries.",
        params: [],
      },
    ],
    actions: [
      {
        key: "collect",
        method: "POST",
        path: "/api/mobilehealth/collect",
        about:
          "Read both stores now rather than waiting for the six-hour timer. Reads only, except that it makes no analytics request. Answers with what each block wrote and which grants were refused.",
        params: [],
      },
    ],
    asks: [
      "Which countries and devices are actually installing the Android apps, and which are uninstalling?",
      "How well does the Play listing convert visitors into installs, and from which traffic source?",
    ],
  },

  {
    id: "stability",
    title: "Mobile stability — crashes, ANRs and which release caused them",
    plugins: ["playstore", "appstore"],
    about:
      "Crash and ANR figures from three sources kept apart: Google Play's " +
      "stats/crashes/ export (daily COUNTS by app version, device and OS " +
      "version), the Play Developer Reporting API (daily RATES as a fraction " +
      "of distinct users, by version code, over a 28-day vitals window), and " +
      "the App Store Connect analytics report named “App Crashes”. Windows in " +
      "days, default 30.",
    rules: [
      "A COUNT AND A RATE ARE DIFFERENT MEASUREMENTS. Play's bucket export is a " +
        "count of crashes with NO denominator; the Reporting API's crashRate is " +
        "a fraction of distinct users. They are never put on one axis, never " +
        "converted into one another, and never averaged together.",
      "The window rate is WEIGHTED by the distinct users each day actually had. " +
        "An unweighted mean lets a quiet Sunday with four users outvote a " +
        "Monday with four thousand. `weightedBy` says so on every rate.",
      "Distinct users are distinct PER DAY. Summing them counts one person up " +
        "to twenty-eight times; the busiest day is the honest headline.",
      "The Reporting API's window ENDS AT ITS OWN PUBLISHED FRESHNESS, several " +
        "days back — not today. A crash rate here cannot speak about a release " +
        "shipped yesterday, and `readiness[].period` says which day it stops on.",
      "A NULL CRASH FIGURE IS NOT A CRASH COUNT OF ZERO. It means the report " +
        "was absent, still processing, or the credential was refused for it — " +
        "the `readiness` block on this document names which, in the provider's " +
        "own words. The Play Developer Reporting API needs its own enablement " +
        "and its own grant; a refusal there takes nothing away from revenue, " +
        "installs or ratings on /api/mobile.",
      "Apple's analytics are privacy-thresholded: rows under five users or " +
        "devices are dropped and noise is added, so an empty iOS crash report is " +
        "Apple withholding rather than a clean release.",
      "Never compare an Android crash count with an iOS one as if they were the " +
        "same measurement. They are counted by different systems with different " +
        "thresholds.",
    ],
    views: [
      {
        key: "default",
        path: "/api/mobilehealth/stability",
        about:
          "Per app per source: daily counts and their per-version breakdown, the weighted rate series, and the readiness of every report behind them.",
        params: [
          DAYS_PARAM,
          { name: "app", type: "string", required: false, about: "One package id or Apple app id." },
          { name: "store", type: "string", required: false, about: "play or appstore." },
        ],
      },
      {
        key: "readiness",
        path: "/api/mobilehealth/readiness",
        about: "Every report and every grant, with the provider's own refusal sentence.",
        params: [],
      },
    ],
    asks: [
      "Did the last Android release raise the crash rate, and on which version code?",
      "Is there any crash or ANR data at all, and if not, exactly which permission is missing?",
    ],
  },

  {
    id: "reviews",
    title: "App store reviews — the texts, the stars and what they are about",
    plugins: ["playstore", "appstore"],
    about:
      "The review inbox for both stores: rating, title, body, the display name " +
      "the store publishes, territory, language, app version and device where " +
      "the store carries them, plus the star distribution per day, the average " +
      "by app version, and a model's reading of the recent texts with the " +
      "review ids each theme cites. Windows in days, default 30.",
    rules: [
      "ANDROID REVIEWS ARE A SEVEN-DAY WINDOW ACCUMULATED. Google's " +
        "reviews.list returns only the last seven days and cannot page further " +
        "back, so the Android rows are what this box has caught since the area " +
        "was switched on — NEVER the app's all-time review count. Say so " +
        "whenever you quote an Android count.",
      "iOS reviews page back to the app's first review, all territories. The " +
        "two bases are different and are published apart in `basis`; never " +
        "quote one figure spanning both without saying which basis each half is on.",
      "`byVersion` is ANDROID-ONLY. Apple's customerReviews resource carries no " +
        "app version at all, so an iOS review can never be attributed to a release.",
      "A null rating is a review with no star — Play allows text without one — " +
        "not a zero-star review. The star histogram always carries all five " +
        "keys, including the ones nobody gave.",
      "THEMES ARE A MODEL'S READING, NOT A MEASUREMENT. Every theme cites the " +
        "review ids it came from, an id the model invented is dropped before " +
        "publication, and a theme left with no real citation is not published " +
        "at all. Quote the ids when you repeat a theme.",
      "REPLYING TO A REVIEW IS OUT OF SCOPE FOR THIS BOX. There is no route, no " +
        "action and no skill here that writes one; a reply is written in the " +
        "store's own console. The `reply` field is the reply the store ALREADY " +
        "holds, read only, so a triage list does not re-file something answered.",
      "`send_to_board` files ONE card carrying the review ids and records them, " +
        "so the same complaint does not become five identical cards. It does not " +
        "answer anybody.",
    ],
    views: [
      {
        key: "default",
        path: "/api/mobilehealth/reviews",
        about:
          "The reviews themselves with the star distribution per day and the average per app version.",
        params: [
          DAYS_PARAM,
          { name: "store", type: "string", required: false, about: "play or appstore." },
          { name: "app", type: "string", required: false, about: "One package id or Apple app id." },
          {
            name: "minRating",
            type: "number",
            required: false,
            about: "Lowest star to include, 1–5. Use with maxRating to read only the angry ones.",
          },
          { name: "maxRating", type: "number", required: false, about: "Highest star to include, 1–5." },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 50,
            about: "Reviews returned, newest first. Clamped to 1–500. The aggregates cover the whole window regardless.",
          },
        ],
      },
      {
        key: "trend",
        path: "/api/mobilehealth/reviews/trend",
        about:
          "Rating by version, the star distribution over time, and themes read out of the recent texts with the review ids cited.",
        params: [
          DAYS_PARAM,
          { name: "store", type: "string", required: false, about: "play or appstore." },
          { name: "app", type: "string", required: false, about: "One package id or Apple app id." },
          {
            name: "n",
            type: "number",
            required: false,
            fallback: 40,
            about: "How many recent reviews with text the model reads. Clamped to 1–200.",
          },
          {
            name: "themes",
            type: "string",
            required: false,
            about: "`off` to skip the model entirely and get only the arithmetic.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "send_to_board",
        method: "POST",
        path: "/api/mobilehealth/reviews/triage",
        about:
          "File one board card carrying the named reviews, their stars, versions and ids. Records which reviews were filed so they are not filed again. Reversible: the card can be archived.",
        params: [
          {
            name: "reviewIds",
            type: "string",
            required: true,
            in: "body",
            about:
              "A list of review ids from the reviews view. At most 25. Ids this box does not hold are reported back rather than silently dropped.",
            exampled: true,
          },
          {
            name: "title",
            type: "string",
            required: false,
            in: "body",
            about: "The card's title. Defaults to “N app reviews to answer”.",
          },
          {
            name: "ventureId",
            type: "string",
            required: false,
            in: "body",
            about: "The venture the card belongs to, if the app maps to one.",
          },
          {
            name: "column",
            type: "string",
            required: false,
            in: "body",
            about: "A board column key or id. Defaults to the backlog.",
          },
        ],
      },
    ],
    asks: [
      "What are people actually complaining about in the last month, with the reviews to prove it?",
      "Did the rating drop after a particular Android version shipped?",
    ],
  },

  {
    id: "ios",
    title: "iOS analytics and release history",
    plugins: ["appstore"],
    about:
      "Two things App Store Connect publishes that /api/mobile does not read. " +
      "First, the analytics pipeline: an ongoing report request, the reports " +
      "Apple lists against it, their daily instances and the CSVs behind them " +
      "— App Downloads, App Store Installation and Deletion, Discovery and " +
      "Engagement, Purchases, App Sessions and App Crashes — folded into " +
      "dated, dimensioned rows. Second, the version-state history, built by " +
      "writing down each version's state on every day this box looked.",
    rules: [
      "READINESS IS PER REPORT, NOT PER ACCOUNT. On a live account four of the " +
        "six wanted reports had zero instances while two had eleven and twelve, " +
        "with the same key and the same permission. `requested`, `processing`, " +
        "`available`, `delayed` and `unauthorized` are five different answers " +
        "and only `available` means there are numbers.",
      "APPLE'S ANALYTICS ARE PRIVACY-THRESHOLDED: rows under five users or " +
        "devices are dropped and noise is added. An empty day is Apple " +
        "withholding, not a measured zero, and a day's data is complete two " +
        "days after it.",
      "`observedOn` IS THE DAY THIS BOX LOOKED, not the day a version's state " +
        "changed. Apple publishes no change dates at all, so the history is " +
        "only as fine as the collection schedule and a gap is a day nobody " +
        "collected.",
      "`phase` (live, pending, in review, rejected, off sale) is DERIVED by " +
        "this box. `state` and `storeState` are Apple's own two vocabularies, " +
        "unedited — quote those when the distinction matters.",
      "Nothing here is Android. The Play Console publishes no version-state " +
        "resource to this credential, so every row in the versions view is iOS.",
      "`request_reports` is the ONLY thing on this box that writes to a store. " +
        "It opts one app into ongoing analytics generation; it is idempotent, " +
        "and the first report arrives 24–48 hours later, so a success is not " +
        "data.",
    ],
    views: [
      {
        key: "default",
        path: "/api/mobilehealth/versions",
        about:
          "Every version observed, its Apple states, the derived phase, and which days each phase was seen on.",
        params: [
          DAYS_PARAM,
          { name: "app", type: "string", required: false, about: "One Apple app id." },
        ],
      },
      {
        key: "readiness",
        path: "/api/mobilehealth/readiness",
        about:
          "Every analytics report Apple lists for each app and what state it is in, with Apple's own sentence.",
        params: [],
      },
      {
        key: "segments",
        path: "/api/mobilehealth/segments",
        about:
          "The analytics rows themselves, sliced by territory, device, source type, download type and app version.",
        params: [
          DAYS_PARAM,
          {
            name: "store",
            type: "string",
            required: false,
            fallback: "appstore",
            about: "Pass appstore for the iOS rows alone.",
            exampled: true,
          },
          { name: "dimension", type: "string", required: false, about: "territory, device, source_type, download_type, app_version." },
          { name: "app", type: "string", required: false, about: "One Apple app id." },
        ],
      },
    ],
    actions: [
      {
        key: "request_reports",
        method: "POST",
        path: "/api/mobilehealth/ios/request",
        about:
          "Ask Apple to start generating analytics reports for one app (an ONGOING analyticsReportRequest). Idempotent — an app that already has one gets its existing id back. The first report arrives 24–48 hours later.",
        params: [
          {
            name: "app",
            type: "string",
            required: true,
            in: "body",
            about: "The Apple app id, exactly as /api/mobile lists it.",
            exampled: true,
          },
        ],
      },
    ],
    asks: [
      "Where did the iOS downloads come from — which territory, device and source?",
      "How long was the last version in review, and is anything rejected right now?",
    ],
  },
];

/** Where these land in Hermes' skill directory. Filed by subject, like every
 *  other pack — see skills/hermes.ts on why the categories are not vendors. */
export const PACKS: Record<string, { name: string; category: string }> = {
  android: { name: "android-acquisition", category: "marketing" },
  stability: { name: "mobile-stability", category: "development" },
  reviews: { name: "app-reviews", category: "marketing" },
  ios: { name: "ios-analytics", category: "development" },
};
