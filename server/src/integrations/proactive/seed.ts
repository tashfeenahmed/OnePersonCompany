/**
 * THE DEFAULT RULES — five suggestions, and every one of them deletable.
 *
 * WHY THERE ARE ANY AT ALL. An alerting page that opens empty asks the owner
 * to invent, from nothing, both the figure worth watching and the number it
 * should cross. Almost nobody does that on the first morning, so the feature
 * sits at zero rules forever and the first outage is found the same way it was
 * found before. Five rules that already work are a worked example: the owner
 * reads them, changes the numbers to their own, and now understands the shape.
 *
 * WHY EACH IS MARKED `seeded` AND NOTHING PROTECTS IT. A seeded rule behaves
 * exactly like a typed one — it is edited, disabled and deleted the same way —
 * and it carries a flag ONLY so the page can say "this box suggested this,
 * nobody chose it". The alternative, quietly writing rules that look like the
 * owner's own, would let somebody believe they had configured a watch they had
 * never seen.
 *
 * WHY SEEDING IS PER SKILL AND ONCE. A rule against a skill that is not
 * connected is an "unreadable" event every half hour, so nothing is seeded for
 * a plugin the owner has not connected — and connecting Stripe in March gets
 * Stripe's suggestion in March rather than never. The fact that a skill has
 * been offered its defaults is recorded in `alert_seeds`, separately from the
 * rules themselves, because deleting a suggested rule is the owner saying no
 * and a seeder that read an empty rules table would put it straight back.
 *
 * WHY THE THRESHOLDS ARE THE ONES THEY ARE. Every one is either the document's
 * own published threshold, or zero. `summary.down > 0` is "a host you listed
 * is not answering", which needs no opinion. Disk at 85 is the one real
 * judgement here and it sits between the fleet document's own `warn` of 80 and
 * its `critical` of 90 — quoted from that document rather than invented, and
 * the first number an owner will change.
 *
 * NOTHING IN THIS FILE NAMES A VENTURE, A HOST, A DOMAIN OR A PRODUCT, and the
 * per-venture rules below do not change that: the businesses they are written
 * for are read from the owner's own `venture_links` at seeding time, so the
 * source names portfolio-level figures every install has and the rules name
 * whatever that install turns out to be.
 */
import { insertRule, markSeeded, seeded, type RuleWrite } from "./store.ts";
import { catalogue } from "./catalogue.ts";
import { ventureStripeBook } from "../finance/attribution.ts";

type Default = Omit<RuleWrite, "seeded"> & { why: string };

/**
 * Keyed by SKILL id rather than plugin id, and that is the honest key: a skill
 * is live exactly when one of its plugins is connected (an ANY-OF — see
 * skills/registry.ts), so "is this skill connected" is the question that
 * actually decides whether a rule can be read. The `alert_seeds` table's
 * `plugin` column holds these ids.
 */
