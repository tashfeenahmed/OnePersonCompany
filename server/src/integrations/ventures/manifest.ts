/**
 * THE VENTURES AREA — the four things that are ABOUT a business rather than
 * about a provider.
 *
 * Every other area on this seam adds an integration: a credential, a
 * collector, a table of somebody else's figures. This one adds nothing that
 * measures a third party. It adds the join between all of them and the
 * businesses they belong to (`/api/venture-links`), a picture of each
 * business's site (`/api/capture`), a crawl of it (`/api/audit`), and the
 * thing that reads a venture record and writes something new out of it
 * (`/api/studio`).
 *
 * SO THERE ARE NO `plugins` AND NO `collectors` HERE. Nothing in this area
 * holds a credential of its own — the studio borrows Replicate's and the model
 * provider's, the audit needs none, and the capture needs a browser rather
 * than a key — and nothing runs on the half-hourly scheduler, because none of
 * these are measurements that go stale on that cadence. The one background
 * pass is the weekly screenshot refresh, which is `onStart`'s and checks
 * hourly for something a week old.
 *
 * TWO PSEUDO-PLUGINS, `capture` AND `studio`, for the reason routes/
 * pluginConfig.ts's `chat` and `models` entries give: `plugin_config` has a
 * foreign key onto `plugins`, so a setting has to hang off a row. Neither
 * holds a credential, neither has an account, neither appears in the catalog
 * the Integrations page draws from, and both exist so that one thing this area
 * cannot work out for itself — where the browser is, which image model to
 * spend money on — can be typed by the owner and read back.
 */
import type { IntegrationManifest } from "../manifest.ts";
import type { Skill } from "../../skills/registry.ts";
import { journeyRoutes } from "./journey.ts";
import { ventureLinkRoutes } from "./links.ts";
import {
  CAPTURE_PLUGIN,
  REFRESH_DAYS,
  captureRoutes,
  findBrowser,
  startCaptureTimer,
} from "./capture.ts";
import { auditRoutes } from "./audit.ts";
import { DEFAULT_MODEL, STUDIO_PLUGIN, studioRoutes } from "./studio.ts";

/* ------------------------------------------------------------------ skills */

