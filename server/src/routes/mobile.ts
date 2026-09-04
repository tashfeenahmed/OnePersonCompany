/**
 * The two app stores, in one document.
 *
 * ONE ROUTE FOR THE WHOLE BOARD, the way `/api/costs` is one route for the
 * whole costs board: "what did the apps do this month" is a question asked of
 * both stores at once, and a page that had to fetch two documents and join
 * them would be a page that eventually joined them wrongly.
 *
 * EVERY TOTAL HERE IS COMPUTED ON THE READ. Nothing stored says "$118 in
 * August" — the tables hold transactions, days and months, and a window is
 * summed when somebody asks. A stored monthly figure is wrong the next morning
 * and badly wrong after a week of failed collections, which is the week
 * somebody actually looks.
 *
 * THREE RULES THIS DOCUMENT EXISTS TO KEEP:
 *
 *   1. THE ESTIMATE AND THE PAYOUT ARE NEVER ADDED, never averaged, and never
 *      substituted for one another. Apple's `estimated` block is its daily
 *      sales report's developer proceeds; its `payout` block is the finance
 *      report. Google's `estimated` block is what buyers were charged; its
 *      `payout` block is the merchant amount that landed. Only the payout
 *      blocks may be called revenue, and each says so in its own note.
 *   2. NOTHING IS ADDED ACROSS CURRENCIES. This account's August took money in
 *      nine buyer currencies. A total would need a real, dated exchange rate
 *      this box does not fetch, so `currency.combined` is null with the reason
 *      attached — the same contract /api/costs keeps between euro and dollars.
 *   3. NULL IS "ASKED AND NOT TOLD". An app with no ratings has a null
 *      average, not zero stars; a month Apple issued no finance report has a
 *      null payout, not a zero one.
 */
import { Hono } from "hono";
import {
  appStoreApps,
  appStorePayouts,
  appStoreProceeds,
  appStoreReports,
  appStoreSales,
  appStoreState,
  getPlugin,
  playEarnings,
  playLatestRatings,
  playSales,
  playState,
  playStats,
} from "../db.ts";
import { FINANCE_MONTHS } from "../providers/appstore.ts";

export const mobile = new Hono();

const round = (n: number) => Number(n.toFixed(2));
const connected = (id: string) => getPlugin(id)?.connected === 1;

/** Amounts summed per currency, biggest first. Never a total: the list IS the
 *  answer, and the card that draws it says so. */
function byCurrency<T>(
  rows: T[],
  currency: (r: T) => string,
  amount: (r: T) => number,
): { currency: string; amount: number }[] {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(currency(r), (sums.get(currency(r)) ?? 0) + amount(r));
  return [...sums]
    .map(([c, a]) => ({ currency: c, amount: round(a) }))
    .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
}

const month = (day: string) => day.slice(0, 7);

/** Google stamps its report months `202608`; Apple names its finance reports
 *  `2026-08`. One document should not carry both spellings of a month, so
 *  Google's is widened here rather than at the row — the stored key stays the
 *  one the object name actually carries. */
const monthLabel = (yyyymm: string) =>
  /^\d{6}$/.test(yyyymm) ? `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}` : yyyymm;

/* ------------------------------------------------------------------- apple */