export const DEFAULTS: Record<string, Default[]> = {
  stripe: [
    {
      name: "A payment failed today",
      skill: "stripe",
      view: "default",
      params: { days: 1 },
      path: "charges[0].failed",
      op: ">",
      threshold: 0,
      windowMinutes: null,
      ventureId: null,
      enabled: true,
      cooldownMinutes: 720,
      why:
        "Failed payment ATTEMPTS in the first currency the document lists, over " +
        "today. It is attempts and not settlement — the two are dated differently " +
        "and nothing crosses them — and it counts Radar blocks beside bank " +
        "declines, which are not the same problem. Twelve hours of cooldown so a " +
        "bad afternoon is one alert.",
    },
  ],

  uptime: [
    {
      name: "A site is not answering",
      skill: "uptime",
      view: "default",
      params: { hours: 24 },
      path: "summary.down",
      op: ">",
      threshold: 0,
      windowMinutes: null,
      ventureId: null,
      enabled: true,
      cooldownMinutes: 120,
      why:
        "How many of the hosts you listed failed their last check, from this " +
        "machine. A 403 counts as down, which is what the uptime document says " +
        "it means. Checks are about half an hour apart, so an outage shorter " +
        "than that is invisible here.",
    },
  ],

  fleet: [
    {
      name: "A box is filling up",
      skill: "fleet",
      view: "default",
      params: { hours: 24 },
      path: "totals.fullestDisk.percent",
      op: ">",
      threshold: 85,
      windowMinutes: null,
      ventureId: null,
      enabled: true,
      cooldownMinutes: 720,
      why:
        "The fullest filesystem on any box, as df reports capacity — used over " +
        "used plus available. 85 sits between the fleet document's own warn (80) " +
        "and critical (90); it is the one number here that is a judgement, and " +
        "it is the first one to change.",
    },
  ],

  domains: [
    {
      name: "A domain expires within 30 days",
      skill: "domains",
      view: "default",
      params: {},
      path: "summary.expiring30",
      op: ">",
      threshold: 0,
      windowMinutes: null,
      ventureId: null,
      enabled: true,
      cooldownMinutes: 1440,
      why:
        "The domains document publishes counts at 7, 30 and 90 days, and this " +
        "watches the 30-day one because that is the last comfortable moment to " +
        "act on a transfer. Auto-renew being on is not a reason to ignore it: " +
        "the card on file is the thing that expires.",
    },
  ],

  stability: [
    {
      name: "Crash rate rose against last week",
      skill: "stability",
      view: "default",
      params: { days: 30 },
      path: "alerting.worstCrashRate",
      op: "rose_by_pct",
      threshold: 25,
      windowMinutes: 7 * 24 * 60,
      ventureId: null,
      enabled: true,
      cooldownMinutes: 720,
      why:
        "The worst crash rate any app reported over its vitals window, as a " +
        "fraction of distinct users, compared with the figure THIS BOX RECORDED " +
        "a week ago. `alerting.worstCrashRateApp` beside it names which app it " +
        "is, and the document's `rates` block breaks it down by version code. " +
        "The Play Developer Reporting API's window ends at its own freshness " +
        "several days back, so this cannot speak about a release shipped " +
        "yesterday. It says nothing at all until there are two weeks of " +
        "readings, and a week with no crash data is `unreadable` rather than a " +
        "rate of zero.",
    },
  ],

  umami: [
    {
      name: "Pageviews dropped by half against last week",
      skill: "umami",
      view: "default",
      params: { days: 30 },
      path: "portfolio.window.pageviews",
      op: "dropped_by_pct",
      threshold: 50,
      windowMinutes: 7 * 24 * 60,
      ventureId: null,
      enabled: true,
      cooldownMinutes: 1440,
      why:
        "The portfolio's pageviews over its own window, compared with the figure " +
        "THIS BOX RECORDED a week ago — not with a figure Umami computed. It " +
        "says nothing at all until there are two weeks of readings, and it says " +
        "so rather than tripping.",
    },
  ],
};

/* ------------------------------------------------------- one per venture */

/**
 * "TELL ME WHEN THIS BUSINESS'S REVENUE MOVES" — the rule that could not be
 * written until the Stripe document published a per-venture key.
 *
 * WHY THESE ARE NOT IN `DEFAULTS`. That table is per skill and is offered
 * once, when the plugin is connected. A venture's rule depends on something
 * that happens later and more than once — the owner linking a Stripe product
 * to a business on the connections page — so each venture is seeded on its own
 * evidence and recorded under its own key. Linking a product in March gets the
 * rule in March; deleting the rule is still the owner saying no, and it stays
 * deleted, because the guard is the `alert_seeds` row and not an empty table.
 *
 * WHY `mrrAbsDelta > 20` AND NOT A PERCENTAGE. The engine has three change
 * comparisons and none of them is "moved either way by more than X":
 * `changed` trips on any difference at all, which on a book of annual plans
 * normalised to a twelfth is most evaluations and would teach the owner to
 * ignore the list; `dropped_by_pct` and `rose_by_pct` each watch ONE direction
 * and compare with a reading THIS BOX recorded a window ago, so a venture
 * would need two rules and neither would say anything for the first fortnight.
 * So the document publishes the move itself — `mrrAbsDelta`, the thirty-day
 * change without its sign, reconstructed from the subscription rows — and the
 * rule is a plain threshold against it, which trips the first time it is
 * evaluated after the money moves and needs no history of its own.
 *
 * TWENTY DOLLARS, AND IT IS THE FIRST NUMBER TO CHANGE. It is the only
 * judgement here: small enough that losing one subscription on most of these
 * books is visible, large enough that a coupon ending is not an alert. An
 * owner who would rather write a percentage changes the path to `mrrMovePct`
 * and the threshold to 10; the document publishes both for exactly that.
 */
