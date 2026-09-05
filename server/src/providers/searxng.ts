/**
 * SearXNG — the self-hosted metasearch node the agents search through.
 *
 * THIS IS A CONSUMPTION API, THE WAY PEXELS AND PIXABAY ARE, and the same
 * reasoning decides what gets built. Over in workdash it is called by
 * `agent/websearch.js` for search_web and by `collect_demand.py` as the last
 * tier of the Reddit fallback: something asks it a question, reads the links
 * and throws the answer away. It keeps no account history, it bills nothing,
 * and — this is the part that decides a whole card — IT DOES NOT COUNT THE
 * QUERIES PUT TO IT.
 *
 * Probed live on 2026-09-04 against this instance:
 *
 *     GET /search?q=…&format=json   200, 10 results, engines attributed
 *                                   per result, `unresponsive_engines` naming
 *                                   the ones that refused, and NO total —
 *                                   `number_of_results` is absent entirely
 *     GET /stats                    200 and text/html. `?format=json` is
 *                                   ignored and returns the same HTML. It
 *                                   reports per-ENGINE scores, result counts,
 *                                   response-time percentiles and a
 *                                   reliability score. There is no query
 *                                   counter on it, for the node or for a day
 *     GET /config                   200, the engine list and the version
 *     GET /healthz                  200, the two bytes "OK"
 *     …without the key              401 on every one of those, /healthz
 *                                   included
 *
 * So "Agent searches · 24h" — the number the catalog promised for this
 * source — cannot be produced here or anywhere else: the node does not
 * publish it, and this box is not the only thing that searches through it, so
 * counting our own calls would answer a smaller question under a bigger name.
 * The widget was changed rather than filled with a guess; see the `cannot`
 * block below, which is what the card draws.
 *
 * WHAT IT CAN ANSWER, and it turns out to matter: which engines actually
 * served the search. On the probe above brave answered "too many requests",
 * duckduckgo answered with a CAPTCHA and qwant answered "access denied" — so
 * every one of those ten results came from Bing alone. A metasearch node down
 * to one engine still returns ten links and still looks like it is working,
 * which is exactly the failure nothing else on this box could see.
 *
 * THE KEY GOES IN A HEADER, NOT THE QUERY STRING. Measured the same day:
 * `?key=…` is 401 and `x-api-key:` is 200. There is no way in but the header,
 * and it is the better one anyway — a key in a URL is a key in an access log,
 * a referrer and every error message that echoes the request.
 *
 * THE URL IS A SETTING AND NOT A CONSTANT. The instance is on the owner's own
 * box and its hostname carries that box's IP (`178-105-187-189.sslip.io`), so
 * the day the box moves, a hardcoded host is a dashboard that quietly stops
 * searching. The default below is where it lives today; `plugin_config` holds
 * the override, reads back, and is the value every call actually uses.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * AND SINCE THERE ARE NOW TWO KINDS OF INSTANCE, THERE ARE TWO MODES.
 *
 * Everything above describes the REMOTE one and is unchanged. The other is
 * MANAGED: installed into `DATA_DIR/searxng/` and run as a child of this
 * process by searxng/instance.ts, bound to 127.0.0.1:8888.
 *
 * The 401 that shapes the remote half of this file IS NOT SEARXNG. SearXNG has
 * no key auth and never has; the key belongs to the reverse proxy in front of
 * the owner's public instance, which is what makes a public instance possible
 * at all. A managed instance has no proxy, so it has no key — A LOOPBACK BIND
 * IS THE AUTH. Nothing off this machine can open that port, and a key checked
 * by this process against a value this process generated would be a password
 * on a door in a locked room.
 *
 * So the mode decides ONE thing here: whether an `x-api-key` header goes out.
 * The transport takes a key and sends it when there is one, which means a
 * managed call is `search(url, "", …)` and needs no second code path — and
 * means the remote node cannot accidentally be called without its key, because
 * the caller that has one always passes it.
 *
 * THE MODE IS DERIVED FROM THE ENDPOINT AND NOT TRUSTED ON ITS OWN.
 * `plugin_config` holds `mode`, written by the installer and by the settings
 * form, but `keyless()` also insists the URL is loopback: a stored mode that
 * has drifted from the URL — a hand-edited row, a restored database — must
 * never be the reason a real key is dropped from a call to a public host.
 */
import * as accounts from "../accounts.ts";
import { configValue } from "../db.ts";

const TIMEOUT_MS = 25_000;

