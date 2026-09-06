import { Hono } from "hono";
import { hasSettings } from "./pluginConfig.ts";
import { allPlugins, getPlugin, recentRuns, upsertPlugin } from "../db.ts";
import * as vault from "../vault.ts";
import * as accounts from "../accounts.ts";
import * as hetzner from "../providers/hetzner.ts";
import * as dynadot from "../providers/dynadot.ts";
import * as spaceship from "../providers/spaceship.ts";
import * as openai from "../providers/openai.ts";
import * as openrouter from "../providers/openrouter.ts";
import * as replicate from "../providers/replicate.ts";
import * as github from "../providers/github.ts";
import * as stock from "../providers/stock.ts";
import * as stripe from "../providers/stripe.ts";
import * as adsense from "../providers/adsense.ts";
import * as appstore from "../providers/appstore.ts";
import * as play from "../providers/play.ts";
import * as gsc from "../providers/gsc.ts";
import * as bing from "../providers/bing.ts";
import * as cloudflare from "../providers/cloudflare.ts";
import * as meta from "../providers/meta.ts";
/* Mail's two doors. Two entries rather than one, because they are two
   credentials with two failure states — and because Resend's is the one door
   here that is opened eleven times, once per sending domain. */
import * as gmail from "../providers/gmail.ts";
import * as resend from "../providers/resend.ts";
/* The two chat agents. Imported for `verify` alone — the ChatBackend each of
   them registers is a side effect of the same import, and index.ts is where
   that ordering is spelled out. */
import * as hermes from "../providers/hermes.ts";
import * as openclaw from "../providers/openclaw.ts";
import * as searxng from "../providers/searxng.ts";
/* The model gateway. Imported for `verify` and for the two constants the help
   text quotes; registering it as a model provider is a side effect of the same
   import, and index.ts is where that ordering is spelled out. */
import * as freellmapi from "../providers/freellmapi.ts";
/* THE THREE MODEL PROVIDERS' VERIFIERS. `local` is a plugin of its own; the
   other two are a SECOND, optional credential on plugins that already exist —
   an inference key beside the key that reads the bill. Imported for `verify`
   alone, exactly as the two chat agents above are; the ModelProvider each of
   them registers is a side effect of routes/models.ts's import, not this
   one's. */
import * as localModels from "../providers/local.ts";
import * as openaiChat from "../providers/openai-chat.ts";
import * as openrouterChat from "../providers/openrouter-chat.ts";
import * as demand from "../providers/demand.ts";
import * as telegram from "../providers/telegram.ts";
import { configValue } from "../db.ts";
import { COLLECTORS as BUILTIN_COLLECTORS } from "../collector.ts";
import { manifestCollectors, manifestPlugins } from "../integrations/index.ts";
import type { PluginRegistryEntry } from "../integrations/manifest.ts";

/* The built-in collectors plus every integration area's — see
   integrations/manifest.ts. */
const COLLECTORS: Record<string, () => Promise<{ ok: boolean; error?: string | null }>> = {
  ...BUILTIN_COLLECTORS,
  ...manifestCollectors(),
};

export const plugins = new Hono();

/**
 * The naming scheme, written down once and never typed by hand:
 *
 *     one field   ->  secretName                (hetzner-token)
 *     many fields ->  secretName-fieldKey       (linkedin-client-id)
 *
 * and, from the SECOND account of a plugin onwards, `#<account id>` after
 * that — see accounts.ts, which owns the derivation because it owns the rule
 * that an entry name can never change once a value is sealed under it.
 *
 * A field outside the registry below is refused. This is a CLOSED REGISTRY for
 * the same reason the previous system's was: a route that can write any name
 * into the vault is a route that can overwrite the Hetzner token with a typo.
 *
 * `verify` is called for EVERY account, every time credentials are stored,
 * including the second and the fifth. That is the load-bearing behaviour here:
 * a token refused at the point it was pasted is a typo; a token stored
 * unchecked is a silently empty dashboard an hour later, and with several
 * accounts it is worse — a quietly missing third of the fleet reads as a
 * fleet, because the other two thirds are right.
 */
