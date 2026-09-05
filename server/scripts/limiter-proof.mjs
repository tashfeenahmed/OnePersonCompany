#!/usr/bin/env node
/**
 * PROVE THE LIMITER, against real completions.
 *
 *     node scripts/limiter-proof.mjs
 *     OPC_API=http://127.0.0.1:8787 node scripts/limiter-proof.mjs
 *
 * The policy in models/provider.ts is four settings and a queue, and every one
 * of them is the kind of thing that looks right in a code review and is wrong
 * in production: an off-by-one in the ceiling, a release that wakes the wrong
 * waiter, a round-robin that advances on the wrong side of the await. So this
 * fires FOUR CONCURRENT completions under each policy and reads back what
 * actually happened, from figures the server itself reports.
 *
 * WHAT IS BEING MEASURED, AND WHY IT IS NOT A STOPWATCH. Each reply carries
 * `queuedMs` — how long that call waited for a slot — and `ms`, how long the
 * completion itself took. With the moment the request was sent, that is enough
 * to reconstruct each call's window: it started at `sent + queuedMs` and
 * finished when the response landed. OVERLAP between those windows is the
 * whole question, and it is a fact about the server rather than about how fast
 * this laptop can open four sockets.
 *
 *   series      no two windows may overlap, and queuedMs must climb: the
 *               second call waits for the first, the third for the second.
 *   parallel/4  all four windows overlap and every queuedMs is ~0.
 *   round-robin with two endpoints, the calls alternate between them in the
 *               order the accounts were added.
 *   least-busy  each call goes to whichever endpoint has the fewest in flight.
 *
 * IT RUNS AGAINST WHATEVER IS CONNECTED AND PUTS EVERYTHING BACK. It needs the
 * `local` provider connected with at least one endpoint — two to show the
 * balance rules — makes it the default for the duration, and restores the
 * previous default and the previous policy on the way out, including after a
 * failure. A test that leaves a dashboard pointed somewhere it was not is a
 * test that costs more than it proves.
 */

const API = process.env.OPC_API ?? "http://127.0.0.1:8787";
const PROMPT =
  process.env.OPC_PROOF_PROMPT ??
  "Write about sixty words on why the sea is salty. Plain prose, no lists.";
