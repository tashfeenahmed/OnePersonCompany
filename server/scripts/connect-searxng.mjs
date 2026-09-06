#!/usr/bin/env node
/**
 * Connect the SearXNG node.
 *
 *     ssh you@the-box 'print-the-searxng-key' | node scripts/connect-searxng.mjs
 *
 *     ssh … | node scripts/connect-searxng.mjs https://searxng.example.com/search
 *     ssh … | SEARXNG_URL=https://searxng.example.com node scripts/connect-searxng.mjs
 *
 * THE KEY ARRIVES ON STDIN AND LEAVES ON A SOCKET, and it is never anything
 * else in between. Not an argument — `ps` shows those to every user on the
 * box and every shell writes them to a history file. Not a file — a file has
 * to be deleted afterwards by somebody who remembers. Not a log line, not an
 * error message: everything this prints is about the OUTCOME, and the one
 * place the key could still surface (an error echoing the request) is scrubbed
 * on the way out.
 *
 * WHY A SCRIPT AT ALL, when the plugin page has a form. Because this
 * credential lives on another machine. Getting it into a browser field means a
 * human copying a 64-character secret through a clipboard, a terminal
 * scrollback and possibly a paste buffer that syncs — three places it did not
 * need to be. A pipe has none of those.
 *
 * IT VERIFIES TWICE, AND THAT IS DELIBERATE. Once here, straight against the
 * live node, so a failure is attributable to the node rather than to the API;
 * and once inside the API, which verifies before it stores because the
 * registry there refuses to seal a credential it has not seen work. The first
 * check is what makes "is the box up" and "is the dashboard up" different
 * sentences when this goes wrong at half past eleven at night.
 *
 * THE URL IS AN ARGUMENT BECAUSE IT IS A SETTING. The node is self-hosted and
 * its hostname carries the box's IP address, so the default below is where it
 * lives TODAY and not a constant anybody should rely on. Whatever is used here
 * is written to the plugin's settings first, so the API verifies the key
 * against the same endpoint it will later collect from.
 */

const API = process.env.OPC_API ?? "http://127.0.0.1:8787";
const DEFAULT_URL = "https://searxng-api.178-105-187-189.sslip.io/search";

const url = (process.argv[2] ?? process.env.SEARXNG_URL ?? DEFAULT_URL).trim();

/** The key, from stdin, and from nowhere else. */
const key = (
  await new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.on("end", () => resolve(buffer));
  })
).trim();

if (!key) {
  console.error(
    "No key on stdin. Pipe it in:\n" +
      "  ssh you@the-box 'print-the-searxng-key' | node scripts/connect-searxng.mjs [url]",
  );
  process.exit(1);
}

/** Take the key back out of anything anybody said before it is printed. */
const scrub = (text) =>
  String(text ?? "").split(key).join("[redacted]").slice(0, 400);

console.log(`endpoint   ${url}`);
console.log(`key        ${key.length} characters, read from stdin`);

/* --------------------------------------------------------------- the node */

/*
  A REAL SEARCH, because the node has no other kind of check: /healthz,
  /stats and /config all answer 401 without the key, and none of them says
  whether the engines behind it are working. The key goes in the HEADER —
  the same key as a `?key=` parameter is refused 401, and a key in a URL is a
  key in an access log.
*/
const probeUrl =
  `${url.replace(/\/+$/, "").endsWith("/search") ? url.replace(/\/+$/, "") : `${url.replace(/\/+$/, "")}/search`}` +
  `?q=${encodeURIComponent("site:reddit.com self hosted")}&format=json&language=en-US`;

let answer;
try {
  const started = Date.now();
  const res = await fetch(probeUrl, {
    headers: {
      "x-api-key": key,
      Accept: "application/json",
      "User-Agent": "onepersoncompany-collector/1.0",
    },
    signal: AbortSignal.timeout(25_000),
  });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    console.error(
      `node       HTTP ${res.status} — ` +
        (res.status === 401
          ? "the node refused that key. It travels as an x-api-key header; a key that works in a browser session is not this."
          : scrub(await res.text())),
    );
    process.exit(1);
  }
  if (!type.includes("json")) {
    console.error(
      `node       HTTP ${res.status} and ${type || "no content type"} — that is a page, not the search API. Check the URL points at /search.`,
    );
    process.exit(1);
  }
  const doc = await res.json();
  const engines = new Set();
  for (const row of doc.results ?? []) for (const e of row.engines ?? []) engines.add(e);
  answer = {
    ms: Date.now() - started,
    results: (doc.results ?? []).length,
    engines: [...engines],
    unresponsive: (doc.unresponsive_engines ?? []).map(
      ([engine, why]) => `${engine} (${why})`,
    ),
  };
  console.log(
    `node       200 · ${answer.results} results in ${answer.ms}ms · ` +
      `engines that answered: ${answer.engines.join(", ") || "none"}`,
  );
  /* Printed even when the search succeeded, because this is the finding a
     working node hides: ten results from one engine and ten from five look
     identical from the outside. */
  if (answer.unresponsive.length)
    console.log(`           refused: ${answer.unresponsive.join(", ")}`);
} catch (err) {
  console.error(`node       could not be reached — ${scrub(err.message)}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the API */

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/*
  THE URL GOES IN FIRST, and that order is the point: the registry verifies
  the key against the endpoint the SETTING names, so writing the key first
  would check it against wherever the plugin used to point. An empty value
  means "use the built-in default", which is why the default is not written
  when it is what was asked for — a setting holding the same string as the
  fallback is a setting that will silently stop being the fallback the day the
  default changes.
*/
if (url !== DEFAULT_URL) {
  const { status, body } = await api("/api/plugins/searxng/config", {
    method: "PUT",
    body: JSON.stringify({ config: { url } }),
  });
  if (status !== 200) {
    console.error(`settings   HTTP ${status} — ${scrub(body?.error)}`);
    process.exit(1);
  }
  console.log(`settings   url stored`);
} else {
  console.log(`settings   url left unset — this is the built-in default`);
}

/*
  The single-account door, which is the shape every script here speaks: it
  writes the first account or replaces the only one, and refuses (409, naming
  them) once there are several — at which point the credential has no single
  referent and PATCH on one account is the answer.
*/
const { status, body } = await api("/api/plugins/searxng", {
  method: "PUT",
  body: JSON.stringify({ fields: { key } }),
});

if (status !== 200) {
  console.error(`api        HTTP ${status} — ${scrub(body?.error)}`);
  process.exit(1);
}

const collected = body.collected ?? null;
console.log(
  `api        verified and stored · connected: ${body.connected} · ` +
    `vault entries: ${(body.secrets ?? []).map((s) => s.name).join(", ") || "none"}`,
);
if (collected)
  console.log(
    `collected  ${collected.ok ? "ok" : "failed"}` +
      /* A skipped run is a deliberate no-op and says so, rather than reading
         as a collection that found nothing: the node is probed on a six-hour
         clock and a reconnect inside that window has nothing new to ask. */
      (collected.skipped
        ? " · not due — the node was probed within the last six hours"
        : collected.results !== null && collected.results !== undefined
          ? ` · ${collected.results} results in ${collected.ms}ms`
          : "") +
      (collected.error ? ` · ${scrub(collected.error)}` : ""),
  );
console.log("done       the key was never an argument, a file or a log line");