export const VENTURE_MRR_MOVE = 20;

/** The key `alert_seeds` holds for one venture's revenue rule. Per venture so
 *  a business linked later is still offered one. */
export const ventureSeedKey = (ventureId: string) => `stripe:venture:${ventureId}`;

export function ventureRevenueRule(venture: { ventureId: string; name: string }): Default {
  return {
    name: `MRR moved for ${venture.name}`,
    skill: "stripe",
    view: "default",
    params: {},
    path: `byVenture.${venture.ventureId}.mrrAbsDelta`,
    op: ">",
    threshold: VENTURE_MRR_MOVE,
    windowMinutes: null,
    ventureId: venture.ventureId,
    enabled: true,
    cooldownMinutes: 1440,
    why:
      "This venture's MRR against the same figure thirty days ago, without its " +
      "sign, so a loss and a gain both trip it. The past figure is reconstructed " +
      "from subscription start and end dates: it sees subscriptions that started " +
      "or stopped and cannot see a price that changed. One-off purchases are not " +
      "in MRR and are never in this — `byVenture.<id>.oneOff` is that money.",
  };
}

/**
 * Seed a revenue rule for every venture that has a Stripe product linked and
 * has not been offered one.
 *
 * A venture with no linked product is skipped rather than given a rule that
 * would read zero forever: `byVenture` publishes no entry for it, so the rule
 * would record an unreadable every half hour and say nothing about the
 * business.
 */
export function seedVentureRules(): { created: number; names: string[] } {
  const names: string[] = [];
  for (const v of ventureStripeBook()) {
    if (seeded(ventureSeedKey(v.ventureId))) continue;
    const { why: _why, ...rule } = ventureRevenueRule(v);
    insertRule({ ...rule, seeded: true });
    markSeeded(ventureSeedKey(v.ventureId), 1);
    names.push(rule.name);
  }
  return { created: names.length, names };
}

export type SeedResult = { skill: string; created: number; names: string[] }[];

/**
 * Seed whatever is connected and has not been offered its defaults yet.
 *
 * CALLED ON EVERY START and safe to call on every start: the guard is a row in
 * `alert_seeds`, not an empty table. A start that cannot reach the catalogue —
 * the port is not open yet, the process is shutting down — seeds nothing and
 * says so; the next start tries again.
 */
export async function seedDefaults(signal?: AbortSignal): Promise<SeedResult> {
  const out: SeedResult = [];
  const cat = await catalogue(signal);
  const live = new Set(cat.filter((s) => s.connected).map((s) => s.id));

  for (const [skill, defaults] of Object.entries(DEFAULTS)) {
    if (!live.has(skill) || seeded(skill)) continue;
    const names: string[] = [];
    for (const d of defaults) {
      const { why: _why, ...rule } = d;
      insertRule({ ...rule, seeded: true });
      names.push(d.name);
    }
    markSeeded(skill, names.length);
    out.push({ skill, created: names.length, names });
  }

  /* THE PER-VENTURE RULES, and only where Stripe can actually be read. They
     are seeded on every start rather than once, because the evidence they
     depend on — a product linked to a business — arrives whenever the owner
     types it, and the per-venture guard is what keeps that idempotent. */
  if (live.has("stripe")) {
    try {
      const ventures = seedVentureRules();
      if (ventures.created) out.push({ skill: "stripe (per venture)", ...ventures });
    } catch (err) {
      /* A seeding pass must never cost the start. The next one tries again. */
      console.error("[alerts] could not seed per-venture revenue rules:", err);
    }
  }
  return out;
}