const CALLS = Number(process.env.OPC_PROOF_CALLS ?? 4);

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status} on ${path}`);
  return body;
}

/**
 * One completion, placed on this process's clock.
 *
 * THE WINDOW IS `sent + queuedMs` TO `+ ms`, AND NOT "UNTIL THE ANSWER
 * LANDED". The slot is released the instant the wire call returns; Hono then
 * serialises a few hundred bytes and puts them on a socket, and the next
 * queued call is already running while that happens. Measured to the moment
 * the response arrives here, a perfectly serialised run shows a few
 * milliseconds of apparent overlap on every pair — which is this script
 * measuring its own HTTP overhead and reporting it as a broken limiter. The
 * first draft of this file did exactly that and said 3 overlapping pairs under
 * `series`. Both figures come from the server, so the window is the slot's and
 * nothing else's.
 */
async function one(n, prompt = PROMPT) {
  const sent = Date.now();
  const r = await api("/api/models/complete", {
    method: "POST",
    body: JSON.stringify({ message: `${prompt} (call ${n})` }),
  });
  const landed = Date.now();
  return {
    n,
    endpoint: r.endpoint,
    queuedMs: r.queuedMs,
    ms: r.ms,
    from: sent + r.queuedMs,
    to: sent + r.queuedMs + r.ms,
    roundTripMs: landed - sent,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * THE ONE FIGURE THAT NEEDS NO CROSS-CLOCK ARITHMETIC: how many calls were in
 * flight on average.
 *
 * Add up every call's own `ms` — server-measured, slot acquired to wire call
 * returned — and divide by the wall clock this script spent firing them. One
 * call at a time gives ~1.00 however long each takes; four at once gives ~4.
 * It is exact because both halves come from one side each and neither is
 * compared to the other's zero.
 *
 * The windows drawn below are the same numbers laid on this process's clock,
 * which involves adding a server duration to a client timestamp and is
 * therefore off by the request's own pre-handler overhead — a few
 * milliseconds, enough to make a perfectly serialised run LOOK like it has one
 * overlapping pair. They are an illustration; this ratio is the measurement.
 */
function observedConcurrency(rows, wallMs) {
  const busy = rows.reduce((n, r) => n + r.ms, 0);
  return busy / Math.max(1, wallMs);
}

/** A window drawn against the run's own span, so "these four ran at once" and
 *  "these four ran one after another" are visible rather than inferred. */
function bar(row, base, span) {
  const W = 46;
  const a = Math.round(((row.from - base) / span) * W);
  const b = Math.max(a + 1, Math.round(((row.to - base) / span) * W));
  return " ".repeat(a) + "#".repeat(b - a);
}

async function scenario(title, policy, expectation) {
  await api("/api/models/local/policy", {
    method: "PUT",
    body: JSON.stringify(policy),
  });

  const started = Date.now();
  const rows = await Promise.all(
    Array.from({ length: CALLS }, (_, i) => one(i + 1)),
  );
  const finished = Date.now();

  const base = Math.min(...rows.map((r) => r.from));
  const span = Math.max(1, Math.max(...rows.map((r) => r.to)) - base);

  console.log(`\n── ${title}`);
  console.log(`   policy ${JSON.stringify(policy)} · ${CALLS} calls fired at once`);
  console.log(`   expect: ${expectation}`);
  console.log(
    `   ${"call".padEnd(5)}${"endpoint".padEnd(26)}${"queuedMs".padStart(9)}${"ms".padStart(7)}  window`,
  );
  for (const r of rows.sort((a, b) => a.from - b.from))
    console.log(
      `   ${String(r.n).padEnd(5)}${String(r.endpoint).slice(0, 24).padEnd(26)}` +
        `${String(r.queuedMs).padStart(9)}${String(r.ms).padStart(7)}  ${bar(r, base, span)}`,
    );

  const wall = finished - started;
  const busy = rows.reduce((n, r) => n + r.ms, 0);
  const byEndpoint = {};
  for (const r of rows) byEndpoint[r.endpoint] = (byEndpoint[r.endpoint] ?? 0) + 1;
  console.log(
    `   ${busy}ms of completion over ${wall}ms of wall clock → ` +
      `observed concurrency ${observedConcurrency(rows, wall).toFixed(2)} ` +
      `(ceiling ${policy.mode === "series" ? 1 : policy.concurrency}) · ` +
      `per endpoint ${Object.entries(byEndpoint)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
  );
  /* The order the endpoints were handed out in, which is the whole of what
     round-robin claims and is invisible in a count. */
  console.log(
    `   order taken: ${rows
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((r) => r.endpoint)
      .join(" → ")}`,
  );
  return rows;
}

/**
 * THE ONE TEST THAT TELLS THE TWO BALANCE RULES APART.
 *
 * Four calls fired at once over two endpoints alternate under BOTH rules, so
 * the scenarios above prove that spreading happens and prove nothing about
 * which rule is doing it. The difference only shows under an UNEVEN load, and
 * this is the smallest arrangement that produces one:
 *
 *   1. a long call goes out and stays running,
 *   2. a short call goes out and COMPLETES on the other endpoint,
 *   3. a third call is fired while the long one is still going.
 *
 * Round-robin hands the third call to the next endpoint in order — which is
 * the one still busy with the long call. Least-busy counts what is in flight
 * and hands it to the free one. Same two endpoints, same three calls, two
 * different answers, and the verdict below is read off which endpoint the
 * third call actually landed on.
 */