const BUILTIN: Record<
  string,
  PluginRegistryEntry> = {
  hetzner: {
    secret: "hetzner-token",
    fields: ["token"],
    async verify(values) {
      const toks = hetzner.parseTokens(values.token ?? "");
      if (!toks.length) return "Paste a read-only API token.";
      /*
        ONE TOKEN PER ACCOUNT. This used to accept a column of them and split
        on newlines, which is why an owner may well paste one — the old habit
        is worth recognising rather than sealing as a single very long bearer
        token that Hetzner would refuse tomorrow. It is refused with the thing
        to do instead, because turning one paste into three accounts silently
        would name three projects for the owner rather than letting them.
      */
      if (toks.length > 1)
        return (
          `That looks like ${toks.length} tokens. A Hetzner token is scoped to ` +
          `one project, so each one is its own account here — add them one at ` +
          `a time and give each the project's name.`
        );
      const res = await hetzner.verify(toks[0]!);
      return res.ok ? null : res.error;
    },
  },

  /*
    THE TWO REGISTRARS. Both take a key and a signing secret, and both are
    verified as a PAIR rather than a key at a time — neither half proves
    anything alone, and "the key is fine but the secret is not" is a sentence
    only the provider can say. The field keys are `key` and `secret`, so the
    naming scheme above writes exactly `dynadot-key` / `dynadot-secret` and
    `spaceship-key` / `spaceship-secret` for the first account — the same four
    entry names the previous system's own vault uses, which is what makes
    moving the credentials across a copy rather than a migration.
  */
  dynadot: {
    secret: "dynadot",
    fields: ["key", "secret"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      const secret = (values.secret ?? "").trim();
      if (!key) return "Paste the API key from Dynadot → Tools → API.";
      if (!secret)
        return "Dynadot signs every RESTful v2 request, so the API secret is required too — a key on its own reads nothing.";
      const res = await dynadot.verify({ key, secret });
      return res.ok ? null : res.error;
    },
  },

  spaceship: {
    secret: "spaceship",
    fields: ["key", "secret"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      const secret = (values.secret ?? "").trim();
      if (!key) return "Paste the API key from Spaceship → Account → API manager.";
      if (!secret) return "The secret is issued alongside the key and both go in.";
      const res = await spaceship.verify({ key, secret });
      return res.ok ? null : res.error;
    },
  },

  /*
    THE THREE COST PROVIDERS. Each takes one credential, and for each of them
    the WRONG SORT of credential is the failure worth catching here rather
    than an hour later: OpenAI answers its organization API only to an admin
    key, and OpenRouter answers /activity and /keys only to a management key.
    Both would otherwise connect happily — one showing an empty month, the
    other a balance with nothing behind it — which is the most expensive shape
    of failure this dashboard has, because it looks like an answer.

    Each field key is the only one its plugin has, so the naming scheme above
    writes the plain names `openai-admin-key`, `openrouter-key` and
    `replicate-token` for the first account: the same three names the previous
    system's own vault uses, which makes moving a credential across a copy
    rather than a translation.
  */
  /*
    OPENAI AND OPENROUTER EACH HOLD TWO KEYS NOW, AND THEY ARE NOT
    INTERCHANGEABLE. Probed on 2026-09-05, with the keys already in this
    vault, and the answers are the reason the second field exists:

      openai   sk-admin-…  POST /v1/chat/completions
               401 "You have insufficient permissions for this operation.
                    Missing scopes: model.request."   code missing_scope
               …and GET /v1/models 403 "Missing scopes: api.model.read."

      openrouter  management key   POST /api/v1/chat/completions
               401 {"error":{"message":"User not found.","code":401}}

    So the key that reads the bill cannot ask the model a question, on both
    services, for two unrelated reasons. `chat-key` is the second credential —
    a project key on OpenAI, an ordinary inference key on OpenRouter — and it
    is OPTIONAL, because the costs collectors were working before it existed
    and must go on working for an owner who never wants to complete through
    either. Neither collector reads it and nothing here changes what they read.
  */
  openai: {
    secret: "openai-admin-key",
    fields: ["key", "chat-key"],
    optional: ["chat-key"],
    /* So the two entries read `openai-admin-key` and `openai-chat-key` rather
       than `openai-admin-key-key` and `openai-admin-key-chat-key`. */
    stems: { "chat-key": "openai-chat-key" },
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key)
        return "Paste an org admin key (sk-admin-…) from Settings → Organization → Admin keys.";
      if (key.includes("\n"))
        return "That is more than one line. One key per account here.";
      const res = await openai.verify(key);
      if (!res.ok) return res.error;
      /* Only when one has been typed. An account that holds the bill and no
         inference key is a complete, working account. */
      const chatKey = (values["chat-key"] ?? "").trim();
      if (chatKey) {
        const inference = await openaiChat.verifyChatKey(chatKey);
        if (!inference.ok) return inference.error;
      }
      return null;
    },
  },

  openrouter: {
    secret: "openrouter-key",
    fields: ["key", "chat-key"],
    optional: ["chat-key"],
    stems: { "chat-key": "openrouter-chat-key" },
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key)
        return "Paste a MANAGEMENT key from openrouter.ai → Settings → Keys. An inference key connects and then shows nothing.";
      if (key.includes("\n"))
        return "That is more than one line. One key per account here.";
      const res = await openrouter.verify(key);
      if (!res.ok) return res.error;
      const chatKey = (values["chat-key"] ?? "").trim();
      if (chatKey) {
        const inference = await openrouterChat.verifyChatKey(chatKey);
        if (!inference.ok) return inference.error;
      }
      return null;
    },
  },

  /*
    LOCAL MODELS — ONE PLUGIN FOR EVERY OpenAI-COMPATIBLE SERVER ON THIS
    MACHINE OR THIS NETWORK, and one account per endpoint.

    Ollama, LM Studio, vLLM, llama.cpp's server and a hand-rolled FastAPI all
    answer the same two paths, and the differences between them are in what
    they run rather than in how they are asked — so a plugin per product would
    be six plugins holding one adapter, and a seventh the day somebody ships a
    new runner. The product's name is what the owner types in the label.

    THIS IS THE ONE CREDENTIAL HERE THAT MAY BE HALF EMPTY. A loopback runner
    has no auth to paste, and searxng's entry two hundred lines below makes the
    same argument about a managed instance: a key checked by this process
    against a value this process generated is a password on a door in a locked
    room. So the key is optional — and providers/local.ts refuses an EMPTY one
    against a host outside the owner's own network, and refuses to send a
    non-empty one over plain http to such a host at all.

    Several accounts are several MACHINES, and unlike every other plugin here
    they all answer: the limiter in models/provider.ts spreads completions
    across them under the provider's balance setting. That is the one place in
    this codebase where "more accounts" means throughput rather than coverage.
  */
  local: {
    /* Stem plus field key, so the first endpoint's entries are exactly
       `local-base-url` and `local-key`. */
    secret: "local",
    fields: ["base-url", "key"],
    optional: ["key"],
    async verify(values) {
      const baseUrl = (values["base-url"] ?? "").trim();
      const key = (values.key ?? "").trim();
      if (!baseUrl)
        return (
          "Paste the endpoint's base URL. Ollama is http://127.0.0.1:11434/v1, " +
          "LM Studio http://127.0.0.1:1234/v1, vLLM http://127.0.0.1:8000/v1 — " +
          "the origin on its own is fine, /v1 is added when it is missing."
        );
      if (key.includes("\n"))
        return "That is more than one line. One key per endpoint here.";
      if (/^https?:\/\//i.test(key))
        return "That is a URL, not a key. The endpoint goes in the base URL field.";
      const res = await localModels.verify({ baseUrl, key });
      return res.ok ? null : res.error;
    },
  },

  replicate: {
    secret: "replicate-token",
    fields: ["token"],
    async verify(values) {
      const token = (values.token ?? "").trim();
      if (!token)
        return "Paste the API token (r8_…) from replicate.com/account/api-tokens.";
      if (token.includes("\n"))
        return "That is more than one line. One token per account here.";
      const res = await replicate.verify(token);
      return res.ok ? null : res.error;
    },
  },

  /*
    GITHUB. One token per ACCOUNT, because a token belongs to exactly one
    GitHub identity — a work login and a personal one are two accounts here,
    the same way two Hetzner projects are.

    Verified against /user before it is stored, which does double duty: it
    refuses a typo at the point it was made, and it comes back with the LOGIN
    the token belongs to, which is the natural name for the account row.

    The token is what buys the second tier. Without one the public repo list is
    still readable — stars, forks, last push — but per-repo traffic (views,
    unique visitors, clones, referrers) needs PUSH access to each repo, so it
    cannot be had anonymously at any rate limit. That is the sentence the help
    text on the plugin page carries.
  */
  github: {
    secret: "github-token",
    fields: ["token"],
    async verify(values) {
      const token = (values.token ?? "").trim();
      if (!token)
        return "Paste a personal access token from github.com/settings/tokens.";
      if (token.includes("\n"))
        return (
          "That is more than one line. A token belongs to one GitHub account, " +
          "so each one is its own account here — add them one at a time."
        );
      const res = await github.verify(token);
      return res.ok ? null : res.error;
    },
  },

  /*
    THE TWO STOCK LIBRARIES. One key each, no signing — and verification that is
    itself a search, because neither service publishes a "is this key valid"
    endpoint. The only way to find out is to spend one request from the very
    allowance the check reports.

    That is not a detail: it is the reason these two collect on a six-hour clock
    rather than the usual half hour. See STOCK_EVERY_HOURS in collector.ts.
  */
  pexels: {
    secret: "pexels-key",
    fields: ["key"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key) return "Paste the key from Pexels → Image & Video API.";
      const res = await stock.verify("pexels", key);
      return res.ok ? null : res.error;
    },
  },

  /*
    STRIPE. One restricted key per account, and the READ permissions are the
    thing worth naming: Balance, Balance transactions, Charges, Subscriptions,
    Prices, Invoices and Payouts. A key missing one of them connects happily
    and then reports an MRR of nothing or a net revenue that is null — which is
    the most expensive shape of failure this dashboard has, because it looks
    like an answer. `verify` therefore asks the two endpoints everything else
    rests on rather than the cheapest one.

    The key is LIVE. Nothing in the provider sends a request body or a method
    other than GET, so a write key's extra power is never used — but a
    restricted key is still the right thing to paste, because a credential that
    cannot refund a customer cannot be made to.
  */
  stripe: {
    secret: "stripe-key",
    fields: ["key"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key)
        return "Paste a restricted key (rk_live_…) from Stripe → Developers → API keys, with READ access to Balance, Balance transactions, Charges, Subscriptions, Prices, Invoices and Payouts.";
      if (key.includes("\n"))
        return "That is more than one line. A Stripe key belongs to one account, so each one is its own account here.";
      if (key.startsWith("pk_"))
        return "That is a publishable key. It can create a payment in a browser and read nothing at all; this needs a secret or restricted key.";
      const res = await stripe.verify(key);
      if (!res.ok) return res.error;
      /*
        A TEST-MODE KEY IS REFUSED RATHER THAN STORED. It would connect, walk a
        test account, and put an invented MRR on a revenue dashboard — sample
        data wearing a live dot, which is the one thing this codebase will not
        do. The owner is told which key this is instead.
      */
      if (!res.livemode)
        return "That is a TEST-mode key. It reads a test account, and its figures would appear on the dashboard as real revenue.";
      return null;
    },
  },

  /*
    GOOGLE ADSENSE — THREE FIELDS, BECAUSE OAUTH NEEDS THREE.

    There is no key to paste here and there never was: AdSense is OAuth2, and
    the only credential that works without a human present is a REFRESH TOKEN,
    which can only be minted by that human approving a consent screen in a
    browser signed in as the AdSense account owner. The client id and secret
    identify the Cloud app the token was minted under, and Google refuses a
    refresh grant that does not carry all three — which is why they are
    verified as a SET, exactly as the registrars' key-and-secret pairs are.

    The previous system keeps these as one `adsense-token.json` document in
    its vault.
    Here they are three entries, because this vault stores FIELDS: a JSON blob
    in a secret is a document that has to be parsed before anything can be
    checked, and a typo inside it fails as "the grant was refused" rather than
    as "the client secret is missing".
  */
  adsense: {
    secret: "adsense",
    fields: ["client-id", "client-secret", "refresh-token"],
    async verify(values) {
      const clientId = (values["client-id"] ?? "").trim();
      const clientSecret = (values["client-secret"] ?? "").trim();
      const refreshToken = (values["refresh-token"] ?? "").trim();
      if (!clientId)
        return "Paste the OAuth client ID from Google Cloud → APIs & Services → Credentials (a Desktop app client).";
      if (!clientSecret)
        return "The client secret is issued with the client ID and Google refuses a refresh grant without it.";
      if (!refreshToken)
        return "Paste the refresh token minted for scope adsense.readonly, with access_type=offline and prompt=consent, signed in as the AdSense account owner.";
      const res = await adsense.verify({ clientId, clientSecret, refreshToken });
      return res.ok ? null : res.error;
    },
  },

  pixabay: {
    secret: "pixabay-key",
    fields: ["key"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key)
        return "Paste the key from Pixabay → API docs — it is shown there when you are signed in.";
      const res = await stock.verify("pixabay", key);
      return res.ok ? null : res.error;
    },
  },

  /*
    THE TWO APP STORES, AND THE ONE THING THEY HAVE IN COMMON: a credential is
    not enough on its own. Apple's report endpoints need a VENDOR NUMBER that
    is not in the API and is not in the key — it is printed on the Payments and
    Financial Reports page — and Google's reports live in a bucket named after
    the DEVELOPER ACCOUNT, which the service account JSON says nothing about.
    Both are identifiers rather than secrets, so both are `kind: "text"` in the
    catalog and both are echoed back on /api/mobile: a write-only field nobody
    can read back is a field that eventually holds a typo forever, and a wrong
    vendor number is the one failure here that produces a permanently empty
    board with no error anywhere to explain it.

    Both verifiers therefore make TWO calls. One proves the credential; the
    other proves the identifier the credential does not carry.
  */
  appstore: {
    secret: "asc",
    fields: ["key-id", "issuer-id", "vendor", "key.p8"],
    async verify(values) {
      const keyId = (values["key-id"] ?? "").trim();
      const issuerId = (values["issuer-id"] ?? "").trim();
      const vendor = (values.vendor ?? "").trim();
      const p8 = values["key.p8"] ?? "";
      if (!keyId) return "The Key ID is on the API keys row in Users and Access → Integrations.";
      if (!issuerId)
        return "The Issuer ID is above the key list on the same page — one per team.";
      if (!vendor)
        return "The vendor number is on Payments and Financial Reports, not in the API. Sales and finance reports cannot be read without it.";
      if (!p8.includes("PRIVATE KEY"))
        return "Paste the .p8 file whole, including its BEGIN and END lines. Apple shows it once.";
      /*
        The field key is `key.p8` for one reason: with several fields the entry
        name is `<stem>-<field>`, so this writes `asc-key.p8` — the exact name
        the previous system's own vault uses, which makes moving the
        credential across a copy rather than a translation.
      */
      const res = await appstore.verify({ keyId, issuerId, vendor, p8 });
      return res.ok ? null : res.error;
    },
  },

  /*
    THE TWO SEARCH ENGINES, AND THE ONE THING EACH VERIFIER HAS TO PROVE
    BEYOND THE CREDENTIAL: that it can see anything.

    A Google service account with no property granted to it, and a Bing account
    with no verified site, both authenticate perfectly and then report an empty
    dashboard — the most expensive shape of failure here, because it looks like
    an answer rather than a mistake. So neither verifier stops at "the key is
    real": each asks for the list of things the credential is supposed to
    reach, and refuses one that reaches nothing with the sentence that says
    where to go and what to add.

    The entry names are `gsc-key.json` and `bing-key` — the names the previous
    system's own vault uses, which makes moving either credential a copy
    rather than a translation. Each plugin has one field, so the naming
    scheme above writes the plain stem.
  */
  gsc: {
    secret: "gsc-key.json",
    fields: ["json"],
    async verify(values) {
      const json = values.json ?? "";
      if (!json.trim())
        return "Paste the service account JSON key from Google Cloud → IAM → Service accounts.";
      const res = await gsc.verify(json);
      return res.ok ? null : res.error;
    },
  },

  "bing-webmaster": {
    secret: "bing-key",
    fields: ["key"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key)
        return "Paste the API key from Bing Webmaster Tools → Settings → API access. It is free.";
      if (key.includes("\n"))
        return "That is more than one line. A Bing key covers every site one account has verified, so one key per account here.";
      const res = await bing.verify(key);
      return res.ok ? null : res.error;
    },
  },

  playstore: {
    /* Stem plus field key, so the first account's entries are exactly
       `play-key.json` and `play-developer-id`. */
    secret: "play",
    fields: ["key.json", "developer-id"],
    async verify(values) {
      const json = values["key.json"] ?? "";
      const developerId = (values["developer-id"] ?? "").trim();
      if (!json.trim())
        return "Paste the service account JSON key from Google Cloud → IAM → Service accounts.";
      if (!developerId)
        return "The developer id names the reports bucket — it is in the URL on Play Console → Download reports, as pubsite_prod_<id>.";
      const res = await play.verify(json, developerId);
      return res.ok ? null : res.error;
    },
  },

  /*
    CLOUDFLARE — ONE TOKEN, AND THE SMALLEST ONE THAT WORKS.

    The scope this integration wants is Zone → Zone → Read plus Zone → DNS →
    Read, and it wants NOTHING else. A token that can edit zone settings or
    deploy a Pages project is a token that can take every site on the account
    down, and a dashboard has no business holding one — so the help text asks
    for read, the provider only ever sends GET and POST-to-GraphQL, and every
    permission the token turns out not to have is reported as a gap rather than
    quietly worked around.

    VERIFIED WITH TWO CALLS, because "the token exists" and "the token can read
    a zone" are different facts and only the second one matters.
    `/user/tokens/verify` answers 200 for a token scoped to nothing at all, so
    a token that passed only that check would connect happily and then show an
    empty board for a reason nothing on the page could state.
  */
  cloudflare: {
    secret: "cf-token",
    fields: ["token"],
    async verify(values) {
      const token = (values.token ?? "").trim();
      if (!token)
        return "Paste an API token from dash.cloudflare.com/profile/api-tokens, scoped to Zone → Read and DNS → Read.";
      if (token.includes("\n"))
        return "That is more than one line. A Cloudflare token belongs to one account, so each one is its own account here.";
      const res = await cloudflare.verify(token);
      return res.ok ? null : res.error;
    },
  },

  /*
    META — ONE TOKEN FOR THE PAGES AND THE ADS, AND AN APP PAIR BESIDE IT.

    The stem is `meta` and the field keys are `token` and `app`, so the naming
    scheme above writes exactly `meta-token` and `meta-app` for the first
    account — the two names the previous system's own vault already uses,
    which makes moving these a copy rather than a translation.

    BOTH ENTRIES ARE COMMENT-ANNOTATED FILES over there, and that is the
    failure this verify exists to catch at the point it happens. Sealed whole
    and sent as a bearer token, a file with a `# what this is` line above the
    secret produces OAuthException 190 "Bad signature" — which reads exactly
    like a revoked credential and sends the owner to mint a replacement for a
    token that was never wrong. The comment lines are stripped here, before the
    value is ever offered to Meta, and 190 is answered with that sentence.

    `meta-app` IS NOT AN APP ID, despite what the field used to be labelled. It
    is `app_id:app_secret` — the shape collect_social.py partitions on — so it
    is a SECRET, and what it buys is `appsecret_proof` on every call. It is
    optional on this door: the token reads everything without it, an account
    stored with only a token connects and works, and the wire says its calls
    are unproofed rather than pretending otherwise.

    VERIFIED WITH THREE CALLS rather than one, because "the token exists" and
    "the token can read anything" are different facts — /me answers 200 for a
    token scoped to nothing at all, and a credential that passed only that
    check would connect happily and then show an empty board for a reason
    nothing on the page could state.
  */
  meta: {
    secret: "meta",
    fields: ["token", "app"],
    async verify(values) {
      const token = meta.parseLines(values.token ?? "")[0] ?? "";
      if (!token)
        return (
          "Paste a Meta access token. A system user token from Business " +
          "settings → System users → Generate token, with pages_show_list, " +
          "pages_read_engagement and ads_read."
        );
      if (meta.parseLines(values.token ?? "").length > 1)
        return (
          "That is more than one token. Each Meta token sees its own set of " +
          "Pages and ad accounts, so each one is its own account here — add " +
          "them one at a time and name each for what it reaches."
        );
      /*
        A NON-EMPTY APP THAT IS NOT A PAIR IS REFUSED HERE, not silently
        ignored. Storing a bare app id under `meta-app` would leave the owner
        believing the calls are proofed while every one of them goes out
        unsigned, which is the quietest way to have a security control that
        does not exist.
      */
      const appRaw = values.app ?? "";
      if (appRaw.trim() && !meta.parseApp(appRaw))
        return (
          "`meta-app` is `app_id:app_secret` on one line — the id and the " +
          "secret from developers.facebook.com → the app → Settings → Basic, " +
          "joined by a colon. An app id on its own signs nothing."
        );
      const res = await meta.verify(token, appRaw);
      return res.ok ? null : res.error;
    },
  },

  /*
    SEARXNG — ONE KEY, AND A URL THAT IS NOT A SECRET AND NOT A CONSTANT.

    The node is self-hosted on the owner's own box and its hostname carries
    that box's IP, so the address is a SETTING (`plugin_config`, read back on
    the plugin page) while the key is a credential. Verification needs both, so
    this reads the setting on its way past: a key checked against the default
    host when the owner has pointed the plugin somewhere else would be a key
    refused for the wrong reason entirely.

    THE KEY IS A HEADER AND ONLY A HEADER. Probed on 2026-09-04: `?key=…` is
    401 and `x-api-key:` is 200. That is also the better door — a key in a URL
    is a key in an access log — and it is why nothing here ever builds a URL
    with a credential in it.

    Verified with a real search, because there is no validate-this-key
    endpoint: every path on the node, /healthz included, answers 401 without
    it. A node that answers with a key but has every engine refusing is
    refused HERE, with the engines' own words, rather than connecting happily
    and returning nothing for every agent search afterwards.

    AND AN EMPTY KEY IS A REAL ANSWER WHEN THE ENDPOINT IS LOOPBACK. The 401
    above is the reverse proxy in front of the owner's public node, not
    SearXNG: the program has no key auth. An instance this box installed and
    runs itself binds to 127.0.0.1, which is the whole of its access control —
    so demanding a key for it would mean inventing one, storing it, and
    checking it against ourselves. The refusal is kept for every other URL,
    because "I left the key box empty" against somebody else's host is a
    mistake and not a configuration.

    THAT DOOR IS FOR A SCRIPT AND NOT FOR THE PANEL. "Install here" connects
    through searxng/instance.ts, which writes NO credential at all and
    therefore leaves a remote key sealed exactly where it was — which is what
    makes switching back to the remote node a one-field change. A `PUT` with an
    empty key is the other way in, and it means here what it means for every
    plugin: these are the credentials now, replacing whatever the account held.
  */
  searxng: {
    secret: "searxng-key",
    fields: ["key"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      const configured = configValue("searxng", "url") ?? "";
      if (configured && !searxng.normalise(configured))
        return `The search endpoint setting (${configured}) is not a URL this can call. Fix it in Settings first.`;
      const url = searxng.endpoint();
      if (!key && !searxng.isLoopback(url))
        return "Paste the API key the SearXNG instance was configured with — it travels as an x-api-key header, never in the URL.";
      if (key.includes("\n"))
        return "That is more than one line. One key per node here.";
      const res = await searxng.verify(url, key);
      return res.ok ? null : res.error;
    },
  },

  /*
    REDDIT — A CREDENTIAL THAT IS OPTIONAL, WHICH IS THE ONLY ONE HERE.

    There is no API key to be had: self-serve app registration closed in
    November 2025 and the anonymous .json endpoints were deprecated in May
    2026. What is still open is the Atom search feed, which answers anonymously
    at ONE QUERY A MINUTE — measured, from its own `x-ratelimit-remaining: 0.0`
    and a reset counting down to the next minute boundary.

    And there is one way out of that throttle that needs no developer app:
    every Reddit ACCOUNT has a personal RSS token at reddit.com/prefs/feeds,
    and a search URL carrying its `user` and `feed` parameters is served
    without the anonymous counter — probed on 2026-09-04, two queries eight
    seconds apart, both 200, no rate-limit headers at all.

    So this plugin works with or without a credential and the difference is
    wall clock: with the token a collection asks the whole watch list, without
    it one phrase. Being CONNECTED therefore does not mean holding this — it
    means having a list to search for, which is npm's rule and is written down
    in routes/pluginConfig.ts.

    IT IS A SECRET RATHER THAN A TEXT FIELD, despite looking like a URL. It is
    a bearer credential for one Reddit account's own feeds: anybody holding it
    can read that account's front page. `kind: "secret"` on the catalog side,
    the vault on this one.

    Verified against the live feed, and a value that does not parse is refused
    at the door — a malformed token is a throttle that never lifts and a
    collection that takes six times as long for a reason nothing on the page
    could state.

    WHAT THE VERIFY CANNOT DO IS PROVE THE TOKEN IS YOURS. Measured on
    2026-09-04: search.rss served a MADE-UP user/feed pair exactly as it served
    the real one — 200, no throttle counter, three queries five seconds apart
    all answered. Carrying the parameters is what lifts the throttle;
    Reddit does not appear to check them on this endpoint. So the check here is
    the honest one — the feed answers and the counter is gone — and the
    provider says as much rather than implying an identity it cannot confirm.
  */
  reddit: {
    secret: "reddit-feed",
    fields: ["feed"],
    async verify(values) {
      const raw = values.feed ?? "";
      if (!raw.trim())
        return (
          "Paste the RSS feed URL from reddit.com/prefs/feeds, or the " +
          '{"user": "…", "feed": "…"} pair from it. Reddit issues one to every ' +
          "account; there is no developer app to register."
        );
      const token = demand.parseFeed(raw);
      if (!token)
        return (
          "That is neither a reddit.com feed URL with user= and feed= in it, " +
          'nor a {"user": "…", "feed": "…"} pair. An app id or an OAuth token ' +
          "is not what this wants — Reddit stopped issuing those to new " +
          "scripts in November 2025."
        );
      const res = await demand.verifyFeed(token);
      return res.ok ? null : res.error;
    },
  },

  /*
    TELEGRAM — ONE BOT TOKEN, AND THE ONLY CREDENTIAL HERE THAT CAN BE TALKED
    TO RATHER THAN READ.

    Every other entry in this registry buys a measurement. This one buys a
    door: a bot anybody on Telegram can open a chat with, wired to an agent
    that can act. Which is why the bridge behind it pairs with exactly one chat
    — the first that messages it — and answers every other chat with nothing at
    all. `getMe` is the whole of what can be verified here: a bot token carries
    no scopes, and the chat it will serve does not exist until a human sends it
    a message, which is the step the help text on the plugin page asks for.

    ONE TOKEN PER ACCOUNT, because a token IS a bot. Two bots is the ordinary
    shape once somebody has a personal one and a project one, and each gets its
    own poller and its own paired chat. A column of tokens is refused with that
    sentence rather than sealed as one very long credential, exactly as
    Hetzner's is.

    The entry name is `telegram-token` — the name the previous system's own
    vault uses for the notifier on the Pi, which makes moving the credential a
    copy rather than a translation. Note that it is a DIFFERENT bot from the
    one that notifier polls: Telegram allows one getUpdates per token, so two processes
    sharing one would each take half the messages. If that ever happens the
    plugin page says so in as many words, because 409 is the only way to find
    out.
  */
  telegram: {
    secret: "telegram-token",
    fields: ["token"],
    async verify(values) {
      const token = (values.token ?? "").trim();
      if (!token)
        return "Paste the bot token from @BotFather — /newbot, or /mybots → the bot → API Token.";
      if (token.includes("\n"))
        return "That is more than one line. A token is a bot, so each one is its own account here — add them one at a time.";
      const res = await telegram.verify(token);
      return res.ok ? null : res.error;
    },
  },

  /*
    GMAIL — THREE FIELDS, AND A TOKEN MORE POWERFUL THAN THE CODE THAT HOLDS IT.

    The previous system keeps this as two vault documents,
    `gmail-client.json` and `gmail-token.json`. The second one already
    contains the first: read off the Pi, gmail-token.json carries
    `client_id`, `client_secret`, `refresh_token`,
    `scopes`, `address` and `obtained` — so the client file is the same pair
    written down twice. One document is enough to connect, and it is split into
    three fields here for the reason `adsense` is: this vault stores FIELDS, and
    a JSON blob in a secret is a document that has to be parsed before anything
    can be checked, so a typo inside it fails as "the grant was refused" rather
    than as "the client secret is missing".

    THE SCOPE IS THE THING TO READ TWICE. That token was minted with
    `gmail.modify`, which can archive, label, trash and mark read — the
    previous system's own mail page sends replies with it. This dashboard
    only reads, and that is
    enforced structurally rather than contractually: `providers/gmail.ts` has
    ONE function that talks to Gmail, it hard-codes GET, and it takes no body,
    so there is no argument anywhere that would make it write. The credential's
    extra power is simply never exercised. Refusing the token outright was the
    alternative and it buys nothing: there is no narrower one to be had without
    a human at a consent screen, and the risk it would avoid is one the
    provider's shape has already removed.

    VERIFIED WITH THE REFRESH AND THEN getProfile, because neither proves the
    other — a grant that refreshes and reaches no mailbox is the wrong Google
    login, which would otherwise connect happily and report an empty inbox
    forever. The profile also returns the ADDRESS, which is the natural name for
    the account row: three mailboxes called "Account 1", "Account 2" and
    "Account 3" is a page nobody can read.
  */
  gmail: {
    secret: "gmail",
    fields: ["client-id", "client-secret", "refresh-token"],
    async verify(values) {
      const clientId = (values["client-id"] ?? "").trim();
      const clientSecret = (values["client-secret"] ?? "").trim();
      const refreshToken = (values["refresh-token"] ?? "").trim();
      if (!clientId)
        return "Paste the OAuth client ID — it is the client_id inside gmail-token.json, or the Desktop app client in Google Cloud → Credentials.";
      if (!clientSecret)
        return "The client secret is issued with the client ID and Google refuses a refresh grant without it.";
      if (!refreshToken)
        return "Paste the refresh token minted by gmail_auth.py with access_type=offline, signed in as the mailbox owner.";
      const res = await gmail.verify({ clientId, clientSecret, refreshToken });
      return res.ok ? null : res.error;
    },
  },

  /*
    RESEND — ONE KEY PER SENDING DOMAIN, WHICH IS ELEVEN ACCOUNTS ON THIS BOX.

    A Resend key is scoped to the domain it was minted for. Probed on
    2026-09-05: one domain's key `GET /domains` returns that domain and
    nothing else, and its `GET /emails` returns that domain's mail and nothing
    else. No key on this account sees all eleven, so one account row could not
    have covered them even in principle — which is why the previous system's
    single `resend-keys.json` blob (a JSON object of eleven domain→key pairs)
    becomes an account per domain here, exactly as `005_accounts_split` split
    the Hetzner token blob into an account per project.

    The entry stem is `resend-key` rather than the previous system's
    `resend-keys.json`, and this is the one place the "use the same name" rule
    is broken on purpose: that name describes a document holding eleven keys,
    and an entry here holds one. Naming a single key after the set would be a
    label that lies about what is sealed under it.

    ONE OF THESE KEYS IS REFUSED AT THIS DOOR AND IT IS NOT A TYPO. Resend
    issues Sending-access keys that can POST an email and read nothing at all:
    they answer 401 "This API key is restricted to only send emails" to every
    endpoint this dashboard uses, deterministically. Stored, such a key would
    connect and produce a permanently empty sending domain — the most expensive
    shape of failure here, because it looks like an answer. It is refused with
    Resend's own sentence and the fix, exactly as a Stripe test key and an
    OpenRouter inference key are. On this account that key is acme.example's.
  */
  resend: {
    secret: "resend-key",
    fields: ["key"],
    async verify(values) {
      const key = (values.key ?? "").trim();
      if (!key)
        return "Paste an API key from resend.com/api-keys with FULL access — a Sending-access key can read nothing at all, and everything here is a read.";
      if (key.includes("\n"))
        return (
          "That is more than one line. A Resend key is scoped to one sending " +
          "domain, so each one is its own account here — add them one at a " +
          "time and name each for its domain."
        );
      const res = await resend.verify(key);
      return res.ok ? null : res.error;
    },
  },

  /*
    THE TWO AGENTS, AND THE ONE THING NEITHER OF THEM IS: a measurement source.

    Every other entry in this registry buys a number — a fleet, a bill, a book
    of subscriptions. These two buy a CONVERSATION, and the shape of the
    credential follows from that: an ADDRESS plus a bearer, because unlike
    Stripe or Hetzner there is no fixed endpoint to hard-code. Both of these
    run wherever the owner put them, and the owner's users will each put them
    somewhere else, so the URL is half the credential and it is pasted with the
    other half.

    THE URL IS A `kind: "text"` FIELD IN THE CATALOG AND A VAULT FIELD HERE,
    which is the same arrangement the App Store vendor number has and for the
    same reason: it is not a secret, it must read back to be corrected, and
    every field of an account still lives in one place so that the pair is
    written and verified together. A base URL stored beside a key that no
    longer matches it is the failure `writeCredentials` exists to prevent.

    BOTH ARE VERIFIED WITH A REAL ROUND TRIP, and neither verification is a
    chat turn. Hermes' model list and OpenClaw's health-plus-models pair prove
    the same three things a completion would — the address is a server, it
    speaks this API, it accepts this bearer — without spending a token budget,
    and in OpenClaw's case without creating an agent session, which its own
    documentation asks callers not to do on a probe.

    NEITHER PROVIDER HAS A PUBLISHABLE KEY SHAPE TO REFUSE. Stripe's `pk_` and
    OpenAI's `sk-proj-` have no counterpart here: there is one kind of Nous
    Portal key and one kind of gateway secret. What IS refused is a URL pasted
    into the key box (a real mistake when a form has one of each), a column of
    values, and — for OpenClaw only — sending the token in the clear to a host
    outside the owner's own network, because that bearer is operator access to
    the entire gateway rather than a scoped API key. The asymmetry is
    deliberate and is argued at the check itself.
  */
  hermes: {
    /* Stem plus field key, so the first account's entries are exactly
       `hermes-base-url` and `hermes-key` — the second being the name the
       catalog already advertises for this plugin. */
    secret: "hermes",
    fields: ["base-url", "key"],
    async verify(values) {
      const baseUrl = (values["base-url"] ?? "").trim();
      const key = (values.key ?? "").trim();
      if (!baseUrl)
        return (
          "Paste the base URL of the OpenAI-compatible endpoint. Hermes itself " +
          "is a CLI agent and serves no HTTP — the door is `hermes proxy " +
          "start`, on 127.0.0.1:8645 by default, which forwards to Nous Portal. " +
          "(`hermes serve` on 9119 is a WebSocket JSON-RPC gateway and does not " +
          "speak this API.)"
        );
      if (!key)
        return (
          "Paste a bearer token. `hermes proxy` accepts ANY value here and " +
          "attaches your real Nous Portal credential on the way out, so a " +
          "placeholder works against it — but point this at Nous Portal or any " +
          "other provider directly and the key is checked."
        );
      if (key.includes("\n"))
        return "That is more than one line. One key per account here.";
      if (/^https?:\/\//i.test(key))
        return "That is a URL, not a key. The endpoint goes in the base URL field.";
      const res = await hermes.verify({ baseUrl, key });
      return res.ok ? null : res.error;
    },
  },

  openclaw: {
    /* `openclaw-gateway-url` and `openclaw-token`, the second being the
       catalog's advertised name. */
    secret: "openclaw",
    fields: ["gateway-url", "token"],
    async verify(values) {
      const gatewayUrl = (values["gateway-url"] ?? "").trim();
      const token = (values.token ?? "").trim();
      if (!gatewayUrl)
        return (
          "Paste the gateway's address — 127.0.0.1:18789 by default. The chat " +
          "endpoint under it is OFF until you turn it on: set " +
          "gateway.http.endpoints.chatCompletions.enabled = true and restart " +
          "the gateway, or this connects to a live gateway that cannot answer."
        );
      if (!token)
        return (
          "Paste the shared secret from gateway.auth.token — `openclaw gateway " +
          "auth-token --show` prints it. Treat it as an owner credential: it is " +
          "operator access to the whole gateway, which is why it is stored here " +
          "and never sent to the browser."
        );
      const res = await openclaw.verify({ gatewayUrl, token });
      return res.ok ? null : res.error;
    },
  },

  /*
    FREELLMAPI — A BASE URL AND THE KEY THAT ENDPOINT ISSUED, and the base URL
    is a field for a reason that took a day to establish: THERE IS NO HOSTED
    FREELLMAPI. `freellmapi.co` is a static marketing site (every `/v1` path
    404s as HTML; a POST to one is 405, because static hosting has no POST) and
    `api.freellmapi.co` is its catalog-and-licence API, which sells the live
    model list and cannot complete a chat turn. The gateway is self-hosted, so
    every instance of it is somebody's own and the address is theirs to say.

    TWO ACCOUNTS ARE THE ORDINARY SHAPE HERE rather than the exception: one
    pointing at the instance already running on the owner's Hetzner box — the
    same endpoint the previous system's own agent used to complete chat turns
    against — and one at the instance freellmapi/instance.ts installs into
    DATA_DIR and runs on 127.0.0.1:3001. The second is created by the installer and never typed;
    this door exists for the first.

    Two fields, so the naming scheme writes exactly `freellmapi-base-url` and
    `freellmapi-key` for the first account — the second being the name the
    previous system's own vault uses, which makes moving the credential a copy.

    VERIFIED WITH ONE CALL, AND IT IS THE ONE THAT MATTERS. `/v1/models` on
    this gateway is authenticated (measured: 401 without a key), so a single
    round trip proves the address, proves the key, and proves the router has a
    catalog to route into. An EMPTY catalog is refused rather than stored: a
    gateway with no provider keys in it answers 200 with `data: []` and would
    connect as a provider that cannot complete anything.
  */
  freellmapi: {
    secret: freellmapi.SECRET_STEM,
    fields: [...freellmapi.FIELDS],
    async verify(values) {
      const baseUrl = (values["base-url"] ?? "").trim();
      const key = (values.key ?? "").trim();
      if (!baseUrl)
        return (
          `Paste the base URL of your FreeLLMAPI — there is no hosted one to ` +
          `default to. Yours on the Hetzner box is ${freellmapi.DEFAULT_BASE}; ` +
          `an instance installed here answers at ${freellmapi.LOCAL_URL}, and the ` +
          `Install button below connects that one without a paste.`
        );
      if (!key)
        return (
          "Paste the unified key that instance issued. It is on its own dashboard " +
          "under Keys and begins `freellmapi-`; a per-client `sk-cp-` key works too."
        );
      if (key.includes("\n")) return "That is more than one line. One key per account here.";
      if (/^https?:\/\//i.test(key))
        return "That is a URL, not a key. The endpoint goes in the base URL field.";
      const res = await freellmapi.verify({ baseUrl, key });
      return res.ok ? null : res.error;
    },
  },
};

/* Built-ins first, then every integration area's entries — a manifest cannot
   redefine a built-in, which is the order this spread enforces. */
const REGISTRY: Record<string, PluginRegistryEntry> = { ...manifestPlugins(), ...BUILTIN };

/* ------------------------------------------------------------------ shapes */

/**
 * One account as the interface sees it: what it is called, whether it works,
 * when it last did, and WHICH VAULT ENTRIES it owns — by name and date only.
 * There is no field on this object that could hold a value and no route below
 * that could fill one, which is the same one-way door the vault enforces from
 * its side.
 */
function shapeAccount(a: accounts.Account) {
  return {
    id: a.id,
    label: a.label,
    connected: a.connected,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    lastOkAt: a.lastOkAt,
    lastError: a.lastError,
    secrets: accounts.entries(a.id),
  };
}

function shape(id: string) {
  const row = getPlugin(id);
  return {
    id,
    connected: row ? row.connected === 1 : false,
    updatedAt: row?.updated_at ?? null,
    lastError: row?.last_error ?? null,
    // Names and timestamps only. There is no endpoint that returns a value.
    secrets: vault.status(id),
    accounts: accounts.list(id).map(shapeAccount),
    collectable: id in COLLECTORS,
    /*
      WHETHER THIS PLUGIN HAS A DOOR HERE AT ALL, which is NOT the same
      question as `collectable` and used to be answered by it.

      Every plugin that could hold a credential also had a collector, so the
      page treated "has a collector" as "is wired to the API". `local` breaks
      that: it holds endpoints and there is nothing to collect FROM a model
      server — a completion is its own health check and happens when somebody
      asks a question, not on a timer. Without this the plugin page would fall
      back to its catalog-only form and write the endpoint into localStorage
      instead of the vault.
    */
    /* A CREDENTIAL OR SETTINGS — either one means the API backs this plugin.
       `backups` and `briefing` have no credential at all and are nothing but
       settings; without the second half they were drawn the catalog-only form
       and their settings had nowhere to appear. */
    configurable: id in REGISTRY || hasSettings(id),
    runs: recentRuns(id, 5).map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      ok: r.ok === null ? null : r.ok === 1,
      note: r.note,
      error: r.error,
    })),
  };
}

