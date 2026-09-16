/**
 * THE EVIDENCE PACKET — what is actually known about one venture tonight.
 *
 * WHY IT IS ASSEMBLED IN CODE AND NOT ASKED FOR. The synthesis pass exists to
 * decide the best next action for a business, and the failure it has to avoid
 * is the one every "AI suggests next steps" feature has: a model given a name
 * and a stage will produce three plausible actions for any business in the
 * world, none of which is about THIS one. So the model is not asked what to do
 * until it has been handed the seven things this box measures, and the gate in
 * synthesis.ts then refuses any proposal that does not cite one of them.
 *
 * EVERY FIELD IS `null` WHEN IT IS NOT MEASURED, AND NULL CARRIES ITS REASON.
 * Not zero. A venture with no Umami website linked has `traffic: null` with
 * "no Umami website is linked to this venture", and the difference between
 * that and "traffic is zero" is the difference between a proposal worth
 * reading and a hallucination with a number in it. `nothingMeasured` is true
 * when every one of the seven is null, and the pass declines to ask the model
 * anything at all in that case — there is no honest question to ask.
 *
 * NOTHING HERE IS HARD-CODED TO A BUSINESS. Which Stripe products and which
 * Umami website belong to a venture is read from `venture_links`, the table
 * the owner fills in on the connections page; a venture with no links gets
 * nulls and a sentence saying which link would fix it. That is the whole
 * mechanism, and it works identically for someone else's nineteen businesses
 * or for one.
 *
 * WINDOWS ARE STATED IN THE PACKET ITSELF because the model is going to quote
 * them. Revenue is monthly recurring revenue per currency, now against the
 * same measure thirty days ago; traffic is Umami's own complete-days window
 * against the window immediately before it; alerts and runs are the last seven
 * days. A figure whose window is not stated is a figure an agent will caption
 * wrongly.
 */
import { db, ventureRowById, type VentureRow } from "../../db.ts";
import { stripeSubscriptions } from "../../db.ts";
import { ventureGoal } from "../chief/goals.ts";
import { notes } from "../chief/memory.ts";
import { linkedEntities } from "../ventures/links.ts";
import { ventureMrr, ventureMrrPrevious, ventureOneOff } from "../finance/attribution.ts";
import { openEventsForVenture, rulesForVenture } from "../proactive/store.ts";
import { money } from "../../shared/money.ts";
/* PORT rather than `apiBase()` from the skill registry, and the difference is
   a module cycle: the registry imports `integrations/index.ts`, which imports
   this area's manifest, which imports this file. proactive/catalogue.ts makes
   the same one-line copy for the same reason. */
import { PORT } from "../../config.ts";
import { serviceHeaders } from "../../auth.ts";

const apiBase = () => `http://127.0.0.1:${PORT}`;

/** How far back "recent" reaches for alerts, runs and previous proposals. */
export const RECENT_DAYS = 7;
/** The window a revenue delta is measured over. */
export const REVENUE_WINDOW_DAYS = 30;

/** One measured thing, or an honest absence. `value` null with a `why` is the
 *  only way this type says "no". */
export type Measure<T> = { measured: T; why: null } | { measured: null; why: string };

const missing = (why: string) => ({ measured: null, why }) as const;

