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
 * them. Revenue is monthly recurring dollars, now against the same measure
 * thirty days ago; traffic is Umami's own complete-days window against the
 * window immediately before it; alerts and runs are the last seven days. A
 * figure whose window is not stated is a figure an agent will caption wrongly.
 */
import { db, ventureRowById, type VentureRow } from "../../db.ts";
import { stripeSubscriptions } from "../../db.ts";
import { ventureGoal } from "../chief/goals.ts";
import { notes } from "../chief/memory.ts";
import { linkedEntities } from "../ventures/links.ts";
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
    mrrUsd: number;
    previousMrrUsd: number;
    deltaUsd: number;
    activeSubscriptions: number;
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
  alerts: Measure<{ window: string; open: { ts: string; rule: string; message: string }[] }>;
  tasks: Measure<{ open: { title: string; column: string; due: string | null; urgency: number }[] }>;
  goals: Measure<{ text: string; updatedAt: string | null; tailorTo: string | null }>;
  memory: Measure<{ notes: { text: string; ageDays: number; source: string }[] }>;
  runs: Measure<{
    window: string;
    finished: { id: string; kind: string; title: string; finishedAt: string | null; headline: string }[];
  }>;
  /** True when all seven are null. The pass asks the model nothing in that
   *  case — see the header. */
  nothingMeasured: boolean;
};

/* ------------------------------------------------------------------ revenue */

/**
 * MRR FOR THE STRIPE PRODUCTS THIS VENTURE OWNS, now against thirty days ago.
 *
 * `monthly_usd` is the collector's own normalisation of a subscription to a
 * monthly dollar figure; this sums it over the subscriptions whose PRODUCT is
 * one the venture is linked to, which is exactly what `/api/venture-links`
 * offers as a Stripe entity. It never sums across ventures and it never adds a
 * currency to a dollar — the collector has already done the one conversion
 * there is, and this file does not invent a second.
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

  let subs: ReturnType<typeof stripeSubscriptions>;
  try {
    subs = stripeSubscriptions();
  } catch {
    return missing("the Stripe subscription table could not be read.");
  }
  const wanted = new Set(products);
  const mine = subs.filter((s) => s.product && wanted.has(s.product));
  if (!mine.length)
    return missing(
      `Stripe products ${products.join(", ")} are linked, but the collector holds no subscription rows for them.`,
    );

  const then = Date.now() - REVENUE_WINDOW_DAYS * 86_400_000;
  const live = (s: (typeof mine)[number]) => s.status === "active" || s.status === "trialing";
  const now = mine.filter((s) => live(s) && !s.ended_at);
  const before = mine.filter(
    (s) => Date.parse(s.created_at) <= then && (!s.ended_at || Date.parse(s.ended_at) > then),
  );
  const sum = (rows: typeof mine) => rows.reduce((a, s) => a + (Number(s.monthly_usd) || 0), 0);
  const mrr = sum(now);
  const prev = sum(before);

  return {
    measured: {
      window: `monthly recurring USD, now against ${REVENUE_WINDOW_DAYS} days ago`,
      products,
      mrrUsd: Math.round(mrr * 100) / 100,
      previousMrrUsd: Math.round(prev * 100) / 100,
      deltaUsd: Math.round((mrr - prev) * 100) / 100,
      activeSubscriptions: now.length,
      note:
        "The past figure is reconstructed from subscription start and end dates, " +
        "so it sees subscriptions that started or stopped and cannot see a price " +
        "that changed. It is dollars only: the collector normalised each plan once, " +
        "and nothing here converts a second time.",
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
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  let rows: { ts: string; name: string; message: string }[];
  try {
    rows = db
      .prepare(
        `SELECT e.ts AS ts, r.name AS name, e.message AS message
           FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
          WHERE r.venture_id = ? AND e.ts >= ? AND e.kind IN ('trip','unreadable')
            AND e.acknowledged_at IS NULL
          ORDER BY e.ts DESC LIMIT 20`,
      )
      .all(v.id, since) as unknown as { ts: string; name: string; message: string }[];
  } catch {
    return missing("the alert tables could not be read.");
  }
  const anyRule = db
    .prepare("SELECT COUNT(*) AS n FROM alert_rules WHERE venture_id = ?")
    .get(v.id) as { n: number };
  if (!Number(anyRule.n))
    return missing("no alert rule on this box names this venture, so nothing is being watched for it.");
  return {
    measured: {
      window: `open trips and unreadable readings in the last ${RECENT_DAYS} days`,
      open: rows.map((r) => ({ ts: r.ts, rule: r.name, message: r.message })),
    },
    why: null,
  };
}

/* -------------------------------------------------------------------- tasks */

/** The venture's open board cards. Also the dedupe corpus — synthesis.ts reads
 *  this same list, so a proposal is compared against exactly what the owner
 *  can see on his board. */
export function openCards(ventureId: string): { title: string; column: string; due: string | null; urgency: number }[] {
  try {
    return db
      .prepare(
        `SELECT c.title AS title, col.title AS column_title, c.due AS due, c.urgency AS urgency
           FROM board_cards c JOIN board_columns col ON col.id = c.column_id
          WHERE c.venture_id = ? AND c.archived_at IS NULL AND col.key <> 'done'
          ORDER BY c.updated_at DESC LIMIT 60`,
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
 * Recently finished sub-agent runs, with the FIRST few hundred characters of
 * each report as a headline.
 *
 * A headline and not the report. A research run's output is thousands of words;
 * seven of them in a prompt would be the whole context window spent on last
 * week's reading, and the pass's job is to notice that a run happened and what
 * it concluded, not to re-read it. The run id is in the packet so the owner —
 * or the agent, through the runs skill — can open the real thing.
 */
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
        headline: r.output.replace(/\s+/g, " ").trim().slice(0, 400),
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
  packet.nothingMeasured =
    packet.revenue.measured === null &&
    packet.traffic.measured === null &&
    packet.alerts.measured === null &&
    packet.tasks.measured === null &&
    packet.goals.measured === null &&
    packet.memory.measured === null &&
    packet.runs.measured === null;
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
