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
 * NOTHING IN THIS FILE NAMES A VENTURE, A HOST, A DOMAIN OR A PRODUCT. The
 * rules are written against portfolio-level figures every install has, which
 * is what makes them safe to write for somebody else's business.
 */
import { insertRule, markSeeded, seeded, type RuleWrite } from "./store.ts";
import { catalogue } from "./catalogue.ts";

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
  return out;
}
