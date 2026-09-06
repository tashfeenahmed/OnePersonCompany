/**
 * The social feed area's three skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph.
 *
 * THREE ACTIONS ARE MARKED `destructive`, AND NOT ONE OF THEM BECAUSE A ROW
 * CANNOT BE DELETED AFTERWARDS. The rule this build settled on is that an
 * action which SPENDS MONEY, SENDS SOMETHING, or CHANGES WHAT A GATE WILL LET
 * THROUGH is flagged, because `destructive` is the only signal a client gets
 * before it decides whether to ask a person first.
 *
 *   `ugc.start`             an image prediction fires on every call and no
 *                           cancellation refunds it
 *   `sourcing.deliver`      it puts a message on the owner's phone
 *   `sourcing.forget_topic` it archives the history entry that was refusing a
 *                           repeat, which is the door an agent that has just
 *                           been refused will find while reading its own rules
 *
 * `forget_topic` IS REVERSIBLE AND STILL FLAGGED. It archives rather than
 * deletes and `restore_topic` undoes it — the pair the board keeps for
 * `archive_card` and `delete_card`, the other way round — but the reason to
 * ask a person is not "can this be undone", it is "should an agent be doing
 * this at all". `collect` and `discover` read, cost nothing and are unflagged.
 *
 * ALL THREE ENTRIES DECLARE `openWorld`. Every action on them reaches off this
 * machine — Meta's Graph, the owner's SearXNG node and the video hosts yt-dlp
 * reads, Replicate — and `openWorldHint` is a field a client is entitled to
 * trust. Most skills on this box are loopback reads of a document a collector
 * already wrote; these are not.
 *
 * `social-posts` IS GATED ON `meta` AND THE OTHER TWO ARE NOT. Reading a
 * timeline needs Meta connected and there is no other way to do it. Source
 * discovery needs SearXNG, which is a different plugin, and the topic history
 * needs nothing at all — a gate that is refusing repeats is worth reading
 * about on a box with no search node.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "social-posts",
    title: "Organic posts — what went out, and how it did",
    plugins: ["meta"],
    about:
      "The Facebook Page posts and Instagram media this box read BACK from " +
      "Meta, with their permalinks, their media type, the text, and the " +
      "engagement figures Meta will publish. Each post carries `fromDraft` " +
      "when it came out of a draft generated here, which is the join between " +
      "what this box made and what it did. The `accounts` block says, per " +
      "Page, when it was last read successfully and what Meta said when it " +
      "refused.",
    rules: [
      "THE KEYS UNDER `metrics` ARE META'S OWN NAMES AND YOU MUST USE THEM. " +
        "`post_media_view` counts RENDERS — one person scrolling past twice is " +
        "two — and Instagram's `reach` counts UNIQUE ACCOUNTS. They are not " +
        "the same measurement, they are never added together, and neither is " +
        "“reach” in the plain-English sense. Say which figure you used.",
      "A METRIC THAT IS NOT A KEY WAS NOT REPORTED. It is not zero. Meta " +
        "retired the whole `post_impressions` family on 15 November 2025 — " +
        "`post_impressions`, `post_impressions_unique`, `post_engaged_users` " +
        "and the rest answer 400 and are listed under `metrics.retired`. A " +
        "post with no `post_media_view` key had no insights block, which is a " +
        "Page permission and not an absence of activity.",
      "`reactions.summary.total_count` AND `comments.summary.total_count` ARE " +
        "NOT INSIGHTS. They come off the edge summaries, need no insights " +
        "permission, and are counts of things rather than of people. `shares." +
        "count` VANISHES WHEN IT IS ZERO — its absence is normal and is not a " +
        "gap.",
      "ONLY MAPPED PAGES ARE READ. A Page the owner has not attached to a " +
        "venture under Publishing is not in this document at all, and that is " +
        "deliberate: a Meta token can administer Pages belonging to strangers.",
      "INSTAGRAM: `coverage.instagramLinked` is NULL until a read has actually " +
        "happened, and null means NOT MEASURED — never “none”. Zero AFTER a read " +
        "means no Page has a linked Instagram business account, which is “no " +
        "Instagram account is linked” and never “Instagram has no posts”.",
      "AN `insightsError` NAMING A METRIC MEANS THE POSTS ARE CURRENT AND THE " +
        "NUMBERS ARE NOT. Insights ride on the posts edge as one field " +
        "expansion, so a metric Meta retires answers 400 and would take the " +
        "whole timeline down with it; the read notices that and retries once " +
        "without them. Say the timeline is up to date, say the engagement " +
        "figures are missing, and name the metric. Do not report the posts as " +
        "stale, and do not read a zero into a post that has no metric keys.",
      "`lastOkAt` AND `lastTriedAt` ARE TWO DATES ON PURPOSE. A Page that is " +
        "failing keeps the date it last worked. Quote the freshness before you " +
        "quote a figure off a Page whose last try failed.",
      "NOTHING HERE PUBLISHES ANYTHING. Every call on this path is a GET " +
        "against Meta. Reading a post is not posting one.",
    ],
    views: [
      {
        key: "posts",
        path: "/api/socialfeed/posts",
        about:
          "Every post read back from a mapped Page or Instagram account, newest first, with the platform's own metric names and per-account freshness.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug. Absent lists every venture's posts." },
          { name: "platform", type: "string", required: false, about: "`facebook` or `instagram`. Absent lists both." },
          { name: "limit", type: "number", required: false, fallback: 60, about: "How many posts. Clamped to 1–300." },
        ],
      },
      {
        key: "performance",
        path: "/api/socialfeed/posts",
        about:
          "The same document, read for the join: a post's `fromDraft` names the publish item that produced it, so a generated draft can be judged on what it actually did.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug." },
          { name: "limit", type: "number", required: false, fallback: 60, about: "How many posts. Clamped to 1–300." },
        ],
      },
    ],
    actions: [
      {
        key: "collect",
        method: "POST",
        path: "/api/socialfeed/collect",
        about:
          "Read every mapped Page's timeline now. One Graph request per Page, all GETs. Free, and bounded by Meta's rate limit rather than by anything here.",
        params: [],
      },
    ],
    asks: [
      "How did the post we generated for this venture last week actually do?",
      "Which of our Pages has not been read successfully, and what did Meta say?",
    ],
    openWorld: true,
  },

  {
    id: "sourcing",
    title: "Sourcing and novelty — what to make next, and what not to make again",
    plugins: [],
    about:
      "Two halves of one decision. `candidates` is what a video search found " +
      "for a venture, ranked, with a reason on every one that was refused. " +
      "`history` is every topic and source this box has already used, with the " +
      "normalised fingerprint the gate compares against. `verdicts` is every " +
      "decision the gate has taken — allows as well as refusals — and it runs " +
      "BEFORE anything is generated, so a refusal costs nothing.",
    rules: [
      "A REFUSAL IS THE FEATURE WORKING AND IS NOT A FAILURE. “Refused: 62% " +
        "of this topic's words were already used on 12 August” means a " +
        "duplicate video was NOT made and no money was spent. Never report it " +
        "as an error or as a reason the autopilot is broken.",
      "THE COMPARISON IS ON A NORMALISED FINGERPRINT AND IS ASYMMETRIC. It is " +
        "the share of the NEW topic's distinctive words that the old one " +
        "already had, so a short brief entirely contained in a longer old one " +
        "scores 1.0 and is refused. Do not describe it as a similarity " +
        "percentage between two texts.",
      "A TOPIC IS COMPARED OVER A WINDOW, A SOURCE VIDEO FOREVER, AND BOTH ARE " +
        "PER VENTURE. The window is the `noveltyDays` setting; a topic older " +
        "than it is allowed back, because a business may make the same point " +
        "twice a year. A source THIS venture has cut up is never offered to it " +
        "again — but another venture may still use it, because a source belongs " +
        "to the business that used it and one business's ledger is not a rule " +
        "about another.",
      "AN ARCHIVED HISTORY ENTRY IS STILL IN THE LIST AND IS NOT DELETED. " +
        "`archivedAt` non-null means the owner set it aside: the gate stops " +
        "counting it, so its topic is allowed again, and the record of what was " +
        "made survives. Do not call it deleted, and do not count it when you " +
        "tell somebody what has been made for a venture.",
      "`durationFrom` DECIDES HOW MUCH A DURATION IS WORTH. `yt-dlp` is the " +
        "file's real metadata. `searxng` is the search engine's own string and " +
        "is sometimes wrong. Null means neither said, and the candidate scores " +
        "as unknown rather than as bad.",
      "THE RANK IS ARITHMETIC AND NOT A JUDGEMENT. Duration fit, recency where " +
        "a date exists, and how many engines carried the link. No model chose " +
        "anything here, so do not describe a candidate as “chosen because it " +
        "is the most relevant”.",
      "`engines.refused` ON A SEARCH IS A MEASUREMENT. A metasearch node down " +
        "to one working engine still returns ten links and still looks healthy; " +
        "if the answer looks thin, say which engines refused.",
      "ARCHIVING A HISTORY ENTRY IS HOW THE GATE IS OVERRULED, AND IT IS THE " +
        "OWNER'S DECISION RATHER THAN YOURS. NEVER archive one to get past a " +
        "refusal you were asked to work around — the refusal IS the answer, and " +
        "the right report is “that has already been made, here is when”. It is " +
        "marked destructive for that reason and not because it cannot be " +
        "undone: `restore_topic` undoes it.",
    ],
    views: [
      {
        key: "default",
        path: "/api/socialfeed/sourcing",
        about:
          "The settings as they resolve, every venture's own channel where one is named, the candidates from the last search, the durable history and every gate verdict.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug. Absent covers every venture." },
          { name: "limit", type: "number", required: false, fallback: 60, about: "Rows per list. Clamped to 1–300." },
        ],
      },
    ],
    actions: [
      {
        key: "discover",
        method: "POST",
        path: "/api/socialfeed/discover",
        about:
          "Search for source videos for one venture and one topic now, rank them and record every refusal. Costs one or two searches on the owner's own SearXNG node and a handful of yt-dlp metadata reads — no downloads, no model calls, no money.",
        params: [
          { name: "venture", type: "string", required: true, about: "A venture's id or slug." },
          { name: "topic", type: "string", required: true, about: "What the footage should be about. The subject, not the product — nobody has filmed the product." },
        ],
      },
      {
        key: "forget_topic",
        method: "POST",
        path: "/api/socialfeed/forget",
        about:
          "ARCHIVE one entry in the content history, so the gate stops counting it and the topic it was blocking is allowed again. The row is NOT deleted — it stays in the history flagged with `archivedAt`, and `restore_topic` puts it back.",
        /* DESTRUCTIVE BECAUSE IT CHANGES WHAT THE GATE WILL LET THROUGH — not
           because it cannot be undone, which it can. This is the door an agent
           that has just been refused finds while reading its own rules, and
           walking through it is how a duplicate gets made with the owner's
           money. Flagged so a client asks a person first. */
        destructive: true,
        params: [{ name: "id", type: "number", required: true, about: "The history row's id, from the `history` list." }],
      },
      {
        key: "restore_topic",
        method: "POST",
        path: "/api/socialfeed/restore",
        about:
          "Put an archived history entry back, so the gate counts it again and its topic is refused as a repeat inside the window. The undo for `forget_topic`, and unflagged because restoring a rule is not the risky direction.",
        params: [{ name: "id", type: "number", required: true, about: "The history row's id, from the `history` list." }],
      },
      {
        key: "deliver",
        method: "POST",
        path: "/api/socialfeed/deliver",
        about:
          "Hand every finished autopilot video that has not been delivered to the paired Telegram chat — or to nobody, when the `deliverTo` setting is off — and file each as a DRAFT in the publishing queue. Idempotent; the draft is filed either way; nothing is published anywhere.",
        params: [],
        /* DESTRUCTIVE BECAUSE IT SPENDS, SENDS OR TOUCHES A MACHINE — not because
           a row cannot be deleted afterwards. `destructive` is what a client is
           entitled to trust when it decides whether to ask a person first, and
           the thing that cannot be taken back here is the money, the message or
           the power state rather than the record. It sends: finished videos go out to the configured channel. */
        destructive: true,
      },
    ],
    asks: [
      "Why did the autopilot not make a video for this venture this week?",
      "What could we cut a short out of for this business, and what was refused?",
    ],
    /* `discover` searches the owner's SearXNG node and then reads metadata off
       whatever video hosts the results point at. That is the open internet. */
    openWorld: true,
  },

  {
    id: "ugc",
    title: "UGC — a product in a scene, made to move",
    plugins: [],
    about:
      "Jobs that take a venture's own reference pictures out of the asset " +
      "library, put the product into a photorealistic scene with the Studio's " +
      "image model, animate that still with a Replicate image-to-video model, " +
      "burn one caption line on and file the result as a draft. The `ready` " +
      "block says which of those steps can actually run on this box.",
    rules: [
      "THE ANIMATION MODEL HAS NO DEFAULT, ON PURPOSE. With `ready.videoModel` " +
        "null, a job makes a still image and SKIPS the animation, and NOTHING " +
        "IS SPENT on video. That is the normal state and it is not a fault; " +
        "`skipped` on the job says so in words.",
      "STARTING A JOB IS MARKED DESTRUCTIVE BECAUSE THE CHARGE CANNOT BE TAKEN " +
        "BACK. The image prediction fires before anything else is checked and " +
        "cancelling the run does not refund it. Ask the owner before starting " +
        "one, and never start several to compare results unless told to.",
      "STARTING A JOB SPENDS MONEY EVERY TIME. One image-model prediction " +
        "always, and one image-to-video prediction — dollars rather than " +
        "fractions of a cent — when a model is configured. Say so before you " +
        "start one on somebody's behalf.",
      "`imageField` IS A MEASUREMENT OF THE MODEL, read off its own schema. " +
        "Null means the model takes NO picture as an input and the references " +
        "were described in words in the prompt instead, which is much weaker: " +
        "the product in that picture is the model's idea of the product. Never " +
        "describe such a job as having used the venture's references.",
      "A JOB WITH NO REFERENCE PICTURES CANNOT RUN AND IS NOT STARTED. " +
        "`canRun: false` on a venture means its asset library is empty, and " +
        "the fix is an upload rather than a retry.",
      "THE OUTPUT IS A DRAFT AND NOTHING HERE POSTS IT. The path from draft to " +
        "published goes through the owner's approval in the publishing area. " +
        "Never say a UGC clip has gone out.",
      "THE CLIP IS SILENT. No voice is asked for and nothing copyrighted is " +
        "bundled with this dashboard, so unless the video model produced sound " +
        "of its own there is none.",
    ],
    views: [
      {
        key: "default",
        path: "/api/socialfeed/ugc",
        about:
          "Which ventures have reference pictures, what the two models are, whether Replicate is connected, and every job with its per-step record.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug. Absent covers every venture." },
          { name: "limit", type: "number", required: false, fallback: 40, about: "How many jobs. Clamped to 1–200." },
        ],
      },
    ],
    actions: [
      {
        key: "start",
        method: "POST",
        path: "/api/socialfeed/ugc/start",
        about:
          "Queue one UGC job as a video run. THIS SPENDS MONEY ON EVERY CALL: one image-model prediction always, plus one image-to-video prediction when a model is configured. The answer names both before anything runs. Nothing refunds a prediction — cancelling the run does not. Refused when the venture has no reference pictures or Replicate is not connected.",
        params: [
          { name: "venture", type: "string", required: true, about: "A venture's id or slug. It must have at least one asset in its library." },
          { name: "brief", type: "string", required: false, about: "What the scene should show, one or two lines. Empty asks for the product in ordinary use." },
          { name: "assets", type: "string", required: false, about: "Comma-separated asset ids to use as references. Empty uses the whole library, up to four." },
          { name: "aspect", type: "string", required: false, fallback: "9:16", about: "`9:16`, `1:1` or `16:9`." },
        ],
        /* DESTRUCTIVE BECAUSE IT SPENDS, SENDS OR TOUCHES A MACHINE — not because
           a row cannot be deleted afterwards. `destructive` is what a client is
           entitled to trust when it decides whether to ask a person first, and
           the thing that cannot be taken back here is the money, the message or
           the power state rather than the record. It spends: one image-model prediction per picture. */
        destructive: true,
      },
    ],
    asks: [
      "Can we make a UGC clip for this venture, and what would it cost?",
      "Why did that UGC job come out as a still image?",
    ],
    openWorld: true,
  },
];

/** Where these land in Hermes' skill directory. The posts one is marketing —
 *  it is about performance — and the other two are media, because they are
 *  about making things. */
export const PACKS: Record<string, { name: string; category: string }> = {
  "social-posts": { name: "social-posts", category: "marketing" },
  sourcing: { name: "content-sourcing", category: "media" },
  ugc: { name: "ugc-studio", category: "media" },
};
