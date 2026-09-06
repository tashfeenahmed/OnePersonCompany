/**
 * THE SIGNALS AREA: who links here, where these products exist on somebody
 * else's site, and the voice half of the Telegram bridge.
 *
 * WHAT THE THREE HAVE IN COMMON. Every other integration on this box measures
 * something the owner owns — his servers, his Stripe account, his own HTML.
 * Two of these measure the opposite: what the rest of the internet has to say
 * about him, from sources that cost nothing and disagree with each other. The
 * third is not a measurement at all; it is a DOOR, the way Telegram is, and
 * it is filed here because it is the same journey — something arrives from
 * outside and has to be turned into something this box can use.
 *
 * TWO OF THE THREE NEED NO CREDENTIAL, and that is why `connected` is derived
 * from a LIST rather than from an account, exactly as npm's is: with no hosts
 * there is nothing to ask about, and with hosts it works immediately. Voice
 * has optional keys and the same rule one layer along — connected means an
 * endpoint is set, because a local whisper server wants no key and refusing
 * to call the plugin connected without one would make the free arrangement
 * the broken-looking one.
 *
 * ALL THREE ARE ON SLOW CLOCKS. Backlinks and presence go out to strangers'
 * free services at one request at a time; voice's probe costs a request to
 * learn something that changes only when a machine goes down. The scheduler
 * calls all three every thirty minutes and all three answer `fresh` most of
 * the time — the per-host, per-product and per-endpoint clocks are inside the
 * collectors, where a newly added host can be exempted from them.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { backlinkRoutes } from "./backlinks/routes.ts";
import { collectBacklinks } from "./backlinks/collect.ts";
import { parseHosts } from "./backlinks/sources.ts";
import { presenceRoutes } from "./presence/routes.ts";
import { collectPresence } from "./presence/collect.ts";
import { SOURCES, parseProducts } from "./presence/sources.ts";
import { voiceRoutes } from "./voice/routes.ts";
import { collectVoice } from "./voice/collect.ts";
import { normaliseBase, probe, settings, sttConfigured } from "./voice/provider.ts";
import { upsertPlugin } from "../../db.ts";
import type { Skill } from "../../skills/registry.ts";

/* --------------------------------------------------------------- settings */

const backlinksConfig = {
  keys: {
    hosts: {
      label: "Sites",
      hint:
        "The domains whose link profile you want, one per line or separated " +
        "by commas. A url is accepted and reduced to its host — paste what is " +
        "in the address bar. `www.` is stripped, because www.example.com and " +
        "example.com are one site to every source here.",
      ph: "example.com, example.org",
      check(value: string) {
        const raw = value.split(/[\s,]+/).filter(Boolean);
        const hosts = parseHosts(value);
        if (raw.length && !hosts.length)
          return `Not hostnames: ${raw.slice(0, 3).join(", ")}.`;
        if (hosts.length > 25)
          return (
            `That is ${hosts.length} sites. Each one costs a Common Crawl query, ` +
            `up to fifteen Bing calls and twenty-five page fetches a day, so the ` +
            `list is capped at 25 — trim it rather than have the extras silently ` +
            `dropped.`
          );
        return null;
      },
    },
  },
  /* CONNECTED MEANS "THERE IS A LIST", npm's rule: with no hosts the
     collector has nothing to ask about, and with hosts it works immediately
     and without a credential. Bing's key, when that plugin has one, makes the
     answers better; it does not make this one connected. */
  after(values: Record<string, string>) {
    upsertPlugin("backlinks", parseHosts(values.hosts ?? "").length > 0, null);
  },
};

const presenceConfig = {
  keys: {
    products: {
      label: "Products",
      hint:
        "One product per line, as `Name = host`. Both halves are needed and " +
        "neither can be derived from the other: the NAME is what a directory " +
        "would have called it and is the only thing worth looking up, and the " +
        "HOST is what proves a record found that way is yours — without it, any " +
        "stranger's project of the same name would be filed as your listing.",
      ph: "Acme = example.com\nBeacon = example.org",
      check(value: string) {
        const lines = value.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
        const products = parseProducts(value);
        if (lines.length && !products.length)
          return "Each line is `Name = host`, like `Acme = example.com`.";
        if (products.length < lines.length) {
          const bad = lines.find((l) => {
            const [name, host] = l.split("=");
            return !parseProducts(`${name}=${host}`).length;
          });
          return `This line is not \`Name = host\`: “${(bad ?? "").slice(0, 60)}”.`;
        }
        if (products.length > 24)
          return (
            `That is ${products.length} products. Each one costs ${SOURCES.length} ` +
            `requests to other people's free services every day, so the list is ` +
            `capped at 24.`
          );
        return null;
      },
    },
  },
  after(values: Record<string, string>) {
    upsertPlugin("presence", parseProducts(values.products ?? "").length > 0, null);
  },
};