/**
 * An honest User-Agent, for the reason stock.ts names one: a tool that says
 * what it is can be complained to. This one reaches the owner's own box, so
 * it is politeness rather than admission — but the same string goes out to
 * Reddit's feed through the fallback tier, and there it is the price of being
 * served.
 */
export const USER_AGENT = "onepersoncompany-collector/1.0";

/**
 * Where the node lives today.
 *
 * A DEFAULT, NEVER A CONSTANT — see the header. It is the same URL
 * `collect_demand.py` defaults to, which is what makes moving between the two
 * a copy rather than a translation.
 */
export const DEFAULT_URL =
  "https://searxng-api.178-105-187-189.sslip.io/search";

/** The plugin id, written once because it is a foreign key value and two
 *  spellings of it would be two plugins. */
export const PLUGIN = "searxng";

/**
 * Where a managed instance lives.
 *
 * A CONSTANT HERE AND A SETTING EVERYWHERE ELSE, which is not a contradiction:
 * this is not "where SearXNG is", it is "where the one this process starts
 * will be", and this file is the thing that starts it. 8888 is the port the
 * owner's own Docker instance publishes, so the two are interchangeable to
 * anything downstream.
 */
export const LOCAL_PORT = 8888;
export const LOCAL_URL = `http://127.0.0.1:${LOCAL_PORT}/search`;

/**
 * Is this URL on this machine?
 *
 * By NAME rather than by resolution: `localhost` is accepted because it is
 * what a person types, and anything that would need a DNS lookup to classify
 * is treated as remote. Getting this wrong in the safe direction costs a
 * header that is ignored; getting it wrong the other way sends a call to a
 * public host with the credential stripped off.
 */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Which instance the plugin is pointed at. Absent means remote — the mode was
 *  introduced with the managed instance, so every existing connection predates
 *  it and is remote by definition. */
export function mode(): "managed" | "remote" {
  return configValue(PLUGIN, "mode") === "managed" ? "managed" : "remote";
}

/**
 * The key to send to this endpoint, given what is in the vault.
 *
 * Empty means "send no header at all", and it is only ever returned for a
 * loopback URL in managed mode — both conditions, for the reason the header
 * says: a mode row that has drifted from the URL must not strip a credential
 * off a call to somebody else's host.
 */
export function keyFor(url: string, stored: string): string {
  return mode() === "managed" && isLoopback(url) ? "" : stored;
}

/** The configured endpoint, or the default. Read on every call rather than
 *  cached, because the setting is a thing the owner edits while the process is
 *  running and a cached host would keep searching the old box until a
 *  restart. */
export function endpoint(): string {
  return normalise(configValue("searxng", "url") ?? "") ?? DEFAULT_URL;
}

/**
 * A URL this will actually call, or null.
 *
 * The base and the search path are both accepted because both are things a
 * person pastes: `https://host/` and `https://host/search` mean the same node,
 * and refusing one of them would be refusing a correct answer on a technicality.
 * A query string is dropped — the query is what this file builds — and anything
 * that is not http(s) is refused rather than normalised into something that
 * might be reached.
 */
export function normalise(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/search") ? path : `${path}/search`;
  return url.toString();
}

export class SearxError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SearxError";
    this.status = status;
  }
}

/** One link the node returned, in the fields it actually publishes. */
export type SearxResult = {
  url: string;
  title: string;
  content: string | null;
  /** Every engine that returned this link. A result carried by three engines
   *  is stronger evidence than one carried by a single engine, and it is the
   *  only quality signal in the document. */
  engines: string[];
  /** SearXNG's own merged score. Its scale is the node's business and nothing
   *  downstream treats it as a quantity of anything. */
  score: number | null;
};

