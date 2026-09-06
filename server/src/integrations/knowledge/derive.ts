/**
 * MEASURED FACTS — what the connected accounts already prove about a product.
 *
 * WHY THESE ARE FACTS AND NOT FIGURES. Every number below is already on this
 * box, in a table, drawn on a dashboard somewhere. What was missing is the
 * SENTENCE: "this venture sells four products on Stripe and three of them have
 * live subscriptions" is a statement about what the product IS, and it belongs
 * beside the repository's statements so an agent asked "what does this sell"
 * has one place to look instead of four.
 *
 * DETERMINISTIC, ALWAYS. Not one of these asks anything to think. A deriver is
 * a SELECT and a sentence; the sentence is the same sentence every time, and
 * the only thing that changes is the figure in it. That is what makes it safe
 * to run one on a timer and safe to hand the result to a model as evidence.
 *
 * EVERY DERIVER IS GATED ON A LINK. A fact is written for a venture only where
 * `venture_links` says the venture owns that Stripe product, that Play package,
 * that npm name. There is no hostname guessing here: the link table is the
 * owner's own statement about which measurement belongs to which business, and
 * a fact filed against the wrong venture is worse than no fact — it is a
 * capability the agent will quote at a customer.
 *
 * A KEY PER DERIVER, NOT A FINGERPRINT PER SENTENCE. "Play installs" is ONE
 * fact whose value moves; keying it on the sentence would file a new fact every
 * morning and leave three hundred readings of the same thing. So each deriver
 * supplies a stable key and `put()` rewrites the row in place, moving
 * `observed_at` — which is exactly what "refreshed on collect" means.
 *
 * MONEY IS NEVER ADDED ACROSS CURRENCIES HERE, and the simplest way to keep
 * that promise is not to add money at all: the Stripe deriver counts products
 * and subscriptions and names them, and leaves every revenue question to
 * `/api/stripe`, which owns the arithmetic and the rules that go with it.
 */
import {
  allGithubRepos,
  appStoreApps,
  db,
  npmPackages,
  playStats,
  stripeSubscriptions,
  ventureRows,
} from "../../db.ts";
import { linkedEntities } from "../ventures/links.ts";
import { CONFIDENCE, type FactKind, put } from "./store.ts";

