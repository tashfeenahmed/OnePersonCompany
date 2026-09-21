/**
 * SOCIAL FEED — what already went out, what to make next, and one format that
 * needs the owner's own pictures.
 *
 * THREE GAPS, ONE AREA, and they are one area because they are one loop.
 * Something is made (the autopilot), it is published (the publishing area),
 * and then nothing on this box could see how it did — so nothing could decide
 * what to make next except by asking a model to remember. This area closes
 * that circle: it reads the timeline back, it remembers durably what has been
 * made, and it refuses a repeat before any money is spent.
 *
 *   #23  organic post history and performance, joined to the drafts that
 *        produced them by Meta's own post id
 *   #27  source discovery for the shorts format, a durable topic and source
 *        history, a novelty gate — a model's judgment since 2026-09-21, and a
 *        stem-overlap score before it — and delivery of finished work
 *   #22  the UGC image-to-video format, which is optional and small
 *
 * ONE CONFIG-ONLY PLUGIN AND NO CREDENTIAL. Everything here needs a key that
 * is already in the vault under somebody else's plugin: Meta's token for the
 * timelines, SearXNG's for the search, Replicate's for both models. A second
 * copy of any of them would be a second thing to revoke. What this area owns
 * is DECISIONS — how far back a topic counts as a repeat, how long a source
 * video may be, which video model may be paid — and those are settings.
 *
 * NO COLLECTOR ENTRY, AND THAT IS THE TRAP WORTH NAMING. `manifestCollectors()`
 * merges every area's map over `collector.ts`'s built-ins BY PLUGIN ID: an
 * entry under `meta` here would SILENTLY REPLACE the collector that reads the
 * ad spend. So the timeline read runs on its own timer and on
 * POST /api/socialfeed/collect, the way mobilehealth does for the same reason.
 *
 * TWO TIMERS, AND EACH DOES NOTHING UNTIL IT HAS SOMETHING TO DO. The posts
 * timer wakes every fifteen minutes and reads nothing until six hours have
 * passed AND a Meta Page is mapped to a venture. The delivery sweep wakes
 * every five minutes and finds nothing at all unless the autopilot queued a
 * video that has since finished.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import { socialfeedRoutes } from "./routes.ts";
import { startPostsTimer, DEFAULT_LIMIT } from "./posts.ts";
import { startDelivery } from "./deliver.ts";
import { DEFAULT_NOVELTY_DAYS, reindex, SOCIALFEED_PLUGIN } from "./novelty.ts";
import { DEFAULT_MAX_MINUTES, DEFAULT_MIN_MINUTES, parseChannels } from "./sourcing.ts";
import { DEFAULT_UGC_SECONDS } from "./ugc.ts";
import { SKILLS, PACKS } from "./skills.ts";

const whole = (value: string, lo: number, hi: number, what: string): string | null => {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < lo || n > hi) return `${what}, between ${lo} and ${hi}.`;
  return null;
};

export const manifest: IntegrationManifest = {
  id: "socialfeed",

  config: {
    [SOCIALFEED_PLUGIN]: {
      keys: {
        posts: {
          label: "Posts read per Page",
          hint:
            `How many posts are read back from each Facebook Page and each ` +
            `Instagram account. Default ${DEFAULT_LIMIT}. This is ONE Graph ` +
            `request either way — a bigger number is a bigger response, not ` +
            `more requests — so raise it if you want more history and lower it ` +
            `if the response is slow.`,
          ph: String(DEFAULT_LIMIT),
          check: (v) => whole(v, 1, 100, "A whole number of posts"),
        },
        noveltyDays: {
          label: "Novelty window (days)",
          hint:
            `How far back the gate looks. Everything this venture made in this ` +
            `format inside the window is put to a MODEL together with the ` +
            `proposed topic, and the model answers whether it is the same piece ` +
            `of work — there is no percentage to set, because "the same video ` +
            `in different words" is not something a word count can decide. ` +
            `Default ${DEFAULT_NOVELTY_DAYS}. It leans towards allowing when ` +
            `the answer is unclear, and it allows when no model can be reached, ` +
            `because a wrong refusal stops the autopilot silently. ZERO ` +
            `SWITCHES THE TOPIC CHECK OFF entirely, which is a real thing to ` +
            `want if you make one post a month. Source videos are NOT affected: ` +
            `a video that has been cut up once is never offered again, whatever ` +
            `this says, because a second short out of the same footage is the ` +
            `same footage.`,
          ph: String(DEFAULT_NOVELTY_DAYS),
          check: (v) => whole(v, 0, 3650, "A whole number of days"),
        },
        /* THERE IS NO `repeatLimit` SETTING, AND ITS REMOVAL IS THE POINT.
           It was the share of a new topic's stems that had to have been used
           before — a dial on a word list, which asked the owner to express
           "these two are the same video" as a number between 0.1 and 1. A
           model answers that in words now. An install that had a value stored
           under the old key simply stops being read: the key is gone from this
           map, so the settings page no longer offers it and nothing loads it. */
        minMinutes: {
          label: "Shortest source video (minutes)",
          hint:
            `A candidate shorter than this is refused before anything is ` +
            `downloaded: it has no moments to cut out of it. Default ` +
            `${DEFAULT_MIN_MINUTES}.`,
          ph: String(DEFAULT_MIN_MINUTES),
          check: (v) => whole(v, 1, 600, "A whole number of minutes"),
        },
        maxMinutes: {
          label: "Longest source video (minutes)",
          hint:
            `A candidate longer than this is refused, because a long download ` +
            `is a long download and nobody is watching it happen. Default ` +
            `${DEFAULT_MAX_MINUTES}. This is the DISCOVERY limit; the shorts ` +
            `pipeline has its own under the Video settings.`,
          ph: String(DEFAULT_MAX_MINUTES),
          check: (v) => whole(v, 1, 600, "A whole number of minutes"),
        },
        probe: {
          label: "Candidates checked with yt-dlp",
          hint:
            "How many of the top candidates get their REAL duration and upload " +
            "date read with yt-dlp before the ranking is settled. Each one is a " +
            "request to somebody else's site and downloads nothing. Default 4; " +
            "zero trusts the search engine's own length string, which is " +
            "sometimes wrong.",
          ph: "4",
          check: (v) => whole(v, 0, 12, "A whole number of candidates"),
        },
        channels: {
          label: "Each venture's own video channel",
          hint:
            "One line per venture, `slug = url`, naming a YouTube channel or " +
            "playlist that business publishes its own long videos on. When one " +
            "is named, discovery searches it as well as the open web, so a " +
            "business is cut from its own footage before a stranger's. Blank " +
            "for every venture that has none, which is the ordinary case. " +
            "Lines beginning `#` are ignored.",
          ph: "acme = https://www.youtube.com/@acme",
          check(value) {
            const lines = value.split(/\n/).map((l) => l.split("#")[0]!.trim()).filter(Boolean);
            const parsed = parseChannels(value);
            const bad = lines.filter((l) => {
              const at = l.indexOf("=");
              if (at < 0) return true;
              return !parsed[l.slice(0, at).trim().toLowerCase()];
            });
            return bad.length
              ? `These lines are not \`slug = https://…\`: ${bad.slice(0, 3).join(" · ")}`
              : null;
          },
        },
        ugcVideoModel: {
          label: "UGC video model",
          hint:
            "The Replicate image-to-video model a UGC job animates its still " +
            "with, as owner/name. THERE IS DELIBERATELY NO DEFAULT: " +
            "image-to-video costs dollars a clip and the price differs by a " +
            "hundredfold between models, so a default here would be a button " +
            "that charges you the first time you press it. LEAVE IT BLANK and " +
            "a UGC job makes a still image, skips the animation and spends " +
            "nothing on video.",
          ph: "",
          check(value) {
            if (!value.trim()) return null;
            return /^[\w.-]+\/[\w.-]+$/.test(value.trim())
              ? null
              : "A Replicate model, as owner/name. Blank skips the animation step entirely.";
          },
        },
        deliverTo: {
          label: "Announce finished work on",
          hint:
            "“telegram” or “off”. When the autopilot's own video finishes, this " +
            "area files it as a DRAFT in the publishing queue and says so on the " +
            "paired Telegram chat. “off” switches off the MESSAGE ONLY — the " +
            "draft is still filed, because that is the half that makes the asset " +
            "usable and it is silent. Telegram is the one channel this box has; " +
            "with no bot paired nothing is sent either way and the delivery row " +
            "says which it was.",
          ph: "telegram",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "telegram" || v === "off" ? null : "Either “telegram” or “off”.";
          },
        },
        ugcSeconds: {
          label: "UGC clip length (seconds)",
          hint:
            `How long the animation is asked to be. Default ` +
            `${DEFAULT_UGC_SECONDS}. Most image-to-video models cap at ten and ` +
            `charge by the second, so this is the cost dial.`,
          ph: String(DEFAULT_UGC_SECONDS),
          check: (v) => whole(v, 1, 20, "A whole number of seconds"),
        },
      },
      /* CONNECTED MEANS "SOMETHING HERE IS SET", the reading `video` and
         `uptime` use: there are no accounts to derive it from and there is no
         credential to verify. It is not a claim that anything can run — the
         three routes answer that, per capability, and each answer is longer
         than a boolean. */
      after(values) {
        upsertPlugin(SOCIALFEED_PLUGIN, Object.values(values).some((v) => (v ?? "").trim().length > 0), null);
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [{ path: "/api/socialfeed", app: socialfeedRoutes }],

  onStart() {
    /*
      THE STORED KEYS FIRST, AND ONLY WHERE THEY DISAGREE.

      `content_history.fingerprint` is a CACHE of a pure function of the topic,
      and on 2026-09-21 that function was REPLACED: the gate stopped scoring
      stem overlap and became a model's judgment, and the column stopped being a
      similarity fingerprint and became `normalise(topic)` — the exact-match key
      behind the one check that is still code. Every row written before that
      holds sorted stems, which nothing will ever equal, so the free
      word-for-word duplicate check would see nothing until this has run. It
      rewrites only the rows that disagree and writes nothing at all on a box
      where nothing changed.
    */
    try {
      const changed = reindex();
      if (changed) console.log(`[socialfeed] re-keyed ${changed} history rows`);
    } catch {
      /* onStart work must not throw. A stale key costs at worst one duplicate
         — `judgeTopic` re-normalises each row it reads anyway — not a boot. */
    }
    startPostsTimer();
    startDelivery();
  },
};
