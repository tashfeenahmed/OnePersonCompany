/**
 * THE PLUGIN CATALOG.
 *
 * Every integration WorkDash actually has, read off three places in that repo:
 * agent/integrations.js (the closed registry its settings page writes through),
 * KNOWN_SECRETS in agent/secrets.js (the vault's own names), and each
 * collectors/collect_*.py to see which service it really calls. The vault entry
 * name and the "read by" list on each entry are the real ones - a key pasted
 * here lands under exactly that name.
 */

export type FieldKind = "secret" | "text";

export type PluginField = {
  key: string;
  label: string;
  kind: FieldKind;
  /** Where in the provider's own UI this value is found. */
  ph?: string;
  /**
   * The vault entry this field writes to, when the plugin has more than one
   * and the names are not a suffix of a common stem.
   *
   * A plugin with one field writes to the plugin's own `secret`. A plugin with
   * several USUALLY writes `<stem>-<field key>`, and that derivation is what
   * the server's closed registry does — but the real names in workdash's vault
   * were chosen before any of this and do not all fit the pattern:
   * `gmail-client.json` is not `gmail-token.json-client`. Where the name is
   * not derivable it is written down here rather than guessed, because this is
   * the string the interface tells the owner their credential is stored under,
   * and a wrong one sends them looking for an entry that does not exist.
   */
  entry?: string;
  /**
   * A field that may be left empty, which is otherwise not a thing here.
   *
   * TWO KINDS OF OPTIONAL, both real. A local model server — Ollama, LM Studio
   * — ships with no auth at all and binds to loopback, which IS its access
   * control; demanding a key would mean inventing one. And the inference key
   * on OpenAI and OpenRouter is a SECOND credential on a plugin that already
   * works: both of those connect to read a bill, and an owner who does not
   * want to complete through them must not be nagged for a key to keep their
   * costs page.
   */
  optional?: boolean;
};

export type PluginCategory =
  "revenue" | "seo" | "social" | "infra" | "ai" | "comms" | "media" | "signals";

export type Plugin = {
  id: string;
  name: string;
  /** Simple Icons slug, or null for a service with no brand mark anywhere. */
  icon: string | null;
  /** Monogram and tint, used only when icon is null. */
  mono?: string;
  tint?: string;
  cat: PluginCategory;
  connected: boolean;
  /** The vault entry this writes to, or null when no credential is involved. */
  secret: string | null;
  desc: string;
  help: string;
  docs: string | null;
  fields: PluginField[];
  /** Which collectors read it, and the document they write. */
  usedBy: string[];
};

export const CATEGORIES: { id: string; label: string }[] = [
  {
    id: "all",
    label: "All",
  },
  {
    id: "connected",
    label: "Connected",
  },
  {
    id: "revenue",
    label: "Revenue",
  },
  {
    id: "seo",
    label: "Search & SEO",
  },
  {
    id: "social",
    label: "Social",
  },
  {
    id: "infra",
    label: "Infrastructure",
  },
  {
    id: "ai",
    label: "AI",
  },
  {
    id: "comms",
    label: "Email & messaging",
  },
  {
    id: "media",
    label: "Media",
  },
  {
    id: "signals",
    label: "Signals",
  },
];