type Derived = { key: string; kind: FactKind; statement: string; plugin: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "1 repository IS public" and "2 repositories ARE". A deriver's sentence is
 *  read by a model and quoted back to the owner, and a count that does not
 *  agree with its verb reads as a machine rather than as a fact. */
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

/* ------------------------------------------------------------------ Stripe */

/**
 * WHAT THIS VENTURE SELLS, by name, out of the live subscription table.
 *
 * PRODUCTS AND NOT PRICES, because `stripe_subscriptions` holds one row per
 * CUSTOMER's copy of a plan and there is no product catalogue table on this
 * box. So "three live prices" would be a claim this data cannot support; what
 * it can support is "these named products have active subscriptions", which is
 * the more useful sentence anyway.
 *
 * A LINKED PRODUCT WITH NO ACTIVE SUBSCRIPTION IS STILL REPORTED, as a
 * separate fact, because a plan nobody is on is a real and interesting state of
 * a business and a deriver that silently omitted it would make the catalogue
 * look smaller than it is.
 */
function stripeFacts(ventureId: string): Derived[] {
  const mine = new Set(linkedEntities(ventureId, "stripe"));
  if (!mine.size) return [];
  const subs = stripeSubscriptions().filter((s) => s.product && mine.has(s.product));
  const live = subs.filter((s) => s.status === "active" || s.status === "trialing");
  const selling = [...new Set(live.map((s) => s.product!))].sort();
  const idle = [...mine].filter((p) => !selling.includes(p)).sort();

  const out: Derived[] = [
    {
      key: "stripe:catalogue",
      kind: "pricing",
      plugin: "stripe",
      statement:
        `Stripe carries ${plural(mine.size, "product")} for this venture: ${[...mine].sort().join(", ")}.`,
    },
  ];
  out.push({
    key: "stripe:live",
    kind: "metric",
    plugin: "stripe",
    statement: selling.length
      ? `${plural(live.length, "subscription")} ${verb(live.length, "is", "are")} active or trialing, across ${plural(selling.length, "product")}: ${selling.join(", ")}.`
      : `No subscription on any of this venture's Stripe products is active or trialing right now.`,
  });
  if (idle.length)
    out.push({
      key: "stripe:idle",
      kind: "limitation",
      plugin: "stripe",
      statement: `${plural(idle.length, "Stripe product")} ${verb(idle.length, "has", "have")} nobody subscribed: ${idle.join(", ")}.`,
    });
  /* The billing shape, which is a fact about the PRODUCT rather than about the
     money: whether it is sold monthly, yearly or both is packaging. */
  const intervals = [...new Set(live.map((s) => s.bill_interval).filter(Boolean))].sort();
  if (intervals.length)
    out.push({
      key: "stripe:intervals",
      kind: "pricing",
      plugin: "stripe",
      statement: `Live subscriptions bill on ${intervals.join(" and ")} intervals.`,
    });
  return out;
}

/* ------------------------------------------------------------------ GitHub */

function githubFacts(ventureId: string): Derived[] {
  const mine = new Set(linkedEntities(ventureId, "github"));
  if (!mine.size) return [];
  const repos = allGithubRepos().filter((r) => mine.has(r.full_name));
  if (!repos.length) return [];
  const out: Derived[] = [];
  const langs = [...new Set(repos.map((r) => r.language).filter(Boolean))] as string[];
  out.push({
    key: "github:repos",
    kind: "integration",
    plugin: "github",
    statement:
      `${plural(repos.length, "GitHub repository", "GitHub repositories")} ${verb(repos.length, "belongs", "belong")} to this venture: ` +
      `${repos.map((r) => r.full_name).join(", ")}` +
      (langs.length ? `, written mainly in ${langs.join(", ")}.` : "."),
  });
  const pub = repos.filter((r) => !r.private);
  if (pub.length)
    out.push({
      key: "github:public",
      kind: "capability",
      plugin: "github",
      statement:
        `${plural(pub.length, "repository", "repositories")} ${verb(pub.length, "is", "are")} public: ` +
        `${pub.map((r) => `${r.full_name}${r.stars ? ` (${r.stars} stars)` : ""}`).join(", ")}.`,
    });
  return out;
}

/* --------------------------------------------------------------------- npm */

function npmFacts(ventureId: string): Derived[] {
  const mine = new Set(linkedEntities(ventureId, "npm"));
  if (!mine.size) return [];
  const pkgs = npmPackages().filter((p) => mine.has(p.package));
  if (!pkgs.length) return [];
  return [
    {
      key: "npm:packages",
      kind: "integration",
      plugin: "npm",
      statement: `Published on npm as ${pkgs.map((p) => p.package).join(", ")}.`,
    },
  ];
}

/* ------------------------------------------------------------- the stores */

/**
 * PLAY INSTALLS, over the last 30 days, and the window is IN the sentence.
 *
 * A figure without its window is the thing this whole box exists not to
 * produce, and a fact that will be read out of context by a model six weeks
 * from now needs it more than a dashboard tile does. Nulls are skipped rather
 * than summed as zero: Play writes no install column for some eras of its
 * export, and "no column" is not "no installs".
 */
function playFacts(ventureId: string): Derived[] {
  const mine = new Set(linkedEntities(ventureId, "playstore"));
  if (!mine.size) return [];
  const rows = playStats(30).filter((r) => mine.has(r.package));
  if (!rows.length)
    return [
      {
        key: "play:listing",
        kind: "integration",
        plugin: "playstore",
        statement: `Shipped on Google Play as ${[...mine].join(", ")}; no daily export covering the last 30 days has been ingested.`,
      },
    ];
  const installs = rows.reduce((n, r) => n + (r.installs ?? 0), 0);
  const devices = rows
    .filter((r) => r.active_devices !== null)
    .sort((a, b) => (a.day < b.day ? 1 : -1))[0]?.active_devices ?? null;
  const out: Derived[] = [
    {
      key: "play:listing",
      kind: "integration",
      plugin: "playstore",
      statement: `Shipped on Google Play as ${[...mine].join(", ")}.`,
    },
    {
      key: "play:installs",
      kind: "metric",
      plugin: "playstore",
      statement: `Google Play recorded ${installs.toLocaleString("en")} installs over the last 30 days.`,
    },
  ];
  if (devices !== null)
    out.push({
      key: "play:devices",
      kind: "metric",
      plugin: "playstore",
      statement: `Play's newest daily export counts ${devices.toLocaleString("en")} active devices.`,
    });
  return out;
}

function appStoreFacts(ventureId: string): Derived[] {
  const mine = new Set(linkedEntities(ventureId, "appstore"));
  if (!mine.size) return [];
  const apps = appStoreApps().filter((a) => mine.has(a.app_id) || (a.bundle_id && mine.has(a.bundle_id)));
  if (!apps.length) return [];
  const out: Derived[] = [
    {
      key: "appstore:listing",
      kind: "integration",
      plugin: "appstore",
      statement:
        `Shipped on the App Store as ${apps
          .map((a) => `${a.name ?? a.app_id}${a.version ? ` (version ${a.version})` : ""}`)
          .join(", ")}.`,
    },
  ];
  const rated = apps.filter((a) => a.rating_avg !== null && a.rating_count);
  if (rated.length)
    out.push({
      key: "appstore:rating",
      kind: "metric",
      plugin: "appstore",
      statement: rated
        .map(
          (a) =>
            `${a.name ?? a.app_id} is rated ${a.rating_avg!.toFixed(2)} from ${a.rating_count} ratings`,
        )
        .join("; ") + ".",
    });
  return out;
}

/* ---------------------------------------------------------------- the pass */

const DERIVERS: ((ventureId: string) => Derived[])[] = [
  stripeFacts,
  githubFacts,
  npmFacts,
  playFacts,
  appStoreFacts,
];

export type DeriveResult = {
  ventureId: string;
  added: number;
  refreshed: number;
  retired: number;
};

/**
 * ONE VENTURE'S MEASURED FACTS, rewritten from the live tables.
 *
 * A measured fact that no deriver produced this pass is RETIRED — a plugin
 * disconnected, a link removed, an app taken off a store. Retiring rather than
 * deleting keeps the record that it was once true, and the date it stopped
 * being produced is the date the row was retired.
 *
 * IT IS SAFE TO CALL OFTEN. Every deriver is a handful of indexed SELECTs over
 * tables the dashboard reads on every page load, and `put()` updates in place
 * where nothing changed, so a pass that finds no news writes no history.
 */
export function deriveVenture(ventureId: string): DeriveResult {
  const out: DeriveResult = { ventureId, added: 0, refreshed: 0, retired: 0 };
  const produced: Derived[] = [];
  for (const d of DERIVERS) {
    try {
      produced.push(...d(ventureId));
    } catch {
      /* One deriver failing loses only that deriver — the rule this codebase
         keeps everywhere. A Stripe table mid-migration must not cost the
         venture its Play facts. */
    }
  }

  const before = new Set(
    (
      db
        .prepare(
          "SELECT id FROM knowledge_facts WHERE venture_id = ? AND tier = 'measured' AND status = 'active'",
        )
        .all(ventureId) as unknown as { id: string }[]
    ).map((r) => r.id),
  );
  const seen = new Set<string>();

  for (const f of produced) {
    const r = put({
      ventureId,
      kind: f.kind,
      statement: f.statement,
      tier: "measured",
      sourceType: "plugin",
      sourceRef: f.plugin,
      confidence: CONFIDENCE.measured,
      createdBy: "agent",
      key: f.key,
    });
    seen.add(r.id);
    if (r.outcome === "added") out.added++;
    else out.refreshed++;
  }

  for (const id of before)
    if (!seen.has(id)) {
      db.prepare("UPDATE knowledge_facts SET status = 'retired' WHERE id = ?").run(id);
      out.retired++;
    }
  return out;
}

export function deriveAll(): DeriveResult[] {
  return ventureRows().map((v) => deriveVenture(v.id));
}

/**
 * THE TIMER, AND WHY IT IS A TIMER RATHER THAN A COLLECTOR.
 *
 * A collector on the manifest hangs off a PLUGIN and runs when that plugin
 * collects. These facts are derived from FIVE plugins at once and belong to no
 * one of them; registering the pass five times would derive the same venture
 * five times an hour and make "which collector wrote this" unanswerable.
 *
 * So it is a plain interval, deliberately offset a few minutes past the
 * scheduler's own half-hour so it reads tables that were just refreshed rather
 * than racing them. It is cheap enough that the offset is a nicety rather than
 * a requirement: nineteen ventures is a few dozen indexed SELECTs.
 *
 * It must not throw — nothing catches it — so the whole body is guarded.
 */
export function startDeriving(): void {
  const pass = () => {
    try {
      deriveAll();
    } catch (err) {
      console.error("[knowledge] derive pass failed:", err instanceof Error ? err.message : err);
    }
  };
  /* The first pass waits two minutes: at boot the collectors have not run yet
     and the venture links may still be being read. */
  setTimeout(pass, 120_000).unref();
  setInterval(pass, 30 * 60_000).unref();
}