/** The fields of a request body that are actually this plugin's, or a reason
 *  they are not. Every write goes through it; the registry is the only list of
 *  names that can reach the vault. */
function checkFields(
  entry: (typeof REGISTRY)[string],
  fields: unknown,
): { ok: true; fields: Record<string, string> } | { ok: false; error: string } {
  if (!fields || typeof fields !== "object")
    return { ok: false, error: "Expected { fields: { … } }." };
  const values = fields as Record<string, string>;
  const unknown = Object.keys(values).filter((k) => !entry.fields.includes(k));
  if (unknown.length)
    return { ok: false, error: `Unknown field(s): ${unknown.join(", ")}` };
  return { ok: true, fields: values };
}

/** The fields that must actually carry a value. Everything the registry did
 *  not mark optional — so a plugin with no `optional` list behaves exactly as
 *  it did before this existed. */
function requiredFields(entry: (typeof REGISTRY)[string]): string[] {
  const optional = entry.optional ?? [];
  return entry.fields.filter((f) => !optional.includes(f));
}

/**
 * Store a credential set, and FORGET the optional fields that were cleared.
 *
 * `accounts.writeCredentials` seals whatever it is handed, so passing an
 * optional field through as `""` would put an empty ciphertext in the vault
 * under a real entry name — and every reader that decides "is there a key
 * here" from the entry NAME (which is how this codebase avoids decrypting to
 * draw a page) would then say yes about nothing. So an optional field that
 * arrives empty is not written; if an entry for it already exists, it is
 * removed, which is what makes "take the inference key off this account"
 * something the same form can do.
 *
 * A REQUIRED field arriving empty never reaches here — the routes below refuse
 * it first, and `verify` refuses it before that.
 */
