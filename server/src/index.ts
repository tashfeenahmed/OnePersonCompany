/**
 * The API.
 *
 * It exists because the browser cannot hold these credentials. A Hetzner token
 * in a Vite bundle is a Hetzner token given to anyone who opens the page, and
 * Hetzner's API sends no CORS headers anyway, so the call has to happen
 * somewhere with a process. That somewhere is here.
 *
 * It binds to loopback by default. The dashboard is a personal tool on a
 * personal network, and a service that can read the bill should not be
 * listening on every interface because a default said so.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { COLLECT_MINUTES, LOAD_RETAIN_DAYS, PORT, RETAIN_DAYS } from "./config.ts";
import { allPlugins, prune, ventureRows } from "./db.ts";
import { COLLECTORS as BUILTIN_COLLECTORS } from "./collector.ts";
import { MANIFESTS, manifestCollectors } from "./integrations/index.ts";

/* Built-in collectors plus each integration area's — see integrations/manifest.ts. */
const COLLECTORS: Record<string, () => Promise<{ ok: boolean; error?: string | null }>> = {
  ...BUILTIN_COLLECTORS,
  ...manifestCollectors(),
};
import { plugins } from "./routes/plugins.ts";
import { hetznerRoutes } from "./routes/hetzner.ts";
import { metrics } from "./routes/metrics.ts";
import { domains } from "./routes/domains.ts";
import { stock } from "./routes/stock.ts";
import { pluginConfig } from "./routes/pluginConfig.ts";
import { githubRoutes } from "./routes/github.ts";
import { npmRoutes } from "./routes/npm.ts";
import { costs } from "./routes/costs.ts";
import { stripeRoutes } from "./routes/stripe.ts";
import { adsenseRoutes } from "./routes/adsense.ts";
import { mobile } from "./routes/mobile.ts";
import { cloudflareRoutes } from "./routes/cloudflare.ts";
import { gscRoutes } from "./routes/gsc.ts";
import { bingRoutes } from "./routes/bing.ts";
import { metaRoutes } from "./routes/meta.ts";
import { demandRoutes } from "./routes/demand.ts";
import { telegramRoutes } from "./routes/telegram.ts";
import { mail } from "./routes/mail.ts";
import { mailbox } from "./routes/mailbox.ts";
/*
  THE CHAT ROUTES, AND WHY THIS IMPORT LINE IS LOAD-BEARING RATHER THAN
  ALPHABETICAL.

  chat/backend.ts holds a registry that adapters fill at IMPORT TIME: each of
  providers/hermes.ts and providers/openclaw.ts calls `registerBackend` as a
  side effect of being loaded, and `activeBackend()` can only return a backend
  that has registered. That file says so in its own header ("The order of
  `import` lines in index.ts is therefore load-bearing and is commented
  there") — this is there.

  routes/chat.ts imports both adapters itself, so importing it is enough: by
  the time this line has run, both are registered and `setChoiceReader` has
  been handed the config reader. Nothing below may reach `ask()` before this
  line, which today nothing does. The alternative — importing the two providers
  here for their side effects — was declined because a bare `import
  "./providers/hermes.ts"` with no binding is exactly the line somebody removes
  as dead six months from now, and the failure would be a chat page reporting
  "no agent is connected" with a perfectly good key in the vault.
*/
import { chat } from "./routes/chat.ts";
/*
  THE MODELS ROUTES, AND THIS IMPORT IS LOAD-BEARING FOR THE SAME REASON THE
  ONE ABOVE IT IS — one layer down.

  models/provider.ts holds a registry that adapters fill at IMPORT TIME:
  providers/local.ts, providers/openai-chat.ts and providers/openrouter-chat.ts
  each call `registerProvider` as a side effect of being loaded, and
  `activeProvider()` can only return a provider that has registered.
  routes/models.ts imports all three itself and hands `setProviderChoiceReader`
  the config reader, so importing it is enough.

  IT MUST COME AFTER routes/chat.ts AND IT DOES. Nothing enforces that today —
  the two registries are independent — but the chat route's fallback asks
  `activeProvider()` when no agent is live, and a build where the providers had
  not registered yet would answer "no provider" with three of them connected.
  Keeping the pair in this order means the question is never asked before the
  answer exists.
*/
import { models } from "./routes/models.ts";
import { searchRoutes, searxngRoutes } from "./routes/searxng.ts";
/*
  THE MODEL GATEWAY, AND THIS IMPORT IS LOAD-BEARING FOR THE SAME REASON THE
  CHAT ONE ABOVE IS.

  models/provider.ts holds a registry that adapters fill at IMPORT TIME:
  providers/freellmapi.ts calls `registerProvider` as a side effect of being
  loaded, and `activeProvider()` can only return a provider that has
  registered. routes/freellmapi.ts imports the adapter itself, so importing it
  is enough — and routes/plugins.ts imports it too, for `verify`, which means
  the registration happens whichever of the two loads first.
*/
import { freellmapiRoutes } from "./routes/freellmapi.ts";
import * as telegramPoller from "./telegram/poller.ts";
import * as searxngInstance from "./searxng/instance.ts";
import * as freellmapiInstance from "./freellmapi/instance.ts";
import { agentRoutes } from "./routes/agents.ts";
import { boardRoutes } from "./routes/board.ts";
import { ventureRoutes } from "./routes/ventures.ts";
import { enrichVenture, readBrand } from "./ventures/enrich.ts";
import { skillRoutes } from "./routes/skills.ts";
import * as agentInstances from "./agents/instance.ts";

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: (o) => (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o) ? o : null),
    credentials: true,
  }),
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    now: new Date().toISOString(),
    collectors: Object.keys(COLLECTORS),
    collectEveryMinutes: COLLECT_MINUTES,
  }),
);

