/**
 * The product-endpoints document.
 *
 * EVERY MAPPED FIGURE IS RE-RESOLVED HERE, against the last document the
 * endpoint answered with. That is the point of keeping the document at all:
 * the mapping is edited long after it was collected, and an owner who has just
 * typed `renders = stats.today.renders` deserves to be told immediately that
 * the endpoint calls it `stats.day.renders` and lists its keys — not to watch
 * an empty chart for half an hour and guess.
 *
 * SO THERE ARE TWO KINDS OF NUMBER ON THIS PAGE AND THEY ARE LABELLED. `value`
 * is what the path resolves to in the LAST document, which is as fresh as that
 * document. `series` is the history from readings, which is what the collector
 * recorded at the time — so a metric added this morning has a value and almost
 * no series, and that is honest rather than broken.
 *
 * A PATH THAT RESOLVES TO NOTHING IS REPORTED AS AN ERROR WITH ITS REASON AND
 * IS NEVER A ZERO. It appears in `mappingErrors`, it appears on the metric, and
 * it does not appear in any total.
 *
 * THERE IS NO TOTAL ACROSS ENDPOINTS AND THERE CANNOT BE. "renders" on one
 * product and "renders" on another are two different things that happen to
 * share a word the owner chose; adding them would be the currency mistake in
 * another costume.
 */
import { Hono } from "hono";
import { configValue, series } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import {
  PLUGIN,
  docRows,
  metricsFor,
  parseMetrics,
  productMetric,
  resolve,
} from "./products.ts";

export const productRoutes = new Hono();

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value));
}

productRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? 30) || 30, 1, 400);
  const all = parseMetrics(configValue(PLUGIN, "metrics"));
  const docs = new Map(docRows().map((d) => [d.account_id, d]));

  const mappingErrors: { endpoint: string; label: string; path: string; why: string }[] = [];

  const endpoints = accounts.list(PLUGIN).map((account) => {
    const row = docs.get(account.id) ?? null;
    let doc: unknown = null;
    if (row?.doc) {
      try {
        doc = JSON.parse(row.doc);
      } catch {
        doc = null;
      }
    }

    const metrics = metricsFor(all, account.label).map((metric) => {
      const history = series(productMetric(account.id, metric.label), days);
      const latest = history.at(-1) ?? null;
      const r = doc === null ? null : resolve(doc, metric);
      if (r && !r.ok)
        mappingErrors.push({
          endpoint: account.label,
          label: metric.label,
          path: metric.count ? `@count(${metric.path})` : metric.path,
          why: r.why,
        });
      return {
        label: metric.label,
        path: metric.count ? `@count(${metric.path})` : metric.path,
        /** Applies to every endpoint, or only to this one. */
        scope: metric.account === null ? "all endpoints" : account.label,
        /** Resolved against the last document, right now. */
        value: r?.ok ? r.value : null,
        /** Why there is no value. Null when there is one. */
        error: r && !r.ok ? r.why : doc === null ? "No document has been collected from this endpoint yet." : null,
        /** What the collector recorded, over the window. A metric added today
         *  has a value and no series; that is not a gap in the data. */
        recorded: latest && { ts: latest.ts, value: latest.value },
        series: history.map((h) => ({ ts: h.ts, value: h.value })),
      };
    });

    return {
      accountId: account.id,
      label: account.label,
      /** From the collector's cache of the vault — see 045_product_url. Null
       *  until the first collection. */
      url: row?.url ?? null,
      reachable: row ? row.ok === 1 : null,
      lastFetchedAt: row?.ts ?? null,
      status: row?.status ?? null,
      ms: row?.ms ?? null,
      truncated: row?.truncated === 1,
      error: row?.error ?? account.lastError,
      documentBytes: row?.doc?.length ?? null,
      /** The top-level keys of the last document, so a mapping can be written
       *  without curling the endpoint by hand. */
      keys:
        doc && typeof doc === "object" && !Array.isArray(doc)
          ? Object.keys(doc as Record<string, unknown>).slice(0, 40)
          : null,
      metrics,
    };
  });

  return c.json({
    window: { days, of: "the mapped figures' recorded history" },
    endpoints,
    /** Gathered in one place because this is the list the owner actually acts
     *  on — every path that matches nothing, with what the document does
     *  contain. Empty is the good state. */
    mappingErrors,
    summary: {
      configured: endpoints.length,
      reachable: endpoints.filter((e) => e.reachable === true).length,
      failing: endpoints.filter((e) => e.reachable === false).length,
      neverCollected: endpoints.filter((e) => e.reachable === null).length,
      metrics: all.length,
      /** No combined figure, and the reason. */
      combined: null,
      note: "Figures are never added across endpoints: two products' “renders” share a word the owner chose and nothing else.",
      lastFetchedAt: endpoints.map((e) => e.lastFetchedAt).filter(Boolean).sort().at(-1) ?? null,
    },
  });
});

/**
 * What a venture could be linked to here.
 *
 * The entity is the account id, because an endpoint's URL changes when the
 * product moves and its account does not. `host` comes from the URL, which is
 * usually the product's own domain — which is exactly what makes the venture
 * link suggest itself.
 */
productRoutes.get("/entities", (c) => {
  const docs = new Map(docRows().map((d) => [d.account_id, d]));
  return c.json({
    entities: accounts.list(PLUGIN).map((a) => {
      const url = docs.get(a.id)?.url ?? null;
      let host: string | null = null;
      if (url) {
        try {
          const h = new URL(url).hostname.toLowerCase();
          host = h === "localhost" || /^[0-9.]+$/.test(h) ? null : h;
        } catch {
          host = null;
        }
      }
      return { plugin: PLUGIN, entity: String(a.id), label: a.label, host };
    }),
  });
});