function applyCredentials(
  account: accounts.Account,
  entry: (typeof REGISTRY)[string],
  values: Record<string, string>,
) {
  const optional = entry.optional ?? [];
  const stems = entry.stems ?? {};
  const write: Record<string, string> = {};
  const forget: string[] = [];

  for (const field of entry.fields) {
    const value = values[field];
    if (value === undefined) continue; /* not sent: keep what is stored */
    if (value.trim()) write[field] = value.trim();
    else if (optional.includes(field)) forget.push(field);
  }

  /* The fields that share the plugin's own stem, written as one set so the
     derivation sees the right number of them — see `stems` above. */
  const shared = entry.fields.filter((f) => !(f in stems));
  const sharedValues: Record<string, string> = {};
  for (const field of shared) if (field in write) sharedValues[field] = write[field]!;
  accounts.writeCredentials(account, entry.secret, shared, sharedValues);

  for (const [field, stem] of Object.entries(stems)) {
    if (!(field in write)) continue;
    accounts.writeCredentials(account, stem, [field], { [field]: write[field]! });
  }

  for (const field of forget) {
    const held = accounts.entries(account.id).find((e) => e.field === field);
    if (held) vault.remove(held.name);
  }
}

/** A freshly stored credential should have data immediately, not in half an
 *  hour — the point of connecting is to see something. */