app.route("/api/plugins", plugins);
app.route("/api/hetzner", hetznerRoutes);
app.route("/api/metrics", metrics);
app.route("/api/domains", domains);
app.route("/api/stock", stock);
/* The settings half of /api/plugins, mounted beside the credential half
   rather than inside it: it owns `/:id/config` and nothing else, which keeps
   the file that can write to the vault as small as it was. */
app.route("/api/plugins", pluginConfig);
app.route("/api/github", githubRoutes);
app.route("/api/npm", npmRoutes);
/* One route for the whole costs board — the three providers that report spend
   and compute, each in its own units, with no total across currencies. */
app.route("/api/costs", costs);
/* The two revenue providers, on two routes rather than one. Stripe measures
   settled money and AdSense an ad network's own estimate of what a day earned;
   they are not the same kind of number, and a single /api/revenue would be an
   invitation to add them. Neither route offers a total across the pair. */
app.route("/api/stripe", stripeRoutes);
app.route("/api/adsense", adsenseRoutes);
/* One route for both app stores — each store's estimate and its payout kept
   apart, every figure per currency, and no total across them. */
app.route("/api/mobile", mobile);
/* The zones, their records and their daily traffic — plus the join this box is
   uniquely able to make: Cloudflare knows which nameservers it assigned, the
   registrars know which the domain actually delegates to, and neither of them
   knows the other. */
app.route("/api/cloudflare", cloudflareRoutes);
/* The two search engines, on two routes rather than one. Google's impressions
   and Bing's count different searches on different networks under different
   anonymisation rules, and a single /api/search would be an invitation to add
   them — the same reason revenue is two routes rather than one. Only one of
   the two can answer what people search for that nothing of ours ranks for. */
app.route("/api/gsc", gscRoutes);
app.route("/api/bing", bingRoutes);
/* The Pages, the ad account and what it spent — and, in the same document, the
   Instagram answer, because Instagram is a field on a Page rather than an API
   of its own. There is no /api/instagram and there should not be: a second
   route would be a second fetch to re-read a field this one already has. */
app.route("/api/meta", metaRoutes);
/* Reddit, Hacker News and the search node behind both — one route, because a
   THREAD is a thread whichever site it was posted on and "is anybody talking
   about this at all" is a question about both. It is the opposite of the split
   the search engines take and passes the same test: there is a figure that
   legitimately spans these sources, and there is none that spans those. Upvotes
   are still never added across them, and the document says so. */
app.route("/api/demand", demandRoutes);
/* The Telegram bridge, which is the one integration here that is a DOOR rather
   than a measurement: a bot anybody can message, wired to the agent. So this
   route reports the thing no other plugin has to — whether the poller is
   actually running, which chat it is locked to, and how many messages from
   other chats it has thrown away. */
