/**
 * WEB ANALYTICS — the depth under the two shallow integrations that already
 * exist.
 *
 * `/api/umami` publishes a site's five figures, a daily line and three top
 * twenties. `/api/meta` publishes an ad account's window and its campaigns.
 * Both are correct and neither can answer the question that follows the
 * headline: WHICH audience changed, WHAT did they do, WHICH campaign sent
 * them, and WHICH advertisement is wearing out. This area is those four
 * questions and nothing else.
 *
 * ONE PSEUDO-PLUGIN, NO CREDENTIAL OF ITS OWN. Every read here uses the Umami
 * and Meta credentials those plugins already hold. `webanalytics` exists as a
 * plugin id for three reasons and each of them is a trap this codebase has
 * already fallen into once:
 *
 *   COLLECTORS MERGE BY PLUGIN ID. An entry under `umami` would SILENTLY
 *   replace the collector that keeps the headline figures current, and an
 *   entry under `meta` would replace the one that reads the money.
 *
 *   CONFIG ENTRIES MERGE BY PLUGIN ID TOO. Two areas defining settings for
 *   `umami` clobber each other's.
 *
 *   AND A ROTATION NEEDS ITS OWN SWITCH. The budget of websites per pass is a
 *   decision about somebody else's analytics server, and it belongs on a page
 *   with the settings it governs.
 *
 * CONNECTED MEANS "THERE IS SOMETHING TO READ", uptime's and npm's reading:
 * this plugin is connected when a Umami or a Meta account is. It is derived on
 * start and after every settings save rather than stored by hand, so removing
 * the last Umami account takes this area's collector off the scheduler with it.
 */
import type { CollectResult, IntegrationManifest } from "../manifest.ts";
import { accountRows, finishRun, startRun, upsertPlugin } from "../../db.ts";
import { boundedError, collectWebAnalytics } from "./umami-collect.ts";
import { collectAdLevel } from "./ads-collect.ts";
import { webAnalyticsRoutes } from "./routes.ts";
import { SKILLS, PACKS } from "./skills.ts";
import {
  ADS_EVERY_HOURS,
  DEFAULT_SITES_PER_PASS,
  PLUGIN,
  SITE_EVERY_HOURS,
  checkRevenue,
  checkSitesPerPass,
  checkUnits,
  checkVentureLists,
} from "./settings.ts";
import { due, markClock } from "./store.ts";

/**
 * Is there anything for this area to read?
 *
 * Counted through `accountRows`, not through the `plugins` table's own
 * `connected` flag, because that flag is derived from the same rows and asking
 * the derived question about a derived answer is how two truths drift apart.
 *
 * IT IS SYNCHRONOUS, AND IT WAS NOT. `db.ts` was imported inside the function
 * behind a `void (async () => …)()` as though it were the manifest cycle the
 * brief warns about. It is not: this file already imports `startRun` from the
 * same module at the top, so the deferral bought nothing and cost something
 * real — `routes/pluginConfig.ts` reads `getPlugin(id)` immediately after
 * calling `after()`, so the first-ever settings save saw the old `connected`
 * and did not run the collection it should have. (The cycle the lesson is
 * about is a manifest reaching `pluginConfig.ts`, which this does not.)
 */
function refreshConnected() {
  try {
    const live = ["umami", "meta"].some((id) => accountRows(id).some((a) => a.connected === 1));
    upsertPlugin(PLUGIN, live, null);
  } catch {
    /* Never throws: onStart must not, and a plugin row that failed to update
       is a plugin that keeps whatever state it had. */
  }
}

/**
 * The one collector, doing both halves — and owning the ONE run row.
 *
 * ONE PLUGIN ID IS ONE COLLECTOR, so the Umami rotation and the Meta ad-level
 * read run in one function, in that order because the dear one has the
 * deadline: a full site read is about fifty requests and takes a minute, while
 * the ad rows are five requests per account and finish in a second. The ad half
 * has its own clock, so it does not repeat every tick because a website was due.
 *
 * THE RUN ROW IS OPENED HERE AND CLOSED HERE, which it was not at first and
 * that was a real bug: the Umami half used to close the run itself, so the
 * Meta half's work finished AFTER the row said the run was over and never
 * appeared on the plugin page — a thousand ad rows written and a note that
 * said "no website was due". One collector, one row, both halves in it.
 *
 * NEITHER HALF CAN FAIL THE OTHER. A Meta token that has lost `ads_read`
 * produces one sentence on the run, not an empty segments page; a dead Umami
 * instance does not cost the ad rows.
 */