async function collectNow(id: string) {
  const collector = COLLECTORS[id];
  return collector ? await collector() : null;
}

/* ------------------------------------------------------------------ routes */

plugins.get("/", (c) =>
  c.json({
    plugins: allPlugins().map((p) => shape(p.id)),
    configurable: Object.keys(REGISTRY),
  }),
);

plugins.get("/:id", (c) => c.json(shape(c.req.param("id"))));

/**
 * Store credentials — the single-account door.
 *
 * Kept, and kept meaning what it always meant, because it is the shape every
 * script and the setup form already speak: connect this plugin with these
 * fields. What it does now depends on what is there — nothing yet means the
 * first account, one account means replacing that one's credentials. With
 * SEVERAL accounts it refuses and names them, because "update the credential"
 * has no answer when there are three of them and picking one would be picking
 * on the owner's behalf. That case has its own route below.
 */
plugins.put("/:id", async (c) => {
  const id = c.req.param("id");
  const entry = REGISTRY[id];
  if (!entry) return c.json({ error: `${id} cannot be configured here yet.` }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    fields?: Record<string, string>;
  } | null;
  const checked = checkFields(entry, body?.fields);
  if (!checked.ok) return c.json({ error: checked.error }, 400);

  const existing = accounts.list(id);
  if (existing.length > 1)
    return c.json(
      {
        error:
          `${id} has ${existing.length} accounts (${existing
            .map((a) => a.label)
            .join(", ")}). Say which one: ` +
          `PATCH /api/plugins/${id}/accounts/<id>.`,
      },
      409,
    );

  if (entry.verify) {
    const problem = await entry.verify(checked.fields);
    if (problem) return c.json({ error: problem, verified: false }, 400);
  }

  upsertPlugin(id, false, null);
  const account = existing[0] ?? accounts.create(id, accounts.nextLabel(id));
  applyCredentials(account, entry, checked.fields);

  return c.json({
    ...shape(id),
    verified: true,
    accountId: account.id,
    collected: await collectNow(id),
  });
});