app.route("/api/telegram", telegramRoutes);
/* Mail, as ONE route over two providers — the mailboxes and the sending
   domains, what is waiting in the first and what came of the second. The same
   shape /api/mobile takes over two app stores, and for the same reason: the
   Email page asks one question of two ends of the same pipe, and a page that
   fetched two documents and joined them is a page that eventually joins them
   wrongly. No figure on it spans the two halves. */
app.route("/api/mail", mail);
/* The mailbox itself — the threads, the reader, and what the products sent.
   A SEPARATE ROUTE FROM /api/mail RATHER THAN A SECTION OF IT, because the two
   keep opposite contracts and folding them together would blur the one that
   matters. /api/mail reads tables whose schema cannot hold a subject; this
   reads Gmail live, on every request, and stores nothing at all. One document
   holding both would be one field away from a body being written down. It also
   holds the only write on this server, which is marking a thread read — named
   there and at providers/gmail.ts, and unable to be anything else. */
app.route("/api/mailbox", mailbox);
/* The agent, whichever one it is today. ONE route rather than /api/hermes and
   /api/openclaw, and that is the whole architecture in a line: a caller never
   learns which agent answered it except as a fact ON the answer, so switching
   the live backend changes nothing about how anything asks. The two
   integrations keep their credential pages under /api/plugins like every other
   plugin; this is where they are talked to. */
app.route("/api/chat", chat);
/* WHERE THE COMPLETIONS COME FROM, as against who does the thinking. /api/chat
   is the AGENT — Hermes or OpenClaw, one of them, with tools and memory.
   This is the layer beneath: which provider completes, how many calls it will
   take at once, and how they are spread over several endpoints. An agent
   spawned here inherits the default set on this route, and /api/chat falls
   through to it when no agent is live — so a plain chat with nothing in front
   of it still answers, and says which provider answered. */
app.route("/api/models", models);
/* The locally installed search node: what is on disk, what is running, and the
   two buttons that change either. It is the only integration this box can
   INSTALL rather than merely connect to, so it is the only one with a route
   about a process of its own. */
app.route("/api/searxng", searxngRoutes);
/* The model gateway as a PROCESS, beside /api/models rather than inside it.
   That route is the seam — which of the four providers is the default, and
   what the limiter is doing — in terms every provider shares. This one is
   about the single thing no other provider has: a program on this machine
   that this process cloned, built, runs, and can leave orphaned on a port. It
   is also where the second account comes from: the installer reads the key the
   gateway minted into its own database and seals it, so "install here" ends
   with a connected provider rather than a running process and an empty form. */
app.route("/api/freellmapi", freellmapiRoutes);
/* The two agents as PROCESSES: what is installed, what is running, which model
   provider each is pointed at, and which one is live. One route for both
   rather than /api/hermes and /api/openclaw, which is the same argument
   /api/chat makes one screen up — a caller never learns which agent answered
   it except as a fact on the answer. Their credential pages stay under
   /api/plugins like every other plugin. */
app.route("/api/agents", agentRoutes);
/*
  THE SEARCH TOOL, AND IT IS NOT THE `/api/search` THIS FILE ARGUES AGAINST
  ABOVE. That argument is about a REPORT over Google's and Bing's figures —
  two populations that must never be added — and it stands. This route
  measures nothing: it performs a search through whichever SearXNG instance is
  active and hands back the links, which is the one thing on this box an agent
  calls rather than reads. GET, no key, no body, no client: an agent that can
  fetch a URL can use it, and so can a person with curl.
*/
app.route("/api/search", searchRoutes);
/*
  THE BOARD — the first route here that stores what the OWNER typed rather than
  what a provider reported. Every other route on this server is a window onto a
  collector's transcript, where a row is replaced the moment the next
  collection disagrees with it; these rows are the record, and nothing
  collects them. It is mounted last for that reason rather than by accident:
  it depends on no credential, no provider registry and no import order at
  all, so there is nothing above it that it needs to have run.
*/
app.route("/api/board", boardRoutes);
/*
  THE VENTURES — the businesses every other route on this server is measuring
  something about, and the second thing here that stores what the OWNER typed.
  Mounted beside the board for the reason the board is mounted last: it depends
  on no credential, no provider registry and no import order.

  It is the route that makes `venture_id` on a board card mean something, and
  the one the agent reads to find out what STAGE a business is at — which is
  the field that decides whether "how is it doing" is a question about demand
  or about churn. See routes/ventures.ts for why that moved off the browser.
*/
app.route("/api/ventures", ventureRoutes);
/*
  THE SKILLS SURFACE — the same data every route above already serves, in the
  one shape an AGENT can learn. It is mounted last, beside the board, because
  it depends on nothing here: it holds a registry of paths in code and reaches
  the routes above over loopback exactly as a person with curl would, so there
  is no import order it could be wrong about and no provider registry it needs
  to have been filled.

  It is deliberately NOT a nineteenth data route. Nothing on it measures
  anything; it is a directory of what the others measure, plus a GET-only
  proxy so an agent has one base URL rather than nineteen paths and four
  different parameter names to remember.
*/
app.route("/api/skills", skillRoutes);