async function balanceContrast(balance) {
  await api("/api/models/local/policy", {
    method: "PUT",
    body: JSON.stringify({ mode: "parallel", concurrency: 4, balance }),
  });

  const LONG =
    "Write about four hundred words on the history of tide tables. Plain prose.";
  const SHORT = "Reply with one word: ok.";

  const long = one("L", LONG); /* deliberately not awaited */
  await sleep(150);
  const first = await one("S1", SHORT);
  const second = await one("S2", SHORT);
  const held = await long;

  const stuckOnBusy = second.endpoint === held.endpoint;
  console.log(`\n── UNEVEN LOAD · ${balance.toUpperCase()}`);
  console.log(
    "   one long call left running, one short call completed elsewhere, then a third",
  );
  console.log(`   long call  L  → ${held.endpoint} (${held.ms}ms, still running when S2 was sent)`);
  console.log(`   short call S1 → ${first.endpoint} (${first.ms}ms, finished)`);
  console.log(`   short call S2 → ${second.endpoint} (${second.ms}ms)`);
  console.log(
    `   S2 went to the endpoint that was ${stuckOnBusy ? "BUSY" : "FREE"} — ` +
      (balance === "round-robin"
        ? stuckOnBusy
          ? "which is round-robin: next in order, busy or not."
          : "unexpected for round-robin."
        : stuckOnBusy
          ? "unexpected for least-busy."
          : "which is least-busy: the one with nothing in flight."),
  );
}

async function main() {
  const before = await api("/api/models/providers");
  const local = before.providers.find((p) => p.id === "local");
  if (!local?.connected) {
    console.error(
      "The `local` provider is not connected. Add at least one endpoint on the " +
        "Local models integration page — two, to see the balance rules — and run " +
        "this again.",
    );
    process.exit(1);
  }

  const endpoints = (await api("/api/models/local/models")).endpoints;
  console.log(`API ${API}`);
  console.log(
    `local endpoints: ${endpoints.map((e) => `${e.label} (${e.baseUrl})`).join(", ")}`,
  );
  console.log(
    `default provider was: ${before.chosen ?? "none"} · policy was ` +
      `${local.policyIsDefault ? "the default" : JSON.stringify(local.policy)}`,
  );

  const restore = async () => {
    if (local.policyIsDefault)
      await api("/api/models/local/policy", { method: "DELETE" });
    else
      await api("/api/models/local/policy", {
        method: "PUT",
        body: JSON.stringify(local.policy),
      });
    await api("/api/models/provider", {
      method: "PUT",
      body: JSON.stringify({ provider: before.chosen }),
    });
    console.log(
      `\nput back: default provider ${before.chosen ?? "none"}, local policy ` +
        `${local.policyIsDefault ? "back to the default" : "as it was"}.`,
    );
  };

  try {
    await api("/api/models/provider", {
      method: "PUT",
      body: JSON.stringify({ provider: "local" }),
    });

    await scenario(
      "SERIES — one at a time",
      { mode: "series", concurrency: 1, balance: "round-robin" },
      "observed concurrency ~1.00, and queuedMs climbing call by call",
    );

    await scenario(
      "PARALLEL 4 — all at once",
      { mode: "parallel", concurrency: 4, balance: "round-robin" },
      "queuedMs zero on all four — the limiter let every one through at once. " +
        "How far they then actually overlap is the RUNNERS' business: an Ollama " +
        "serving one request at a time caps the observed concurrency at one per " +
        "endpoint however wide this ceiling is opened",
    );

    if (endpoints.length > 1) {
      await scenario(
        "PARALLEL 4 · ROUND-ROBIN — spread in order",
        { mode: "parallel", concurrency: 4, balance: "round-robin" },
        `the ${endpoints.length} endpoints taken in turn, in the order they were added`,
      );
      await scenario(
        "PARALLEL 4 · LEAST-BUSY — spread by load",
        { mode: "parallel", concurrency: 4, balance: "least-busy" },
        "each call to whichever endpoint has the fewest in flight",
      );
      /* Four simultaneous calls alternate under both rules, so the two above
         prove spreading and not WHICH rule. This is the uneven load that
         separates them. */
      await balanceContrast("round-robin");
      await balanceContrast("least-busy");
    } else {
      console.log(
        "\n── the two balance rules were NOT exercised: there is one local " +
          "endpoint, and round-robin over one endpoint is indistinguishable " +
          "from least-busy over one endpoint. Add a second and run this again.",
      );
    }
  } finally {
    await restore();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (err?.cause) console.error(String(err.cause?.message ?? err.cause));
  process.exit(1);
});