export type EvidencePacket = {
  ventureId: string;
  venture: string;
  slug: string;
  stage: string;
  host: string | null;
  description: string;
  builtAt: string;
  revenue: Measure<{
    window: string;
    products: string[];
    /** Live MRR keyed by currency code. Never one number: `monthly_usd` is the
     *  plan's price in ITS OWN currency, normalised to a month, and adding a
     *  euro to a dollar here would invent an exchange rate. */
    mrr: Record<string, number>;
    previous: Record<string, number>;
    delta: Record<string, number>;
    /**
     * SETTLED ONE-OFF CASH, which is not a run rate and is not in the three
     * fields above.
     *
     * A lifetime licence or a single study is money that ARRIVED — dated,
     * measured, per currency — and on at least one business here it is most of
     * the cash it takes. MRR cannot hold it: counted in as recurring it would
     * have to come back out as churn the following month. So it sits beside
     * MRR with its own window and its own label, and nothing adds the two.
     */
    oneOff: {
      window: string;
      days: number;
      count: number;
      gross: Record<string, number>;
      byProduct: { product: string; currency: string; count: number; gross: number }[];
    };
    note: string;
  }>;
  traffic: Measure<{
    window: string;
    sites: {
      entity: string;
      domain: string | null;
      pageviews: number | null;
      previousPageviews: number | null;
      deltaPct: number | null;
      visitors: number | null;
    }[];
  }>;
  alerts: Measure<{
    window: string;
    /** WHAT IS ACTUALLY BEING WATCHED for this venture. Without it the packet
     *  said "nothing is open" and a reader could not tell whether that meant
     *  all is well or nothing is looking. */
    watching: { name: string; skill: string; path: string; enabled: boolean }[];
    open: { ts: string; rule: string; message: string }[];
  }>;
  tasks: Measure<{ open: { title: string; column: string; due: string | null; urgency: number }[] }>;
  goals: Measure<{ text: string; updatedAt: string | null; tailorTo: string | null }>;
  memory: Measure<{ notes: { text: string; ageDays: number; source: string }[] }>;
  runs: Measure<{
    window: string;
    finished: { id: string; kind: string; title: string; finishedAt: string | null; headline: string }[];
  }>;
  /**
   * True when nothing SUBSTANTIVE is known: every section is null, or the only
   * measured one is an empty board.
   *
   * It used to be "all seven are null", which was unreachable — `tasks` is
   * measured even for an empty board, deliberately, because "there is nothing
   * on the list for this venture" is a fact a proposal may rest on. So the flag
   * was never true, the short-circuit never fired, and a venture about which
   * this box knew literally nothing still cost a model call every time its turn
   * came round. An empty board is evidence when there is something else beside
   * it and an absence of evidence when there is not.
   */
  nothingMeasured: boolean;
};

/* ------------------------------------------------------------------ revenue */

/**
 * MRR FOR THE STRIPE PRODUCTS THIS VENTURE OWNS, now against thirty days ago.
 *
 * THE LIVE HALF IS `ventureMrr`, which is the figure the finance area
 * publishes. Reducing the same rows a second time here is how the two came to
 * disagree: this file counted `active || trialing`, and a trial has never sent
 * a cent — counted in as revenue it comes back out as churn the day it ends.
 *
 * DESPITE THE COLUMN NAME, `monthly_usd` IS NOT DOLLARS. It is the plan's own
 * price normalised to a month in the plan's own currency, so both halves are
 * keyed by currency code and nothing here adds one to another.
 *
 * "Thirty days ago" is reconstructed from the subscription rows themselves: a
 * subscription counts in the past figure if it had been created by then and
 * had not ended by then. That is a reconstruction and it says so in `note` —
 * it cannot see a plan whose PRICE changed, only one that started or stopped.
 */
function revenue(v: VentureRow): EvidencePacket["revenue"] {
  let products: string[] = [];
  try {
    products = linkedEntities(v.id, "stripe");
  } catch {
    return missing("the venture-links table could not be read.");
  }
  if (!products.length)
    return missing(
      "no Stripe product is linked to this venture. Link one on the venture's connections page and this becomes a measured figure.",
    );

  let mrr: Record<string, number>;
  let subs: ReturnType<typeof stripeSubscriptions>;
  try {
    mrr = ventureMrr(v.id);
    subs = stripeSubscriptions();
  } catch {
    return missing("the Stripe subscription table could not be read.");
  }

  /* Case-insensitively, as `ventureMrr` matches: a product linked as "Pro" and
     billed as "pro" is one product, and matching exactly here would put the two
     halves of the delta on different sets of rows. */
  const wanted = new Set(products.map((e) => e.trim().toLowerCase()));
  const mine = subs.filter((s) => s.product && wanted.has(s.product.trim().toLowerCase()));
  if (!mine.length)
    return missing(
      `Stripe products ${products.join(", ")} are linked, but the collector holds no subscription rows for them.`,
    );

  /* THE RECONSTRUCTION IS THE FINANCE AREA'S, not a second copy here. The
     Stripe document publishes the same delta per venture for alert rules to
     watch, and two reconstructions of one figure is how the rule that fires
     and the proposal that is written come to disagree about the same night. */
  const previous = ventureMrrPrevious(v.id, REVENUE_WINDOW_DAYS, subs);

  const delta: Record<string, number> = {};
  for (const code of new Set([...Object.keys(mrr), ...Object.keys(previous)]))
    delta[code] = money((mrr[code] ?? 0) - (previous[code] ?? 0));

  /* THE OTHER HALF OF THE MONEY. Counted from the charge rows, whose product
     comes off the Checkout Session that sold it, so this is settled cash with
     a product on it rather than an allocation. It never touches `mrr`. */
  let oneOff: ReturnType<typeof ventureOneOff>;
  try {
    oneOff = ventureOneOff(v.id, REVENUE_WINDOW_DAYS);
  } catch {
    oneOff = {
      days: REVENUE_WINDOW_DAYS,
      count: 0,
      gross: {},
      byProduct: [],
      window: "the charge table could not be read",
    };
  }

  return {
    measured: {
      window: `monthly recurring revenue per currency, now against ${REVENUE_WINDOW_DAYS} days ago`,
      products,
      mrr: Object.fromEntries(Object.entries(mrr).map(([c, n]) => [c, money(n)])),
      previous: Object.fromEntries(Object.entries(previous).map(([c, n]) => [c, money(n)])),
      delta,
      oneOff: {
        window: oneOff.window,
        days: oneOff.days,
        count: oneOff.count,
        gross: oneOff.gross,
        byProduct: oneOff.byProduct,
      },
      note:
        "The past figure is reconstructed from subscription start and end dates, " +
        "so it sees subscriptions that started or stopped and cannot see a price " +
        "that changed. Currencies are kept apart: each plan was normalised to a " +
        "month in its own currency and nothing here converts. LIFETIME AND OTHER " +
        "ONE-OFF PURCHASES ARE EXCLUDED FROM MRR BY DESIGN — they are money that " +
        "arrived once, not money contracted to arrive again — and are reported in " +
        "`oneOff` as settled cash over its own window. Do not add the two, and do " +
        "not describe one-off cash as a run rate. A one-off charge this box could " +
        "not attribute to a product is in neither figure.",
    },
    why: null,
  };
}

