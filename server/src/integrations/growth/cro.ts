/**
 * WHERE THE FUNNEL LEAKS, AND WHAT TO TRY ABOUT IT.
 *
 * THE LIBRARY IS STATIC AND THE STAGE IS MEASURED. `cro-library.ts` holds
 * forty-odd hypotheses bucketed by funnel stage and written by hand; this file
 * decides WHICH BUCKET a venture should be reading, from figures the box
 * already collects, and keeps the ledger of which ones are actually being run.
 *
 * THREE SOURCES, TRIED IN ORDER, AND THE ANSWER SAYS WHICH ONE ANSWERED —
 * because they are not equally good and an owner acting on the third deserves
 * to know it is the third:
 *
 *   1. THE PRODUCT'S OWN FUNNEL. A product endpoint whose URL is on this
 *      venture's host, whose last document carries counters this recognises as
 *      funnel steps. This is the only source that measures the product's own
 *      users; everything else is a proxy.
 *   2. UMAMI EVENTS AND STRIPE. Sessions for the venture's domain as the top
 *      of the funnel, the named events the site actually fires (`signup-…`,
 *      `checkout-started`, `payment-completed`) as the middle, and Stripe
 *      subscriptions whose PRODUCT NAME contains the venture's name as the
 *      bottom. Every join there is a name match and the answer says so.
 *   3. NOTHING. Then there is no stage, the whole library is offered, and the
 *      owner is asked. A guessed stage would send somebody to rewrite a
 *      pricing page when the problem is that nobody arrives.
 *
 * COUNTERS ARE NEVER SUMMED WITHIN A STAGE. A site that fires both
 * `checkout-started` and `checkout-requested` has two names for one step, and
 * adding them would double the step and invent a leak below it. The largest
 * single counter is taken and the key it came from is named.
 *
 * A LEAK IS A TRANSITION, NOT A STAGE, and the stage reported is the LATER
 * half of the worst transition: the step people failed to reach is the one
 * whose page is worth changing. Both halves are on the answer so this can be
 * argued with.
 *
 * AND IT REFUSES TO NAME ONE ON A SMALL SAMPLE. Below `MIN_SAMPLE` at the top
 * of a transition the ratio moves by a fifth every time one more person acts;
 * a stage named off that is a coin toss with a recommendation attached.
 */
import { db, now, type VentureRow } from "../../db.ts";
import { registrable } from "./pages.ts";
import { EXPERIMENTS, REFUSALS, STAGES, experiment, forStage, type Experiment } from "./cro-library.ts";

/** The order steps happen in. A transition is only computed between two
 *  stages that are adjacent IN THIS LIST among the ones actually present. */
const STAGE_ORDER = ["landing", "signup", "onboarding", "activation", "pricing", "paywall", "retention"];

/** Below this many at the top of a transition, no stage is named. */
const MIN_SAMPLE = 30;

/** How far back the Umami and Stripe fallback looks. */
const WINDOW_DAYS = 30;

/* ------------------------------------------------- naming a counter's stage */

/**
 * Which funnel stage a counter's NAME describes.
 *
 * Regexes over the key rather than a fixed list of key names, because every
 * product endpoint on this box spells its own counters differently — one calls
 * it `report_lookup`, another `views`, a third `checkout_started` — and a fixed
 * list would work for exactly the endpoint it was written against. A name that
 * matches nothing is not a funnel step and is ignored rather than guessed at.
 */
export function stageOfKey(key: string): string | null {
  const k = key.toLowerCase();
  /* A NEGATIVE OUTCOME IS NOT A FUNNEL STEP. `subscription-ended`,
     `checkout-failed` and `checkout-abandoned` all carry the words this file
     matches on, and counting one as the bottom of the funnel would report
     cancellations as conversions — which is not a small error, it is the
     opposite of the truth. They are excluded here rather than filtered later,
     so nothing downstream has to remember. */
  if (/cancel|ended|refund|churn|abandon|fail|declin|error|deleted|removed|unsubscrib|bounce/.test(k)) return null;
  if (/(^|[_\-.])(paid|payment|purchase|revenue|subscription|subscribed|checkout[_\-.]?(complete|completed|paid))/.test(k)) return "paywall";
  if (/checkout|cart|upgrade|premium[_\-.]?cta/.test(k)) return "pricing";
  if (/sign[_\-.]?up|signup|register|account[_\-.]?created/.test(k)) return "signup";
  if (/onboard/.test(k)) return "onboarding";
  if (/activat|first[_\-.]?(run|result|use)/.test(k)) return "activation";
  if (/retain|retention|return(ing)?|repeat|active[_\-.]?(user|device)/.test(k)) return "retention";
  if (/view|visit|session|pageview|lookup|impression|search/.test(k)) return "landing";
  return null;
}

