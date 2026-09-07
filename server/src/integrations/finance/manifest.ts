/**
 * FINANCE — the operating-cost ledger, the allocation rules and the profit
 * model.
 *
 * A PSEUDO-PLUGIN, LIKE BACKUPS. There is no credential here and no provider
 * to reach: everything this area reads is already in the database, put there
 * by Hetzner's collector, the registrars', the app stores' and the runtime's
 * own meter. What it needs is SETTINGS — a display currency, exchange rates
 * the owner typed, an electricity tariff, a default allocation rule — and the
 * settings registry is closed and checked, so they live under a plugin id
 * rather than in a file nobody can correct from the page.
 *
 * IT IS CONNECTED FROM THE MOMENT THE SERVER STARTS, and that is deliberate.
 * "Connected" for this plugin means what it means for uptime and npm: there is
 * something to do. The scheduler only runs collectors for connected plugins,
 * and the collector here is the SEED REFRESH — the pass that keeps the ledger
 * in step with the servers that exist and the domains that renew. A finance
 * area that had to be switched on would silently hold a stale rate card.
 *
 * THE COLLECTOR TOUCHES THE NETWORK TWICE A DAY AND NEVER DEPENDS ON IT. The
 * seed itself reads hetzner_servers, hetzner_volumes, domains, venture_links
 * and workstation_state and writes finance_expenses — a handful of indexed
 * queries that cannot fail for a reason outside this box. Ahead of it, two
 * published documents are refreshed when their cached copy is a day old:
 * Dynadot's renewal price list, which is what prices the domain rows, and the
 * ECB's daily reference rates, which is what lets a card name the rate it
 * drew euro beside dollars at. Both keep yesterday's rows on a failed read and
 * report it; neither can stop the seed. See ./prices.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { finishRun, startRun, syncPlugin, upsertPlugin } from "../../db.ts";
import { PLUGIN, relinkDomains, seedDomains, seedHetzner } from "./expenses.ts";
import { seedPower } from "./power.ts";
import { refreshReferenceRates, refreshTldPrices } from "./prices.ts";
import { financeRoutes } from "./routes.ts";
import { parseRates } from "./money.ts";
import { SKILLS, PACKS } from "./skills.ts";

/** The seed refresh, as a collector. Never throws: a malformed row in one
 *  source must not stop the other two from being brought up to date. */