/** Forget every account this plugin has. The plugin-level "disconnect". */
plugins.delete("/:id", (c) => {
  const id = c.req.param("id");
  const entry = REGISTRY[id];
  if (!entry) return c.json({ error: `Unknown plugin ${id}.` }, 404);
  for (const account of accounts.list(id)) accounts.remove(account);
  upsertPlugin(id, false, null);
  return c.json(shape(id));
});

/* --------------------------------------------------------------- accounts */

plugins.get("/:id/accounts", (c) => {
  const id = c.req.param("id");
  if (!REGISTRY[id]) return c.json({ error: `Unknown plugin ${id}.` }, 404);
  return c.json({ accounts: accounts.list(id).map(shapeAccount) });
});

/**
 * Add another account.
 *
 * Verified against the provider BEFORE the account row exists, so a refused
 * credential leaves nothing behind — an empty "Account 3" sitting on the page
 * after a failed paste is a row that claims a set-up that never happened.
 */
plugins.post("/:id/accounts", async (c) => {
  const id = c.req.param("id");
  const entry = REGISTRY[id];
  if (!entry) return c.json({ error: `${id} cannot be configured here yet.` }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    label?: string;
    fields?: Record<string, string>;
  } | null;
  const checked = checkFields(entry, body?.fields);
  if (!checked.ok) return c.json({ error: checked.error }, 400);

  const missing = requiredFields(entry).filter((f) => !(checked.fields[f] ?? "").trim());
  if (missing.length)
    return c.json({ error: `Missing: ${missing.join(", ")}.` }, 400);

  const label = (body?.label ?? "").trim() || accounts.nextLabel(id);
  if (accounts.list(id).some((a) => a.label === label))
    return c.json(
      {
        error: `This plugin already has an account called “${label}”. Two accounts with one name make “which project is this?” unanswerable.`,
      },
      409,
    );

  if (entry.verify) {
    const problem = await entry.verify(checked.fields);
    if (problem) return c.json({ error: problem, verified: false }, 400);
  }

  upsertPlugin(id, false, null);
  const account = accounts.create(id, label);
  applyCredentials(account, entry, checked.fields);

  return c.json(
    {
      ...shape(id),
      verified: true,
      accountId: account.id,
      collected: await collectNow(id),
    },
    201,
  );
});