const skills: Skill[] = [
  {
    id: "venture-links",
    title: "The connection map — what belongs to which business",
    plugins: [],
    about:
      "Which of the things this box measures belong to which venture: Cloudflare " +
      "zones, Search Console properties, Bing sites, registrar domains, GitHub " +
      "repos, npm packages, Stripe products, apps in either store, Meta Pages, " +
      "Resend sending domains, mailboxes — and whatever the other integration " +
      "areas publish. The map is every venture, every thing, and every edge " +
      "between them; one venture's view adds SUGGESTIONS, computed live from " +
      "hostnames and names.",
    rules: [
      "A LINK IS THE OWNER'S STATEMENT AND A SUGGESTION IS A GUESS. Never quote a " +
        "suggestion as a fact about the business — it means two strings looked " +
        "alike. Every suggestion carries a `why`; if you mention one, quote that.",
      "`source: \"owner\"` was linked one at a time and `\"auto\"` was accepted in " +
        "bulk from the suggestions. Both are real links; only the first means " +
        "somebody looked at that one row.",
      "A HOSTNAME MATCH IS STRONG AND A NAME MATCH IS WEAK, and they are different " +
        "sentences in `why`. Two ventures may be acme.ie and acme.so: a " +
        "match is on the whole host or on a subdomain of it, never on a suffix, " +
        "and you must not reason as though one owns the other.",
      "`present: false` ON AN EDGE means the link points at something no collector " +
        "currently reports — a paused integration or a deleted zone, and nothing " +
        "here can tell which. It is not evidence that the thing is gone.",
      "`unlinked` IS NOT A FAULT LIST. A domain belonging to no venture is usually " +
        "a domain the owner is holding, not an oversight.",
      "LINKING IS CHEAP AND UNLINKING IS CHEAP; neither touches the thing linked. " +
        "Removing a link removes a statement about ownership and nothing else — no " +
        "zone, no property, no repository is affected.",
    ],
    views: [
      {
        key: "default",
        path: "/api/venture-links/map",
        about:
          "The whole graph: every venture, every plugin with how many things it " +
          "holds, every entity, every edge, and the things linked to nothing.",
        params: [],
      },
      {
        key: "one",
        path: "/api/venture-links/:ventureKey",
        about:
          "One venture's links, plus what this box thinks it should also be linked " +
          "to and why. Suggestions are computed on the read from live tables.",
        params: [
          {
            name: "ventureKey",
            type: "string",
            required: true,
            in: "path",
            about: "The venture's id (`v-acme`) or slug (`acme`).",
          },
        ],
      },
    ],
    actions: [
      {
        key: "link",
        method: "POST",
        path: "/api/venture-links/:ventureKey",
        about:
          "Say that one thing belongs to this venture. The entity is the " +
          "integration's OWN identifier for it — a Cloudflare zone id, a Search " +
          "Console property string, an npm package name — which is what the " +
          "suggestions and the map both carry.",
        params: [
          { name: "ventureKey", type: "string", required: true, in: "path", about: "The venture's id or slug." },
          { name: "plugin", type: "string", required: true, about: "The integration's id: cloudflare, gsc, bing-webmaster, dynadot, github, npm, stripe, appstore, playstore, meta, resend, gmail, or one from another area." },
          { name: "entity", type: "string", required: true, about: "That integration's own identifier for the thing. Copy it from a suggestion or from the map; do not compose one." },
          { name: "label", type: "string", required: false, about: "What to call it on the map. Absent keeps whatever the suggestion carried." },
        ],
      },
      {
        key: "unlink",
        method: "DELETE",
        path: "/api/venture-links/:ventureKey/:plugin/:entity",
        about:
          "Remove one link. Nothing about the thing itself changes — this is a " +
          "statement about ownership and only that.",
        params: [
          { name: "ventureKey", type: "string", required: true, in: "path", about: "The venture's id or slug." },
          { name: "plugin", type: "string", required: true, in: "path", about: "The integration's id." },
          { name: "entity", type: "string", required: true, in: "path", about: "The entity as the link holds it." },
        ],
        /* Reversible in one call with the same three values, which is what
           `destructive` is a claim about — see the type's header. */
      },
    ],
    asks: [
      "What does my main venture actually consist of on this box?",
      "Which domains and properties belong to no venture at all?",
    ],
  },

  {
    id: "audit",
    title: "SEO audit — what is wrong with a venture's own site",
    plugins: [],
    about:
      "A crawl of a venture's website, done here rather than reported by anyone: " +
      "robots.txt obeyed, the sitemap counted, up to sixty same-host pages fetched " +
      "one at a time. Per page — status, title, meta description, h1s, canonical, " +
      "noindex, word count, links, images with no alt, redirects. Per site — " +
      "http→https, duplicate titles, thin pages, broken internal links. When a " +
      "Search Console property is linked to the venture, the faults are ranked by " +
      "the impressions the page is actually earning.",
    rules: [
      "THERE IS NO SCORE AND YOU MUST NOT INVENT ONE. Every finding names the " +
        "evidence it was computed from; a number out of a hundred hides which input " +
        "moved it.",
      "THE CRAWL IS A SURVEY, NOT A MIRROR. At most sixty pages, within a two-minute " +
        "budget. `crawl.stoppedBecause` and `crawl.queuedButNotReached` say what was " +
        "not seen — a fault absent from this document may simply be on a page " +
        "nobody fetched.",
      "SEVERITY IS THIS FILE'S JUDGEMENT AND IT IS STATED, NOT ARGUED. `error` is " +
        "something broken (a 404, a noindex, a dead link); `warning` is something " +
        "costing traffic; `notice` is a convention (title length, a redirect hop) " +
        "that is fine to leave.",
      "IMPRESSIONS AND CLICKS UNDER `search` ARE SEARCH CONSOLE'S, over ITS window, " +
        "not this crawl's. They say which fault is worth the afternoon; they are " +
        "not a measurement this audit made.",
      "`links.checked` LESS THAN THE LINKS FOUND MEANS THE REST ARE UNKNOWN, not " +
        "sound. A 405 is never counted as broken — plenty of servers refuse HEAD.",
      "RUNNING AN AUDIT FETCHES SOMEBODY'S WEBSITE SIXTY TIMES. It is the owner's " +
        "own site and the crawl is polite, but it is not free: run it when asked, " +
        "not to check a hunch.",
    ],
    views: [
      {
        key: "default",
        path: "/api/audit/:ventureKey",
        about:
          "The most recent audit: findings grouped by severity, every page's own " +
          "row, and the Search Console join when a property is linked.",
        params: [
          { name: "ventureKey", type: "string", required: true, in: "path", about: "The venture's id or slug." },
        ],
      },
      {
        key: "history",
        path: "/api/audit/:ventureKey/history",
        about: "Every audit of this venture: when, how many pages, how many findings.",
        params: [
          { name: "ventureKey", type: "string", required: true, in: "path", about: "The venture's id or slug." },
        ],
      },
    ],
    actions: [
      {
        key: "run",
        method: "POST",
        path: "/api/audit/:ventureKey",
        about:
          "Crawl the site now and store the result. Takes one to three minutes and " +
          "makes up to sixty requests to the site plus a hundred and fifty link " +
          "checks. Answers with the finished audit.",
        params: [
          { name: "ventureKey", type: "string", required: true, in: "path", about: "The venture's id or slug." },
        ],
      },
    ],
    asks: [
      "What is wrong with my main site, worst first?",
      "Which pages Google actually shows have problems?",
    ],
    /* It fetches a website. That site is the owner's, and it is still the open
       internet — the same claim `search` makes, and for the same reason: this
       is published as MCP's `openWorldHint` and a client is entitled to trust
       it. */
    openWorld: true,
  },

  {
    id: "studio",
    title: "Studio — a post for a venture, in its own brand",
    plugins: [],
    about:
      "Drafts: a caption and hashtags from the live model provider, and a square, " +
      "story or landscape image from Replicate, both built from what this box " +
      "knows about the venture — the owner's name for it, his own sentence about " +
      "it, its stage, and the palette and fonts read off its site. Nothing here " +
      "publishes anything; a post is a draft on this machine.",
    rules: [
      "A POST IS A DRAFT AND NOTHING PUBLISHES IT. There is no route on this box " +
        "that posts to any network, and you must not imply one exists.",
      "THE IMAGE COSTS MONEY. Every create and every image regenerate runs a real " +
        "Replicate prediction on the owner's account. Do it when he asks for a " +
        "post, not to show him what one would look like.",
      "A POST WITH `error` SET AND A CAPTION IS THE NORMAL FAILURE, not a broken " +
        "row: it means the caption worked and the image did not, and the error " +
        "says which credential or which call was the problem.",
      "THE STAGE DECIDES WHAT A POST MAY CLAIM. For an `idea` there is nothing to " +
        "try and no price; for `pre-launch` nothing is on sale yet. A draft that " +
        "invites people to buy something that does not exist is the expensive " +
        "mistake here, because somebody clicks it.",
      "COLOURS IN A PROMPT WERE MEASURED FROM THE SITE, not chosen. Say so if you " +
        "quote them, exactly as the ventures skill's rules require.",
      "NO COST IS REPORTED AND NONE CAN BE. Replicate publishes no price in its " +
        "API — see the Costs page. `ms` is wall clock, not money.",
    ],
    views: [
      {
        key: "default",
        path: "/api/studio/posts",
        about: "The drafts, newest first, with the readiness of both halves.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's id or slug, to see only its posts. Absent is all of them.",
          },
        ],
      },
      {
        key: "readiness",
        path: "/api/studio",
        about:
          "Whether a caption can be written and an image made right now: which " +
          "provider is live, whether Replicate is connected, and which image model " +
          "is configured.",
        params: [],
      },
    ],
    actions: [
      {
        key: "create",
        method: "POST",
        path: "/api/studio/posts",
        about:
          "Draft one post. Writes a caption through the live model provider and " +
          "runs an image prediction on Replicate — which spends money. Without a " +
          "model provider nothing is created; without Replicate the post is stored " +
          "with its caption and an error where the picture goes.",
        params: [
          { name: "ventureId", type: "string", required: true, about: "The venture's id or slug — everything about the brand comes from its record." },
          { name: "brief", type: "string", required: true, about: "One line saying what the post is about, in the owner's own words. At most 2000 characters." },
          { name: "format", type: "string", required: false, fallback: "square", about: "`square` (1:1), `story` (9:16) or `landscape` (16:9)." },
          { name: "platform", type: "string", required: false, about: "instagram, linkedin, x… — it changes the caption's length and register. Absent writes a platform-neutral caption." },
        ],
      },
    ],
    asks: [
      "Draft a launch post for my newest venture about the feature that just shipped.",
      "What can the studio actually do right now — is Replicate connected?",
    ],
    /* The image comes from Replicate and the caption from whichever provider is
       live, which may be a hosted one. Either way this leaves the machine. */
    openWorld: true,
  },
];