async function collect(): Promise<CollectResult> {
  const runId = startRun(PLUGIN);
  /* THE ROW IS CLOSED IN A `finally`. Anything that escapes either half leaves
     a run row open forever on the plugin page — the one failure that cannot be
     seen from the page it happens on. */
  let note: string | null = null;
  let error: string | null = null;
  let ok = false;
  try {
    /* WHICH HALVES HAVE ANYTHING TO DO, asked before either runs, because the
       verdict on the pass depends on it: an install with Meta and no Umami
       must not get a red run every thirty minutes saying "No Umami instance is
       connected" after the ad rows were written perfectly. `connected` for
       this plugin is EITHER, so the run is judged on the halves that had
       accounts. */
    const hasUmami = accountRows("umami").some((a) => a.connected === 1);
    const hasMeta = accountRows("meta").some((a) => a.connected === 1);

    let web: Awaited<ReturnType<typeof collectWebAnalytics>> = {
      ok: true,
      note: null,
      warnings: [],
      websites: 0,
    };
    let webThrew = false;
    if (hasUmami) {
      /* WRAPPED, LIKE THE OTHER HALF. `collectWebAnalytics` reads settings and
         the vault before its own try blocks, so it can throw — and an
         unwrapped throw here would take the Meta half with it, which is
         exactly what this collector's header promises cannot happen. */
      try {
        web = await collectWebAnalytics();
      } catch (err) {
        webThrew = true;
        web = {
          ok: false,
          note: null,
          warnings: [`the Umami half failed: ${err instanceof Error ? err.message : String(err)}`],
          websites: 0,
        };
      }
    }

    let adsNote: string | null = hasMeta ? "the ad-level read was fresh" : null;
    let adsWarnings: string[] = [];
    let adsOk = false;
    if (hasMeta && due("web-ads", "all", ADS_EVERY_HOURS)) {
      try {
        const out = await collectAdLevel();
        markClock("web-ads", "all");
        adsNote = out.adAccounts
          ? `${out.ads} ads, ${out.adSets} ad sets, ${out.days} ad-days, ${out.windows} window rows across ${out.adAccounts} ad account(s)`
          : "no active ad account answered";
        adsWarnings = out.warnings;
        adsOk = true;
      } catch (err) {
        adsNote = null;
        adsWarnings = [`ad-level read: ${err instanceof Error ? err.message : String(err)}`];
      }
    } else if (hasMeta) {
      adsOk = true;
    }

    /* THE VERDICT IS ABOUT THE HALVES THAT HAD SOMETHING TO DO. A pass with no
       account at all is a failure and says which credential is missing; a pass
       where either half did its work is a success carrying the other's
       warnings. */
    ok = (hasUmami && web.ok && !webThrew) || (hasMeta && adsOk);
    const warnings = [...web.warnings, ...adsWarnings];
    if (!hasUmami && !hasMeta)
      warnings.push(
        "Neither a Umami nor a Meta account is connected, so there is nothing for this area to read.",
      );
    else if (!hasUmami)
      warnings.push(
        "No Umami instance is connected, so the audience, event and UTM half of this area read nothing. The ad-level half is unaffected.",
      );
    else if (!hasMeta)
      warnings.push(
        "No Meta account is connected, so the ad-level half read nothing. The Umami half is unaffected.",
      );
    note = [web.note, adsNote].filter(Boolean).join(" · ") || null;
    error = boundedError(warnings);
  } catch (err) {
    /* Nothing above should reach here; if it does the row still closes. */
    error = err instanceof Error ? err.message : String(err);
    ok = false;
  } finally {
    finishRun(runId, ok, note ?? undefined, error ?? undefined);
  }
  return { ok, note, error };
}

export const manifest: IntegrationManifest = {
  id: "webanalytics",

  config: {
    [PLUGIN]: {
      keys: {
        sitesPerPass: {
          label: "Websites per collection pass",
          hint:
            `How many of your Umami websites are read IN FULL on one pass. A full read is about ` +
            `fifty requests to your own analytics server — seven dimensions over three windows, ` +
            `the query strings, the event list and two more requests per event name — so this is ` +
            `a decision about that server's load rather than about this box. Each website has its ` +
            `own clock and is due again after ${SITE_EVERY_HOURS} hours; the least recently read ` +
            `go first, so the whole portfolio cycles whatever this is set to. Default ` +
            `${DEFAULT_SITES_PER_PASS}.`,
          ph: String(DEFAULT_SITES_PER_PASS),
          check: checkSitesPerPass,
        },
        conversions: {
          label: "Conversion events",
          hint:
            "One line per business: `venture-slug = event-name, event-name`. NOTHING IN UMAMI " +
            "SAYS WHICH EVENT MATTERS — `signup-completed` and `signup-viewed` are the same kind " +
            "of row to it — so this is the only place that decision exists. The order you type is " +
            "the order they are shown in, and it is NOT evidence of an order in which anything " +
            "happened: each step is an independent count of the sessions that fired that event, " +
            "and the document says so rather than drawing a funnel.",
          ph: "example-app-1 = signup-cta-clicked, signup-page-viewed, checkout-clicked",
          check: checkVentureLists,
        },
        revenue: {
          label: "Site-reported revenue",
          hint:
            "One line per business: `venture-slug = event-name.property-name`, naming the NUMERIC " +
            "event property that carries money. It is used for one figure and only one — what the " +
            "SITE reported over 30 complete days — and it is never added to the ledger revenue " +
            "beside it, because the same sale would be counted twice. Leave it empty and the " +
            "blended efficiency line uses the ledger alone.",
          ph: "freellmapi = payment-completed.revenue",
          check: checkRevenue,
        },
        units: {
          label: "Event property units",
          hint:
            "One line per property: `event-name.property-name = unit`. A property called " +
            "`revenue` might be cents, dollars or credits and nothing in the Umami API says " +
            "which, so a property with no line here is published with the unit stated as unknown " +
            "— never as a currency somebody guessed.",
          ph: "payment-completed.revenue = USD\naudit-completed.seconds = seconds",
          check: checkUnits,
        },
      },
      after() {
        refreshConnected();
      },
    },
  },

  collectors: { [PLUGIN]: collect },

  routes: [{ path: "/api/webanalytics", app: webAnalyticsRoutes }],

  skills: SKILLS,
  packs: PACKS,

  onStart() {
    refreshConnected();
  },
};