/**
 * Rename one account, replace its credentials, or both.
 *
 * A rename alone does not touch the provider — there is nothing to verify
 * about a name — and it deliberately does not rewrite the entry names the
 * values are sealed under, because those are associated data and re-sealing a
 * working secret to make a string prettier is a way to lose it.
 */
plugins.patch("/:id/accounts/:accountId", async (c) => {
  const id = c.req.param("id");
  const entry = REGISTRY[id];
  if (!entry) return c.json({ error: `${id} cannot be configured here yet.` }, 404);

  const account = accounts.get(Number(c.req.param("accountId")));
  if (!account || account.pluginId !== id)
    return c.json({ error: "No such account on this plugin." }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    label?: string;
    fields?: Record<string, string>;
  } | null;
  if (!body) return c.json({ error: "Expected { label?, fields? }." }, 400);

  if (body.label !== undefined) {
    const label = body.label.trim();
    if (!label) return c.json({ error: "An account needs a name." }, 400);
    if (accounts.list(id).some((a) => a.label === label && a.id !== account.id))
      return c.json(
        { error: `This plugin already has an account called “${label}”.` },
        409,
      );
    accounts.rename(account.id, label);
  }

  let verified = false;
  if (body.fields !== undefined) {
    const checked = checkFields(entry, body.fields);
    if (!checked.ok) return c.json({ error: checked.error }, 400);

    /*
      A replacement is verified as a WHOLE credential set, not as the fields
      that were typed. Sending only the Dynadot secret would otherwise be
      checked on its own — which the provider cannot do — and land beside a key
      it may no longer match. What is already in the vault fills the gaps, and
      the pair that gets verified is exactly the pair that gets used.
    */
    const current = vault.readSet(account.id, `configure_${id}`);
    const merged: Record<string, string> = {};
    for (const f of entry.fields) {
      const typed = (checked.fields[f] ?? "").trim();
      merged[f] = typed || (current[f] ?? "");
    }
    const missing = requiredFields(entry).filter((f) => !merged[f]);
    if (missing.length)
      return c.json({ error: `Missing: ${missing.join(", ")}.` }, 400);

    if (entry.verify) {
      const problem = await entry.verify(merged);
      if (problem) return c.json({ error: problem, verified: false }, 400);
    }
    applyCredentials(account, entry, merged);
    verified = true;
  }

  return c.json({
    ...shape(id),
    verified,
    accountId: account.id,
    collected: verified ? await collectNow(id) : null,
  });
});

/**
 * Remove one account.
 *
 * The rows it collected are NOT deleted here. They go on the next collection,
 * when the fleet is replaced by what the remaining accounts actually see and
 * the registrars' rows go with the account by the foreign key's cascade — so
 * the page is corrected by a measurement rather than by this route's opinion.
 * The collection is kicked off immediately for exactly that reason.
 */
plugins.delete("/:id/accounts/:accountId", async (c) => {
  const id = c.req.param("id");
  if (!REGISTRY[id]) return c.json({ error: `Unknown plugin ${id}.` }, 404);

  const account = accounts.get(Number(c.req.param("accountId")));
  if (!account || account.pluginId !== id)
    return c.json({ error: "No such account on this plugin." }, 404);

  accounts.remove(account);
  const left = accounts.list(id);
  return c.json({
    ...shape(id),
    collected: left.length ? await collectNow(id) : null,
  });
});

plugins.post("/:id/collect", async (c) => {
  const id = c.req.param("id");
  const collector = COLLECTORS[id];
  if (!collector) return c.json({ error: `${id} has no collector yet.` }, 404);
  const result = await collector();
  return c.json({ ...shape(id), collected: result });
});