/** The model id fields, which take whatever the endpoint calls it: the only
 *  wrong values are the ones that cannot be an id. */
function modelIdCheck(value: string): string | null {
  if (!value) return null; // cleared means "the default in provider.ts"
  if (value.includes("\n")) return "One id, on one line.";
  if (value.length > 120) return "That is too long to be a model id.";
  return null;
}

function urlCheck(value: string): string | null {
  if (!value) return null; // cleared is a real value: nothing is configured
  return normaliseBase(value)
    ? null
    : "That is not a url this can call — it needs a host, like http://127.0.0.1:8080/v1 or https://api.openai.com/v1.";
}

const voiceConfig = {
  keys: {
    sttUrl: {
      label: "Transcription endpoint",
      hint:
        "An OpenAI-compatible base url whose /audio/transcriptions accepts a " +
        "file — a whisper server on this machine, a box on the LAN, or " +
        "https://api.openai.com/v1. The origin on its own is fine; /v1 is added " +
        "when it is missing. A local server needs no key, which is the whole " +
        "reason the key beside this is optional.",
      ph: "http://127.0.0.1:8080/v1",
      check: urlCheck,
    },
    sttModel: {
      label: "Transcription model",
      hint:
        "The model id to ask for, exactly as the endpoint spells it. Empty " +
        "means `whisper-1`, which is what OpenAI's endpoint and most local " +
        "servers answer to.",
      ph: "whisper-1",
      check: modelIdCheck,
    },
    tts: {
      label: "Speech",
      hint:
        "off, openai or piper. `off` is a real answer and the default: speech " +
        "costs money on a hosted endpoint and disk on a local one, and a " +
        "dashboard that starts talking because it could is one somebody turns " +
        "off entirely. `openai` is any /v1/audio/speech endpoint; `piper` is a " +
        "binary on this machine.",
      ph: "off",
      check(value: string) {
        if (!value) return null;
        return ["off", "openai", "piper"].includes(value)
          ? null
          : `“${value}” is not a speech mode. The three are off, openai and piper.`;
      },
    },
    ttsUrl: { label: "Speech endpoint", hint: "An OpenAI-compatible base url whose /audio/speech returns audio. Only read when Speech is `openai`.", ph: "https://api.openai.com/v1", check: urlCheck },
    ttsModel: { label: "Speech model", hint: "Empty means `tts-1`.", ph: "tts-1", check: modelIdCheck },
    ttsVoice: { label: "Voice", hint: "The voice name the speech endpoint publishes. Empty means `alloy`.", ph: "alloy", check: modelIdCheck },
    piperPath: {
      label: "Piper binary",
      hint:
        "The full path to a piper executable on this machine. Only read when " +
        "Speech is `piper`. Nothing installs it for you, and the voice page " +
        "says so rather than failing the first time somebody speaks.",
      ph: "/opt/homebrew/bin/piper",
      check(value: string) {
        if (!value) return null;
        return value.startsWith("/") ? null : "A full path, starting with /.";
      },
    },
    piperModel: {
      label: "Piper voice",
      hint: "The full path to the .onnx voice piper should read with.",
      ph: "/opt/piper/en_GB-alba-medium.onnx",
      check(value: string) {
        if (!value) return null;
        return value.startsWith("/") ? null : "A full path, starting with /.";
      },
    },
    replyWithVoice: {
      label: "Answer a voice note with a voice note",
      hint:
        "on or off. The text answer is sent either way and always first — the " +
        "words are the answer and the audio is a convenience, so a speech " +
        "endpoint that is down costs a nicety rather than the reply.",
      ph: "off",
      check(value: string) {
        if (!value) return null;
        return value === "on" || value === "off" ? null : "on or off.";
      },
    },
  },
  /* CONNECTED MEANS AN ENDPOINT IS SET. Whether it ANSWERS is the collector's
     sentence, and the two are kept apart everywhere — see voice/collect.ts. */
  after() {
    upsertPlugin("voice", sttConfigured(), null);
  },
};