/* ---------------------------------------------------------------- manifest */

export const manifest: IntegrationManifest = {
  id: "ventures",

  config: {
    [CAPTURE_PLUGIN]: {
      keys: {
        chromium: {
          label: "Browser",
          hint:
            "The full path to a Chrome or Chromium binary, for the site " +
            "screenshots. Leave it EMPTY and this looks for one itself: Google " +
            "Chrome, Chromium, Brave and Edge under /Applications, then chromium, " +
            "google-chrome, chromium-browser, google-chrome-stable and " +
            "brave-browser on PATH. Fill it in only to point at one the search " +
            "cannot find, or to choose a different one. Nothing else on this " +
            "dashboard needs a browser — the brand reader works from the HTML.",
          ph: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          check(value) {
            if (!value) return null; // cleared means "find one yourself"
            if (value.includes("\n")) return "One path, on one line.";
            if (!value.startsWith("/"))
              return "An absolute path, please — this is executed, and a relative one would depend on where the server happened to be started.";
            /* Checked at the point it was typed rather than discovered by a
               capture that silently does nothing an hour later — the rule
               every other check in the settings registry keeps. */
            return null;
          },
        },
      },
    },

    [STUDIO_PLUGIN]: {
      keys: {
        imageModel: {
          label: "Image model",
          hint:
            `The Replicate model the studio generates images with, as owner/name. ` +
            `Empty means ${DEFAULT_MODEL} — four steps, a second or two, and a ` +
            "fraction of a cent a picture, which is why it is the default. A " +
            "slower model here is a slower and more expensive post; the model is " +
            "a setting because “cheapest thing that looks good” is a judgement " +
            "that changes. No version hash: the model-scoped endpoint always runs " +
            "the current version.",
          ph: DEFAULT_MODEL,
          check(value) {
            if (!value) return null; // cleared means the default
            if (!/^[\w.-]+\/[\w.-]+$/.test(value))
              return `A Replicate model is owner/name, like ${DEFAULT_MODEL} — no version hash and no URL.`;
            return null;
          },
        },
      },
    },
  },

  routes: [
    { path: "/api/venture-journey", app: journeyRoutes },
    /* The join. Mounted beside /api/ventures rather than inside it, because
       that router owns what the owner TYPED about a business and this one owns
       what the box has FOUND that might belong to it. */
    { path: "/api/venture-links", app: ventureLinkRoutes },
    /* The picture. */
    { path: "/api/capture", app: captureRoutes },
    /* The crawl. */
    { path: "/api/audit", app: auditRoutes },
    /* The drafts. */
    { path: "/api/studio", app: studioRoutes },
  ],

  skills,

  packs: {
    /* Filed where a person would look for each, which is what skills/hermes.ts's
       header asks of a placement: the map is how the owner's work is organised,
       an audit is marketing, and a post is media. */
    "venture-links": { name: "venture-links", category: "productivity" },
    audit: { name: "seo-audit", category: "marketing" },
    studio: { name: "studio-posts", category: "media" },
  },

  onStart() {
    /* The weekly screenshot refresh. It checks hourly and captures only what is
       actually a week old — a timer that fires once a week never fires on a
       machine restarted more often than that. */
    startCaptureTimer();
    const browser = findBrowser();
    console.log(
      browser.found
        ? `[capture] ${browser.path} (${browser.source}) · refreshing shots older than ${REFRESH_DAYS} days`
        : `[capture] no browser found — screenshots are off. ${browser.error}`,
    );
  },
};
