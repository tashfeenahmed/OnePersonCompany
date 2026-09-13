/** Adapters read collected data only. No provider calls, credentials, or user-specific IDs. */
import { accountRows, db, series, ventureRows } from "../../db.ts";
import { umamiRoutes } from "../analytics/umami-route.ts";
import { userRoutes } from "../activity/users-routes.ts";
import { linkIndex, normaliseEntity } from "../ventures/links.ts";
import { shiftDay } from "../../../../shared/workJournal.ts";
import type { MetricSeries } from "../../../../shared/insights.ts";

function ventureForSite(entity: string, domain: string | null): string | null {
  const linked = linkIndex("umami").get(normaliseEntity(entity)) ?? [];
  if (linked.length) return linked.length === 1 ? linked[0]! : null;
  if (!domain) return null;
  const host = domain.toLowerCase().replace(/^www\./, "");
  const matches = ventureRows().filter(v => { try { return new URL(v.website ?? "").hostname.replace(/^www\./, "") === host; } catch { return false; } });
  return matches.length === 1 ? matches[0]!.id : null;
}

export async function trafficSeries(): Promise<MetricSeries[]> {
  const doc = await (await umamiRoutes.request("/?days=90")).json() as { websites: { accountId: number; entity: string; name: string | null; domain: string | null; window: { end: string; seenAt: string } | null; days: { day: string; pageviews: number }[] }[] };
  const accounts = new Map(accountRows("umami").filter(a => a.connected).map(a => [a.id, a]));
  return doc.websites.filter(s => accounts.has(s.accountId)).map(s => ({ id: `umami:${s.accountId}:${s.entity}:pageviews`, label: `${s.name ?? s.domain ?? s.entity} · pageviews`, source: "umami", ventureId: ventureForSite(s.entity, s.domain), metric: "pageviews", unit: "views", observedAt: s.window?.seenAt ?? null,
    completeThrough: s.window?.end ?? "", unavailable: accounts.get(s.accountId)?.last_error || null,
    points: s.days.map(p => ({ day: p.day, value: p.pageviews })) }));
}
export async function userSeries(): Promise<MetricSeries[]> {
  const doc = await (await userRoutes.request("/?days=90")).json() as { products: { accountId: number; product: string; reachable: boolean | null; lastFetchedAt: string | null; partialList: boolean; firstSignupAt: string | null; shape: string | null; venture: { id: string } | null; days: { day: string; signups: number | null; total: number | null }[] }[] };
  const today = new Date().toISOString().slice(0, 10), yesterday = shiftDay(today, -1);
  const accounts = new Set(accountRows("users").filter(a => a.connected).map(a => a.id));
  return doc.products.filter(p => accounts.has(p.accountId)).flatMap(p => {
    const base = { source: "users", ventureId: p.venture?.id ?? null, observedAt: p.lastFetchedAt, completeThrough: yesterday, unavailable: !p.reachable ? "Product did not answer the last collection." : null };
    const counts = new Map(p.days.map(d => [d.day, d.signups]));
    const start = p.firstSignupAt?.slice(0, 10);
    // Only a complete user listing proves zero signups on omitted days.
    const signups = p.shape === "users" && !p.partialList && start ? Array.from({ length: 90 }, (_, i) => shiftDay(yesterday, i - 89)).filter(day => day >= start).map(day => ({ day, value: counts.get(day) ?? 0 })) : p.days.map(d => ({ day: d.day, value: d.signups }));
    return [
      { ...base, id: `users:${p.accountId}:signups`, label: `${p.product} · signups`, metric: "signups" as const, unit: "signups", unavailable: base.unavailable ?? (p.partialList ? "Only part of the user list is available." : null), points: signups },
      { ...base, id: `users:${p.accountId}:total`, label: `${p.product} · users`, metric: "users" as const, unit: "users", points: db.prepare("SELECT day, total AS value FROM activity_user_totals WHERE account_id = ? AND day >= date(?, '-90 days') ORDER BY day").all(p.accountId, today) as { day: string; value: number }[] },
    ];
  });
}
export function revenueSeries(): MetricSeries[] {
  const accounts = accountRows("stripe").filter(a => a.connected);
  if (!accounts.length) return [];
  const currencies = new Map<string, { day: string; value: number | null }[]>();
  const latest = new Map<string, string>();
  for (const p of series("stripe.mrr", 90)) {
    let meta: { currency?: string; accounts?: number } = {};
    try { meta = JSON.parse(p.meta ?? "{}"); } catch { continue; }
    if (!meta.currency || meta.accounts !== accounts.length) continue;
    const unit = meta.currency.toUpperCase();
    const points = currencies.get(unit) ?? [];
    points.push({ day: p.ts.slice(0, 10), value: p.value }); currencies.set(unit, points); latest.set(unit, p.ts);
  }
  // New collectors record each currency independently; use those observations when available.
  for (const unit of [...new Set([...currencies.keys(), ...(db.prepare("SELECT DISTINCT substr(metric, 12) AS currency FROM readings WHERE metric LIKE 'stripe.mrr.%'").all() as { currency: string }[]).map(r => r.currency.toUpperCase())])]) {
    const rows = series(`stripe.mrr.${unit.toLowerCase()}`, 90).filter(r => {
      try { return JSON.parse(r.meta ?? "{}").accounts === accounts.length; } catch { return false; }
    });
    if (rows.length) { currencies.set(unit, [...(currencies.get(unit) ?? []), ...rows.map(r => ({ day: r.ts.slice(0, 10), value: r.value }))]); latest.set(unit, rows.at(-1)!.ts); }
  }
  const yesterday = shiftDay(new Date().toISOString().slice(0, 10), -1);
  return [...currencies].map(([unit, points]) => ({ id: `stripe:mrr:${unit}`, label: `Stripe MRR · ${unit}`, source: "stripe", ventureId: null, metric: "mrr", unit, points, observedAt: latest.get(unit) ?? null, completeThrough: yesterday, unavailable: accounts.some(a => a.last_error) ? "A Stripe account failed its last collection." : null }));
}