/* ------------------------------------------------------------------ skills */

const skills: Skill[] = [
  {
    id: "backlinks",
    title: "Backlinks — who links to these sites, and who says so",
    plugins: ["backlinks"],
    about:
      "Per host, one row per source: Common Crawl's crawl presence, Bing " +
      "Webmaster's inbound-link index, and a verification crawler that fetches " +
      "the pages the others named and looks. Every figure carries the source " +
      "that produced it and that source's confidence (0.95 crawler, 0.70 Bing, " +
      "0.50 Common Crawl). Collected once a day per host.",
    rules: [
      "NEVER ADD TWO SOURCES TOGETHER. They overlap, they disagree by design, " +
        "and `referringDomains.combined` is null with the reason on it. Quote a " +
        "number with the source that said it, every time.",
      "Host IN-DEGREE — how many sites link to this one across the whole web — " +
        "is NOT MEASURED and no figure here is a proxy for it. Common Crawl's " +
        "graph has no query endpoint; what it contributes is crawl presence, " +
        "which is how many pages of the domain its index captured.",
      "`ok: false` is a source that refused and `ok: null` is one that was never " +
        "asked (no Bing account connected, no index resolved). A count of 0 with " +
        "`ok: true` is a real measurement of nothing — Bing genuinely knowing of " +
        "no linking page — and must not be reported as missing data.",
      "A link with `live: null` was not checked: only the verification crawler " +
        "can say whether a link is still on a page, and a 403 from a WAF is a " +
        "null rather than a removed link.",
      "The verification crawler only visits pages another source named. A host " +
        "with no verified links usually means nothing claimed a link to it, not " +
        "that its links are gone.",
    ],
    views: [
      {
        key: "default",
        path: "/api/backlinks",
        about: "Per host, per source: referring domains, inbound links, linked pages, crawl presence, verified links.",
        params: [],
      },
    ],
    asks: [
      "Who links to my main site, and how sure are we?",
      "Are the links anybody claims for this site still live and followed?",
    ],
  },
  {
    id: "presence",
    title: "Presence — where these products exist on somebody else's site",
    plugins: ["presence"],
    about:
      `A matrix of product × source over ${SOURCES.length} sources: Wikipedia, ` +
      "Wikidata, GitHub, PyPI, the App Store, Hacker News, Product Hunt, G2 and " +
      "Capterra. Each cell is present, absent, blocked or error, with the url " +
      "and the kind of evidence behind it. Checked once a day per product.",
    rules: [
      "`blocked` IS NOT `absent`. It means the source could not be asked — a " +
        "403, a rate limit, a timeout, or a directory with no keyless lookup. " +
        "Report it as “not checked”. Saying a product is unlisted because a WAF " +
        "answered is the single worst mistake available here.",
      "`present` from GitHub, PyPI, the App Store or Hacker News requires the " +
        "record to NAME the brand AND POINT BACK at the product's host. A record " +
        "that only names it is stored as a CANDIDATE on an `absent` row — half " +
        "these names are two ordinary English words and strangers own projects " +
        "with the same ones.",
      "The G2 and Product Hunt checks fetch the url that product NAME would be " +
        "at. An `absent` from them is a statement about that url, not about the " +
        "site: a listing under a different slug is not found.",
      "Nothing here is a submission and nothing counts as done. A found page is " +
        "evidence for the owner to confirm.",
      "There is no footprint score. The original collector's score is mostly a " +
        "search sweep this port deliberately does not carry, and a score built " +
        "from what is left would be a different number wearing the same name.",
    ],
    views: [
      {
        key: "default",
        path: "/api/presence",
        about: "The product × source matrix, with per-product counts of present, absent, blocked and unchecked.",
        params: [],
      },
    ],
    asks: [
      "Which of my products has an encyclopedia entry or a directory page?",
      "Where is my product listed, and which directories could not be checked?",
    ],
  },
  {
    id: "voice",
    title: "Voice — transcription in, speech out",
    plugins: ["voice"],
    about:
      "The speech path behind the Telegram bridge: an OpenAI-compatible " +
      "transcription endpoint, an optional speech endpoint, and whether ffmpeg " +
      "is on this machine to make a Telegram voice note out of what comes back. " +
      "Reports what is configured, the median transcription latency in " +
      "milliseconds, and the last twenty attempts.",
    rules: [
      "`connected` means an endpoint is SET, not that it answered. The probe " +
        "result and the run rows say whether it answers.",
      "An empty transcript is a SUCCESS, not a failure: silence transcribes to " +
        "nothing, and the health probe is half a second of it.",
      "No word that was said and no byte that was heard is stored. The rows are " +
        "timings and outcomes; a transcript goes into the chat transcript where " +
        "the typed message would have gone.",
      "`speak` returns a PATH and an id, never audio. The bytes are one GET away " +
        "at /api/voice/clip/<id>.<format>, and a clip may be deleted after it has " +
        "been sent.",
    ],
    views: [
      { key: "default", path: "/api/voice", about: "What is configured, what it can do, latency and the last attempts.", params: [] },
    ],
    actions: [
      {
        key: "speak",
        method: "POST",
        path: "/api/voice/speak",
        about:
          "Turn text into an audio clip on this machine and return where it is. " +
          "Refused with a sentence when speech is off, which is the default.",
        params: [
          { name: "text", type: "string", required: true, about: "What to say. Up to 4,000 characters.", in: "body" },
        ],
      },
    ],
    asks: [
      "Is the voice path working, and how long does a transcription take?",
      "Read this answer out loud.",
    ],
  },
];