/* Every integration area's routers, at the paths their manifests name. */
for (const m of MANIFESTS) for (const r of m.routes ?? []) app.route(r.path, r.app);

app.notFound((c) => c.json({ error: "No such route." }, 404));

app.onError((err, c) => {
  console.error("[api]", err);
  return c.json({ error: err.message }, 500);
});

/* ------------------------------------------------------------- schedule */

/**
 * A plain interval rather than cron. There is one process, the cadence is
 * "every so often" rather than "at 03:00", and a missed tick while the laptop
 * was asleep should just be the next tick — not a backlog to catch up on.
 */
if (COLLECT_MINUTES > 0) {
  const everyMs = COLLECT_MINUTES * 60_000;
  setInterval(() => {
    void (async () => {
      for (const row of allPlugins()) {
        const collector = COLLECTORS[row.id];
        if (!collector || row.connected !== 1) continue;
        const r = await collector();
        console.log(
          `[collect] ${row.id} ${r.ok ? "ok" : "failed"}${r.error ? ` — ${r.error}` : ""}`,
        );
      }
      const pruned = prune(RETAIN_DAYS, LOAD_RETAIN_DAYS);
      if (pruned.readings || pruned.runs || pruned.load)
        console.log(
          `[prune] ${pruned.readings} readings, ${pruned.runs} runs, ` +
            `${pruned.load} load samples`,
        );
    })();
  }, everyMs).unref();
}

/* ------------------------------------------------------------- telegram */

/**
 * The bridge's long poll, started at boot and kept in step from then on.
 *
 * It is HERE rather than in a service of its own because a second process
 * would need the vault key, the database and the chat backend — which is to
 * say it would be this process under another name. An idle poll is one
 * outbound request a minute and no CPU, and nothing in it blocks: every wait
 * is an awaited fetch or an unref'd timer, so Hono answers exactly as fast
 * with it running as without.
 *
 * `start()` also puts a ten-second reconciler in place, which is what makes a
 * bot connected on the Integrations page start polling without a restart — and
 * a disconnected one stop. It reads two tables and no credentials, so the
 * cadence costs nothing and leaves `secret_access` a record of real use.
 */
telegramPoller.start();

/* ------------------------------------------------------------- searxng */

/**
 * The managed search instance, adopted at boot.
 *
 * IT IS CALLED BEFORE THE SERVER LISTENS, and that ordering is the point.
 * `boot()` installs the SIGINT/SIGTERM/exit handlers that kill the child, and
 * only then decides whether to start one — so there is no window in which a
 * SearXNG exists and nothing is arranged to take it down with the API. A child
 * process outliving its parent is the one failure mode this whole feature can
 * have that the owner cannot see: the port stays busy, the next start fails
 * for a reason nothing on the page could state, and the searches keep working
 * against a process nobody owns.
 *
 * It starts the instance only if the instance was RUNNING when the API last
 * stopped — the owner's own last instruction, written to `plugin_config`
 * rather than inferred, because a process that was killed cannot report what
 * it was doing.
 */
searxngInstance.boot();

/* ---------------------------------------------------------- freellmapi */

