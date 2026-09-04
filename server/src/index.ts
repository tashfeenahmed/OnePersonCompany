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
import { allPlugins, prune } from "./db.ts";
import { COLLECTORS } from "./collector.ts";
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
import * as telegramPoller from "./telegram/poller.ts";

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

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`[api] http://127.0.0.1:${info.port}`);
  console.log(
    `[api] collectors: ${Object.keys(COLLECTORS).join(", ") || "none"}` +
      (COLLECT_MINUTES > 0 ? ` · every ${COLLECT_MINUTES}m` : " · scheduler off"),
  );
});