function appStore(days: number) {
  const state = appStoreState();
  const apps = appStoreApps();
  const sales = appStoreSales(days);
  const proceeds = appStoreProceeds(days);
  const payouts = appStorePayouts();
  const salesReports = appStoreReports("sales");
  const financeReports = appStoreReports("finance");

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const window = salesReports.filter((r) => r.period >= since);

  /*
    THE DAILY LINE IS DRAWN FROM THE REPORTS TABLE, NOT FROM THE SALES ROWS.
    A day Apple answered "no sales" has no sales rows and is a real zero; a day
    Apple has not generated has no sales rows either and is not a zero at all.
    Building the series from the days Apple actually answered is what keeps the
    second out of the line.
  */
  const unitsByDay = new Map<string, { downloads: number; updates: number; inApp: number }>();
  for (const r of sales) {
    const held = unitsByDay.get(r.day) ?? { downloads: 0, updates: 0, inApp: 0 };
    held.downloads += r.downloads;
    held.updates += r.updates;
    held.inApp += r.in_app_units;
    unitsByDay.set(r.day, held);
  }

  const answered = window.filter((r) => r.state === "reported" || r.state === "zero");
  const series = answered
    .map((r) => ({ day: r.period, downloads: unitsByDay.get(r.period)?.downloads ?? 0 }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const unitsPerApp = new Map<string, { downloads: number; updates: number; inApp: number }>();
  for (const r of sales) {
    const held = unitsPerApp.get(r.app_id) ?? { downloads: 0, updates: 0, inApp: 0 };
    held.downloads += r.downloads;
    held.updates += r.updates;
    held.inApp += r.in_app_units;
    unitsPerApp.set(r.app_id, held);
  }

  const proceedsPerApp = new Map<string, { currency: string; amount: number }[]>();
  for (const r of proceeds) {
    const list = proceedsPerApp.get(r.app_id) ?? [];
    const held = list.find((x) => x.currency === r.currency);
    if (held) held.amount = round(held.amount + r.amount);
    else list.push({ currency: r.currency, amount: round(r.amount) });
    proceedsPerApp.set(r.app_id, list);
  }

  /*
    RATINGS ACROSS APPS ARE WEIGHTED BY THEIR OWN COUNTS. The mean of two
    averages is not the average of the ratings behind them, and an app with
    four ratings would otherwise weigh as much as one with four hundred. Apps
    nobody has rated are left out of both halves rather than counted as zero.
  */
  const rated = apps.filter((a) => a.rating_avg !== null && (a.rating_count ?? 0) > 0);
  const ratings = rated.reduce((n, a) => n + (a.rating_count ?? 0), 0);
  const average = ratings
    ? Number(
        (
          rated.reduce((n, a) => n + a.rating_avg! * (a.rating_count ?? 0), 0) / ratings
        ).toFixed(2),
      )
    : null;

  const monthsAsked = financeReports.map((r) => r.period).sort();
  const reportedMonths = financeReports.filter((r) => r.state === "reported");
  const payoutMonths = [...new Set(payouts.map((p) => p.month))].sort().map((m) => ({
    month: m,
    currencies: byCurrency(
      payouts.filter((p) => p.month === m),
      (p) => p.currency,
      (p) => p.amount,
    ),
  }));

  return {
    connected: connected("appstore"),
    accounts: state.length,
    seenAt: state.map((s) => s.seen_at).sort().at(-1) ?? null,
    /* The three identifiers the collector is actually sending, echoed back.
       They are printed in Apple's own console and are not secrets — and the
       one failure that produces a permanently empty board is a vendor number
       belonging to a different team, which is undebuggable if nothing will say
       which number was used. */
    identity: state.map((s) => ({
      accountId: s.account_id,
      label: s.account_label,
      keyId: s.key_id,
      issuerId: s.issuer_id,
      vendor: s.vendor,
      apps: s.apps,
    })),

    apps: apps.map((a) => ({
      id: a.app_id,
      account: a.account_label,
      name: a.name,
      bundleId: a.bundle_id,
      /** The newest version's state, and whether that state means "buyable". */
      state: a.state,
      version: a.version,
      onStore: a.on_store === null ? null : a.on_store === 1,
      /** Null average with a zero count is "nobody has rated it". */
      rating: a.rating_avg,
      ratingCount: a.rating_count,
      storefront: a.storefront,
      listed: a.listed === null ? null : a.listed === 1,
      releasedAt: a.released_at,
      downloads: unitsPerApp.get(a.app_id)?.downloads ?? 0,
      updates: unitsPerApp.get(a.app_id)?.updates ?? 0,
      inAppUnits: unitsPerApp.get(a.app_id)?.inApp ?? 0,
      estimatedProceeds: proceedsPerApp.get(a.app_id) ?? [],
    })),

    /** Where the apps are, which is the finding the money cannot express. */
    store: {
      total: apps.length,
      live: apps.filter((a) => a.on_store === 1).length,
      notLive: apps.filter((a) => a.on_store === 0).length,
      unknown: apps.filter((a) => a.on_store === null).length,
    },

    downloads: {
      /** First-time downloads. Updates and re-downloads are their own figures
       *  and are never folded in — they are people who were already here. */
      units: series.reduce((n, d) => n + d.downloads, 0),
      updates: sales.reduce((n, r) => n + r.updates, 0),
      inAppUnits: sales.reduce((n, r) => n + r.in_app_units, 0),
      days: series,
      daysReported: window.filter((r) => r.state === "reported").length,
      daysZero: window.filter((r) => r.state === "zero").length,
      /** Days Apple has not generated yet. Left OUT of the line rather than
       *  drawn as zero, and counted here so a card can say why it is short. */
      daysAbsent: window.filter((r) => r.state === "absent").length,
      from: series[0]?.day ?? null,
      to: series.at(-1)?.day ?? null,
    },

    /** APPLE'S OWN ESTIMATE, under its own name. */
    estimated: {
      currencies: byCurrency(proceeds, (p) => p.currency, (p) => p.amount),
      months: [...new Set(proceeds.map((p) => month(p.day)))].sort().map((m) => ({
        month: m,
        currencies: byCurrency(
          proceeds.filter((p) => month(p.day) === m),
          (p) => p.currency,
          (p) => p.amount,
        ),
      })),
      note:
        "Apple's estimated developer proceeds from the daily sales report — a preview of the payout, before settlement and Apple's own currency conversion. Not revenue.",
    },

    /** THE PAYOUT, and the one figure anything downstream may call revenue. */
    payout: {
      currencies: byCurrency(payouts, (p) => p.currency, (p) => p.amount),
      months: payoutMonths,
      monthsAsked: monthsAsked.length,
      monthsReported: reportedMonths.length,
      /** Months Apple issued no financial report for. NOT zero-payout months —
       *  see `cannot`, because the API cannot tell the two apart. */
      monthsNone: financeReports.filter((r) => r.state === "none").map((r) => r.period),
      note:
        "Extended partner share from the monthly finance report — the money Apple actually pays, per currency, net of its cut.",
    },

    rating: {
      /** Weighted by each app's own rating count. Null when nobody has rated
       *  anything, which is not a rating of zero. */
      average,
      ratings,
      apps: rated.length,
      storefronts: [...new Set(rated.map((a) => a.storefront).filter(Boolean))],
      source: "the public App Store listing — ratings are not in the API at all",
    },

    /*
      WHAT APPLE WILL NOT SAY, as a property of the API rather than a gap in
      the collector. A reader who goes looking for a per-day payout or a
      confident zero should find out here why there isn't one.
    */
    cannot: [
      {
        asked: "was a month with no finance report a month that earned nothing?",
        answer:
          "unknown — the endpoint answers the same 404 for a settled month, the running month and a month in the future, so a missing report is never read as a payout of zero",
      },
      {
        asked: "what did each day pay out?",
        answer: `no — payouts exist per fiscal month only, and the last ${FINANCE_MONTHS} were asked for`,
      },
      {
        asked: "how many people rated the apps?",
        answer:
          "only through the public store listing, per storefront — the App Store Connect API carries no ratings",
      },
      {
        asked: "one total across the currencies?",
        answer: "not offered — no dated exchange rate is fetched on this box",
      },
    ],
  };
}

/* ------------------------------------------------------------------ google */

function play(days: number) {
  const state = playState();
  const stats = playStats(days);
  const earnings = playEarnings();
  const sales = playSales();
  const ratings = playLatestRatings();

  const packages = [...new Set(stats.map((s) => s.package))].sort();

  const installsByDay = new Map<string, number>();
  for (const s of stats)
    if (s.installs !== null)
      installsByDay.set(s.day, (installsByDay.get(s.day) ?? 0) + s.installs);
  const series = [...installsByDay]
    .map(([day, installs]) => ({ day, installs }))
    .sort((a, b) => a.day.localeCompare(b.day));

  /*
    ACTIVE DEVICES IS A CURRENT STATE AND NOT A SUM. It is how many devices
    have the app installed today, so adding thirty days of it would count the
    same phone thirty times. The newest day that reported one per package is
    the whole of the answer.
  */
  const activeByPackage = new Map<string, { day: string; devices: number }>();
  for (const s of stats) {
    if (s.active_devices === null) continue;
    const held = activeByPackage.get(s.package);
    if (!held || s.day > held.day)
      activeByPackage.set(s.package, { day: s.day, devices: s.active_devices });
  }

  const months = [...new Set(earnings.map((e) => e.month))].sort();
  const salesMonths = [...new Set(sales.map((s) => s.month))].sort();
  const latestPayoutMonth = months.at(-1) ?? null;

  return {
    connected: connected("playstore"),
    accounts: state.length,
    seenAt: state.map((s) => s.seen_at).sort().at(-1) ?? null,
    /* The bucket and the service account, echoed back for the same reason
       Apple's vendor number is: the failure this integration actually has is a
       key that Google issued and the Play Console has not been told about, and
       fixing it means knowing which email to invite. */
    identity: state.map((s) => ({
      accountId: s.account_id,
      label: s.account_label,
      bucket: s.bucket,
      serviceAccount: s.service_account,
      packages: s.packages,
    })),

    packages: packages.map((pkg) => {
      const mine = stats.filter((s) => s.package === pkg);
      const rating = ratings.find((r) => r.package === pkg) ?? null;
      const net = earnings.filter((e) => e.package === pkg);
      return {
        package: pkg,
        installs: mine.reduce((n, s) => n + (s.installs ?? 0), 0),
        uninstalls: mine.reduce((n, s) => n + (s.uninstalls ?? 0), 0),
        activeDevices: activeByPackage.get(pkg)?.devices ?? null,
        activeAt: activeByPackage.get(pkg)?.day ?? null,
        /** Play's own running average, as of the last day that carried one.
         *  The export has no rating COUNT in this era, so there is none here. */
        rating: rating?.rating_total ?? null,
        ratingAt: rating?.day ?? null,
        payout: byCurrency(net, (e) => e.currency, (e) => e.net),
      };
    }),

    installs: {
      /** Device installs, from the console's own export. Never called
       *  downloads: this counts devices, and Google counts them itself. */
      installs: series.reduce((n, d) => n + d.installs, 0),
      uninstalls: stats.reduce((n, s) => n + (s.uninstalls ?? 0), 0),
      days: series,
      daysReported: series.length,
      from: series[0]?.day ?? null,
      to: series.at(-1)?.day ?? null,
      activeDevices: [...activeByPackage.values()].reduce((n, a) => n + a.devices, 0),
    },

    rating: {
      /** Averaged across the packages that report one, unweighted — because
       *  Play's export carries no rating count to weight it by, and inventing
       *  weights would be inventing the thing that is missing. */
      average: ratings.length
        ? Number((ratings.reduce((n, r) => n + r.rating_total, 0) / ratings.length).toFixed(2))
        : null,
      packages: ratings.length,
      at: ratings.map((r) => r.day).sort().at(-1) ?? null,
      note: "Play's running average per package. The console export carries no rating count, so nothing here is weighted by one.",
    },

    /** THE PAYOUT: merchant currency, net of Google's fee and refunds. */
    payout: {
      currencies: byCurrency(earnings, (e) => e.currency, (e) => e.net),
      months: months.map((m) => {
        const mine = earnings.filter((e) => e.month === m);
        return {
          month: monthLabel(m),
          currencies: [...new Set(mine.map((e) => e.currency))].map((currency) => {
            const rows = mine.filter((e) => e.currency === currency);
            return {
              currency,
              charged: round(rows.reduce((n, r) => n + r.charged, 0)),
              refunds: round(rows.reduce((n, r) => n + r.refunds, 0)),
              /** Google's cut, as its own rows report it — never a percentage
               *  applied to a total. */
              fees: round(rows.reduce((n, r) => n + r.fees, 0)),
              net: round(rows.reduce((n, r) => n + r.net, 0)),
              transactions: rows.reduce((n, r) => n + r.transactions, 0),
            };
          }),
        };
      }),
      latestMonth: latestPayoutMonth ? monthLabel(latestPayoutMonth) : null,
      note:
        "Merchant earnings from the console's earnings export — charges, less refunds, less Google's own fee rows. This is the money that lands.",
    },

    /** THE ESTIMATE: what buyers were charged, in their own currencies. */
    estimated: {
      months: salesMonths.map((m) => ({
        month: monthLabel(m),
        /** Settled means an earnings export exists for the same month, in
         *  which case the payout above is the figure to read and this one is
         *  only its shadow. */
        settled: months.includes(m),
        currencies: byCurrency(
          sales.filter((s) => s.month === m),
          (s) => s.currency,
          (s) => s.charged,
        ),
        orders: sales.filter((s) => s.month === m).reduce((n, s) => n + s.orders, 0),
        refunds: sales.filter((s) => s.month === m).reduce((n, s) => n + s.refunds, 0),
      })),
      /** The month still running, which has orders and no payout — Google
       *  writes the earnings export only once a month has closed. */
      running: salesMonths.filter((m) => !months.includes(m)).map(monthLabel),
      note:
        "What buyers were charged, in the buyer's own currency, tax included and before Google's cut. An estimate, and the only figure that exists for a month still running.",
    },

    cannot: [
      {
        asked: "what did today earn?",
        answer:
          "no — the financial exports are stamped by MONTH and nothing finer, so no window narrower than a month can be measured",
      },
      {
        asked: "how many ratings are behind the average?",
        answer: "not in this era's console export, which carries the average and no count",
      },
      {
        asked: "one total across the buyer currencies?",
        answer: "not offered — no dated exchange rate is fetched on this box",
      },
    ],
  };
}

/* ------------------------------------------------------------------- route */

mobile.get("/", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 400);
  const ios = appStore(days);
  const android = play(days);

  const currencies = [
    ...new Set([
      ...ios.payout.currencies.map((x) => x.currency),
      ...ios.estimated.currencies.map((x) => x.currency),
      ...android.payout.currencies.map((x) => x.currency),
      ...android.estimated.months.flatMap((m) => m.currencies.map((x) => x.currency)),
    ]),
  ].sort();

  return c.json({
    window: {
      days,
      from: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    },
    /*
      THE CURRENCY BLOCK, which is the same contract /api/costs carries and
      the one this document most needed. Nine currencies of Play sales and a
      handful of App Store storefronts do not add up without a dated rate, and
      one confident number spanning them is worth less than nine that are each
      right.
    */
    currency: {
      seen: currencies,
      combined: null,
      note:
        "No total across currencies is offered. Both stores report per currency and this box fetches no exchange rate, so a combined figure would need a rate nobody wrote down on a day nobody recorded.",
    },
    /*
      AND THE OTHER THING THAT MUST NOT BE ADDED, said once for the whole
      document: an estimate and a payout are two measurements of two different
      things, and a board that sums them reports money that was never paid.
    */
    estimateVsPayout:
      "Estimated proceeds (Apple's daily sales report) and charged amounts (Google's sales export) are previews. Payouts (Apple's finance report, Google's earnings export) are the money that lands. They are never added and never substituted for one another.",
    appstore: ios,
    play: android,
    generatedAt: new Date().toISOString(),
  });
});
