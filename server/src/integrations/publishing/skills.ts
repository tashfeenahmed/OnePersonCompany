/**
 * The publishing area's skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph, and its header says why
 * that must not happen.
 *
 * THREE ENTRIES, AND THE FIRST ONE IS THE ONLY PLACE ON THIS BOX WHERE AN
 * AGENT CAN CAUSE SOMETHING TO BE SEEN BY STRANGERS. Everything else an agent
 * can do here is a read or a reversible filing. So the rules on `publish` are
 * longer than the rules anywhere else in this codebase, and they are about
 * exactly one thing: an agent must never be the reason a post went out that a
 * person had not read.
 *
 * WHAT IS DELIBERATELY NOT HERE. NO ACTION REACHES A LIVE SUBMISSION. Not
 * `publish`, and — since this pass — not `retry_item` either: both of those
 * routes are `requireBrowser`, so the action was a published promise that
 * could only ever return 403, telling an agent it could retry a failed post
 * and then refusing. The action is gone rather than the guard, because the
 * guard is the surface routes.ts spends thirty lines protecting and the
 * structural wall — no URL for the proxy to compose — is the one that does not
 * depend on a header being unforgeable. A failed item is retried by a person,
 * on the page, which is where consent to put something in front of strangers
 * has always lived.
 *
 * What is left that reaches a network at all is `approve_item`, which
 * authorises a send the owner then schedules, and `probe_destinations`, which
 * asks credentials what they can reach. There is no destination creation, no
 * credential write and no way to change a caption's destination to another
 * venture's account. And there is a `rehearse_item`, which runs the entire
 * pipeline against a mock transport and posts nothing at all — the thing an
 * agent should reach for when it wants to know whether something WOULD work.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "publish",
    title: "Publishing — the queue, the calendar and what each account can actually post",
    /* ALWAYS LIVE, like the board. These are the owner's own rows: a queue with
       no destinations connected is still a real and useful answer — "there is
       nowhere to send anything, and here is what each network is missing". */
    plugins: [],
    about:
      "Everything waiting to be published, per venture: drafts made by the Studio, the " +
      "Autopilot or a campaign; the owner's approvals; the calendar; and, per destination, " +
      "what the last PROBE established that credential could actually do. A destination is a " +
      "Facebook Page, an Instagram business account, a LinkedIn page or member, or a TikTok " +
      "account. Statuses are draft, approved, scheduled, publishing, published, failed and " +
      "cancelled. Every published item carries the platform's own id and, where the platform " +
      "gives one, a permalink.",
    rules: [
      "NOTHING IS PUBLISHED THAT THE OWNER DID NOT APPROVE. `approve_item` is the owner's " +
        "consent, and calling it on his behalf without him having read that exact caption " +
        "against that exact account is the one unforgivable thing on this surface. If you are " +
        "not certain he has read it, quote it back and ask.",
      "Approving does not publish. It authorises. The item still has to be scheduled or " +
        "published by hand, and saying “I have posted it” after approving one is false.",
      "`capabilities` is what a DATED PROBE found, not what the platform supports. " +
        "`probe.at: null` means nobody has ever asked — it is not a failure and it is not a " +
        "no. Quote the date beside any claim about what an account can do.",
      "A destination that cannot publish says WHY in `capabilities.missing`. On Meta the " +
        "commonest reason is a missing PAGE ROLE rather than a missing scope, and those are " +
        "fixed in different places — never paraphrase one as the other.",
      "`problems` on an item is computed on every read and is the list of things that would " +
        "stop it going out: caption length, media type, a missing public URL, a destination " +
        "that cannot post. An item with problems cannot be approved, and the fix is named in " +
        "each sentence.",
      "Instagram and TikTok FETCH their own media from a URL, so they cannot publish at all " +
        "unless `publicBaseUrl` is set and the internet actually reaches this box. Never " +
        "report those two as ready on the strength of a credential.",
      "Video is implemented for Facebook Pages and TikTok only. Instagram Reels and LinkedIn " +
        "video are not implemented here — say “not supported for this destination”, never " +
        "“it failed”.",
      "`rehearse_item` posts NOTHING — its route is structurally incapable of it. It runs the " +
        "whole pipeline against a mock transport and reports the calls that would have been " +
        "made. Use it to answer “would this work”; never describe its result as a publish. " +
        "`result.dry` is true on every answer it gives; if you ever see `dry: false` from it, " +
        "something is wrong and a real post may have gone out — say so rather than reporting " +
        "a success.",
      "An item that carries an `externalId` has been submitted and is never submitted again, " +
        "whatever its status. If a publish timed out, the post may well be live — check the " +
        "account before suggesting a retry, because a retry after a silent success is a " +
        "double post.",
      "A blackout window HOLDS due items; it does not skip them. They go out when it closes.",
      "Times on the wire are UTC instants. The calendar's day buckets are LOCAL to the " +
        "configured timezone, which is on every calendar answer — quote it.",
    ],
    views: [
      {
        key: "default",
        path: "/api/publishing",
        about:
          "Readiness: the settings, whether a public media URL exists, how many destinations can publish, the status counts and what is due.",
        params: [],
      },
      {
        key: "destinations",
        path: "/api/publishing/destinations",
        about:
          "Every destination with its dated probe: what it can post, what is missing, and the platform limits that apply to it.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's id or slug. Omitted, every venture's destinations.",
          },
        ],
      },
      {
        key: "queue",
        path: "/api/publishing/items",
        about:
          "The queue: items with their status, destination, caption, media, attempts and computed problems.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug." },
          {
            name: "status",
            type: "string",
            required: false,
            about: "draft, approved, scheduled, publishing, published, failed or cancelled.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 100,
            about: "Rows. Clamped to 1–500.",
          },
        ],
      },
      {
        key: "item",
        path: "/api/publishing/items/:id",
        about:
          "One item with every attempt made on it, including rehearsals, and the exact calls each attempt sent.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The item's id." },
        ],
      },
      {
        key: "calendar",
        path: "/api/publishing/calendar",
        about:
          "Scheduled and published items bucketed by LOCAL day, with the timezone and the blackout windows.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug." },
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 7,
            about: "How many days from `from`. Clamped to 1–62.",
          },
          {
            name: "from",
            type: "string",
            required: false,
            about: "An ISO instant to start at. Defaults to now.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "queue_item",
        method: "POST",
        path: "/api/publishing/items",
        about:
          "File a Studio post or a finished video into the queue as a DRAFT, optionally addressed to a destination. Asking twice returns the row that already exists.",
        params: [
          { name: "ventureId", type: "string", required: false, about: "A venture's id. Derived from the source when omitted." },
          { name: "sourceKind", type: "string", required: true, about: "studio_post, video_job or manual." },
          { name: "sourceId", type: "string", required: false, about: "The Studio post's id, or the video run's id." },
          { name: "destinationId", type: "string", required: false, about: "Where it should go. Leave it out to decide later." },
          { name: "caption", type: "string", required: false, about: "Overrides the source's own caption for this item only." },
        ],
      },
      {
        key: "approve_item",
        method: "POST",
        path: "/api/publishing/items/:id/approve",
        about:
          "THE OWNER'S CONSENT. It authorises this exact caption and picture to go to this exact account. It does not publish. Refused while the item has any problem.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The item's id." },
          { name: "by", type: "string", required: false, about: "Who approved it, recorded on the row." },
        ],
        /* DESTRUCTIVE, AND THE CLAIM IS EXACT. Approving is reversible on its
           own — `cancel_item` undoes it. What is not reversible is what it
           authorises: an approved item on a calendar is published without
           anybody being asked again, and the post is then in strangers' feeds.
           A client entitled to ask a person first should ask here. */
        destructive: true,
      },
      {
        key: "schedule_item",
        method: "POST",
        path: "/api/publishing/items/:id/schedule",
        about:
          "Put an APPROVED item on the calendar for an instant. Refused for anything not approved — the calendar does not carry consent.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The item's id." },
          { name: "at", type: "string", required: true, about: "An ISO instant, e.g. 2026-09-08T09:30:00Z." },
        ],
      },
      {
        key: "unschedule_item",
        method: "POST",
        path: "/api/publishing/items/:id/unschedule",
        about: "Take an item off the calendar. It stays approved; only the date goes.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The item's id." }],
      },
      {
        key: "cancel_item",
        method: "POST",
        path: "/api/publishing/items/:id/cancel",
        about:
          "Decide against an item. The row stays, so the queue can say a thing was decided against rather than losing it. Refused for something already published.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The item's id." }],
      },
      {
        key: "rehearse_item",
        method: "POST",
        /*
          ITS OWN ROUTE, WITH NO FLAG. This action used to point at
          `/publish` and carry `dry: "true"`, and the proxy sends every
          parameter as a STRING — so the flag was compared against a boolean,
          read false, and a rehearsal published a real post to a real Page.
          A route that cannot publish is the only version of this that is
          safe to hand an agent, and it is now the ONLY submission-shaped
          action here: see this file's header for why `retry_item` went.
        */
        path: "/api/publishing/items/:id/rehearse",
        about:
          "Run the whole pipeline against a MOCK transport and report the calls that would have been sent. This route cannot publish: nothing leaves this machine and the item is not touched.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The item's id." },
        ],
      },
      {
        key: "probe_destinations",
        method: "POST",
        path: "/api/publishing/destinations/probe",
        about:
          "Ask every connected social credential what it can reach for one venture, and record what each account can actually post. Reads only; writes destination rows on this box.",
        params: [
          { name: "ventureId", type: "string", required: true, about: "A venture's id or slug." },
        ],
      },
    ],
    asks: [
      "What is waiting to be published, and what is stopping each one?",
      "Can we actually post to the Instagram account, and if not what is missing?",
      "What is going out this week?",
    ],
    /* REACHES OFF THIS MACHINE, so the annotation says so.
       `probe_destinations` calls three networks and `approve_item` authorises
       a send; `openWorldHint: false` is a claim a client may act on without
       asking, and it would be a lie here. */
    openWorld: true,
  },

  {
    id: "campaigns",
    title: "Campaigns — one argument, made in several rooms",
    plugins: [],
    about:
      "A campaign is a goal, an audience and a set of channels, planned into a small number of " +
      "non-overlapping CONCEPTS and then written once per concept per channel. The production " +
      "is a queued RUN, so it is cancellable and reported like every other run on this box. " +
      "Every variant becomes a Studio draft and a DRAFT publish item; progress is counted as " +
      "planned, produced and failed.",
    rules: [
      "Starting a campaign spends money: one model call per variant and one image render per " +
        "variant. Say how many variants a channel list and a concept count imply before " +
        "starting one — concepts × channels.",
      "A campaign publishes NOTHING. Its variants are drafts and every one of them still needs " +
        "the owner's approval. Never report a finished campaign as posts that have gone out.",
      "`progress.planned` is zero until the concepts exist. A campaign still planning has no " +
        "denominator, and a percentage computed against zero is not a figure.",
      "A campaign cancelled half way keeps its real counters. `produced` is what actually " +
        "exists, and whole concepts are finished before the next one is started, so a " +
        "cancelled campaign is usable rather than uniformly half-done.",
      "A channel this box cannot publish to is still a channel a campaign can be WRITTEN for. " +
        "Those variants become Studio drafts with no publish item, which is stated on each one " +
        "— do not report it as a failure.",
      "The planner is given only what this box measured about the venture and is told it may " +
        "invent nothing. If the brief is empty, say so rather than describing the output as " +
        "informed.",
    ],
    views: [
      {
        key: "default",
        path: "/api/publishing/campaigns",
        about: "Every campaign with its concepts, its variants and its progress counters.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug." },
        ],
      },
      {
        key: "campaign",
        path: "/api/publishing/campaigns/:id",
        about: "One campaign with its run and every publish item it produced.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The campaign's id." },
        ],
      },
      {
        key: "suggestions",
        path: "/api/publishing/campaigns/suggestions",
        about:
          "What a campaign could be about, derived from the venture's stage, its destinations and what it has recently posted. No model call.",
        params: [
          { name: "venture", type: "string", required: true, about: "A venture's id or slug." },
        ],
      },
    ],
    actions: [
      {
        key: "start_campaign",
        method: "POST",
        path: "/api/publishing/campaigns",
        about:
          "Queue a campaign run: plan the concepts, then write one variant per concept per channel. Answers with the run, immediately.",
        params: [
          { name: "ventureId", type: "string", required: true, about: "A venture's id or slug." },
          { name: "goal", type: "string", required: true, about: "One line saying what the campaign is for." },
          {
            name: "channels",
            type: "string",
            required: true,
            exampled: true,
            about: "Comma separated: page, ig, linkedin, tiktok, or a bare platform name.",
          },
          { name: "audience", type: "string", required: false, about: "Who it is aimed at, in the owner's words." },
          {
            name: "concepts",
            type: "number",
            required: false,
            fallback: 3,
            about: "How many non-overlapping concepts to plan. Clamped to 1–5.",
          },
        ],
        /*
          DESTRUCTIVE, AND THE CLAIM IS ABOUT MONEY RATHER THAN ABOUT DATA.
          Five concepts across four channels is twenty model calls and twenty
          Replicate renders from ONE call, and none of that is refundable. The
          rules already said so in prose; a client entitled to ask a person
          first should be told in the field it can read.
        */
        destructive: true,
      },
    ],
    asks: [
      "Plan a campaign for the launch across Facebook and LinkedIn.",
      "How far did that campaign get before it was cancelled?",
    ],
    /* The planner call and every Studio render leave this machine. */
    openWorld: true,
  },

  {
    id: "assets",
    title: "Assets — a venture's own logos, references and screenshots",
    plugins: [],
    about:
      "Per venture: pictures the owner uploaded or this box fetched, kept so a generated post " +
      "can look like it came from that business. A `logo` is the mark, a `reference` is a look " +
      "to imitate, a `screenshot` is the product. Each carries an optional open instruction " +
      "that travels to the image model with it. The answer also says whether the CURRENT image " +
      "model can be handed a picture at all, read off that model's own schema.",
    rules: [
      "Whether a reference can be used depends on the image model, and the answer is " +
        "three-valued: supported with a field name, not supported, or NOT CHECKED because " +
        "Replicate is not connected. `checked: false` never means “the model cannot”.",
      "When the model has no image input, a selected asset is described in WORDS in the prompt " +
        "instead. That is much weaker and the post records that it happened — never describe " +
        "such a post as having used the reference.",
      "`source` is provenance and it matters: `url` means this box fetched somebody else's " +
        "picture, which can be their copyright. Do not put one into a published post without " +
        "the owner having decided that.",
      "`onDisk: false` is a row whose file has gone. It is not an empty library.",
      "A logo is usually the wrong thing to hand a generative model — it will redraw it " +
        "slightly wrong. Say so when suggesting one for an image prompt.",
    ],
    views: [
      {
        key: "default",
        path: "/api/publishing/assets",
        about:
          "One venture's assets, the kinds, what the library costs on disk, and whether the current image model takes a picture as input.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug." },
          { name: "kind", type: "string", required: false, about: "logo, reference, screenshot or other." },
        ],
      },
    ],
    actions: [
      {
        key: "import_asset",
        method: "POST",
        path: "/api/publishing/assets",
        about:
          "Fetch an image from a URL and keep the bytes. Recorded with `source: url`, because it can be somebody else's picture.",
        params: [
          { name: "ventureId", type: "string", required: true, about: "A venture's id or slug." },
          { name: "url", type: "string", required: true, about: "An http(s) image URL — PNG, JPEG, WebP or GIF." },
          { name: "kind", type: "string", required: false, fallback: "reference", about: "logo, reference, screenshot or other." },
          { name: "name", type: "string", required: false, about: "What to call it." },
          {
            name: "prompt",
            type: "string",
            required: false,
            about: "An open instruction forwarded to the image model with it — “keep the palette cold”, not a description.",
          },
        ],
      },
      {
        key: "delete_asset",
        method: "DELETE",
        path: "/api/publishing/assets/:id",
        about: "Forget an asset and delete its file.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The asset's id." }],
        destructive: true,
      },
    ],
    asks: [
      "What reference images does this venture have?",
      "Can the current image model actually use a logo?",
    ],
    /* `import_asset` fetches a URL and the library view reads the image
       model's schema off Replicate. Both leave this machine. */
    openWorld: true,
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  publish: { name: "publishing", category: "marketing" },
  campaigns: { name: "campaigns", category: "marketing" },
  assets: { name: "brand-assets", category: "media" },
};