export const PLUGINS: Plugin[] = [
  {
    id: "stripe",
    name: "Stripe",
    icon: "stripe",
    cat: "revenue",
    connected: true,
    secret: "stripe-key",
    desc: "MRR, churn, net revenue and the payout balance.",
    help: "Stripe Dashboard → Developers → API keys → Create restricted key, with READ access to Balance, Balance transactions, Charges, Subscriptions, Prices, Invoices and Payouts. Nothing here sends anything but a GET, so a key that could write would only be extra power nobody uses. A key missing one of those permissions is refused when it is pasted rather than showing an empty dashboard an hour later, and a test-mode key is refused outright: its figures would appear on a revenue board as real money.",
    docs: "https://dashboard.stripe.com/apikeys",
    fields: [
      { key: "key", label: "Restricted key", kind: "secret", ph: "rk_live_…" },
    ],
    usedBy: [
      "collect_stripe.py (payments.json) — workdash",
      "GET /api/stripe — MRR, churn, the balance ledger and the payout balance",
    ],
  },
  {
    id: "adsense",
    name: "Google AdSense",
    icon: "googleadsense",
    cat: "revenue",
    /*
      NOT CONNECTED, AND IT NEVER HAS BEEN. This said `true` because the
      catalog was seeded from the integrations workdash intends to have. There
      is no adsense-token in any vault, no adsense-token.json beside its
      collectors, and no consent has ever been granted for either box. Saying
      "Connected" was a mock value presented as a measurement, which is the one
      thing this project refuses.
    */
    connected: false,
    secret: "adsense",
    desc: "Ad earnings and RPM per site. Needs an OAuth grant nobody has given yet.",
    help: "This needs an OAuth refresh token, and only a human at a Google consent screen can mint one. (1) In Google Cloud, on the project you will use: APIs & Services → Library → enable the AdSense Management API. (2) APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app; keep the client ID and secret. (3) Run the consent for scope adsense.readonly with access_type=offline and prompt=consent, signed in as the AdSense account owner, and keep the refresh_token — workdash's adsense_auth.py does exactly this in a terminal and prints the URL to open. (4) PUBLISH the Cloud app: while it is in Testing, Google expires every refresh token after seven days, so an integration that works all week stops on the eighth day. (5) Paste all three here. The first collection after a fresh consent usually fails with SERVICE_DISABLED if step 1 was skipped — the card carries Google's own link to switch the API on.",
    docs: "https://developers.google.com/adsense/management/reference/rest/v2/accounts.reports/generate",
    fields: [
      { key: "client-id", label: "OAuth client ID", kind: "text", ph: "…apps.googleusercontent.com" },
      { key: "client-secret", label: "OAuth client secret", kind: "secret", ph: "GOCSPX-…" },
      { key: "refresh-token", label: "Refresh token", kind: "secret", ph: "1//0e…" },
    ],
    usedBy: [
      "collect_adsense.py (adsense.json) — workdash, also unauthorised",
      "GET /api/adsense — earnings per site per day, or the reason there are none",
    ],
  },
  {
    id: "appstore",
    name: "App Store Connect",
    icon: "appstore",
    cat: "revenue",
    connected: true,
    /* The stem, not the entry: with four fields the entry name is
       `<stem>-<field>`, so the private key lands under `asc-key.p8` — the same
       name workdash's own vault uses. */
    secret: "asc",
    desc: "Downloads, store status, estimated proceeds and the monthly payout.",
    help: "App Store Connect → Users and Access → Integrations → App Store Connect API for the key, its ID and the issuer ID; the .p8 downloads once and Apple will not show it again. The VENDOR NUMBER is somewhere else entirely — Payments and Financial Reports — and without it no sales or finance report can be read at all.",
    docs: "https://appstoreconnect.apple.com/access/integrations/api",
    fields: [
      /* Three identifiers and one secret. The identifiers are printed in
         Apple's own console, so they are plain text fields shown in full and
         echoed back on /api/mobile — a wrong vendor number is the one failure
         here that leaves a board empty with nothing anywhere to explain it. */
      { key: "key-id", label: "Key ID", kind: "text", ph: "ABCD1234EF" },
      { key: "issuer-id", label: "Issuer ID", kind: "text", ph: "69a6de7f-…" },
      { key: "vendor", label: "Vendor number", kind: "text", ph: "80000000" },
      {
        key: "key.p8",
        label: "Private key (.p8)",
        kind: "secret",
        ph: "-----BEGIN PRIVATE KEY-----",
      },
    ],
    usedBy: [
      "collect_appstore.py (appstore.json)",
      "/api/mobile (downloads, store state, proceeds and payouts)",
    ],
  },
  {
    id: "playstore",
    name: "Google Play",
    icon: "googleplay",
    cat: "revenue",
    connected: true,
    /* Stem again: `play-key.json` and `play-developer-id`. */
    secret: "play",
    desc: "Installs, ratings, what buyers were charged and what Google paid.",
    help: "A Google Cloud service account, invited to the Play Console with permission to download reports. Everything read here lives in the console's own report bucket, so the key needs only read access to Cloud Storage — no other Google API has to be switched on.",
    docs: "https://play.google.com/console/developers/api-access",
    fields: [
      {
        key: "key.json",
        label: "Service account JSON",
        kind: "secret",
        ph: '{"type":"service_account",…}',
      },
      /* The reports live in a bucket named after the DEVELOPER ACCOUNT, and
         the service account key says nothing about which one it was invited
         to. It is on Play Console → Download reports, in the bucket name. */
      {
        key: "developer-id",
        label: "Developer id",
        kind: "text",
        ph: "6847190745506848286",
      },
    ],
    usedBy: [
      "collect_playstore.py (playstore.json)",
      "/api/mobile (installs, ratings, earnings and sales)",
    ],
  },
  {
    id: "gsc",
    name: "Google Search Console",
    icon: "googlesearchconsole",
    cat: "seo",
    connected: true,
    secret: "gsc-key.json",
    desc: "Impressions, clicks and query positions for all verified sites.",
    help: "A service account JSON with the Search Console API enabled, added as a user on each property. Property-by-property — a domain missed here is a domain silently absent from the charts, so the key is refused outright if it can see none. Read-only: the token is minted for webmasters.readonly, which cannot submit a sitemap or request indexing.",
    docs: "https://search.google.com/search-console",
    fields: [
      {
        key: "json",
        label: "Service account JSON",
        kind: "secret",
        ph: '{"type":"service_account",…}',
      },
    ],
    usedBy: [
      "collect_gsc.py (gsc.json)",
      "collect_seo.py (seo.json)",
      "/api/gsc (impressions, clicks, positions, queries and sitemaps)",
    ],
  },
  {
    id: "bing-webmaster",
    name: "Bing Webmaster Tools",
    icon: "microsoftbing",
    cat: "seo",
    connected: true,
    secret: "bing-key",
    desc: "Bing's own traffic and index, plus the only free source of keyword volume.",
    /* The backlink half of the old description came off: probed on 2026-09-04,
       the endpoint that names a linking page answers with an empty list for
       every verified site on this account, so there is a link COUNT out of the
       crawl statistics and no referring-domain figure at all. */
    help: "Bing Webmaster Tools → Settings → API access → API key. Free, and one key covers every site the account has verified. It is the only source in this dashboard for keyword volume — how many people search a phrase whether or not you have a page for it, which Search Console structurally cannot answer. Which phrases is a setting, below.",
    docs: "https://www.bing.com/webmasters/",
    fields: [
      {
        key: "key",
        label: "API key",
        kind: "secret",
        ph: "the 32-character key from the API access page",
      },
    ],
    usedBy: [
      "collect_bingkw.py (keywords.json)",
      "collect_backlinks.py (backlinks.json)",
      "/api/bing (traffic, index and crawl, inbound links, keyword volume)",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    icon: "cloudflare",
    cat: "seo",
    connected: true,
    secret: "cf-token",
    desc: "Zones, DNS records, delegation drift and per-zone request volume.",
    help: "An API token scoped to Zone → Zone → Read and Zone → DNS → Read, and nothing else. Deliberately read-only: it cannot edit zone settings or deploy Pages, and it should stay that way — every permission it lacks is reported as a gap rather than worked around. It is verified twice before it is stored, because a token that is valid and scoped to nothing answers 200 and then shows an empty board.",
    docs: "https://dash.cloudflare.com/profile/api-tokens",
    fields: [
      {
        key: "token",
        label: "API token",
        kind: "secret",
        ph: "zone-read scope only",
      },
    ],
    usedBy: [
      "collect_domains.py (domains.json)",
      "collect_uptime.py (uptime.json)",
    ],
  },
  {
    id: "umami",
    name: "Umami",
    icon: "umami",
    cat: "seo",
    connected: false,
    secret: "umami",
    desc: "Self-hosted web analytics: pageviews, visits, bounce and average visit, per website.",
    help: "ONE ACCOUNT IS ONE INSTANCE, NOT ONE WEBSITE. An Umami install carries every site pointed at it and one login sees all of them, so the credential belongs to the instance exactly as a Hetzner token belongs to a project, and the websites inside it are rows. Two installs are two accounts. There are TWO WAYS IN and you use one: a self-hosted instance signs in with the username and password at /api/auth/login, and Umami Cloud (or any instance that has issued a key) answers x-umami-api-key instead and has no login endpoint at all. A set that is half of each is refused when it is pasted rather than stored to fail hourly. The address is required and is stored beside the rest, because Umami runs wherever you put it and a base URL kept apart from the key that matches it is an account that reads nothing while looking configured. Read-only: five GETs and one login POST. Days are bucketed in the INSTANCE's timezone, which this box does not know, so a day here is never joined to a day from another integration.",
    docs: "https://umami.is/docs/api",
    fields: [
      {
        key: "url",
        label: "Dashboard address",
        kind: "text",
        ph: "https://analytics.example.com",
      },
      {
        key: "username",
        label: "Username",
        kind: "text",
        ph: "the login you open the dashboard with — leave empty if using a key",
        optional: true,
      },
      {
        key: "password",
        label: "Password",
        kind: "secret",
        ph: "its password",
        optional: true,
      },
      {
        key: "token",
        label: "API key",
        kind: "secret",
        ph: "Umami Cloud → Settings → API — instead of the login above",
        optional: true,
      },
    ],
    usedBy: [
      "collect_umami (websites, windows, daily lines and the top-20 rankings)",
      "GET /api/umami — per website and the portfolio, with no combined visitor count",
    ],
  },
  {
    id: "backlinks",
    name: "Backlinks",
    icon: null,
    mono: "B",
    tint: "#3F7D58",
    cat: "seo",
    connected: false,
    secret: null,
    desc: "Who links to these sites — three free sources, each figure carrying the one that said it.",
    help: "NO CREDENTIAL, A LIST INSTEAD: the sources are free, so \u201cconnected\u201d means there are sites to ask about, which is npm's reading. Three sources with three confidences: a VERIFICATION CRAWLER (0.95) that fetches a page somebody claimed links here and looks, which is the only source that can be checked and the only one that can say whether a link is still there and whether it is nofollow; BING WEBMASTER (0.70), through the key that plugin already holds, which is a real index and a sample rather than a census; and COMMON CRAWL (0.50), which contributes crawl presence \u2014 pages of the domain its index captured. NOTHING IS EVER ADDED ACROSS THEM. They overlap and disagree by design, so `referringDomains.combined` is null with the reason attached. And HOST IN-DEGREE \u2014 how many sites link to this one across the whole web \u2014 is NOT MEASURED here and nothing above is a proxy for it: Common Crawl's hyperlink graph is the only free source and it ships as bulk files with no query endpoint. Collected once a day per host.",
    docs: "https://index.commoncrawl.org/",
    fields: [],
    usedBy: [
      "collect_backlinks (per host, per source, plus the pages the crawler verified)",
      "GET /api/backlinks \u2014 per source rows, never a merged total",
    ],
  },
  {
    id: "meta",
    name: "Meta",
    icon: "meta",
    cat: "social",
    connected: true,
    secret: "meta-token",
    desc: "Facebook Page followers, and the ad account’s spend, reach and leads.",
    help: "A system user token from Business settings → System users → Generate token, with pages_show_list, pages_read_engagement, read_insights and ads_read. One token serves the Pages and the Ads. PASTE ONLY THE TOKEN: if it is copied out of a notes file, the “#” comment lines have to come out — Meta answers a whole file with OAuthException 190 “Bad signature”, which reads exactly like a revoked credential and sends you to mint a replacement for a token that was never wrong. The app pair is optional and hardens every call with appsecret_proof. Note what this token CANNOT reach, because it is not a fault: Page reach is gone (Meta retired page_impressions_unique in November 2025), and Page views, follows and posts need a Page Access Token that a system user’s page role is not permitted to mint.",
    docs: "https://business.facebook.com/",
    fields: [
      {
        key: "token",
        entry: "meta-token",
        label: "System user token",
        kind: "secret",
        ph: "EAA…",
      },
      /* NOT AN APP ID, despite what this field used to be labelled. `meta-app`
         holds `app_id:app_secret` on one line — the shape collect_social.py
         partitions on — so the second half is a real secret and the field is
         one. Labelled as a pair, because an app id pasted on its own signs
         nothing and would leave the owner believing the calls are proofed. */
      {
        key: "app",
        entry: "meta-app",
        label: "App id and secret (optional)",
        kind: "secret",
        ph: "app_id:app_secret",
      },
    ],
    usedBy: [
      "collect_social.py (social.json) — workdash",
      "collect_ads.py (ads.json) — workdash",
      "GET /api/meta — the Pages, the ad account’s window and daily line, and the Instagram answer",
    ],
  },
  {
    id: "instagram",
    name: "Instagram",
    icon: "instagram",
    cat: "social",
    connected: true,
    secret: "meta-token",
    /* CONNECTED, AND THERE IS NOTHING TO READ — which is a third state and not
       either of the two this flag can hold. The credential is real: it is the
       same live system user token that lists three Pages by name. What is
       missing is on Meta's side, and the description says so rather than
       leaving a reader to read "connected" as "reporting". */
    desc: "Rides on the Meta token, which works — but no Instagram Business account is linked to any Page.",
    help: "Nothing to paste, and nothing to fix here. Instagram is not an API this dashboard talks to: an Instagram Business account is reached as a FIELD on a Facebook Page (instagram_business_account), through the same Meta token that already serves the Pages and the Ads. That token is connected and working — probed 4 September 2026, it listed all three Pages — and every one of those Pages reports NO linked Instagram Business account. So there is a working credential and no account behind it, which is neither an error nor zero followers. The one step that changes it is on Meta’s side: Meta Business Suite → Settings → Accounts → Instagram accounts → Connect, linking an Instagram Business or Creator account to one of the Pages. Nothing needs re-pasting afterwards; the next collection reads it with the token already here.",
    docs: "https://business.facebook.com/",
    fields: [],
    usedBy: [
      "collect_social.py (social.json) — workdash",
      "GET /api/meta — the `instagram` block, which reports which of four states this is in",
    ],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: "linkedin",
    cat: "social",
    connected: false,
    secret: "linkedin",
    /*
      "CREDENTIALS STORED, FLOW NOT SHIPPED" WAS HALF FALSE, AND IT WAS THE
      HALF THAT MATTERED. `linkedin-client-id` and `linkedin-client-secret` are
      DECLARED NAMES in workdash's KNOWN_SECRETS and no value has ever been set
      for either — checked on the Pi, 4 September 2026. A catalog that says
      credentials are stored is a catalog telling the owner they have something
      they do not, which is the same claim the AdSense entry made before it was
      corrected, and it is corrected here the same way: the entry now says what
      is true, which is that the name exists and the vault is empty.
    */
    desc: "Registered with no credential and nothing collected.",
    help: "Nothing is stored and nothing is read. The vault entry names linkedin-client-id and linkedin-client-secret are declared in workdash and have never held a value — checked on the Pi, 4 September 2026. No provider, collector or route exists here for LinkedIn either, and that is deliberate rather than pending: LinkedIn's is a POSTING API, so the useful part of it is behind a three-legged OAuth flow that a human has to complete in a browser as the page's admin — which no process can do — and there is no read surface worth collecting on the other side. This entry exists so the names are documented; a credential pasted here cannot be verified, because there is nothing to verify it against.",
    docs: "https://www.linkedin.com/developers/apps",
    fields: [
      {
        key: "client-id",
        label: "Client ID",
        kind: "text",
        ph: "77xxxxxxxxxxxx",
      },
      {
        key: "client-secret",
        label: "Client secret",
        kind: "secret",
        ph: "the secret beside it in the Auth tab",
      },
    ],
    usedBy: [
      "nothing reads these — no collector, provider or route exists for LinkedIn",
    ],
  },
  {
    id: "tiktok",
    name: "TikTok",
    icon: "tiktok",
    cat: "social",
    connected: false,
    secret: "tiktok",
    /* The same correction as LinkedIn's, for the same reason and on the same
       evidence: `tiktok-client-key` and `tiktok-client-secret` are declared
       names in workdash's KNOWN_SECRETS with no value ever stored, checked on
       the Pi on 4 September 2026. */
    desc: "Registered with no credential and nothing collected.",
    help: "Nothing is stored and nothing is read. The vault entry names tiktok-client-key and tiktok-client-secret are declared in workdash and have never held a value — checked on the Pi, 4 September 2026. No provider, collector or route exists here for TikTok, and, as with LinkedIn, that is a decision rather than a backlog item: the API is for POSTING, its useful scopes need an OAuth flow a human completes in a browser, and there is nothing to read until one is. A credential pasted here cannot be verified, because there is nothing to verify it against.",
    docs: "https://developers.tiktok.com/apps",
    fields: [
      {
        key: "client-key",
        label: "Client key",
        kind: "text",
        ph: "awxxxxxxxxxxxxxxxx",
      },
      {
        key: "client-secret",
        label: "Client secret",
        kind: "secret",
        ph: "the secret beside it in Manage",
      },
    ],
    usedBy: [
      "nothing reads these — no collector, provider or route exists for TikTok",
    ],
  },
  {
    id: "bluesky",
    name: "Bluesky",
    icon: "bluesky",
    cat: "social",
    connected: false,
    secret: null,
    desc: "Followers and engagement for the handles you watch. The public AppView \u2014 no key exists to paste.",
    help: "NO CREDENTIAL AND NO ACCOUNT: public.api.bsky.app answers for any handle on the network, unauthenticated. What it needs is a LIST of handles, which is a setting rather than a secret and is shown in full below. It watches ANY handle rather than only yours \u2014 the endpoint has no notion of \u201cmine\u201d \u2014 so every figure is captioned with the handle it belongs to. THE FEED IS READ ONE PAGE DEEP, fifty posts, and that is the honesty problem worth knowing about: for a quiet account that covers a year, for one posting five times a day it covers ten, and a window that did not fit is marked truncated and every figure in it is a FLOOR rather than a total. Followers are never added across handles \u2014 one person following two of these is one person, and Bluesky publishes nothing that would de-duplicate them.",
    docs: "https://docs.bsky.app/",
    fields: [],
    usedBy: [
      "collect_bluesky (profiles, follower history and per-window engagement)",
      "GET /api/bluesky \u2014 per handle, with no combined follower count",
    ],
  },
  {
    id: "hetzner",
    name: "Hetzner Cloud",
    icon: "hetzner",
    cat: "infra",
    connected: true,
    secret: "hetzner-token",
    desc: "Server inventory and the monthly bill, per project.",
    help: "Hetzner Cloud Console → Security → API tokens, read permission. Feeds the cost rollup that converts to EUR against the ECB daily rate.",
    docs: "https://console.hetzner.cloud/",
    fields: [
      {
        key: "token",
        label: "API token",
        kind: "secret",
        ph: "64-character read token",
      },
    ],
    usedBy: [
      "collect_costs.py (costs.json)",
      "collect_uptime.py (uptime.json)",
    ],
  },
  {
    id: "dynadot",
    name: "Dynadot",
    icon: null,
    mono: "D",
    tint: "#3B7BD8",
    cat: "infra",
    connected: true,
    secret: "dynadot-key",
    desc: "Domain portfolio, renewal dates and yearly registrar spend.",
    help: "Dynadot → Tools → API. The RESTful v2 surface signs every request with an HMAC, so the key alone reads nothing — the secret half is required too.",
    docs: "https://www.dynadot.com/account/domain/setting/api.html",
    fields: [
      {
        key: "key",
        entry: "dynadot-key",
        label: "API key",
        kind: "secret",
        ph: "the key from Tools → API",
      },
      {
        key: "secret",
        entry: "dynadot-secret",
        label: "API secret",
        kind: "secret",
        ph: "the signing half of the pair",
      },
    ],
    usedBy: [
      "collect_domains.py (domains.json)",
      "collect_costs.py (costs.json)",
    ],
  },
  {
    id: "spaceship",
    name: "Spaceship",
    icon: "spaceship",
    cat: "infra",
    connected: true,
    secret: "spaceship-key",
    desc: "The second registrar — domains that never moved to Dynadot.",
    help: "Spaceship → Account → API manager. Key and secret are issued as a pair and both go in.",
    docs: "https://www.spaceship.com/application/api-manager/",
    fields: [
      {
        key: "key",
        entry: "spaceship-key",
        label: "API key",
        kind: "secret",
        ph: "from the API manager",
      },
      {
        key: "secret",
        entry: "spaceship-secret",
        label: "API secret",
        kind: "secret",
        ph: "issued alongside the key",
      },
    ],
    usedBy: ["collect_domains.py (domains.json)"],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    cat: "infra",
    connected: true,
    secret: "github-token",
    desc: "Stars, forks and — with a token — who is actually looking at the repos.",
    help: "A token buys the SECOND TIER. Stars, forks and last-push dates are public and readable without one; per-repo traffic (views, unique visitors, clones, referrers) needs PUSH access to each repo, so it cannot be had anonymously at any rate limit. One token per GitHub account, and the account it belongs to becomes its name here.",
    docs: "https://github.com/settings/tokens",
    fields: [
      {
        key: "token",
        label: "Personal access token",
        kind: "secret",
        ph: "github_pat_…",
      },
    ],
    usedBy: [
      "collect_github.py (github.json)",
      "collect_demand.py (demand.json)",
    ],
  },
  {
    id: "npm",
    name: "npm",
    icon: "npm",
    cat: "infra",
    connected: true,
    secret: null,
    desc: "Weekly download counts for the packages you publish. No key needed.",
    help: "No credential: the downloads API is public. What it does need is the list of packages that are yours, which is a setting rather than a secret and is shown in full below. Downloads are HTTP tarball fetches — CI, mirrors and people are one each — so they are never called installs here.",
    docs: "https://api.npmjs.org/",
    fields: [],
    usedBy: ["collect_npm.py (npm.json)"],
  },
  {
    id: "pypi",
    name: "PyPI",
    icon: "pypi",
    cat: "infra",
    connected: false,
    secret: null,
    desc: "Download counts for the Python packages you publish. No key needed.",
    help: "npm's shape, one registry across. Both services behind this are public, so there is nothing to seal and nothing to verify \u2014 what it needs is the LIST of which packages are yours, shown in full below and readable back so a typo can be corrected rather than becoming a 404 on every run for a week. DOWNLOADS, NEVER INSTALLS: PyPI's counter comes from CDN logs, and a CI job, a Docker layer rebuild and a person typing pip install are one download each with nothing able to tell them apart. MIRRORS ARE EXCLUDED on every request, which makes these figures smaller than pypistats' own default view \u2014 a mirror warming its cache is not demand. pypistats rebuilds its dataset daily, so the last day or two are usually absent rather than zero and the current week is marked partial rather than drawn beside finished ones as a collapse.",
    docs: "https://pypistats.org/",
    fields: [],
    usedBy: [
      "collect_pypi (daily downloads, plus what each package IS from pypi.org)",
      "GET /api/pypi \u2014 per package and the portfolio, ISO weeks marked partial",
    ],
  },
  {
    id: "uptime",
    name: "Uptime",
    icon: null,
    mono: "U",
    tint: "#2E7D6B",
    cat: "infra",
    connected: false,
    secret: null,
    desc: "Is it up, from this machine \u2014 with latency, certificate runway and incidents.",
    help: "THERE IS NOTHING TO AUTHENTICATE AGAINST, which is the point: an uptime check is an ordinary request any stranger could make, and that is exactly what makes it worth making \u2014 it meets the site through the same DNS, the same CDN and the same certificate a visitor does. So \u201cconnected\u201d means there is a list, and the list is below. WHAT THE FIGURES ARE, precisely: `ok` is a final status under 400 after redirects, so a 301 landing on a 200 is up and a 403 is DOWN because the site is not serving your page to your checker; latency is wall clock for the whole exchange including DNS, TLS and every redirect, measured from THIS machine on its own connection, so it is a trend and not a service level; and the certificate figure is days remaining, which goes NEGATIVE when one has expired and is null \u2014 never zero \u2014 when none was read. Checks run about every thirty minutes, so an outage shorter than that is invisible to every number here, and a percentage over fewer than six checks is marked rather than quoted.",
    docs: null,
    fields: [],
    usedBy: [
      "collect_uptime (one check and one TLS probe per host per collection)",
      "GET /api/uptime \u2014 availability, latency percentiles, certificate runway, incidents",
    ],
  },
  {
    id: "fleet",
    name: "Fleet",
    icon: null,
    mono: "F",
    tint: "#8A6BBE",
    cat: "infra",
    connected: false,
    secret: "fleet",
    desc: "Your boxes from the inside, over ssh: memory, disk, load, containers and your own counters.",
    help: "ONE ACCOUNT IS ONE BOX and the account's name is the box's name \u2014 which is why there is no name field here. It sits beside Hetzner rather than inside it because Hetzner measures from the HYPERVISOR and structurally cannot see memory or disk capacity, and because this answers for a box Hetzner never sold: a Pi on the desk, a VPS elsewhere, this laptop. THE KEY IS OPTIONAL, and that is the interesting case: with none, ssh uses your own agent and ~/.ssh defaults, so a box already reachable from this machine's terminal is reachable from here with nothing pasted. With one, it is written to the data directory at 0600 because ssh will not read a private key from a pipe. NOTHING IS INSTALLED ON THE BOX \u2014 one POSIX sh script goes down ssh's stdin per collection and prints one JSON document, so a box that stops being watched needs nothing removed from it. It reads /proc, df, ps and docker ps, and it runs YOUR OWN counter commands and nothing else: there is deliberately no route and no agent action that takes a command, because an agent that could name one would have a shell on every box in this list.",
    docs: null,
    fields: [
      {
        key: "host",
        label: "Address",
        kind: "text",
        ph: "user@host, or user@host:2222",
      },
      {
        key: "key",
        label: "Private key",
        kind: "secret",
        ph: "-----BEGIN OPENSSH PRIVATE KEY----- \u2014 or leave empty to use this machine's own ssh agent",
        optional: true,
      },
    ],
    usedBy: [
      "collect_fleet (one ssh round trip per box: memory, disks, load, containers, counters)",
      "GET /api/fleet and /api/fleet/counters",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "openai",
    cat: "ai",
    connected: true,
    secret: "openai-admin-key",
    desc: "Organisation spend by project, day by day.",
    help: "TWO KEYS THAT DO TWO DIFFERENT JOBS, and neither can do the other's. The ADMIN key (sk-admin-…) reads /v1/organization/costs and is what fills the costs board; a project key is refused there whatever scopes it carries. It is also refused at /v1/chat/completions — probed 2026-09-05, OpenAI answers 401 “Missing scopes: model.request” — so completing through OpenAI needs the second field: an ordinary PROJECT key (sk-proj-…) with model access. Leave that one empty and everything about the bill still works. The Costs API groups by project or by line item and never both, so there is no per-model split to be had from it.",
    docs: "https://platform.openai.com/settings/organization/admin-keys",
    fields: [
      { key: "key", label: "Admin key", kind: "secret", ph: "sk-admin-…" },
      {
        key: "chat-key",
        label: "Inference key (optional)",
        kind: "secret",
        ph: "sk-proj-… — only if you want to CHAT through OpenAI",
        /* Named rather than derived: the derivation for a multi-field plugin
           is `<secret>-<field>`, which would read `openai-admin-key-chat-key`.
           The admin key keeps the plain name it has always had. */
        entry: "openai-chat-key",
        optional: true,
      },
    ],
    usedBy: [
      "collect_openai.py (costs.json)",
      "GET /api/models — completions, when the inference key is set and OpenAI is the default provider",
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "openrouter",
    cat: "ai",
    connected: true,
    secret: "openrouter-key",
    desc: "Credit balance and per-model usage for routed inference.",
    help: "TWO KEYS THAT DO TWO DIFFERENT JOBS. The first must be a MANAGEMENT key: an inference key answers /credits and its own /key and is refused by /activity and /keys with a 403, so it would connect, show a balance and never show what the balance went on. The reverse is just as true — probed 2026-09-05, the management key is refused at /chat/completions with 401 “User not found.” — so completing through OpenRouter needs the second field: an ordinary inference key. Leave it empty and everything about the bill still works. (Its /models catalog answers 200 to no key at all, so a key that lists models has proved nothing.)",
    docs: "https://openrouter.ai/keys",
    fields: [
      { key: "key", label: "Management key", kind: "secret", ph: "sk-or-v1-… (management)" },
      {
        key: "chat-key",
        label: "Inference key (optional)",
        kind: "secret",
        ph: "sk-or-v1-… — only if you want to CHAT through OpenRouter",
        entry: "openrouter-chat-key",
        optional: true,
      },
    ],
    usedBy: [
      "collect_openrouter.py (models.json)",
      "GET /api/models — completions, when the inference key is set and OpenRouter is the default provider",
    ],
  },
  {
    id: "replicate",
    name: "Replicate",
    icon: "replicate",
    cat: "ai",
    connected: true,
    secret: "replicate-token",
    desc: "Image and video model runs for the media workers.",
    help: "Replicate → Account → API tokens. It reads the prediction history — models, outcomes and compute time. It cannot read spend: Replicate publishes no billing endpoint, a prediction carries no hardware or price, and its per-output models are not billed by compute time at all.",
    docs: "https://replicate.com/account/api-tokens",
    fields: [{ key: "token", label: "API token", kind: "secret", ph: "r8_…" }],
    usedBy: ["faceless-worker", "reel-worker", "shorts-worker"],
  },
  {
    id: "hermes",
    name: "Hermes",
    icon: null,
    mono: "H",
    tint: "#2a8c82",
    cat: "ai",
    connected: false,
    secret: "hermes-key",
    desc: "Nous Research’s agent. One of the two that can answer the Chat page.",
    /*
      REWRITTEN AGAINST THE REAL THING, 2026-09-04. The old text said "a CLI
      agent in a container, reached over an OpenAI-compatible endpoint" and
      gave 127.0.0.1:3011 as the address. The first half is right and the
      second was wrong in a way that cost an hour: Hermes is a CLI agent and
      its container listens on NOTHING. Port 3011 on the Pi is workdash's own
      read-only proxy, which answers /v1/models with 200 and an index.html.
      The OpenAI-compatible door Hermes actually ships is `hermes proxy start`.
    */
    help: "TWO WAYS IN. Paste the address of a Hermes that is already running somewhere — any OpenAI-compatible endpoint works, and the model is picked in Settings or left empty to use whichever the endpoint lists first. Or press “Install here” further down and this app installs Hermes into its own data directory, points it at your default model provider, runs it as a child process and connects the plugin for you. The door a managed instance serves is the API SERVER on 127.0.0.1:8642, which runs the agent with its tools and needs no Nous login — NOT `hermes proxy` on 8645, which only forwards to Nous or xAI OAuth and refuses to start without one, and not `hermes serve` on 9119, which is WebSocket JSON-RPC and does not speak this API.",
    docs: "https://hermes-agent.nousresearch.com/docs/",
    fields: [
      {
        key: "base-url",
        label: "Base URL",
        kind: "text",
        ph: "http://127.0.0.1:8645/v1",
        /* Named rather than derived: the derivation for a multi-field plugin
           is `<secret>-<field>`, which would read `hermes-key-base-url`. The
           server's stem is `hermes`, so these are the real entry names. */
        entry: "hermes-base-url",
      },
      {
        key: "key",
        label: "API key",
        kind: "secret",
        ph: "the Nous Portal key, or any value for a local proxy",
        entry: "hermes-key",
      },
    ],
    usedBy: [
      "POST /api/chat — when Hermes is the live chat backend",
      "GET /api/agents — the managed instance: installed, running, and what it is pointed at",
    ],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    icon: null,
    mono: "C",
    tint: "#e2543b",
    cat: "ai",
    connected: false,
    secret: "openclaw-token",
    desc: "The same job as Hermes, on the open-source gateway instead.",
    /*
      ALSO REWRITTEN AGAINST A REAL GATEWAY (openclaw 2026.9.1, run locally on
      2026-09-04). The old text sent you to POST /tools/invoke, which is a real
      endpoint and the wrong one for a conversation: its DEFAULT HARD DENY LIST
      includes `sessions_send`, the tool that would deliver a message to an
      agent. The chat surface is the OpenAI-compatible one — and it is OFF
      until you switch it on, which is the single most useful sentence on this
      page.
    */
    help: "TWO WAYS IN. Paste the address of a gateway you already run — 127.0.0.1:18789 by default — with its shared secret. Or press “Install here” further down and this app npm-installs a pinned OpenClaw into its own data directory, writes a config pointing it at your default model provider, runs it as a child process and connects the plugin for you. Either way a chat turn goes to POST /v1/chat/completions addressed to openclaw/default — NOT to /tools/invoke, whose hard deny list blocks sessions_send. That endpoint is OFF by default: gateway.http.endpoints.chatCompletions.enabled = true is what turns it on, and without it /v1/models answers 404 while /health answers 200. The bearer here is operator access to the ENTIRE gateway rather than a scoped API key, so it stays on the server and this refuses to send it in the clear to anything outside your own network.",
    docs: "https://docs.openclaw.ai/gateway/openai-http-api",
    fields: [
      {
        key: "gateway-url",
        label: "Gateway URL",
        kind: "text",
        ph: "http://127.0.0.1:18789",
        /* The server's stem is `openclaw`; see the note on Hermes' fields. */
        entry: "openclaw-gateway-url",
      },
      {
        key: "token",
        label: "Bearer token",
        kind: "secret",
        ph: "openclaw gateway auth-token --show",
        entry: "openclaw-token",
      },
    ],
    usedBy: [
      "POST /api/chat — when OpenClaw is the live chat backend",
      "GET /api/agents — the managed instance: installed, running, and what it is pointed at",
    ],
  },
  /*
    LOCAL MODELS — ONE ENTRY FOR EVERY OpenAI-COMPATIBLE SERVER, and that is a
    decision rather than laziness.

    Ollama, LM Studio, vLLM, llama.cpp's server and a hand-rolled FastAPI all
    answer `GET /v1/models` and `POST /v1/chat/completions`, and the
    differences between them are in what they RUN rather than in how they are
    asked. A tile per product would be five tiles holding one adapter, and a
    sixth the day somebody ships a new runner — so there is one, its credential
    is a URL, and the product's name is what you type in the account's label.

    IT IS ALSO THE ONE PLUGIN HERE WHERE MORE ACCOUNTS MEANS MORE THROUGHPUT.
    Everywhere else a second account is a second thing to read — another
    Hetzner project, another mailbox. Two local endpoints are two machines that
    can each take a completion, spread across by the policy on this page.
  */
  {
    id: "local",
    name: "Local models",
    icon: null,
    mono: "L",
    tint: "#4c8c5a",
    cat: "ai",
    connected: false,
    /* The stem, not an entry: with two fields the names are `<stem>-<field>`,
       so the first endpoint holds `local-base-url` and, if it needs one,
       `local-key`. */
    secret: "local",
    desc: "Ollama, LM Studio, vLLM — anything on this machine that speaks the OpenAI wire.",
    help: "Paste the base URL the runner printed when it started: Ollama is http://127.0.0.1:11434, LM Studio 1234, vLLM 8000, llama.cpp 8080. The origin on its own is fine — /v1 is added when it is missing, and Ollama's own /api is a DIFFERENT, non-OpenAI surface from the /v1 this uses. The key is optional and normally empty: these runners ship with no auth and bind to loopback, which is the access control. An endpoint that is NOT on your own network is refused without one, and a key is never sent in the clear over plain http to such a host. Each endpoint is its own account, and they all answer — how many calls run at once, and which box takes the next one, are the policy settings on this page.",
    docs: "https://ollama.com/",
    fields: [
      {
        key: "base-url",
        label: "Base URL",
        kind: "text",
        ph: "http://127.0.0.1:11434/v1",
        entry: "local-base-url",
      },
      {
        key: "key",
        label: "Bearer token (optional)",
        kind: "secret",
        ph: "usually empty — vLLM's --api-key, or a proxy in front",
        entry: "local-key",
        optional: true,
      },
    ],
    usedBy: [
      "GET /api/models — completions, when this is the default provider",
      "POST /api/chat — when no agent is live and this is the default provider",
    ],
  },
  {
    id: "freellmapi",
    name: "FreeLLMAPI",
    icon: null,
    mono: "F",
    tint: "#7C5CE6",
    cat: "ai",
    connected: true,
    /* The STEM, not an entry: two fields, so the vault holds
       `freellmapi-base-url` and `freellmapi-key` — the second being the name
       workdash's own vault already uses. */
    secret: "freellmapi",
    desc: "One key in front of every provider with a free tier — hosted, or installed here.",
    /*
      REWRITTEN AGAINST THE REAL THING (repo at 1edb8d5, probed 2026-09-05).
      The old entry described this as "the in-house catalog API — licence
      checks and free-tier routing", which is a different service: the catalog
      API at api.freellmapi.co sells the live model list and completes nothing.
      FreeLLMAPI itself is an OpenAI-compatible GATEWAY, and the thing worth
      saying on this page is that THERE IS NO HOSTED ONE — freellmapi.co is a
      static marketing site whose /v1 paths 404 — so the base URL is always
      somebody's own instance, and this box can be one of them.
    */
    help: "An OpenAI-compatible gateway that holds keys for the ~34 providers with a free tier and routes each completion to whichever can serve it, failing over when one is throttled. THERE IS NO HOSTED FREELLMAPI: freellmapi.co is a marketing site and api.freellmapi.co is its catalog-and-licence API — neither completes a chat turn — so the base URL is an instance somebody runs. Two ways to have one, and this page offers both. Point it at one you already run (the Hetzner box answers at https://freellm.178-105-187-189.sslip.io/v1) and paste the unified key from that instance's own Keys page, which begins `freellmapi-`. Or install one here: the server clones the repo at a commit it writes down, builds it, and runs it as a child process on 127.0.0.1:3001 — loopback only, stopped when this API stops. That one needs nothing pasted at all, because the gateway mints its own key into its database on first migration and the server reads it straight into the vault. Both end up as accounts of this plugin, so switching which one answers is a click. A freshly installed gateway routes to nothing until it has provider keys, so the first start switches on the two providers that work anonymously; add your own on its dashboard at http://127.0.0.1:3001, which no setup code is needed for from a browser on this machine.",
    docs: "https://github.com/tashfeenahmed/freellmapi",
    fields: [
      {
        key: "base-url",
        label: "Base URL",
        kind: "text",
        ph: "https://freellm.178-105-187-189.sslip.io/v1",
        entry: "freellmapi-base-url",
      },
      {
        key: "key",
        label: "Unified key",
        kind: "secret",
        ph: "freellmapi-…, from that instance's Keys page",
        entry: "freellmapi-key",
      },
    ],
    usedBy: [
      "models/provider.ts — every completion, when it is the default provider",
      "freellmapi/instance.ts — the copy installed under data/freellmapi/",
    ],
  },
  {
    id: "voice",
    name: "Voice",
    icon: null,
    mono: "V",
    tint: "#C2703D",
    cat: "ai",
    connected: false,
    secret: "voice",
    desc: "Transcription in and speech out, so a voice note to the bot is answered like anything else.",
    help: "TWO OPENAI-COMPATIBLE ENDPOINTS YOU NAME, and no model runs here. The transcription endpoint may be a whisper server on this laptop, a box on the LAN, or api.openai.com, and BOTH KEYS ARE OPTIONAL because a local server wants no Authorization header at all and sending it an empty one is how a working endpoint starts refusing. What is verified is therefore the ENDPOINT rather than the credential: half a second of silence posted to /audio/transcriptions, which has to come back as JSON with a text field. SPEECH IS OFF UNTIL YOU CHOOSE IT and `off` is a real value \u2014 it costs money on a hosted endpoint and disk on a local one, and a dashboard that starts talking because it could is one somebody turns off entirely. \u201cConnected\u201d here means an endpoint is SET; whether it answers is what the probe says, and the two are kept as separate sentences everywhere. Nothing said is stored: no word and no byte of audio is kept, and a transcript goes where the typed message would have gone.",
    docs: "https://platform.openai.com/docs/api-reference/audio",
    fields: [
      {
        key: "sttKey",
        entry: "voice-stt-key",
        label: "Transcription key",
        kind: "secret",
        ph: "sk-\u2026 \u2014 leave empty for a local server, which wants no header at all",
        optional: true,
      },
      {
        key: "ttsKey",
        entry: "voice-tts-key",
        label: "Speech key",
        kind: "secret",
        ph: "the key for the speech endpoint, when it is a hosted one",
        optional: true,
      },
    ],
    usedBy: [
      "telegram bridge (a voice note is transcribed and answered like a typed message)",
      "GET /api/voice, POST /api/voice/transcribe and /api/voice/speak",
    ],
  },
  {
    id: "gmail",
    name: "Gmail",
    icon: "gmail",
    cat: "comms",
    connected: true,
    /* The stem, not an entry: with three fields the entry names are
       `<stem>-<field>`, so the vault holds `gmail-client-id`,
       `gmail-client-secret` and `gmail-refresh-token`. */
    secret: "gmail",
    desc: "Inbox triage, the daily mail line, and who you actually write to.",
    /*
      THREE FIELDS RATHER THAN THE TWO JSON DOCUMENTS WORKDASH KEEPS, and the
      reason is that the second one already contains the first: gmail-token.json
      carries client_id, client_secret and refresh_token together, so the client
      file is the same pair written down twice. Split into fields for the reason
      AdSense is — a JSON blob in a secret is a document that has to be parsed
      before anything can be checked, and a typo inside it fails as "the grant
      was refused" rather than as "the client secret is missing".

      THE SCOPE IS SAID OUT LOUD BECAUSE IT MATTERS. The token gmail_auth.py
      mints carries gmail.modify — a WRITE scope — because workdash's own mail
      page sends replies with it. This dashboard only reads, and enforces that
      in code rather than in a promise: the provider has one HTTP entry point,
      it hard-codes GET, and it takes no body.
    */
    help: "Run gmail_auth.py once and paste the three values out of the gmail-token.json it writes: client_id, client_secret and refresh_token. The token it mints carries gmail.modify — Google offers no way to narrow a token after the fact, and a gmail.readonly one needs a second trip through a consent screen. This dashboard never exercises the write half: its provider has a single HTTP entry point that hard-codes GET and takes no body, so there is no send, archive or trash path in it at all. Nothing it reads carries a subject, a body or a correspondent's address — every request goes out with a fields mask, and the one call that reads headers reads To and Cc off your own SENT mail and turns each address into an HMAC before it leaves the process.",
    docs: "https://console.cloud.google.com/apis/credentials",
    fields: [
      { key: "client-id", label: "OAuth client ID", kind: "text", ph: "…apps.googleusercontent.com" },
      { key: "client-secret", label: "OAuth client secret", kind: "secret", ph: "GOCSPX-…" },
      { key: "refresh-token", label: "Refresh token", kind: "secret", ph: "1//0e…" },
    ],
    usedBy: [
      "collect_inbox.py (inbox.json) — workdash",
      "collect_contacts.py (contacts.json) — workdash",
      "GET /api/mail — the mailbox, its queue, its daily line and who you wrote to",
    ],
  },
  {
    id: "resend",
    name: "Resend",
    icon: "resend",
    cat: "comms",
    connected: true,
    secret: "resend-key",
    desc: "Every sending domain: verification, DNS, and what became of the mail.",
    /*
      ONE KEY PER ACCOUNT, WHERE WORKDASH KEEPS ELEVEN IN ONE DOCUMENT.

      Over there this is `resend-keys.json`, a JSON object of domain → key. That
      shape has no per-key label, no per-key state and no per-key error, so one
      revoked key shows up as a warning on the plugin rather than as
      "example-app-1.example.test stopped answering" — which is exactly what the accounts
      model exists to undo, and what 005_accounts_split did to the Hetzner
      token blob. Each key is an account here, named for its domain.

      A key really is scoped to its domain: probed live, one key's /domains and
      /emails both return that domain and nothing else. So eleven accounts is
      not tidiness, it is the only arrangement that can see everything.

      THE FIELD ASKS FOR FULL ACCESS ON PURPOSE. A Sending-access key answers
      401 "restricted to only send emails" to every endpoint this reads, so it
      would connect and then report a permanently empty domain. It is refused at
      the door with Resend's own sentence instead.
    */
    help: "Resend → API keys → Create, with FULL access, one per sending domain — then add one account here per domain and name each for it. A Sending-access key is refused: it can POST an email and read nothing at all, and everything this reads is a GET. Nothing here can send, either: the provider has a single HTTP entry point that hard-codes GET and takes no body, so POST /emails is unreachable from it. Recipients and subjects come back on Resend's /emails rows and neither is stored or served — what is kept is the day, your own from-address, and the delivery outcome.",
    docs: "https://resend.com/api-keys",
    fields: [
      { key: "key", label: "API key (full access)", kind: "secret", ph: "re_…" },
    ],
    usedBy: [
      "agent/outbox.js (drafts, sends) — workdash",
      "GET /api/mail — verification, DNS health, sends and bounces per domain",
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    icon: "telegram",
    cat: "comms",
    connected: true,
    secret: "telegram-token",
    desc: "Talk to the agent from your phone — and where alerts land.",
    help: "A bot token from @BotFather. The chat id is discovered on the first message the bot receives, so send it one after pasting this — that first message PAIRS the bot, and every message from any other chat is ignored from then on and never reaches the agent. Clear the paired chat in Settings below to hand the bot to a different chat.",
    docs: "https://core.telegram.org/bots#botfather",
    fields: [
      { key: "token", label: "Bot token", kind: "secret", ph: "123456:AA…" },
    ],
    usedBy: ["chat bridge (this app)", "notifier (alerts)"],
  },
  {
    id: "calendar",
    name: "Google Calendar",
    icon: "googlecalendar",
    cat: "comms",
    connected: false,
    secret: "calendar",
    desc: "Today and the week ahead: what is booked, and how many hours of it there are.",
    help: "THE SAME OAUTH CLIENT AS GMAIL, A DIFFERENT SCOPE, and that is the whole reason this is a second plugin. Google grants scopes at the consent screen, per grant, and nothing on this box can widen one \u2014 so the refresh token in the Gmail plugin was minted for gmail.modify and can no more read a calendar than a Hetzner token can read Stripe. Rerun the consent flow with calendar.readonly ticked, paste the same client id and secret beside the NEW refresh token, and the check here refuses the mail token by name rather than storing it to 403 forever. READ-ONLY STRUCTURALLY: one function reaches Google here and it is a GET with no body parameter, so even a token carrying the wider calendar scope cannot create, move or cancel anything from this box. NOTHING PRIVATE IS HELD \u2014 no event description is stored or even fetched and no attendee is ever named: the attendee field is a count and the response is your own answer. Busy hours MERGE overlapping events rather than adding them, and an all-day event contributes no hours at all because there is no honest number for one.",
    docs: "https://console.cloud.google.com/apis/credentials",
    fields: [
      {
        key: "client-id",
        entry: "calendar-client-id",
        label: "OAuth client ID",
        kind: "secret",
        ph: "the same Desktop app client Gmail uses",
      },
      {
        key: "client-secret",
        entry: "calendar-client-secret",
        label: "Client secret",
        kind: "secret",
        ph: "issued with the client ID",
      },
      {
        key: "refresh-token",
        entry: "calendar-refresh-token",
        label: "Refresh token",
        kind: "secret",
        ph: "minted with access_type=offline AND calendar.readonly \u2014 not the Gmail one",
      },
    ],
    usedBy: [
      "collect_calendar (7 days back, 21 ahead, across the calendars ticked in Google)",
      "GET /api/calendar \u2014 today, the week, busy hours and the calendars list",
    ],
  },
  {
    id: "pexels",
    name: "Pexels",
    icon: "pexels",
    cat: "media",
    connected: true,
    secret: "pexels-key",
    desc: "Stock footage and stills for the short-form pipeline.",
    help: "Pexels → Image & Video API → your API key. Free tier, 200 requests an hour, which the workers stay well under.",
    docs: "https://www.pexels.com/api/",
    fields: [{ key: "key", label: "API key", kind: "secret", ph: "563492ad…" }],
    usedBy: ["faceless-worker", "reel-worker"],
  },
  {
    id: "pixabay",
    name: "Pixabay",
    icon: "pixabay",
    cat: "media",
    connected: false,
    secret: "pixabay-key",
    desc: "Second stock source, used when Pexels has no match.",
    help: "Pixabay → API docs, key shown when signed in. Configured as a fallback, so an empty result here is not an error.",
    docs: "https://pixabay.com/api/docs/",
    fields: [
      { key: "key", label: "API key", kind: "secret", ph: "12345678-…" },
    ],
    usedBy: ["faceless-worker (fallback)"],
  },
  /*
    THE THREE DEMAND SOURCES. All three are now backed by this dashboard's own
    API rather than described from workdash, so `connected` here is the
    catalog's fallback claim and the plugin page reads the real state off
    /api/plugins — the AdSense correction, applied before the mistake could be
    made: a flag that says "Connected" about a credential nobody has pasted is
    a mock value presented as a measurement.
  */
  {
    id: "searxng",
    name: "SearXNG",
    icon: "searxng",
    cat: "signals",
    connected: false,
    secret: "searxng-key",
    desc: "The search node behind every agent lookup — install one here, or point at one you run.",
    help: "TWO WAYS IN. Install it here and the server clones SearXNG, builds it into its own virtualenv with uv and runs it as a child process on 127.0.0.1:8888 — no Docker, no key, and it connects itself the moment it answers, because a loopback bind is the whole of the access control. Or point at a node you already run: its address goes in the search endpoint setting and its API key in the credentials, travelling as an x-api-key HEADER (the same key as a ?key= parameter is refused 401, and a key in a URL is a key in an access log). That key belongs to the proxy in front of a public instance, not to SearXNG, which has no key auth of its own. Either way, agents search through GET /api/search?q=… and never learn which of the two answered. The node publishes no count of the searches made against it — /stats is HTML and counts engines — so what is measured here is whether a search made right now answers, and which engines served it.",
    docs: "https://docs.searxng.org/",
    fields: [
      {
        key: "key",
        label: "API key",
        kind: "secret",
        ph: "the value SEARXNG_API_KEY was set to on the node",
      },
    ],
    usedBy: [
      "agent/websearch.js (search_web, research, competitors)",
      "collect_demand.py (reddit fallback tier)",
    ],
  },
  {
    id: "reddit",
    name: "Reddit",
    icon: "reddit",
    cat: "signals",
    connected: false,
    secret: "reddit-feed",
    desc: "Demand signals from Reddit search. The Atom feed — there is no key to be had.",
    help: "Self-serve API app registration closed in Nov 2025 and the anonymous .json endpoints answer 403, so this runs on search.rss with upvote counts from the Arctic Shift archive. It works with no credential at ONE QUERY A MINUTE, which is Reddit's own published limit — so a collection asks one phrase and the rest go next time. The RSS token from reddit.com/prefs/feeds lifts that: no developer app, one settings page, and the whole watch list every collection. What to watch for is a setting, under Settings below.",
    docs: "https://www.reddit.com/prefs/feeds/",
    fields: [
      {
        key: "feed",
        label: "Personal feed token",
        /* A SECRET RATHER THAN A TEXT FIELD, despite looking like a URL: it is
           a bearer credential for one account's own feeds, and anybody holding
           it can read that account's front page. */
        kind: "secret",
        ph: 'https://reddit.com/.rss?feed=…&user=… — or the {"user": …, "feed": …} pair',
      },
    ],
    usedBy: ["collect_demand.py (demand.json)"],
  },
  {
    id: "hackernews",
    name: "Hacker News",
    icon: "ycombinator",
    cat: "signals",
    connected: false,
    secret: null,
    desc: "Mentions and launch chatter, via the Algolia search API. No key, a watch list instead.",
    help: "The HN Algolia API is public and free, so there is no credential — what it needs is the same watch list Reddit uses, and it is ONE list: editing it on either page changes both, because a phrase is the same phrase whichever site it was said on. Comments are searched as well as stories, which is where the “I wish something did X” sentences are; the index publishes no score for a comment, so those rows carry none rather than a zero.",
    docs: "https://hn.algolia.com/api",
    fields: [],
    usedBy: [
      "collect_demand.py (demand.json)",
      "collect_presence.py (presence.json)",
    ],
  },
  {
    id: "product-stats",
    name: "Product endpoints",
    icon: null,
    mono: "E",
    tint: "#4C7DBF",
    cat: "signals",
    connected: false,
    secret: "product",
    desc: "The numbers a business knows about itself, read from its own JSON endpoint.",
    help: "Stripe knows what was paid and Umami knows who visited; neither knows how many reels were rendered yesterday or how many applications are in the index. The product knows, and the cheapest honest way to get it here is the way the product already publishes it. ONE ACCOUNT IS ONE ENDPOINT and the account's name is the product's name. The token is optional because most of these are public or carry their secret in a URL you pasted; when there is one it goes out as a bearer. WHICH NUMBERS MATTER IS A SETTING, one line per metric as \u201clabel = path.to.the.number\u201d, because a collector that walked the JSON and recorded every number it found would fill the database with version strings and port numbers. The last document is kept so that editing a line is answered immediately \u2014 \u201cthat path matches nothing in what this endpoint returns\u201d \u2014 rather than half an hour later as a chart of zeroes. A PATH THAT RESOLVES TO NOTHING IS A MAPPING ERROR AND NEVER A ZERO: an endpoint answering 0 and an endpoint with no such field are different facts about the business.",
    docs: null,
    fields: [
      {
        key: "url",
        label: "Endpoint",
        kind: "text",
        ph: "https://app.example.com/api/stats.json",
      },
      {
        key: "token",
        label: "Bearer token",
        kind: "secret",
        ph: "only if the endpoint needs one",
        optional: true,
      },
    ],
    usedBy: [
      "collect_products (one fetch per endpoint, the document kept and the mapped numbers recorded)",
      "GET /api/products \u2014 per endpoint, per metric, with every mapping error named",
    ],
  },
  {
    id: "presence",
    name: "Presence",
    icon: null,
    mono: "P",
    tint: "#B4694E",
    cat: "signals",
    connected: false,
    secret: null,
    desc: "Where each product exists on somebody else's site \u2014 nine directories, no key.",
    help: "Every other measurement here is of something you own. This one is the opposite: whether anybody ELSE has a page about a product, because that is what an answer engine reads when it decides whether a brand is real. A site can pass every SEO check ever written and still be a thing only its owner has mentioned. NO CREDENTIAL \u2014 a list instead, one product per line as `Name = host`, and both halves are needed: the name is what a directory would have called it, and the host is what proves a record found that way is yours. `BLOCKED` IS NOT `ABSENT` and confusing them is the worst mistake available on this page: a 403 from a firewall, a rate limit, a timeout, or a directory like Capterra whose urls carry an id no name can derive, all mean the source could not be ASKED. Present from a search-shaped source needs the record to name the brand AND point back at the host \u2014 half these names are two ordinary English words and strangers own projects with the same ones, so a record that only names it is stored as a candidate for you to judge. Nothing here is a submission and nothing counts as done.",
    docs: null,
    fields: [],
    usedBy: [
      "collect_presence (nine sources per product, once a day)",
      "GET /api/presence \u2014 the product \u00d7 source matrix, with blocked kept apart from absent",
    ],
  },
];