export type SearxAnswer = {
  query: string;
  results: SearxResult[];
  /** Engine name to the node's own words for why it did not answer —
   *  "too many requests", "CAPTCHA", "access denied". This is a MEASUREMENT
   *  and the most useful one here: a node down to one working engine still
   *  answers ten links and still looks healthy. */
  unresponsive: { engine: string; reason: string }[];
  /** Engines that carried at least one result, with how many. */
  answered: { engine: string; results: number }[];
  /** Round trip in milliseconds, measured here. The node publishes per-engine
   *  timings on an HTML page and nothing about the request as a whole. */
  ms: number;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * The transport, which is the only place a request is built.
 *
 * ONE FUNCTION FOR BOTH CALLERS — the probe below and the tool route's richer
 * query — because everything that can go wrong here is the same for both, and
 * two copies of "a page rather than JSON means the URL is wrong" is one copy
 * that eventually stops being true.
 *
 * `language=en-US` for the reason collect_presence.py sets it: without it the
 * node answers in the locale of whatever IP asked, and the remote box is in
 * Nuremberg — so the same query would quietly return German results from a
 * German datacentre and English ones from here. The caller may override it,
 * because "search in French" is a real thing to ask an agent for.
 */
async function fetchSearx(
  url: string,
  key: string,
  params: URLSearchParams,
  timeoutMs = TIMEOUT_MS,
): Promise<{ doc: Record<string, unknown>; ms: number }> {
  const target = `${url}?${params.toString()}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(target, {
      headers: {
        /*
          THE HEADER IS THE ONLY DOOR, and only when there is a key. See the
          file header: against the remote node the same key as a `?key=`
          parameter is refused 401, and a managed instance has no key at all —
          so an empty value sends no header rather than an empty one, which a
          proxy would read as a wrong key rather than as no key.
        */
        ...(key ? { "x-api-key": key } : {}),
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new SearxError(
      0,
      name === "TimeoutError"
        ? `The SearXNG node did not answer within ${TIMEOUT_MS / 1000} seconds.`
        : `Could not reach the SearXNG node at ${url}.`,
    );
  }

  if (res.status === 401 || res.status === 403)
    throw new SearxError(res.status, "The SearXNG node rejected that API key.");
  if (res.status === 429)
    throw new SearxError(429, "The SearXNG node is rate-limiting this key.");
  if (!res.ok)
    throw new SearxError(res.status, `The SearXNG node answered HTTP ${res.status}.`);

  /*
    A page rather than JSON is the failure worth naming, exactly as it is for
    Pixabay: a reverse proxy in front of the node answers a wrong path with an
    HTML 200, and read as a result set that is "the search found nothing" —
    the one thing this file must never say when it does not know.
  */
  if (!(res.headers.get("content-type") ?? "").includes("json"))
    throw new SearxError(
      res.status,
      "The SearXNG node answered with a page rather than JSON — check the URL points at /search.",
    );

  const body = (await res.json()) as Record<string, unknown>;
  if (!Array.isArray(body.results))
    throw new SearxError(res.status, "The SearXNG node answered in an unrecognised shape.");

  return { doc: body, ms: Date.now() - started };
}

/** The parameters every call shares. `format=json` is the whole reason the
 *  managed instance's settings name `json` in `search.formats`: without it
 *  SearXNG serves this path as HTML and means it. */
function baseParams(query: string, language = "en-US"): URLSearchParams {
  const params = new URLSearchParams({ q: query, format: "json" });
  if (language) params.set("language", language);
  return params;
}

/**
 * One search, in the shape the collector's probe reads.
 *
 * The key may be empty, and against a managed instance it always is — see the
 * transport above and the file header for why that is the correct call rather
 * than a missing credential.
 */
export async function search(
  url: string,
  key: string,
  query: string,
): Promise<SearxAnswer> {
  const { doc: body, ms } = await fetchSearx(url, key, baseParams(query));

  const results: SearxResult[] = [];
  const byEngine = new Map<string, number>();
  /* The transport has already refused a document whose `results` is not an
     array, which is what makes this cast a statement rather than a hope. */
  for (const raw of body.results as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const link = str(row.url);
    const title = str(row.title);
    if (!link || !title) continue;
    const engines = Array.isArray(row.engines)
      ? row.engines.filter((e): e is string => typeof e === "string")
      : str(row.engine)
        ? [str(row.engine)!]
        : [];
    for (const e of engines) byEngine.set(e, (byEngine.get(e) ?? 0) + 1);
    results.push({
      url: link,
      title,
      content: str(row.content),
      engines,
      score: typeof row.score === "number" ? row.score : null,
    });
  }

  const unresponsive: SearxAnswer["unresponsive"] = [];
  if (Array.isArray(body.unresponsive_engines))
    for (const pair of body.unresponsive_engines) {
      /* The node sends `[engine, reason]` pairs. The reason is its own
         sentence and is kept verbatim: "CAPTCHA" and "too many requests" are
         two different problems with two different fixes, and paraphrasing
         them into "unavailable" would lose which. */
      if (Array.isArray(pair) && typeof pair[0] === "string")
        unresponsive.push({
          engine: pair[0],
          reason: typeof pair[1] === "string" ? pair[1] : "no reason given",
        });
    }

  return {
    query,
    results,
    unresponsive,
    answered: [...byEngine.entries()]
      .map(([engine, n]) => ({ engine, results: n }))
      .sort((a, b) => b.results - a.results),
    ms,
  };
}

/* ------------------------------------------------- the tool surface's query */

/**
 * One link, as an AGENT wants it rather than as the health card wants it.
 *
 * The difference is `engine` singular and `publishedDate`. The probe cares
 * which engines carried a result because that is a fact about the NODE; a
 * caller reading the link cares which one found it and when it was published,
 * which are facts about the RESULT. Both are what SearXNG publishes — the
 * primary engine is `engine`, the list is `engines` — and neither is invented
 * here: a result with no date has `publishedDate: null`, which means the
 * engine did not say, and never today's date.
 */
export type ToolResult = {
  title: string;
  url: string;
  content: string | null;
  engine: string | null;
  score: number | null;
  publishedDate: string | null;
};

export type ToolAnswer = {
  query: string;
  results: ToolResult[];
  engines: {
    answered: { engine: string; results: number }[];
    refused: { engine: string; reason: string }[];
  };
  ms: number;
};

/**
 * A search on somebody else's behalf.
 *
 * SEPARATE FROM `search()` BECAUSE THE CALLERS ARE DIFFERENT ANIMALS. The
 * collector's probe is one fixed question asked of the node about itself, and
 * its answer feeds a health card. This is an arbitrary question from an agent,
 * with the parameters SearXNG actually takes — categories, engines, language,
 * page — and its answer is passed on. Folding them together would mean the
 * health probe growing options nothing sets and the tool inheriting a
 * site-restriction rule that has nothing to do with it.
 *
 * EVERY PARAMETER IS PASSED THROUGH AND NONE IS INVENTED. An unknown category
 * or engine name is SearXNG's to refuse, and refusing it here would mean
 * keeping a copy of its engine list in this file that goes stale the first
 * time the instance is upgraded.
 */
export async function ask(
  url: string,
  key: string,
  opts: {
    query: string;
    categories?: string | null;
    engines?: string | null;
    language?: string | null;
    page?: number | null;
  },
  timeoutMs = TIMEOUT_MS,
): Promise<ToolAnswer> {
  const params = baseParams(opts.query, opts.language ?? "en-US");
  if (opts.categories) params.set("categories", opts.categories);
  if (opts.engines) params.set("engines", opts.engines);
  if (opts.page && opts.page > 1) params.set("pageno", String(opts.page));

  const { doc, ms } = await fetchSearx(url, key, params, timeoutMs);

  const results: ToolResult[] = [];
  const byEngine = new Map<string, number>();
  for (const raw of doc.results as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const link = str(row.url);
    const title = str(row.title);
    if (!link || !title) continue;
    const engine =
      str(row.engine) ??
      (Array.isArray(row.engines) ? (str(row.engines[0]) ?? null) : null);
    if (engine) byEngine.set(engine, (byEngine.get(engine) ?? 0) + 1);
    results.push({
      title,
      url: link,
      content: str(row.content),
      engine,
      score: typeof row.score === "number" ? row.score : null,
      publishedDate: str(row.publishedDate),
    });
  }

  const refused: ToolAnswer["engines"]["refused"] = [];
  if (Array.isArray(doc.unresponsive_engines))
    for (const pair of doc.unresponsive_engines)
      if (Array.isArray(pair) && typeof pair[0] === "string")
        refused.push({
          engine: pair[0],
          reason: typeof pair[1] === "string" ? pair[1] : "no reason given",
        });

  return {
    query: opts.query,
    results,
    engines: {
      answered: [...byEngine.entries()]
        .map(([engine, n]) => ({ engine, results: n }))
        .sort((a, b) => b.results - a.results),
      /* REPORTED EVEN ON A SUCCESSFUL SEARCH, because this is the finding a
         working metasearch node hides: ten links from one engine and ten from
         five look identical to whatever reads them. */
      refused,
    },
    ms,
  };
}

/**
 * The host a `site:` query restricted itself to, and how many results actually
 * came from it.
 *
 * WHY THIS IS MEASURED AT ALL. Ten results is not ten answers. Measured on
 * this instance on 2026-09-04, `site:reddit.com free llm api` came back with
 * ten links about free browser games — the one engine still answering had
 * ignored both the site restriction and the query, and SearXNG passed the
 * links on because passing links on is its job. A results COUNT cannot see
 * that, and the Reddit fallback tier built on top of it would have produced
 * nothing while the card said the node was fine.
 *
 * So the probe asks a site-restricted query — the one this box actually
 * depends on the node for — and counts what came back FROM that site. Zero on
 * site out of ten results is a different and much more serious state than zero
 * results, and the two are never folded together.
 */
export const PROBE_SITE = "reddit.com";

export function onSite(answer: SearxAnswer, host = PROBE_SITE): number {
  let n = 0;
  for (const result of answer.results) {
    let hostname: string;
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (hostname === host || hostname.endsWith(`.${host}`)) n += 1;
  }
  return n;
}

/**
 * What was asked of this node and what came back — the evidence rather than
 * the verdict, the shape Replicate's and Cloudflare's `cannot` blocks carry.
 *
 * It exists because a reader looking for the "agent searches" figure the
 * catalog used to promise deserves to find out that it was asked for and does
 * not exist, rather than concluding the collector is broken.
 */
export const CANNOT = {
  checkedOn: "2026-09-04",
  asked: [
    /*
      THE 401s BELOW BELONG TO THE PROXY AND NOT TO SEARXNG, which is a
      distinction the managed instance made visible. Probed on 2026-09-05
      against a locally installed instance on 127.0.0.1:8888: /healthz is 200
      and two bytes with NO key, /stats is 200, and a search answers — because
      SearXNG has no key auth at all and the header the remote node insists on
      is its reverse proxy's. Everything that is a property of SEARXNG is the
      same on both: no query counter, no `number_of_results`, and /stats in
      HTML whatever `format` says.
    */
    {
      asked: "How many searches has this node served?",
      answer:
        "Not published anywhere. /stats is HTML only and counts engines, not queries.",
    },
    {
      asked: "GET /stats?format=json",
      answer: "200 and text/html — the format parameter is ignored on that page.",
    },
    {
      asked: "How many results exist for a query?",
      answer:
        "No total in the document — `number_of_results` is absent, so a page of links is all there is.",
    },
    {
      asked: "GET /search with the key as ?key=",
      answer:
        "401 on the remote node. The key is an x-api-key HEADER and nothing else works — and it is the proxy's key, not SearXNG's.",
    },
    {
      asked: "GET /healthz without the key",
      answer:
        "401 on the remote node — every path there is behind the proxy, liveness included. A locally installed instance answers 200: SearXNG itself has no key auth, and a loopback bind is what keeps it private.",
    },
    {
      asked: "Are the results about the query?",
      answer:
        "Not always, and the node cannot say so: site:reddit.com returned ten off-topic links the day this was written. The probe counts what came back from the site it asked for.",
    },
  ],
} as const;

/**
 * Is this key, against this URL, real?
 *
 * A real search, because there is no validate-this-key endpoint and every
 * other path answers 401 without the key anyway — so the check IS the thing
 * being checked, exactly as it is for the stock libraries. The probe term is
 * deliberately dull and stable: it proves the pipe, and nothing downstream
 * reads its results.
 *
 * THE "EVERY ENGINE REFUSED" REFUSAL IS FOR A REMOTE NODE ONLY, and the
 * asymmetry is deliberate. Refusing to store a key against somebody else's
 * node that can no longer search is right: the key is fine, the node is
 * useless to us, and storing it would put a green dot over an integration that
 * returns nothing. A MANAGED instance is a different situation entirely — it
 * is a process this box just started, on this machine, and whether Google is
 * currently serving it is a property of the day rather than of the connection.
 * Refusing there would leave the owner looking at a running instance the
 * dashboard denies exists, with no field to correct and nothing to retry. So a
 * loopback instance connects on being reachable, and the engine state is
 * reported by the cards that exist to report it.
 */
export async function verify(
  url: string,
  key: string,
): Promise<{ ok: true; answer: SearxAnswer } | { ok: false; error: string }> {
  try {
    const answer = await search(url, key, "site:reddit.com self hosted");
    /*
      A NODE THAT ANSWERS WITH NO RESULTS AND NO ENGINES IS NOT CONNECTED. It
      is reachable, the key is accepted, and every engine behind it is refusing
      — which would connect happily and then return nothing for every query
      the agents make, with nothing on the page able to say why.
    */
    if (!isLoopback(url) && !answer.results.length && answer.unresponsive.length)
      return {
        ok: false,
        error:
          `The node answered, but every engine refused: ` +
          answer.unresponsive.map((u) => `${u.engine} (${u.reason})`).join(", ") +
          `. The key is fine; the instance has nothing to search with.`,
      };
    return { ok: true, answer };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof SearxError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not reach the SearXNG node.",
    };
  }
}

/* ------------------------------------------------------------------ collect */

export type ProbeResult = {
  id: number;
  label: string;
  ok: boolean;
  url: string;
  error?: string;
  answer?: SearxAnswer;
};

export type CollectResult = {
  accounts: ProbeResult[];
  accountsTried: number;
  warnings: string[];
};

/**
 * The node, probed once.
 *
 * ONE QUERY PER COLLECTION AND NOT ONE PER ENGINE. The thing worth knowing is
 * whether a search made right now would come back with anything and which
 * engines served it, and that is one request — asking five would be five
 * times the load on somebody's own box to learn the same sentence.
 *
 * The probe term is passed in so the collector can spend the probe on
 * something the owner actually cares about rather than on a fixed string: a
 * watch term searched here is a real search of a real phrase, and it costs the
 * node exactly what a dummy would.
 *
 * WHICH FIELDS AN ACCOUNT NEEDS DEPENDS ON THE MODE, which is the one place
 * the two kinds of instance change the shape of this file rather than just a
 * header. Against the remote node an account with no key is BROKEN and says
 * so. Against a managed instance there is no key to be missing — the account
 * exists to carry the probe's state and the interface's row — so asking
 * `credentialed` for no fields at all is the honest request: nothing is
 * decrypted, nothing is reported missing, and the vault is not opened to
 * discover that it holds nothing relevant.
 */
export async function collect(
  probeTerm: string,
  reader = "collect_searxng",
): Promise<CollectResult> {
  const url = endpoint();
  const keyless = mode() === "managed" && isLoopback(url);
  const { ready, broken } = accounts.credentialed(
    PLUGIN,
    keyless ? [] : ["key"],
    reader,
  );
  const out: ProbeResult[] = [];
  const warnings: string[] = [];

  for (const { account } of broken) {
    out.push({ id: account.id, label: account.label, ok: false, url, error: "No API key stored." });
    warnings.push(`${account.label}: no API key stored`);
  }

  for (const { account, values } of ready) {
    const key = keyFor(url, (values.key ?? "").trim());
    try {
      const answer = await search(url, key, probeTerm);
      out.push({ id: account.id, label: account.label, ok: true, url, answer });
    } catch (err) {
      const error = scrub(err instanceof Error ? err.message : String(err), key);
      out.push({ id: account.id, label: account.label, ok: false, url, error });
      warnings.push(`${account.label}: ${error}`);
    }
  }

  return { accounts: out, accountsTried: ready.length + broken.length, warnings };
}

/** Take the key back out of anything the node said before it is stored on a
 *  run row the interface displays. The key travels in a header rather than a
 *  URL, so this should never have anything to do — which is exactly why it is
 *  cheap to keep. */
export function scrub(text: string, key: string): string {
  return (key.length >= 6 ? text.split(key).join("[redacted]") : text).slice(0, 220);
}

/**
 * The credential of the first SearXNG account that has one, for the callers
 * that are not this plugin.
 *
 * THE REDDIT COLLECTOR NEEDS IT AND MUST NOT OWN IT. SearXNG is the last tier
 * of Reddit's fallback — see providers/demand.ts — so the Reddit run reaches
 * across for a key that belongs to another plugin. That is a deliberate
 * crossing and it is written down here rather than in the caller, so the
 * secret_access row says which collector opened the entry.
 *
 * Null means "SearXNG is not connected", which is an ordinary state: Reddit's
 * safety net simply is not strung, and the run says so rather than failing.
 *
 * IN MANAGED MODE THERE IS NOTHING TO BORROW AND THE NET IS STILL STRUNG. The
 * name of this function is about the remote case, where the credential belongs
 * to another plugin; a loopback instance has no credential, so what crosses is
 * the endpoint and an empty key. Returning null there would silently switch
 * Reddit's fallback tier off for exactly the owners who took the trouble to
 * run their own instance.
 */
export function borrowKey(reader: string): { url: string; key: string } | null {
  const url = endpoint();
  if (mode() === "managed" && isLoopback(url)) {
    /* Connected still has to mean something: an account row that says the
       instance is in use, which is what the installer writes on the first
       healthy run. Without one this is a plugin nobody has connected. */
    const connected = accounts.list(PLUGIN).some((a) => a.connected);
    return connected ? { url, key: "" } : null;
  }
  const { ready } = accounts.credentialed(PLUGIN, ["key"], reader);
  const first = ready[0];
  if (!first) return null;
  const key = (first.values.key ?? "").trim();
  return key ? { url, key } : null;
}