/* ------------------------------------------------------------------ traffic */

/**
 * Umami's own window against the window immediately before it, for the
 * websites this venture is linked to.
 *
 * Read over the loopback rather than out of the tables, because
 * `/api/umami` is where the window arithmetic and the "visitors do not add"
 * rule already live, and a second reader of `umami_windows` would be a second
 * place for that rule to be forgotten.
 */
async function traffic(v: VentureRow, signal?: AbortSignal): Promise<EvidencePacket["traffic"]> {
  let linked: string[] = [];
  try {
    linked = linkedEntities(v.id, "umami");
  } catch {
    return missing("the venture-links table could not be read.");
  }
  if (!linked.length)
    return missing(
      "no Umami website is linked to this venture. Link one on the connections page and this becomes a measured figure.",
    );

  let doc: unknown;
  try {
    const res = await fetch(`${apiBase()}/api/umami`, { headers: serviceHeaders(), signal });
    if (!res.ok) return missing(`the Umami document answered HTTP ${res.status}.`);
    doc = await res.json();
  } catch {
    return missing("the Umami document could not be read.");
  }
  const websites = (doc as { websites?: unknown })?.websites;
  if (!Array.isArray(websites)) return missing("the Umami document held no website list.");

  const wanted = new Set(linked);
  const sites = (websites as Record<string, unknown>[])
    .filter((w) => typeof w.entity === "string" && wanted.has(w.entity))
    .map((w) => {
      const win = w.window as { pageviews?: number; visitors?: number } | null;
      const prev = w.previous as { pageviews?: number } | null;
      const deltas = w.deltas as { pageviews?: number | null } | null;
      return {
        entity: String(w.entity),
        domain: typeof w.domain === "string" ? w.domain : null,
        pageviews: win?.pageviews ?? null,
        previousPageviews: prev?.pageviews ?? null,
        deltaPct: deltas?.pageviews ?? null,
        visitors: win?.visitors ?? null,
      };
    });
  if (!sites.length)
    return missing(
      `Umami website${linked.length === 1 ? "" : "s"} ${linked.join(", ")} ${linked.length === 1 ? "is" : "are"} linked, but the collector holds no window for ${linked.length === 1 ? "it" : "them"} yet.`,
    );

  return {
    measured: {
      window:
        "Umami's last complete days against the same length of window immediately before. " +
        "Visitors are de-duplicated per website and must never be added across sites.",
      sites,
    },
    why: null,
  };
}

/* ------------------------------------------------------------------- alerts */

function alerts(v: VentureRow): EvidencePacket["alerts"] {
  let rows: ReturnType<typeof openEventsForVenture>;
  try {
    rows = openEventsForVenture(v.id, { days: RECENT_DAYS });
  } catch {
    return missing("the alert tables could not be read.");
  }
  /* "No rule watches this" and "nothing has tripped" are different findings,
     and only one of them is about the business. The rules are NAMED rather
     than counted: "nothing is open" under two rules about payments and
     "nothing is open" under one rule about a domain expiring are different
     assurances, and a packet that reported only a count let the model treat
     the second as the first. */
  let watchers: ReturnType<typeof rulesForVenture>;
  try {
    watchers = rulesForVenture(v.id);
  } catch {
    return missing("the alert rules could not be read.");
  }
  if (!watchers.length)
    return missing("no alert rule on this box names this venture, so nothing is being watched for it.");
  return {
    measured: {
      window: `open trips and unreadable readings in the last ${RECENT_DAYS} days`,
      watching: watchers.map((r) => ({
        name: r.name,
        skill: r.skill,
        path: r.path,
        enabled: r.enabled === 1,
      })),
      open: rows.map((r) => ({ ts: r.ts, rule: r.rule, message: r.message })),
    },
    why: null,
  };
}

