/**
 * The managed instance's doors, and the search tool itself.
 *
 * TWO ROUTERS IN ONE FILE, because they are two halves of one thing and
 * splitting them would put the tool's contract a directory away from the
 * process that serves it:
 *
 *   /api/searxng/instance          what is installed and what is running
 *   /api/searxng/instance/install  start the install (long, so: a job)
 *   /api/searxng/instance/start    spawn it
 *   /api/searxng/instance/stop     kill it, and stop it coming back at boot
 *   /api/search?q=…                SEARCH — the tool an agent is given
 *
 * WHY `/api/search` IS NOT THE MISTAKE index.ts WARNS ABOUT. That warning is
 * about a REPORT: `/api/gsc` and `/api/bing` are two routes because Google's
 * impressions and Bing's count different populations, and one document holding
 * both would invite somebody to add them. This is not a report at all — it
 * performs a search and hands back links. Nothing on it is a measurement, so
 * there is nothing on it to add up wrongly, and `/api/search` is the name a
 * caller would guess for the thing that searches.
 *
 * IT IS GET-ONLY AND IT TAKES NO BODY, which is what makes it usable as a tool
 * at all: an agent that can fetch a URL can use this, with no client, no SDK
 * and no schema — and a GET can be tried by hand in a terminal, which is how
 * anybody debugs an agent that says it searched and came back with nothing.
 *
 * NO KEY, DELIBERATELY. The API binds to 127.0.0.1 and this route is behind
 * that bind like every other one; adding a token here would be a credential
 * for a service that is already unreachable from anywhere it would matter. It
 * does not reach the vault either, unless the plugin is pointed at the remote
 * node, in which case the key is read for that call and never leaves the
 * process.
 */
import { Hono } from "hono";
import * as instance from "../searxng/instance.ts";
import * as searxng from "../providers/searxng.ts";

export const searxngRoutes = new Hono();
export const searchRoutes = new Hono();

/* --------------------------------------------------------------- instance */

searxngRoutes.get("/instance", (c) => c.json(instance.report()));

/**
 * Begin an install.
 *
 * 202 AND NOT 200, because nothing is installed when this answers — a clone, a
 * virtualenv and a compiled dependency tree take minutes. The state is polled
 * from `GET /instance`, which carries the step and the last lines of output;
 * this returns only whether the job STARTED.
 */
searxngRoutes.post("/instance/install", (c) => {
  const started = instance.install();
  if (!started.ok) return c.json({ error: started.error, ...instance.report() }, 409);
  return c.json(instance.report(), 202);
});

searxngRoutes.post("/instance/start", async (c) => {
  const started = await instance.start();
  if (!started.ok) return c.json({ error: started.error, ...instance.report() }, 409);
  return c.json(instance.report());
});

searxngRoutes.post("/instance/stop", async (c) => {
  await instance.stop("asked to stop from the plugin page");
  return c.json(instance.report());
});

/* ------------------------------------------------------------ the tool */

/** The tool's own ceiling, shorter than the collector's. A collection can
 *  afford to wait twenty-five seconds for a node that is thinking; something
 *  waiting on an answer to give a person cannot, and a slow engine is not
 *  worth a conversation stalling on. */
const TOOL_TIMEOUT_MS = 20_000;

/**
 * Search, through whichever instance is active.
 *
 * THE CALLER NEVER LEARNS WHICH INSTANCE IT IS EXCEPT AS A FACT ON THE ANSWER,
 * which is the shape /api/chat takes over its two agents and for the same
 * reason: switching from the remote node to a locally installed one must
 * change nothing about how anything asks. `instance` is on the response
 * because "why are these results different from yesterday's" is a question
 * whose answer is usually that.
 *
 * A MANAGED INSTANCE THAT IS NOT RUNNING IS A 503 WITH A SENTENCE, not an
 * empty result set. Zero links means the engines found nothing; this means
 * nobody asked them, and an agent handed the first when the second is true
 * will report that the web is empty on the subject.
 */
searchRoutes.get("/", async (c) => {
  const query = (c.req.query("q") ?? "").trim();
  if (!query)
    return c.json(
      {
        error:
          "Nothing to search for. GET /api/search?q=your+question — and optionally " +
          "&categories=, &engines=, &language=, &page=.",
      },
      400,
    );

  const url = searxng.endpoint();
  const managed = searxng.mode() === "managed" && searxng.isLoopback(url);

  if (managed && !instance.isRunning()) {
    const report = instance.report();
    return c.json(
      {
        error:
          report.state === "absent"
            ? "The local SearXNG instance is not installed. Install it from the SearXNG page, or point the search endpoint at a node that is already running."
            : `The local SearXNG instance is ${report.state}, so there is nothing to search through. Start it from the SearXNG page.`,
        instance: "managed",
        state: report.state,
      },
      503,
    );
  }

  /*
    THE CREDENTIAL, WHICH EXISTS IN ONE OF THE TWO MODES. `borrowKey` is the
    one door onto it and it writes a `secret_access` row naming this route, so
    "what read the SearXNG key at four in the morning" stays a query. In
    managed mode it hands back an empty key and the transport sends no header.
  */
  const borrowed = searxng.borrowKey("search_tool");
  if (!borrowed)
    return c.json(
      {
        error:
          "SearXNG is not connected. Either install the local instance from the SearXNG page, or paste the URL and key of a node you already run.",
        instance: "remote",
      },
      503,
    );

  const page = Number(c.req.query("page") ?? "");

  try {
    const answer = await searxng.ask(
      borrowed.url,
      borrowed.key,
      {
        query,
        categories: c.req.query("categories") ?? null,
        engines: c.req.query("engines") ?? null,
        language: c.req.query("language") ?? null,
        page: Number.isFinite(page) && page > 0 ? page : null,
      },
      TOOL_TIMEOUT_MS,
    );
    return c.json({ ...answer, instance: managed ? "managed" : "remote" });
  } catch (err) {
    /* The node's own words, scrubbed of the key for the reason the provider
       scrubs everything else: an error that echoes a request is the one place
       a header can come back out. */
    const message =
      err instanceof Error ? searxng.scrub(err.message, borrowed.key) : "The search failed.";
    /* 502 AND NOT THE NODE'S OWN STATUS. A 401 from the node is not this API
       telling the caller their credentials are wrong — the caller sent none —
       and a 429 from it is not this API rate-limiting anybody. What is true in
       every case is that the upstream this route depends on did not answer,
       which is what 502 says; the node's own sentence is in the body. */
    return c.json({ error: message, instance: managed ? "managed" : "remote" }, 502);
  }
});