/* ---------------------------------------------------------------- manifest */

export const manifest: IntegrationManifest = {
  id: "signals",

  plugins: {
    /*
      VOICE — TWO OPTIONAL KEYS AND NO REQUIRED ONE, which is unusual enough
      to say why. A whisper server on this machine or on the LAN wants no
      Authorization header at all, and sending an empty bearer token to one
      that does not expect it is how a working endpoint starts refusing. So
      both fields are optional, an absent key means the header is not sent,
      and what is verified is the ENDPOINT rather than the credential: half a
      second of silence posted to /audio/transcriptions, which must come back
      as JSON with a `text` field in it.

      The field keys are camel-cased because that is what the settings beside
      them are called and the pair reads as one integration; the vault entries
      they land in are dashed like every other one here, through `stems`.
    */
    voice: {
      secret: "voice",
      fields: ["sttKey", "ttsKey"],
      optional: ["sttKey", "ttsKey"],
      stems: { sttKey: "voice-stt-key", ttsKey: "voice-tts-key" },
      async verify(values) {
        const s = settings();
        if (!normaliseBase(s.sttUrl))
          return (
            "There is no transcription endpoint to check the key against. Set " +
            "`sttUrl` in this plugin's settings first — a local whisper server " +
            "needs no key at all, and this field can stay empty for one."
          );
        if ((values.sttKey ?? "").includes("\n") || (values.ttsKey ?? "").includes("\n"))
          return "That is more than one line. One key per field here.";
        /* THE PASTED KEY IS HANDED STRAIGHT TO THE PROBE rather than read
           back from the vault, because verify runs BEFORE anything is
           written — which is the property that lets a refused credential
           leave nothing behind. An empty field is passed as null and means
           "send no Authorization header at all", which is exactly what a
           local whisper server wants. */
        const got = await probe((values.sttKey ?? "").trim() || null);
        return got.ok
          ? null
          : `The transcription endpoint refused a half-second silent probe: ${got.error}`;
      },
    },
  },

  config: {
    backlinks: backlinksConfig,
    presence: presenceConfig,
    voice: voiceConfig,
  },

  collectors: {
    backlinks: collectBacklinks,
    presence: collectPresence,
    voice: collectVoice,
  },

  routes: [
    { path: "/api/backlinks", app: backlinkRoutes },
    { path: "/api/presence", app: presenceRoutes },
    { path: "/api/voice", app: voiceRoutes },
  ],

  skills,

  packs: {
    backlinks: { name: "backlink-profile", category: "marketing" },
    presence: { name: "off-site-presence", category: "marketing" },
    voice: { name: "voice", category: "communication" },
  },
};