async function collectFinance() {
  const runId = startRun(PLUGIN);
  const notes: string[] = [];
  const problems: string[] = [];
  /* The published documents first, so the seed prices against today's list.
     A failed read is a problem on the run and nothing more. */
  for (const [name, refresh] of [
    ["dynadot prices", refreshTldPrices],
    ["ECB rates", refreshReferenceRates],
  ] as const) {
    const r = await refresh();
    if (r.error) problems.push(r.error);
    else notes.push(`${name}: ${r.skipped ? `${r.rows} cached` : `${r.rows} read`}`);
  }
  for (const [name, fn] of [
    ["hetzner", seedHetzner],
    ["registrar", seedDomains],
    ["power", seedPower],
  ] as [string, () => { added: number; refreshed: number; unchanged: number; archived: number }][]) {
    try {
      const t = fn();
      notes.push(`${name}: ${t.added} added, ${t.refreshed} refreshed, ${t.unchanged} unchanged, ${t.archived} archived`);
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const moved = relinkDomains();
    if (moved) notes.push(`${moved} domain(s) re-attributed to a venture`);
  } catch (err) {
    problems.push(`relink: ${err instanceof Error ? err.message : String(err)}`);
  }
  const note = notes.join("; ");
  finishRun(runId, problems.length === 0, note, problems.join("; ") || undefined);
  syncPlugin(PLUGIN, problems.join("; ") || null);
  return { ok: problems.length === 0, error: problems.join("; ") || null, note };
}

export const manifest: IntegrationManifest = {
  id: "finance",

  config: {
    [PLUGIN]: {
      keys: {
        display_currency: {
          label: "Display currency",
          hint:
            "Optional, and empty is the honest default. Every total in this area is reported PER CURRENCY and " +
            "nothing adds them; set a three-letter code here and one extra, clearly approximate, converted " +
            "figure becomes available beside them — using only the rates you type below. Leave it empty and " +
            "there is no combined figure anywhere, which is the safer state.",
          ph: "USD",
          check(value) {
            const v = value.trim();
            if (!v) return null;
            return /^[A-Za-z]{3}$/.test(v) ? null : "A three-letter ISO code — USD, EUR, GBP.";
          },
        },
        fx: {
          label: "Exchange rates",
          hint:
            "One per line: “EUR = 1.08 on 2026-09-01”, meaning one euro buys 1.08 of the display currency on that " +
            "date. Optional: a pair with no line here uses the ECB's daily reference rate, read once a day and " +
            "dated on every figure it touches. A rate typed here is the last word for its pair. Every converted " +
            "figure is labelled approximate whichever rate it used.",
          ph: "EUR = 1.08 on 2026-09-01",
          check(value) {
            const { errors } = parseRates(value, "USD");
            return errors.length ? errors[0]! : null;
          },
        },
        default_allocation: {
          label: "Default rule for shared costs",
          hint:
            "“none” or “equal”. A shared cost with no allocation rule of its own is carried by nobody under " +
            "“none” — every venture's margin is honest about not carrying it, and the portfolio page shows the " +
            "money sitting there. Under “equal” it is spread evenly across every venture at read time, without " +
            "writing any rules, and those lines are labelled as a fallback. Default is none.",
          ph: "none",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "none" || v === "equal" ? null : "Either “none” or “equal”.";
          },
        },
        stripe_split: {
          label: "Split Stripe revenue per venture",
          hint:
            "“off” or “mrr-share”. Stripe's settled ledger has no product dimension in this box's tables, so a " +
            "per-venture settled figure is not a measurement. OFF (the default) reports the portfolio's settlement " +
            "at the portfolio and says so on every venture's P&L. “mrr-share” apportions it by each venture's " +
            "share of live MRR in that currency and stamps every figure it produces as estimated. Choose it " +
            "knowing that is what it is.",
          ph: "off",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "off" || v === "mrr-share" ? null : "Either “off” or “mrr-share”.";
          },
        },
        kwh_rate: {
          label: "Electricity price per kWh",
          hint:
            "What your supplier charges for a kilowatt-hour, as a number — 0.32 for 32 cents. Used for any " +
            "machine power profile that carries no price of its own. With nothing here every electricity line is " +
            "unpriced, which is the correct answer to “what does the GPU cost” when nobody has said.",
          ph: "0.32",
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isFinite(n) && n > 0 && n < 100 ? null : "A positive number — the price of one kWh in the currency below.";
          },
        },
        kwh_currency: {
          label: "Electricity currency",
          hint: "Three letters. Defaults to EUR. It is never converted into anything without a rate above.",
          ph: "EUR",
          check(value) {
            const v = value.trim();
            if (!v) return null;
            return /^[A-Za-z]{3}$/.test(v) ? null : "A three-letter ISO code.";
          },
        },
        busy_gpu_percent: {
          label: "GPU busy threshold",
          hint:
            "A workstation sample whose GPU is at or above this percentage counts as BUSY and is charged at the " +
            "busy wattage; everything else awake is charged at idle. Default 20. A sample where nvidia-smi did " +
            "not answer is never counted busy — that is a fact about ssh, not about the card.",
          ph: "20",
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isFinite(n) && n >= 0 && n <= 100 ? null : "A percentage between 0 and 100.";
          },
        },
      },
    },
  },

  collectors: { [PLUGIN]: collectFinance },

  skills: SKILLS,
  packs: PACKS,

  routes: [{ path: "/api/finance", app: financeRoutes }],

  /* Connected always, and seeded once at boot so the ledger is populated the
     first time the page is opened rather than up to half an hour later. */
  onStart() {
    upsertPlugin(PLUGIN, true, null);
    /* `.catch` AND NOT `void`. index.ts wraps `onStart()` in a try/catch,
       which only ever sees a synchronous throw; a rejection from the seed —
       and `startRun`/`finishRun`/`syncPlugin` sit outside the collector's own
       try — would be an unhandled rejection at boot. The ledger being stale
       for half an hour is not worth taking the process down for. */
    collectFinance().catch((err: unknown) => {
      console.error("[finance] the boot seed failed; the ledger is whatever the last collection left it:", err);
    });
  },
};