/* -------------------------------------------------------------------- tasks */

/**
 * The venture's open board cards. Also the dedupe corpus.
 *
 * TWO CALLERS AND TWO LIMITS. The PACKET shows the model a recent slice, capped
 * for prompt size; the GATE (`opts.all`) reads every one, because a card the
 * owner cannot see at the top of his board is exactly the one he has forgotten,
 * and re-proposing it is the fastest way to teach him to stop reading these.
 * One truncated list serving both was a silent hole in the dedupe.
 */
export const PACKET_CARDS = 60;
export const GATE_CARDS = 2_000;

export function openCards(
  ventureId: string,
  opts: { all?: boolean } = {},
): { title: string; column: string; due: string | null; urgency: number }[] {
  try {
    return db
      .prepare(
        `SELECT c.title AS title, col.title AS column_title, c.due AS due, c.urgency AS urgency
           FROM board_cards c JOIN board_columns col ON col.id = c.column_id
          WHERE c.venture_id = ? AND c.archived_at IS NULL AND col.key <> 'done'
          ORDER BY c.updated_at DESC LIMIT ${opts.all ? GATE_CARDS : PACKET_CARDS}`,
      )
      .all(ventureId)
      .map((r) => {
        const row = r as { title: string; column_title: string; due: string | null; urgency: number };
        return { title: row.title, column: row.column_title, due: row.due, urgency: row.urgency };
      });
  } catch {
    return [];
  }
}

function tasks(v: VentureRow): EvidencePacket["tasks"] {
  let open: ReturnType<typeof openCards>;
  try {
    open = openCards(v.id);
  } catch {
    return missing("the board could not be read.");
  }
  /* An EMPTY board is measured, not missing: "nothing is on the list for this
     venture" is a fact a proposal may rest on, and the commonest one. */
  return { measured: { open }, why: null };
}

/* -------------------------------------------------------------------- goals */

function goals(v: VentureRow): EvidencePacket["goals"] {
  const doc = ventureGoal(v.id);
  if (!doc) return missing("the goals document could not be read.");
  if (!doc.text.trim())
    return missing("nothing has been written as a goal for this venture. Its stage is the only intent on record.");
  return { measured: { text: doc.text.slice(0, 2_000), updatedAt: doc.updatedAt, tailorTo: doc.tailorTo }, why: null };
}

/* ------------------------------------------------------------------- memory */

function memory(v: VentureRow): EvidencePacket["memory"] {
  let rows: ReturnType<typeof notes>;
  try {
    rows = notes({ scope: "venture", ventureId: v.id });
  } catch {
    return missing("the memory table could not be read.");
  }
  if (!rows.length) return missing("the assistant holds no dated note about this venture.");
  return {
    measured: {
      notes: rows.slice(0, 12).map((n) => ({ text: n.text, ageDays: n.ageDays, source: n.source })),
    },
    why: null,
  };
}

/* --------------------------------------------------------------------- runs */

/**
 * THE HEAD OF A RUN'S REPORT, CUT ONLY WHERE THE REPORT ITSELF BREAKS.
 *
 * It used to be `output.replace(/\s+/g," ").slice(0, 400)`, and both halves of
 * that were wrong in the same way. Collapsing the newlines destroyed the one
 * structure a report has — its findings are LINES — and a blind 400 then cut
 * the survivor mid-word:
 *
 *   "- [error] page-error — one URL (`/'%20+%20href%20+%20'`) retu"
 *
 * The synthesis model read that fragment, could not see "returned 404", and
 * invented a server error. A truncation that can end mid-word is a truncation
 * that can change what the evidence says, and the whole pass rests on the
 * evidence saying what it says.
 *
 * SO: whole lines or nothing. The first few findings, each one entire, up to a
 * character budget that is checked BEFORE a line is added rather than after —
 * and an ellipsis when anything was left behind, so the model can see it is
 * reading a head and not a report.
 *
 * Still a headline and not the report: a research run's output is thousands of
 * words and six of those in a prompt would be the context window spent on last
 * week's reading. The run id is in the packet so the owner — or the agent,
 * through the runs skill — can open the real thing.
 */
