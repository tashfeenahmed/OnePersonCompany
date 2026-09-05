/**
 * The analytics area's four skills.
 *
 * The rule skills/registry.ts sets and this file keeps: a restatement of a
 * route's honesty rule may be SHORTER than the route's own header, and may
 * never be WEAKER. Each rule below traces to a paragraph in the route file
 * beside it, and the two change together.
 *
 * ALL FOUR ARE READ-ONLY. No entry here has `actions`, which — as the registry
 * header puts it — is the thing to read first: a skill with no `actions` key
 * cannot be made to write by any request the proxy will accept. Nothing in
 * this area has a write to offer in the first place; Umami, PyPI and Bluesky
 * are read through APIs this box only ever GETs, and the calendar provider
 * hard-codes its one verb for exactly that reason.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "umami",
    title: "Umami — web traffic on the owner's own analytics instances",
    plugins: ["umami"],
    about:
      "Self-hosted web analytics, per website: pageviews, visitors, visits, " +
      "bounces and time on site over the last 30 COMPLETE days against the 30 " +
      "before them, a daily line up to 90 days, and the top pages, referrers " +
      "and events. One account is one Umami instance and carries every website " +
      "on it.",
    rules: [
      "VISITORS ARE NEVER SUMMED ACROSS WEBSITES. Umami de-duplicates them per " +
        "site over the window, so one person who read two sites is one visitor " +
        "on each. `portfolio.visitors.combined` is null and there is no endpoint " +
        "that could fill it. Pageviews and visits DO add.",
      "A bounce is UMAMI'S definition — a visit with a single pageview — and is " +
        "not comparable to GA4, which has no such concept and reports engaged " +
        "sessions instead. Bounce rate is computed at read time from bounces ÷ " +
        "visits.",
      "Days are bucketed in the INSTANCE'S timezone, which this box does not " +
        "know. A day here is not necessarily a UTC day and is never joined to a " +
        "day from another integration.",
      "Top pages, referrers and events are a RANKING of the top 20 of a list " +
        "Umami truncated — never a total. They sum to less than the window's " +
        "pageviews by an amount nothing here can measure.",
      "The window is the last 30 complete days; today is deliberately outside " +
        "it. Deltas compare it with the same length of window immediately " +
        "before, and a delta is null rather than infinite when the previous " +
        "window was zero.",
      "This is the last collection, not a live call, and it runs at most every " +
        "six hours. `seenAt` says when.",
    ],
    views: [
      {
        key: "default",
        path: "/api/umami",
        about:
          "Every website: the window, the window before it, deltas, bounce rate, " +
          "average visit, the daily line and the three rankings — plus the " +
          "portfolio totals that are honest to compute.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 90,
            about: "How much of the daily line to return. Clamped to 1–90. It does NOT change the 30-day window figures.",
          },
        ],
      },
      {
        key: "entities",
        path: "/api/umami/entities",
        about: "Each website as a linkable entity, with the domain a venture can be matched on.",
        params: [],
      },
    ],
    asks: [
      "Which of my sites grew last month, and by how much against the month before?",
      "What are the top referrers to example-app-1.example.test in the last 30 days?",
    ],
  },

  {
    id: "calendar",
    title: "Calendar — what is on today, and how much of the week is spoken for",
    plugins: ["calendar"],
    about:
      "Google Calendar, read-only, across the calendars the owner has ticked in " +
      "Google. Today's events, the next seven days grouped by day, and busy " +
      "hours per day computed by merging overlapping meetings. The collector " +
      "keeps seven days back and twenty-one ahead.",
    rules: [
      "BUSY HOURS MERGE OVERLAPPING EVENTS AND NEVER ADD THEM. Two calls booked " +
        "over the same hour are one busy hour. A figure that added them would be " +
        "a thirty-hour Tuesday.",
      "Busy counts accepted, tentative and unanswered invitations. It NEVER " +
        "counts a declined event, and never a cancelled one — a cancelled event " +
        "is listed because it was called off, which is news, not a commitment.",
      "AN ALL-DAY EVENT HAS NO HOURS. It is listed and counted separately and " +
        "contributes nothing to any hours figure. Do not assume eight, or " +
        "twenty-four.",
      "Times are Google's own RFC3339 strings with the offset the event was " +
        "created in. Nothing is normalised to UTC, and the day an event belongs " +
        "to is the date inside its own timestamp. “Today” is the server's local " +
        "date and the document says which.",
      "NO EVENT DESCRIPTION IS STORED OR FETCHED, and no attendee is named: " +
        "`attendees` is a count and `response` is the owner's own answer. There " +
        "is nothing here to quote from a meeting body, because there is no " +
        "column that could hold one.",
      "Only calendars ticked in Google are read. A calendar the owner unticked " +
        "is absent rather than empty, and the calendars list says which is which.",
    ],
    views: [
      {
        key: "default",
        path: "/api/calendar",
        about:
          "Today, the next days by day with merged busy hours, the calendars " +
          "being read, and the accounts behind them.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 7,
            about: "How far ahead to group. Clamped to 1–21, which is the window the collector maintains.",
          },
        ],
      },
    ],
    asks: [
      "How much of tomorrow is already booked?",
      "What is on today, and what is the next thing that has not started yet?",
    ],
  },

  {
    id: "pypi",
    title: "PyPI — downloads of the packages the owner publishes",
    plugins: ["pypi"],
    about:
      "Downloads per package per day from pypistats, bucketed into ISO weeks at " +
      "read time, plus what each package IS from PyPI's own JSON — version, " +
      "summary, home page. Shaped exactly like /api/npm so the two registries " +
      "can be read side by side.",
    rules: [
      "IT IS DOWNLOADS, NEVER INSTALLS. PyPI counts CDN file requests: a CI job " +
        "on every push, a Docker layer rebuild and a person typing `pip install` " +
        "are one download each and nothing can tell them apart. Never build a " +
        "conversion rate on top of it.",
      "MIRRORS ARE EXCLUDED from every figure here (`?mirrors=false`), so these " +
        "numbers are smaller than pypistats' own default view. Say so when " +
        "quoting one against a number from elsewhere.",
      "Weeks are ISO, Monday to Sunday. A week marked `partial` — the week in " +
        "progress, a history that starts mid-week, or a day pypistats has not " +
        "published — must never be compared with a complete one.",
      "`recent` is pypistats' OWN rolling last day/week/month, ending yesterday. " +
        "It will not equal `lastCompleteWeek` and neither is wrong; quote which " +
        "one you used.",
      "A day pypistats has no row for is ABSENT, not zero. Its dataset is " +
        "rebuilt daily and the last day or two are usually missing.",
      "The package list is the owner's, typed by hand. `configured` and " +
        "`answering` differ when a name is wrong or brand new, and that is a " +
        "fact worth reporting rather than a quiet dip.",
    ],
    views: [
      {
        key: "default",
        path: "/api/pypi",
        about: "Per package and for the portfolio: weeks, the daily line, the last complete week, the week in progress, and pypistats' own rolling windows.",
        params: [],
      },
      {
        key: "entities",
        path: "/api/pypi/entities",
        about: "Each package as a linkable entity, with the host from its home page where there is one that is not a code forge.",
        params: [],
      },
    ],
    asks: [
      "How many downloads did my packages get last complete week?",
      "Is any package I publish failing to report, and why?",
    ],
  },

  {
    id: "bluesky",
    title: "Bluesky — followers and what the recent posts did",
    plugins: ["bluesky"],
    about:
      "Public profile figures for the watched handles — followers, follows, " +
      "total posts — with this box's own follower history behind them, plus " +
      "what the last fifty posts have gathered over 7 and 30 days. Read " +
      "unauthenticated from Bluesky's public AppView.",
    rules: [
      "A WINDOW MARKED `truncated` IS A FLOOR, NOT A TOTAL. The feed is read " +
        "one page deep — fifty posts — so an account that posted more than that " +
        "inside the window has at least this many likes and possibly many more. " +
        "Never quote a truncated figure as a total.",
      "Engagement counts are what those posts carry NOW, not what they earned " +
        "inside the window. An old post gathering new likes moves the figure, so " +
        "it is 'likes those posts have' and never 'likes gained this week'.",
      "A repost BY the handle is somebody else's post and is excluded from every " +
        "count. `reposts` means the handle's own posts being reposted by others.",
      "FOLLOWERS ARE NEVER SUMMED ACROSS HANDLES. One person following two of " +
        "these accounts is one person and Bluesky offers no way to de-duplicate " +
        "them. `portfolio.followers.combined` is null on purpose.",
      "Growth is over the readings this box HOLDS, not over the window asked " +
        "for. A handle added yesterday has one reading and no growth figure — " +
        "which is null, and is not a flat line.",
      "The handles are whatever the owner typed. This API has no notion of " +
        "'mine', so a handle here is being watched rather than owned.",
    ],
    views: [
      {
        key: "default",
        path: "/api/bluesky",
        about: "Per handle: the profile figures, the follower history, and the 7- and 30-day windows with their truncation flags.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 90,
            about: "How much follower history to return. Clamped to 1–400.",
          },
        ],
      },
      {
        key: "entities",
        path: "/api/bluesky/entities",
        about: "Each handle as a linkable entity. `host` is always null — a handle is a name Bluesky issued, not a website anybody owns.",
        params: [],
      },
    ],
    asks: [
      "How many followers did I gain on Bluesky this quarter?",
      "Which of my recent posts got any traction, and is that figure complete?",
    ],
  },
];

/** Where each of these lands in Hermes' skill tree. Filed by SUBJECT rather
 *  than by vendor — see skills/hermes.ts on why a vendor-shaped category is a
 *  directory nobody browses. */
export const PACKS: Record<string, { name: string; category: string }> = {
  umami: { name: "umami-traffic", category: "marketing" },
  bluesky: { name: "bluesky-social", category: "marketing" },
  pypi: { name: "pypi-downloads", category: "development" },
  calendar: { name: "calendar", category: "communication" },
};