/**
 * The managed model gateway, adopted at boot — the same contract SearXNG's
 * `boot()` keeps, called before the server listens and for the same reason:
 * the SIGINT/SIGTERM/exit handlers that kill a child go in FIRST, and only
 * then is anything spawned. There is no window in which a gateway exists and
 * nothing is arranged to take it down with the API.
 *
 * It also hands the provider the "is the local instance live" question, which
 * is what decides — when the owner has not chosen an account — whether a
 * completion goes to the instance on this machine or to the one on the Hetzner
 * box. A function rather than an import, because the provider owns the URLs
 * the instance is built from and the two would otherwise be a cycle.
 */
freellmapiInstance.boot();

/* ------------------------------------------------------------- agents */

/**
 * The managed agents, adopted at boot — the same contract SearXNG's `boot()`
 * keeps, and called for the same reason before the server listens: the
 * SIGINT/SIGTERM/exit handlers that kill a child go in FIRST, and only then is
 * anything spawned. There is no window in which a Hermes or an OpenClaw exists
 * and nothing is arranged to take it down with the API.
 *
 * The stakes are higher here than for a search node. An orphaned agent is
 * several hundred megabytes of runtime holding 8642 or 18789 and, if the
 * default model provider is a metered one, quietly able to spend money on
 * whatever it was in the middle of.
 *
 * It brings back at most ONE, whichever was running when the API last
 * stopped — that being the whole of the "only one at a time" rule, which is
 * about the machine rather than about the chat setting.
 */
agentInstances.boot();

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`[api] http://127.0.0.1:${info.port}`);
  console.log(
    `[api] collectors: ${Object.keys(COLLECTORS).join(", ") || "none"}` +
      (COLLECT_MINUTES > 0 ? ` · every ${COLLECT_MINUTES}m` : " · scheduler off"),
  );
  /* Each integration area's own start-up work — a nightly timer, a weekly
     refresh — once the port is open and never before it. An area's start
     must not take the process down; the catch is the guarantee. */
  for (const m of MANIFESTS) {
    try {
      m.onStart?.();
    } catch (err) {
      console.error(`[api] ${m.id} onStart failed:`, err);
    }
  }
});

/* ------------------------------------------------------------- ventures */

/**
 * READ THE SITES OF ANY VENTURES THAT HAVE NEVER BEEN READ — after the server
 * is listening, and never before it.
 *
 * The four seeded ventures arrive from `021_ventures` with an empty `brand`,
 * because a migration cannot fetch a website: it runs inside a transaction, at
 * import, on a process that has not opened a port yet. So the reading happens
 * here, once, and only for rows whose brand has no `enrichedAt` — which means
 * a restart costs nothing, a site that failed is retried on the NEXT restart
 * (its brand carries an `error` and no timestamp), and a site that was read is
 * never re-read on a schedule. Re-reading is the owner's button.
 *
 * SEQUENTIAL, AND THAT IS THE POINT RATHER THAN A SIMPLIFICATION. Four sites
 * at ten seconds each is forty seconds of one socket at a time; four at once
 * is four DNS lookups, four TLS handshakes and four icon downloads competing
 * with whatever the collectors are doing on a Pi, to save half a minute of
 * something nobody is waiting for.
 *
 * NOTHING HERE MAY THROW. `enrichVenture` catches its own failures into the
 * record, and the catch below is for everything else — a database locked by a
 * collector, an id deleted between the query and the fetch. A boot pass that
 * took the process down would be a dashboard that will not start because
 * somebody else's web server is having a bad morning.
 */
void (async () => {
  const pending = ventureRows().filter(
    (r) => r.website && !readBrand(r.brand).enrichedAt,
  );
  for (const row of pending) {
    try {
      const after = await enrichVenture(row.id);
      const brand = readBrand(after?.brand ?? null);
      console.log(
        `[ventures] read ${row.host ?? row.website}` +
          (brand.error
            ? ` — failed: ${brand.error}`
            : ` — ${brand.favicon ? "icon" : "no icon"}, ` +
              `${brand.palette.primary ?? "no primary colour"}` +
              (brand.notes.length ? `, ${brand.notes.length} note(s)` : "")),
      );
    } catch (err) {
      console.error(
        `[ventures] ${row.id} could not be read — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
})();