export const HEADLINE_LINES = 6;
export const HEADLINE_CHARS = 1_200;

export function headline(output: string): string {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= HEADLINE_LINES) break;
    /* The FIRST line is always taken whole, whatever it costs: a report that is
       one long paragraph has no line boundary to stop at, and returning nothing
       would be worse than returning it. Every line after it has to fit. */
    if (kept.length && used + line.length + 1 > HEADLINE_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }

  /* THE ONE-PARAGRAPH REPORT, the only case where a cut inside a line is the
     lesser evil. It is made at a SPACE, so the last thing the model reads is
     still a whole word. */
  let cutInside = false;
  if (kept.length === 1 && kept[0]!.length > HEADLINE_CHARS) {
    const head = kept[0]!.slice(0, HEADLINE_CHARS);
    const space = head.lastIndexOf(" ");
    kept[0] = space > 0 ? head.slice(0, space) : head;
    cutInside = true;
  }

  return kept.join("\n") + (cutInside || kept.length < lines.length ? " …" : "");
}
/** Recently finished sub-agent runs, each with the head of its report — see
 *  `headline` above for why that is measured in whole lines. */
function runs(v: VentureRow): EvidencePacket["runs"] {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  let rows: { id: string; kind: string; title: string; finished_at: string | null; output: string }[];
  try {
    rows = db
      .prepare(
        `SELECT id, kind, title, finished_at, output FROM agent_runs
          WHERE venture_id = ? AND status = 'done' AND finished_at >= ?
          ORDER BY finished_at DESC LIMIT 6`,
      )
      .all(v.id, since) as unknown as typeof rows;
  } catch {
    return missing("the runs ledger could not be read.");
  }
  if (!rows.length)
    return missing(`no sub-agent run finished for this venture in the last ${RECENT_DAYS} days.`);
  return {
    measured: {
      window: `runs that finished in the last ${RECENT_DAYS} days`,
      finished: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        finishedAt: r.finished_at,
        headline: headline(r.output),
      })),
    },
    why: null,
  };
}

/* ------------------------------------------------------------------ the packet */

export async function packetFor(ventureId: string, signal?: AbortSignal): Promise<EvidencePacket | null> {
  const v = ventureRowById(ventureId);
  if (!v) return null;

  const packet: EvidencePacket = {
    ventureId: v.id,
    venture: v.name,
    slug: v.slug,
    stage: v.stage,
    host: v.host,
    description: (v.description ?? "").slice(0, 600),
    builtAt: new Date().toISOString(),
    revenue: revenue(v),
    traffic: await traffic(v, signal),
    alerts: alerts(v),
    tasks: tasks(v),
    goals: goals(v),
    memory: memory(v),
    runs: runs(v),
    nothingMeasured: false,
  };
  packet.nothingMeasured = substantiveKeys(packet).length === 0;
  return packet;
}

/**
 * WHICH EVIDENCE KEYS ARE ACTUALLY MEASURED IN THIS PACKET.
 *
 * The gate's whole first rule reads this: a proposal must name one of these,
 * and a proposal that names a key whose value is null is dropped. Exported
 * rather than recomputed in synthesis.ts so the list the model is SHOWN and
 * the list it is JUDGED against are the same array.
 */
export function measuredKeys(p: EvidencePacket): string[] {
  const keys: string[] = [];
  if (p.revenue.measured) keys.push("revenue");
  if (p.traffic.measured) keys.push("traffic");
  if (p.alerts.measured) keys.push("alerts");
  if (p.tasks.measured) keys.push("tasks");
  if (p.goals.measured) keys.push("goals");
  if (p.memory.measured) keys.push("memory");
  if (p.runs.measured) keys.push("runs");
  return keys;
}

/**
 * THE MEASURED KEYS THAT ACTUALLY SAY SOMETHING.
 *
 * `measuredKeys` is what the GATE judges against and it deliberately includes
 * an empty board: "nothing is on the list for this venture" is a legitimate
 * thing for an action to rest on. This is the narrower question — is there
 * enough here to be worth a model call at all — and the difference between the
 * two is exactly the empty board. A venture with no linked product, no linked
 * site, no rule, no goal, no note, no recent run and an empty board is one this
 * box knows nothing about, and asking a model what to do about it produces
 * generic advice with a business's name on top.
 */
export function substantiveKeys(p: EvidencePacket): string[] {
  return measuredKeys(p).filter((k) => k !== "tasks" || (p.tasks.measured?.open.length ?? 0) > 0);
}