/* --------------------------------------------------------------- the funnel */

export type Step = {
  stage: string;
  /** The counter's own name, exactly as its source spells it. */
  key: string;
  count: number;
  from: string;
};

export type Transition = { from: string; to: string; ratio: number | null; why: string };

export type Funnel = {
  /** "product endpoint" | "umami and stripe" | null */
  source: string | null;
  steps: Step[];
  transitions: Transition[];
  /** The stage to read the library for. Null means nothing could name one. */
  stage: string | null;
  /** Why that stage, or why none. Always populated. */
  why: string;
  /** What was looked at and did not answer. */
  tried: string[];
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Every leaf number in a document, flattened to `a.b.c` keys. Bounded, so a
 *  product endpoint that publishes a thousand-row export cannot turn this into
 *  a walk of a thousand keys. */
function leaves(doc: unknown, prefix = "", out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (depth > 3 || Object.keys(out).length > 200) return out;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const n = num(v);
    if (n !== null) out[key] = n;
    else if (v && typeof v === "object" && !Array.isArray(v)) leaves(v, key, out, depth + 1);
  }
  return out;
}

/** The product endpoint whose URL is on this venture's host, if there is one. */
function productFunnel(v: VentureRow): { steps: Step[]; label: string } | null {
  if (!v.host) return null;
  const want = registrable(v.host);
  const rows = db.prepare("SELECT account_id, url, doc, ts FROM product_docs WHERE ok = 1").all() as unknown as {
    account_id: number;
    url: string;
    doc: string;
    ts: string;
  }[];
  for (const r of rows) {
    let host: string | null = null;
    try {
      host = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (registrable(host) !== want) continue;
    let doc: unknown = null;
    try {
      doc = JSON.parse(r.doc);
    } catch {
      continue;
    }
    /* `totals` first when the document has one — a funnel endpoint that
       publishes both totals and a weekly series means the totals, and walking
       the series would produce one step per week. */
    const scope = (doc as Record<string, unknown>).totals ?? doc;
    const flat = leaves(scope);
    const best = new Map<string, Step>();
    for (const [key, count] of Object.entries(flat)) {
      const stage = stageOfKey(key);
      if (!stage) continue;
      const prev = best.get(stage);
      /* THE LARGEST SINGLE COUNTER, NEVER THE SUM. See the header. */
      if (!prev || count > prev.count) best.set(stage, { stage, key, count, from: `the product endpoint ${r.url}` });
    }
    if (best.size >= 2) return { steps: [...best.values()], label: `the product endpoint ${r.url}, last read ${r.ts}` };
  }
  return null;
}

/** Umami sessions and events for the venture's domain, plus Stripe
 *  subscriptions whose product name carries the venture's name. */
function signalFunnel(v: VentureRow): { steps: Step[]; label: string } | null {
  const steps: Step[] = [];
  const parts: string[] = [];

  if (v.host) {
    const want = registrable(v.host);
    const sites = db.prepare("SELECT account_id, website_id, domain FROM umami_websites").all() as unknown as {
      account_id: number;
      website_id: string;
      domain: string | null;
    }[];
    const site = sites.find((s) => s.domain && registrable(s.domain.replace(/^https?:\/\//, "").split("/")[0]!) === want);
    if (site) {
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
      const sessions = db
        .prepare("SELECT SUM(sessions) AS n FROM umami_days WHERE website_id = ? AND day >= ?")
        .get(site.website_id, since) as { n: number | null } | undefined;
      if (sessions?.n)
        steps.push({ stage: "landing", key: "sessions", count: sessions.n, from: `Umami sessions for ${site.domain} over the last ${WINDOW_DAYS} days` });

      const events = db
        .prepare("SELECT name, count, window_days FROM umami_top WHERE website_id = ? AND kind = 'event' ORDER BY window_days")
        .all(site.website_id) as unknown as { name: string; count: number; window_days: number }[];
      const best = new Map<string, Step>();
      for (const e of events) {
        const stage = stageOfKey(e.name);
        if (!stage || stage === "landing") continue;
        const prev = best.get(stage);
        if (!prev || e.count > prev.count)
          best.set(stage, { stage, key: e.name, count: e.count, from: `Umami's ${e.window_days}-day event count for ${site.domain}` });
      }
      steps.push(...best.values());
      if (steps.length) parts.push(`Umami for ${site.domain}`);
    }
  }

  /* STRIPE, JOINED ON THE PRODUCT'S NAME AND NOTHING ELSE. There is no venture
     id anywhere in Stripe, so this matches the venture's name inside the
     subscription's product name — which is how the owner named the products,
     and is a join by convention rather than by key. It is labelled as such and
     a venture whose products are named differently simply gets no bottom step. */
  const key = v.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.length >= 4) {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const subs = db
      .prepare("SELECT product FROM stripe_subscriptions WHERE created_at >= ?")
      .all(since) as unknown as { product: string | null }[];
    const mine = subs.filter((s) => (s.product ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(key)).length;
    if (mine > 0)
      steps.push({
        stage: "paywall",
        key: "stripe subscriptions created",
        count: mine,
        from: `Stripe subscriptions created in the last ${WINDOW_DAYS} days whose product name contains “${v.name}” — a join by NAME, not by any id`,
      });
    if (mine > 0) parts.push("Stripe");
  }

  return steps.length >= 2 ? { steps, label: parts.join(" and ") } : null;
}

/** Order the steps, compute the transitions, and name the leak. */
function readFunnel(steps: Step[], label: string): Funnel {
  /* ONE STEP PER STAGE, ACROSS EVERY SOURCE. Umami's `payment-completed` and
     Stripe's subscription count are both the paywall step, and leaving both in
     would produce a paywall → paywall transition — a stage compared with
     itself, which is not a leak. The larger single counter wins, on the same
     rule that applies inside a source: never the sum, and the key that
     answered is named on the step. */
  const best = new Map<string, Step>();
  for (const s of steps) {
    if (!STAGE_ORDER.includes(s.stage)) continue;
    const prev = best.get(s.stage);
    if (!prev || s.count > prev.count) best.set(s.stage, s);
  }
  const ordered = [...best.values()].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));

  const transitions: Transition[] = [];
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const from = ordered[i]!;
    const to = ordered[i + 1]!;
    if (from.count < MIN_SAMPLE)
      transitions.push({
        from: from.stage,
        to: to.stage,
        ratio: null,
        why: `only ${from.count} at ${from.stage} over the window, under the floor of ${MIN_SAMPLE} — the ratio would move by a fifth every time one more person acted, so it is not computed`,
      });
    else
      transitions.push({
        from: from.stage,
        to: to.stage,
        /* THREE SIGNIFICANT FIGURES RATHER THAN FOUR DECIMAL PLACES. Five
           checkouts out of a hundred thousand lookups is 0.0000471, and
           rounding that to four places prints `0` — which reads as "nobody
           ever" when what happened is "one in twenty thousand". */
        ratio: Number((to.count / from.count).toPrecision(3)),
        why: `${to.count} (${to.key}) ÷ ${from.count} (${from.key})`,
      });
  }

  const usable = transitions.filter((t) => t.ratio !== null);
  if (!usable.length)
    return {
      source: label,
      steps: ordered,
      transitions,
      stage: null,
      why:
        ordered.length < 2
          ? `${label} produced only ${ordered.length} recognisable funnel step, and a leak is a transition between two of them.`
          : `${label} produced steps, but every transition was under the sample floor of ${MIN_SAMPLE}. There is not enough traffic yet to say where it leaks.`,
      tried: [],
    };

  const worst = usable.reduce((a, b) => (b.ratio! < a.ratio! ? b : a));
  return {
    source: label,
    steps: ordered,
    transitions,
    /* THE LATER HALF. The step people failed to REACH is the one whose page is
       worth changing — if nobody starts checkout, it is the pricing page that
       is not working, not the page they came from. */
    stage: worst.to,
    why: `The worst transition is ${worst.from} → ${worst.to} at ${worst.ratio} (${worst.why}), read from ${label}. The stage reported is the later half: the step people did not reach is the one whose page is worth changing.`,
    tried: [],
  };
}

/** The whole answer for one venture, with an owner override honoured. */
export function funnelFor(v: VentureRow, override?: string | null): Funnel {
  if (override && STAGES.some((s) => s.id === override))
    return {
      source: "the owner",
      steps: [],
      transitions: [],
      stage: override,
      why: `The stage was chosen by the owner. Nothing was measured to reach it, and the library below is simply that stage's bucket.`,
      tried: [],
    };

  const tried: string[] = [];
  const product = productFunnel(v);
  if (product) return { ...readFunnel(product.steps, product.label), tried };
  tried.push(
    v.host
      ? `No connected product endpoint publishes a URL on ${v.host} with at least two recognisable funnel counters in its last document.`
      : "This venture has no host recorded, so no product endpoint could be matched to it.",
  );

  const signals = signalFunnel(v);
  if (signals) return { ...readFunnel(signals.steps, signals.label), tried };
  tried.push(
    `Umami has no website matching this venture's host with named funnel events, and no Stripe subscription's product name contains “${v.name}” within the last ${WINDOW_DAYS} days.`,
  );

  return {
    source: null,
    steps: [],
    transitions: [],
    stage: null,
    why:
      "Nothing on this box can name the leaking stage for this venture, so none is claimed. The whole library is offered instead and the owner is the one to pick — a guessed stage would send somebody to rewrite a pricing page when the problem is that nobody arrives.",
    tried,
  };
}

/* --------------------------------------------------------------- the ledger */

export type CroRow = {
  venture_id: string;
  experiment: string;
  status: string;
  stage: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  outcome_link: string | null;
  created_at: string;
  updated_at: string;
};

export function ledgerFor(ventureId: string) {
  const rows = db
    .prepare("SELECT * FROM growth_cro WHERE venture_id = ? ORDER BY updated_at DESC")
    .all(ventureId) as unknown as CroRow[];
  return rows.map((r) => ({
    experiment: r.experiment,
    /** The library entry, resolved now. Null when the library no longer has an
     *  experiment by that id — a row from an older build, kept rather than
     *  hidden, because the owner ran it. */
    detail: experiment(r.experiment),
    status: r.status,
    stage: r.stage,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    result: r.result,
    outcomeLink: r.outcome_link,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function startExperiment(
  ventureId: string,
  id: string,
  stage: string | null,
): { ok: true; row: ReturnType<typeof ledgerFor>[number] } | { ok: false; error: string } {
  const def = experiment(id);
  if (!def) return { ok: false, error: `There is no experiment “${id}” in the library. GET /api/growth/cro/<venture> lists them.` };
  const existing = db.prepare("SELECT status FROM growth_cro WHERE venture_id = ? AND experiment = ?").get(ventureId, id) as
    | { status: string }
    | undefined;
  if (existing && existing.status === "running")
    return { ok: false, error: `${id} is already running for this venture. Finish it before starting it again.` };
  const ts = now();
  db.prepare(
    `INSERT INTO growth_cro (venture_id, experiment, status, stage, started_at, finished_at, result, outcome_link, created_at, updated_at)
     VALUES (?, ?, 'running', ?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(venture_id, experiment) DO UPDATE SET
       status = 'running', stage = excluded.stage, started_at = excluded.started_at,
       finished_at = NULL, result = NULL, updated_at = excluded.updated_at`,
  ).run(ventureId, id, stage ?? def.stage, ts, ts, ts);
  const row = ledgerFor(ventureId).find((r) => r.experiment === id)!;
  return { ok: true, row };
}

export function finishExperiment(
  ventureId: string,
  id: string,
  outcome: string,
  result: string | null,
  outcomeLink: string | null,
): { ok: true; row: ReturnType<typeof ledgerFor>[number] } | { ok: false; error: string } {
  if (outcome !== "done" && outcome !== "dropped")
    return { ok: false, error: `An experiment finishes as “done” or “dropped”, not “${outcome}”. Dropped means it was abandoned before it had a result, and that is not a finding.` };
  const existing = db.prepare("SELECT status FROM growth_cro WHERE venture_id = ? AND experiment = ?").get(ventureId, id) as
    | { status: string }
    | undefined;
  if (!existing) return { ok: false, error: `${id} was never started for this venture, so there is nothing to finish.` };
  const ts = now();
  db.prepare(
    `UPDATE growth_cro SET status = ?, finished_at = ?, result = ?, outcome_link = ?, updated_at = ?
      WHERE venture_id = ? AND experiment = ?`,
  ).run(outcome, ts, result, outcomeLink, ts, ventureId, id);
  const row = ledgerFor(ventureId).find((r) => r.experiment === id)!;
  return { ok: true, row };
}

/** The document one venture's CRO tab and the skill both read. */
export function croFor(v: VentureRow, override?: string | null) {
  const funnel = funnelFor(v, override);
  const running = ledgerFor(v.id);
  const shortlist: Experiment[] = funnel.stage ? forStage(funnel.stage) : [];
  return {
    venture: { id: v.id, slug: v.slug, name: v.name, host: v.host, stage: v.stage },
    funnel,
    stages: STAGES,
    /** The bucket for the leaking stage, biggest lever first. Empty when no
     *  stage could be named — and then `library` is the whole thing. */
    shortlist,
    library: EXPERIMENTS,
    refusals: REFUSALS,
    experiments: running,
    note:
      "The library is static and hand-written; no model wrote a line of it and none may add one. Nothing here is a promise that a test will win — most lose. The point is that a hypothesis never has to be invented from a blank page.",
  };
}
